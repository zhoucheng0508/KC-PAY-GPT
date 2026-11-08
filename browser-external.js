'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readDebugEndpoint(profileDir) {
    let lines;
    try {
        lines = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    } catch (_) {
        throw new Error('无法读取 AdsPower 调试端口，请先在 AdsPower 中打开已配置的环境');
    }
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('AdsPower DevToolsActivePort 中的端口无效');
    }
    return `http://127.0.0.1:${port}`;
}

async function connectExternalBrowser(profileDir, chromium = require('playwright').chromium) {
    const cdpUrl = readDebugEndpoint(profileDir);
    let browser;
    try {
        browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
    } catch (_) {
        throw new Error('无法连接已打开的 AdsPower 环境，请确认环境仍在运行');
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('AdsPower 未提供持久化浏览器上下文');
    const probe = await context.newPage();
    let realUserAgent;
    try {
        realUserAgent = await probe.evaluate(() => navigator.userAgent);
    } finally {
        await probe.close().catch(() => {});
    }
    console.log('[Browser/external] 已接入 AdsPower 现有环境，沿用环境的代理、Cookie 和浏览器配置');
    return { mode: 'external', browser, context, ownsBrowser: false, cdpUrl, realUserAgent };
}

module.exports = { readDebugEndpoint, connectExternalBrowser };
