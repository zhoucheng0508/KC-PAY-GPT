'use strict';

/**
 * 浏览器运行时调度：按模式选择独立启动或池 CDP 接入，两套实现互不影响。
 */

const { connectStandaloneBrowser } = require('./browser-standalone');
const { connectPoolBrowser } = require('./browser-pool-client');

function resolveBrowserRuntimeMode(env = process.env) {
    const explicit = String(env.BROWSER_RUNTIME_MODE || '').trim().toLowerCase();
    if (explicit === 'pool' || explicit === 'standalone' || explicit === 'external' || explicit === 'persistent') {
        return explicit;
    }
    const poolCdpUrl = String(env.BROWSER_POOL_CDP_URL || '').trim();
    if (env.BROWSER_POOL === '1' && poolCdpUrl) {
        return 'pool';
    }
    return 'standalone';
}

async function getTaskBrowserProxy(store, env = process.env) {
    if (resolveExternalProfileDir(env)) return '';
    if (String(env.BROWSER_PROXY_MODE || '').toLowerCase() === 'direct') return '';
    if (String(env.BROWSER_PROXY_MODE || '').toLowerCase() === 'environment') {
        const proxy = String(env.PROXY || '').trim();
        if (!proxy) throw new Error('environment 代理模式缺少 PROXY，已停止以避免意外直连');
        return proxy;
    }
    return store.getActiveProxy();
}

function resolveExternalProfileDir(env = process.env) {
    if (resolveBrowserRuntimeMode(env) === 'persistent') return '';
    if (resolveBrowserRuntimeMode(env) === 'external') {
        const profile = String(env.BROWSER_EXTERNAL_CDP_PROFILE_DIR || '').trim();
        if (!profile) throw new Error('external 浏览器模式缺少 BROWSER_EXTERNAL_CDP_PROFILE_DIR');
        return profile;
    }
    return env.CHECKOUT_DEBUG_ONLY === '1' ? String(env.CHECKOUT_DEBUG_CDP_PROFILE_DIR || '').trim() : '';
}

const externalLeases = new Set();
async function withExternalBrowserLease(profileDir, run) {
    const key = require('node:path').resolve(profileDir).toLowerCase();
    if (externalLeases.has(key)) throw new Error('AdsPower 环境正在执行其他任务，请等待当前任务结束');
    externalLeases.add(key);
    try { return await run(); }
    finally { externalLeases.delete(key); }
}

/**
 * 子进程连接浏览器（由 server 注入 BROWSER_RUNTIME_MODE / 池 CDP 环境变量）
 */
async function connectTaskBrowser(options = {}) {
    const env = options.env || process.env;
    const externalProfile = resolveExternalProfileDir(env);
    if (externalProfile) {
        return require('./browser-external').connectExternalBrowser(externalProfile);
    }
    const mode = resolveBrowserRuntimeMode(env);
    if (mode === 'persistent') {
        return require('./browser-persistent').connectPersistentBrowser({ ...options, env });
    }

    if (mode === 'pool') {
        return connectPoolBrowser({
            poolCdpUrl: env.BROWSER_POOL_CDP_URL,
            poolSlotId: env.BROWSER_POOL_SLOT
        });
    }

    return connectStandaloneBrowser({
        proxyConfig: options.proxyConfig,
        headful: options.headful,
        chromiumChannel: options.chromiumChannel || env.CHROMIUM_CHANNEL,
        cdpPort: env.CDP_PORT
    });
}

function applyCdpEnv(session) {
    if (!session?.cdpUrl) {
        return;
    }
    process.env.CDP_URL = session.cdpUrl;
    if (session.cdpPort) {
        process.env.CDP_PORT = String(session.cdpPort);
    }
}

async function closeTaskBrowser(session, browser) {
    if (session?.mode === 'persistent') {
        await session.close();
        return;
    }
    if (!browser) {
        return;
    }
    if (session?.mode === 'external') {
        console.log('[Browser/external] 已保留 AdsPower 环境和原有标签页');
        return;
    }
    if (session?.ownsBrowser) {
        await browser.close().catch(() => {});
        return;
    }
    console.log('♻️ [Browser/pool] 任务 context 已关闭，槽位归还（Chromium 保持常驻）');
}

function buildWorkerRuntimeEnv(baseEnv, slot, mode) {
    if (mode === 'pool' && slot) {
        return {
            ...baseEnv,
            BROWSER_RUNTIME_MODE: 'pool',
            BROWSER_POOL: '1',
            BROWSER_POOL_SLOT: String(slot.slotId),
            BROWSER_POOL_CDP_URL: slot.cdpUrl,
            CDP_URL: slot.cdpUrl,
            CDP_PORT: String(slot.port)
        };
    }
    return {
        ...baseEnv,
        BROWSER_RUNTIME_MODE: mode === 'persistent' ? 'persistent' : 'standalone',
        BROWSER_POOL: '0',
        BROWSER_POOL_CDP_URL: '',
        BROWSER_POOL_SLOT: ''
    };
}

module.exports = {
    resolveBrowserRuntimeMode,
    getTaskBrowserProxy,
    connectTaskBrowser,
    applyCdpEnv,
    closeTaskBrowser,
    buildWorkerRuntimeEnv,
    resolveExternalProfileDir,
    withExternalBrowserLease
};
