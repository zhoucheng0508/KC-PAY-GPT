'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const outcome of ['ready', 'not-ready', 'challenge']) {
    test(`formal index worker: ${outcome} never reaches payment or database and closes browser`, async () => {
        const messages = [];
        let closed = 0;
        let paid = 0;
        let dbCalls = 0;
        let orders = 0;
        const page = { on() {}, isClosed: () => false, url: () => 'https://chatgpt.com/checkout/test', screenshot: async () => {} };
        const context = { pages: () => [page] };
        const modules = {
            './payment-retry': { executePaymentWithRetry: async () => { paid++; throw new Error('payment forbidden'); } },
            './pricing-checkout': {}, './chatgpt': {}, './checkout-api-policy': {},
            './mysql-store': new Proxy({}, { get: () => () => { dbCalls++; throw new Error('database forbidden'); } }),
            './region-config': { getRegionConfig: () => ({ currency: 'PHP' }), getRegionBrowserProfile: () => ({}) },
            './session-auth': {},
            './browser-runtime': { connectTaskBrowser: async () => ({ mode: 'persistent', browser: {}, context, page, realUserAgent: 'Chrome/147' }),
                applyCdpEnv() {}, closeTaskBrowser: async () => { closed++; } },
            './playwright-proxy': { preparePlaywrightProxy: async () => ({ cleanup: async () => {} }) },
            './server-session': { prepareServerSession: async () => {
                if (outcome === 'challenge') throw new Error('verification required');
                return { sessionData: { user: { email: 'test@example.test' } }, cookieVerified: true };
            }, verifyServerPage: async () => {} },
            './official-client-checkout': { createOfficialClientCheckout: async () => { orders++; return { checkoutUrl: page.url() }; } },
            './checkout-preflight': { openVerifiedCheckout: async () => ({ cardFieldsReady: outcome === 'ready' }) },
            fs: { mkdirSync() {} }, path
        };
        const processStub = { env: { BROWSER_RUNTIME_MODE: 'persistent', CHECKOUT_MODE: 'official_client', PAYMENT_PREFLIGHT_ONLY: '1',
            RECORD_VIDEO: '0', PAYMENT_REGION_OVERRIDE: 'PH', CHATGPT_SESSION_JSON: '{}' }, exitCode: 0 };
        const log = (...args) => messages.push(args.join(' '));
        await vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8'), {
            require: name => { if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`); return modules[name]; },
            process: processStub, __dirname: path.resolve(__dirname, '..'), URL,
            console: { log, warn: log, error: log }, setTimeout: () => ({ unref() {} })
        });
        assert.equal(paid, 0);
        assert.equal(dbCalls, 0);
        assert.equal(closed, 1);
        assert.equal(orders, outcome === 'challenge' ? 0 : 1);
        assert.equal(processStub.exitCode, outcome === 'ready' ? 0 : 1);
        assert.equal(messages.includes('CHECKOUT_PREFLIGHT_READY'), outcome === 'ready');
    });
}
