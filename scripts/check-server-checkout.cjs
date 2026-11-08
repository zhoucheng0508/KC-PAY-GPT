'use strict';

// Standalone, no database and no payment worker: at most one new checkout.
// Credentials are read from a file, never passed on the command line.
const fs = require('node:fs');
const { chromium } = require('playwright');
const { preparePlaywrightProxy } = require('../playwright-proxy');
const { installChatGptSession, resolveSessionInput } = require('../session-auth');
const { openApiCheckout, createHostedCheckoutLink } = require('../chatgpt');

async function main() {
    const raw = fs.readFileSync(process.env.PREFLIGHT_SESSION_FILE || 'session.json', 'utf8');
    const session = resolveSessionInput(raw);
    if (!session?.accessToken) throw new Error('SESSION_ACCESS_TOKEN_REQUIRED');
    let claims;
    try { claims = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url')); } catch (_) {}
    if (claims?.exp && Date.now() >= claims.exp * 1000) throw new Error('SESSION_ACCESS_TOKEN_EXPIRED');
    const transport = process.env.PREFLIGHT_TRANSPORT || 'browser';
    if (!['browser', 'http'].includes(transport)) throw new Error('PREFLIGHT_TRANSPORT must be browser or http');
    if (transport === 'http') {
        const result = await createHostedCheckoutLink({
            accessToken: session.accessToken,
            planType: process.env.PREFLIGHT_PLAN || 'plus',
            country: process.env.PREFLIGHT_COUNTRY || 'PH',
            proxy: process.env.PREFLIGHT_PROXY || ''
        });
        // Do not print upstream response bodies, session URLs or credentials.
        console.log(JSON.stringify({ ok: result.success, stage: 'checkout-api-http',
            code: result.code || null, httpStatus: result.http_status ?? null,
            newCheckoutCreated: result.success && !!result.url, paymentSubmitted: false }));
        if (!result.success) process.exitCode = 1;
        return;
    }
    const proxy = await preparePlaywrightProxy(process.env.PREFLIGHT_PROXY || '');
    let browser;
    let stage = 'browser';
    try {
        browser = await chromium.launch({ headless: true, proxy: proxy.proxyConfig || undefined,
            channel: process.env.PREFLIGHT_CHROMIUM_CHANNEL || undefined,
            args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
        const context = await browser.newContext({ serviceWorkers: 'block' });
        // Only the checkout creation POST is allowed; no payment or tax mutations.
        await context.route('**/*', async route => {
            const req = route.request();
            const url = new URL(req.url());
            if (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) ||
                (req.method() === 'POST' && url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/payments/checkout')) {
                return route.continue();
            }
            return route.abort('blockedbyclient');
        });
        stage = 'session';
        const installed = await installChatGptSession(context, raw, { nativeSession: true, freshContext: true, sessionTransport: 'fetch' });
        if (!installed.cookieVerified) throw new Error('SESSION_REAL_LOGIN_REQUIRED');
        const page = await context.newPage();
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        stage = 'checkout-api';
        const checkout = await openApiCheckout(page, {
            accessToken: installed.sessionData.accessToken,
            planType: process.env.PREFLIGHT_PLAN || 'plus',
            country: process.env.PREFLIGHT_COUNTRY || 'PH',
            verifyPage: false
        });
        console.log(JSON.stringify({ ok: true, stage, newCheckoutCreated: !!checkout.checkoutUrl, paymentSubmitted: false }));
    } catch (error) {
        console.error(JSON.stringify({ ok: false, stage, code: error.code || 'PREFLIGHT_FAILED',
            httpStatus: error.httpStatus || null, message: String(error.message).split(/\r?\n/)[0], paymentSubmitted: false }));
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        await proxy.cleanup();
    }
}

main().catch(error => { console.error(String(error.message).split(/\r?\n/)[0]); process.exitCode = 1; });
