'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDebugEndpoint, connectExternalBrowser } = require('../browser-external');
const { installChatGptSession } = require('../session-auth');
const { closeTaskBrowser } = require('../browser-runtime');

it('rereads the current port and rejects invalid ports instead of falling back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-cdp-'));
    const file = path.join(dir, 'DevToolsActivePort');
    try {
        fs.writeFileSync(file, '12345\n/devtools/browser/test');
        assert.equal(readDebugEndpoint(dir), 'http://127.0.0.1:12345');
        fs.writeFileSync(file, '23456\n/devtools/browser/test');
        assert.equal(readDebugEndpoint(dir), 'http://127.0.0.1:23456');
        fs.writeFileSync(file, '0');
        assert.throws(() => readDebugEndpoint(dir), /端口无效/);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(dir);
    }
});

it('uses the existing context and preserves its browser and existing pages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-cdp-'));
    const file = path.join(dir, 'DevToolsActivePort');
    let probeClosed = false;
    const context = { newPage: async () => ({ evaluate: async () => 'actual UA', close: async () => { probeClosed = true; } }) };
    const browser = { contexts: () => [context], close: () => { throw new Error('external browser must remain open'); } };
    try {
        fs.writeFileSync(file, '12345');
        const session = await connectExternalBrowser(dir, { connectOverCDP: async () => browser });
        assert.equal(session.context, context);
        assert.equal(session.realUserAgent, 'actual UA');
        assert.equal(probeClosed, true);
        await closeTaskBrowser(session, browser);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(dir);
    }
});

it('checks the real logged-in account without installing cookies or session shims', async () => {
    const data = { user: { email: 'actual@example.test' }, accessToken: 'native-token' };
    const context = { newPage: async () => ({
        goto: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'application/json' }), text: async () => JSON.stringify(data) }),
        close: async () => {}
    }) };
    const raw = JSON.stringify(data);
    const result = await installChatGptSession(context, raw, { nativeSession: true });
    assert.deepEqual(result.sessionData, data);
    assert.equal(result.cookieVerified, true);
    await assert.rejects(installChatGptSession(context, JSON.stringify({ user: { email: 'other@example.test' }, accessToken: 'other-token' }), { nativeSession: true }), /账号与粘贴的 Session 不一致/);
});
