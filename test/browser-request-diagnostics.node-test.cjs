'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { classifyRequest, attachRequestDiagnostics } = require('../browser-request-diagnostics');

test('classifies only expected origins and never returns query or account data', () => {
    assert.equal(classifyRequest('https://chatgpt.com/api/auth/session?secret=test'), 'session');
    assert.equal(classifyRequest('https://chatgpt.com/backend-api/accounts/private-account/check'), 'account');
    assert.equal(classifyRequest('https://chatgpt.com.evil.test/api/auth/session'), 'other');
    assert.equal(classifyRequest('https://evilchallenges.cloudflare.com/foo'), 'other');
});
test('caps diagnostic storage and detaches listeners without reading bodies', () => {
    const page = new EventEmitter();
    const capture = attachRequestDiagnostics(page, () => 'session');
    for (let i = 0; i < 120; i++) page.emit('response', {
        url: () => 'https://chatgpt.com/api/auth/session?token=secret',
        status: () => 403, headers: () => ({ 'cf-mitigated': 'challenge', 'set-cookie': 'secret' }),
        text: () => { throw new Error('must not read'); }
    });
    assert.equal(capture.events.length, 100);
    assert.deepEqual(capture.events[0], { stage: 'session', category: 'session', status: 403, challenge: true });
    assert.ok(!JSON.stringify(capture.events).includes('secret'));
    capture.detach();
    assert.equal(page.listenerCount('response'), 0);
    assert.equal(page.listenerCount('requestfailed'), 0);
});
