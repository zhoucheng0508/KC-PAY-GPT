'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { getTaskBrowserProxy, resolveBrowserRuntimeMode, buildWorkerRuntimeEnv, resolveExternalProfileDir, withExternalBrowserLease } = require('../browser-runtime');

it('direct browser mode never reads or rotates a configured database proxy', async () => {
    const store = { getActiveProxy: () => { throw new Error('proxy must not be selected'); } };
    assert.equal(await getTaskBrowserProxy(store, { BROWSER_PROXY_MODE: 'direct' }), '');
});

it('default browser mode preserves the configured proxy selection', async () => {
    assert.equal(await getTaskBrowserProxy({ getActiveProxy: async () => 'http://proxy.test' }, {}), 'http://proxy.test');
});

it('environment proxy is explicit and does not fall back to a database proxy or direct access', async () => {
    const store = { getActiveProxy: () => { throw new Error('must not select database proxy'); } };
    assert.equal(await getTaskBrowserProxy(store, { BROWSER_PROXY_MODE: 'environment', PROXY: 'http://mihomo:7890' }), 'http://mihomo:7890');
    await assert.rejects(getTaskBrowserProxy(store, { BROWSER_PROXY_MODE: 'environment' }), /缺少 PROXY/);
});

it('explicit standalone mode overrides inherited pool connection settings', () => {
    assert.equal(resolveBrowserRuntimeMode({ BROWSER_RUNTIME_MODE: 'standalone', BROWSER_POOL: '1', BROWSER_POOL_CDP_URL: 'http://pool.test' }), 'standalone');
    const env = buildWorkerRuntimeEnv({ CHROMIUM_CHANNEL: 'chrome', HEADFUL: '1', BROWSER_PROXY_MODE: 'direct' }, null, 'standalone');
    assert.equal(env.BROWSER_POOL, '0');
    assert.equal(env.BROWSER_POOL_CDP_URL, '');
    assert.equal(env.CHROMIUM_CHANNEL, 'chrome');
    assert.equal(env.BROWSER_PROXY_MODE, 'direct');
});

it('formal external tasks use the configured persistent profile without selecting a database proxy', async () => {
    const env = { BROWSER_RUNTIME_MODE: 'external', BROWSER_EXTERNAL_CDP_PROFILE_DIR: 'C:/profile', BROWSER_POOL: '1', BROWSER_POOL_CDP_URL: 'http://pool.test' };
    assert.equal(resolveBrowserRuntimeMode(env), 'external');
    assert.equal(resolveExternalProfileDir(env), 'C:/profile');
    assert.equal(await getTaskBrowserProxy({ getActiveProxy: () => { throw new Error('must not rotate proxy'); } }, env), '');
    assert.throws(() => resolveExternalProfileDir({ BROWSER_RUNTIME_MODE: 'external' }), /缺少/);
    assert.equal(resolveExternalProfileDir({ CHECKOUT_DEBUG_ONLY: '1', CHECKOUT_DEBUG_CDP_PROFILE_DIR: 'C:/legacy' }), 'C:/legacy');
});

it('debug and formal tasks cannot share an active profile and leases release on failure', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const first = withExternalBrowserLease('C:/same-profile', () => pending);
    await assert.rejects(withExternalBrowserLease('C:/same-profile', async () => {}), /正在执行其他任务/);
    release();
    await first;
    await assert.rejects(withExternalBrowserLease('C:/same-profile', async () => { throw new Error('worker failed'); }), /worker failed/);
    assert.equal(await withExternalBrowserLease('C:/same-profile', async () => 'released'), 'released');
});
