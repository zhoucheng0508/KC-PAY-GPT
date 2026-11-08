'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { connectPersistentBrowser } = require('../browser-persistent');
const { resolveBrowserRuntimeMode, buildWorkerRuntimeEnv, resolveExternalProfileDir } = require('../browser-runtime');

test('persistent mode survives worker dispatch and ignores inherited external debug profile', () => {
    const env = buildWorkerRuntimeEnv({ CHECKOUT_DEBUG_ONLY: '1', CHECKOUT_DEBUG_CDP_PROFILE_DIR: 'old' }, null, 'persistent');
    assert.equal(resolveBrowserRuntimeMode(env), 'persistent');
    assert.equal(resolveExternalProfileDir(env), '');
    assert.equal(env.BROWSER_POOL, '0');
});

test('profile lock rejects concurrent workers, closes old pages and releases on success/failure', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pay-profile-'));
    const env = { PERSISTENT_PROFILE_DIR: profile, DISPLAY: ':99' };
    let oldClosed = 0;
    let contextClosed = 0;
    const page = { evaluate: async () => 'Chrome/147.0.0.0' };
    const chromium = { launchPersistentContext: async (_, options) => {
        assert.equal(options.headless, false);
        return { newPage: async () => page, pages: () => [{ close: async () => { oldClosed++; } }, page],
            browser: () => ({}), close: async () => { contextClosed++; } };
    } };
    try {
        const first = await connectPersistentBrowser({ env, chromium });
        await assert.rejects(connectPersistentBrowser({ env, chromium }), { code: 'BROWSER_PROFILE_BUSY' });
        assert.equal(oldClosed, 1);
        await first.close();
        await first.close();
        assert.equal(contextClosed, 1);
        await assert.rejects(connectPersistentBrowser({ env, chromium: { launchPersistentContext: async () => { throw new Error('launch failed'); } } }), /launch failed/);
        const next = await connectPersistentBrowser({ env, chromium });
        await next.close();
    } finally { await fs.rm(profile, { recursive: true, force: true }); }
});

test('failed browser close retains the lock instead of permitting overlapping access', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pay-profile-'));
    const env = { PERSISTENT_PROFILE_DIR: profile, DISPLAY: ':99' };
    const page = { evaluate: async () => 'Chrome/147' };
    try {
        const session = await connectPersistentBrowser({ env, chromium: { launchPersistentContext: async () => ({
            newPage: async () => page, pages: () => [page], browser: () => ({}), close: async () => { throw new Error('close failed'); }
        }) } });
        await assert.rejects(session.close(), /close failed/);
        await assert.rejects(connectPersistentBrowser({ env }), { code: 'BROWSER_PROFILE_BUSY' });
    } finally { await fs.rm(profile, { recursive: true, force: true }); }
});
