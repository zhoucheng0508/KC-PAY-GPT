'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// An atomic directory lock also protects workers in separate processes/containers.
// Never steal a stale lock automatically: an operator must confirm the old browser stopped.
async function connectPersistentBrowser({ env = process.env, proxyConfig, chromium } = {}) {
    const profile = env.PERSISTENT_PROFILE_DIR;
    if (!profile || !path.isAbsolute(profile)) throw new Error('PERSISTENT_PROFILE_DIR 必须是独立目录的绝对路径');
    if (process.platform === 'linux' && !env.DISPLAY) throw new Error('persistent 模式需要 xvfb-run / DISPLAY');
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    const lock = path.join(profile, '.task-lock');
    try { await fs.mkdir(lock); }
    catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(new Error('持久化浏览器目录正在使用或上次异常退出；确认旧进程停止后才能解除 .task-lock'), { code: 'BROWSER_PROFILE_BUSY' });
        throw error;
    }
    let context;
    let closed = false;
    const close = async () => {
        if (closed) return;
        // Keep the lock if Chromium cannot be closed safely.
        if (context) await context.close();
        await fs.rmdir(lock);
        closed = true;
    };
    try {
        context = await (chromium || require('playwright').chromium).launchPersistentContext(profile, {
            headless: false, proxy: proxyConfig || undefined,
            viewport: { width: 1365, height: 900 },
            args: process.platform === 'linux' ? ['--no-sandbox'] : []
        });
        // Old checkout pages must not be reused by a later task.
        const page = await context.newPage();
        for (const old of context.pages()) if (old !== page) await old.close();
        const realUserAgent = await page.evaluate(() => navigator.userAgent);
        return { mode: 'persistent', browser: context.browser(), context, page, realUserAgent, ownsBrowser: true, close };
    } catch (error) {
        await close();
        throw error;
    }
}
module.exports = { connectPersistentBrowser };
