'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openSessionChallenge } = require('../session-challenge-page');
const { verifyRealSessionApi } = require('../session-auth');
const url = 'https://chatgpt.com/api/auth/session';
function fixture() {
    const page = new EventEmitter();
    const frame = {};
    page.mainFrame = () => frame;
    page.url = () => url;
    const response = (status, body, headers = {}) => ({ url: () => url, frame: () => frame,
        request: () => ({ isNavigationRequest: () => true }), status: () => status,
        headers: () => headers, text: async () => body });
    const denied = response(403, '', { 'cf-mitigated': 'challenge' });
    page.goto = async target => { assert.equal(target, url); page.emit('response', denied); return denied; };
    return { page, response, denied };
}
test('uses the actual session navigation response after one interaction and removes listeners', async () => {
    const { page, response } = fixture();
    const success = response(200, '{"user":{"id":"test"},"accessToken":"test"}');
    const result = await openSessionChallenge(page, async (current, options) => {
        assert.equal(current, page); assert.equal(options.jsonDocument, true);
        page.emit('response', success);
    });
    assert.equal(result, success);
    assert.equal(page.listenerCount('response'), 0);
});
test('callback completion without an authenticated response cannot establish login', async () => {
    const { page, denied } = fixture();
    assert.equal(await openSessionChallenge(page, async () => {}), denied);
    assert.equal(page.listenerCount('response'), 0);
});
test('handles a fetch challenge via visible navigation but validates JSON before accepting login', async () => {
    for (const [body, expected] of [['{}', false], ['{"user":{"id":"test"},"accessToken":"test"}', true]]) {
        const { page, response } = fixture();
        const context = {};
        page.context = () => context;
        page.evaluate = async () => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' });
        const result = await verifyRealSessionApi(context, { page, transport: 'fetch', onChallenge: async () => {
            page.emit('response', response(200, body));
        } });
        assert.equal(result.ok, expected);
    }
});
