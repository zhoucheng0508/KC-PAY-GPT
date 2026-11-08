'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const raw = fs.readFileSync(process.env.PREFLIGHT_SESSION_FILE || path.resolve(__dirname, '../session.json'), 'utf8');
JSON.parse(raw);
const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js')], {
    stdio: 'inherit', env: {
        ...process.env, BROWSER_RUNTIME_MODE: 'persistent', CHECKOUT_MODE: 'official_client',
        PAYMENT_PREFLIGHT_ONLY: '0', CHECKOUT_DEBUG_ONLY: '0', PAYMENT_REVIEW_ONLY: '1',
        CHECKOUT_API_UI_FALLBACK: '0', RECORD_VIDEO: '0',
        CHATGPT_SESSION_JSON: raw, CHATGPT_TOKEN: '', CHATGPT_SESSION_COOKIE: '', CHATGPT_SESSION_TOKEN: '',
        CDK_CODE: '', ACTIVATION_EMAIL: '', PLAN_NAME_OVERRIDE: '',
        PAYMENT_REGION_OVERRIDE: process.env.PREFLIGHT_COUNTRY || 'PH', CDK_PLAN_TYPE: process.env.PREFLIGHT_PLAN || 'plus',
        BROWSER_PROXY_MODE: process.env.PREFLIGHT_PROXY ? 'environment' : 'direct', PROXY: process.env.PREFLIGHT_PROXY || ''
    }
});
child.on('error', () => { console.error('Review worker failed to start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
