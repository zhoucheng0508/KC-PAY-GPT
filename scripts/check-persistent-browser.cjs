'use strict';

// Server-side headed Chromium under Xvfb. Never imports or executes a payment worker.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { preparePlaywrightProxy } = require('../playwright-proxy');

async function main() {
    const stageLimit = process.env.PERSISTENT_CHECK_STAGE || 'public';
    if (!['public', 'session', 'checkout'].includes(stageLimit)) throw new Error('Invalid PERSISTENT_CHECK_STAGE');
    const checkoutMode = process.env.PERSISTENT_CHECKOUT_MODE || 'official_client';
    if (!['official_client', 'api'].includes(checkoutMode)) throw new Error('Invalid PERSISTENT_CHECKOUT_MODE');
    const profile = process.env.PERSISTENT_PROFILE_DIR;
    if (!profile || !path.isAbsolute(profile)) throw new Error('PERSISTENT_PROFILE_DIR must be an absolute dedicated directory');
    if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('DISPLAY is required; use xvfb-run');
    const proxy = await preparePlaywrightProxy(process.env.PREFLIGHT_PROXY || '');
    let context;
    let page;
    let diagnostics;
    let stage = 'browser';
    const verifyVisible = async (currentPage, required = false, jsonDocument = false) => {
        if (process.env.PERSISTENT_VISIBLE_VERIFICATION !== '1') return;
        const { completeVisibleSiteVerification } = require('../visible-site-verification');
        const result = await completeVisibleSiteVerification(currentPage, { required, jsonDocument });
        if (result.clicked) console.log('[Preflight] 可见验证交互完成，继续校验当前步骤');
    };
    try {
        context = await chromium.launchPersistentContext(profile, {
            headless: false,
            proxy: proxy.proxyConfig || undefined,
            viewport: { width: 1365, height: 900 },
            args: process.platform === 'linux' ? ['--no-sandbox'] : []
        });
        page = context.pages()[0] || await context.newPage();
        diagnostics = require('../browser-request-diagnostics').attachRequestDiagnostics(page, () => stage);
        stage = 'public';
        let status = 0;
        let challenged = false;
        page.on('response', response => {
            if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
            status = response.status();
            challenged = response.headers()['cf-mitigated'] === 'challenge';
        });
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await verifyVisible(page, challenged);
        // Let normal page scripts finish; no verification clicks or solver calls.
        if (challenged) {
            await page.waitForResponse(response => response.request().isNavigationRequest()
                && response.frame() === page.mainFrame() && response.status() === 200
                && response.headers()['cf-mitigated'] !== 'challenge', { timeout: 15000 }).catch(() => {});
        }
        if (challenged || status < 200 || status >= 300 || new URL(page.url()).origin !== 'https://chatgpt.com') {
            const error = new Error(challenged ? 'Human verification is required' : 'Site access failed');
            error.code = challenged ? 'SESSION_HUMAN_VERIFICATION_REQUIRED' : 'SITE_ACCESS_FAILED';
            error.httpStatus = status;
            throw error;
        }
        if (stageLimit !== 'public') {
            stage = 'session';
            const { installChatGptSession } = require('../session-auth');
            const raw = fs.readFileSync(process.env.PREFLIGHT_SESSION_FILE || '/run/secrets/session.json', 'utf8');
            const login = await installChatGptSession(context, raw, { nativeSession: true,
                freshContext: process.env.PREFLIGHT_REPLACE_SESSION === '1',
                sessionTransport: 'fetch', page,
                onVerificationRequired: process.env.PERSISTENT_VISIBLE_VERIFICATION === '1'
                    ? (currentPage, options) => verifyVisible(currentPage, true, options?.jsonDocument === true) : undefined });
            const submitted = JSON.parse(raw);
            const tokenState = token => {
                try {
                    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url'));
                    return { hasExpiry: Number.isFinite(claims.exp), expired: Number.isFinite(claims.exp) ? Date.now() >= claims.exp * 1000 : null };
                } catch (_) { return { hasExpiry: false, expired: null }; }
            };
            console.log(JSON.stringify({ stage: 'session-token-check', sameAsSubmitted: login.sessionData.accessToken === (submitted.accessToken || submitted.access_token),
                submitted: tokenState(submitted.accessToken || submitted.access_token), verified: tokenState(login.sessionData.accessToken) }));
            if (stageLimit === 'checkout') {
                stage = 'checkout';
                const { getRegionConfig } = require('../region-config');
                const country = process.env.PREFLIGHT_COUNTRY || 'PH';
                const currency = getRegionConfig(country)?.currency;
                if (!currency) throw new Error('Unsupported country');
                if (checkoutMode === 'api') {
                    const result = await require('../chatgpt').openApiCheckout(page, {
                        accessToken: login.sessionData.accessToken, planType: process.env.PREFLIGHT_PLAN || 'plus',
                        country, currency, verifyPage: false
                    });
                    console.log(JSON.stringify({ stage: 'checkout-created', newCheckoutCreated: !!result.checkoutUrl, paymentSubmitted: false }));
                    await require('../checkout-preflight').openVerifiedCheckout(page, result, { currency });
                } else {
                const { hasVisibleLoginChrome, isLoginPageContent, waitForLoggedInChatUi } = require('../auth-page-detect');
                await waitForLoggedInChatUi(page, 10000);
                if (login.switched || await hasVisibleLoginChrome(page) || await isLoginPageContent(page)) {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
                    await verifyVisible(page);
                    await waitForLoggedInChatUi(page, 15000);
                }
                if (await hasVisibleLoginChrome(page) || await isLoginPageContent(page)) {
                    throw Object.assign(new Error('真实 Session 有效，但官网客户端仍显示未登录，停止建单'), { code: 'CLIENT_SESSION_NOT_READY' });
                }
                const { createOfficialClientCheckout } = require('../official-client-checkout');
                const result = await createOfficialClientCheckout(page, {
                    planType: process.env.PREFLIGHT_PLAN || 'plus', country, currency,
                    onPricingPage: verifyVisible
                });
                console.log(JSON.stringify({ stage: 'checkout-created', httpStatus: result.httpStatus, newCheckoutCreated: true, paymentSubmitted: false }));
                await require('../checkout-preflight').openVerifiedCheckout(page, result, { currency });
                }
            }
        }
        console.log(JSON.stringify({ ok: true, stage, headless: false, persistent: true, paymentSubmitted: false }));
    } catch (error) {
        console.error(JSON.stringify({ ok: false, stage, code: error.code || 'PERSISTENT_PREFLIGHT_FAILED',
            httpStatus: error.httpStatus || null,
            message: String(error.message).split(/\r?\n/)[0].replace(/https?:\/\/\S+/g, '[URL]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[TOKEN]'),
            paymentSubmitted: false }));
        process.exitCode = 1;
    } finally {
        if (diagnostics) {
            console.log(JSON.stringify({ diagnosticEvents: diagnostics.events }));
            diagnostics.detach();
        }
        // Session JSON documents contain credentials and must never be screenshotted.
        const isSessionDocument = page && (() => { try { return new URL(page.url()).pathname === '/api/auth/session'; } catch (_) { return true; } })();
        if (page && !isSessionDocument && process.env.PREFLIGHT_ARTIFACT_DIR) {
            fs.mkdirSync(process.env.PREFLIGHT_ARTIFACT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.PREFLIGHT_ARTIFACT_DIR, `${stage}.png`) }).catch(() => {});
        }
        if (context) await context.close();
        await proxy.cleanup();
    }
}
main().catch(() => { console.error('Persistent browser configuration failed'); process.exitCode = 1; });
