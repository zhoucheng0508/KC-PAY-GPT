'use strict';
// Explicit review entry: never submits a payment or consumes a CDK.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const input = process.argv[2] || process.env.PREFLIGHT_SESSION_FILE;
if (!input) throw new Error('Usage: npm run review:external -- /absolute/path/to/session.json');
const raw = fs.readFileSync(path.resolve(input), 'utf8').replace(/^\uFEFF/, '');
JSON.parse(raw);
const child = spawn(process.execPath, [path.join(root, 'index.js')], { cwd: root, stdio: 'inherit', env: {
    ...process.env,
    DB_HOST: process.env.LOCAL_DB_HOST || '127.0.0.1', DB_PORT: process.env.LOCAL_DB_PORT || '3310',
    BROWSER_RUNTIME_MODE: 'external', CHECKOUT_MODE: 'official_client',
    PAYMENT_REVIEW_ONLY: '1', PAYMENT_PREFLIGHT_ONLY: '0', CHECKOUT_DEBUG_ONLY: '0',
    RECORD_VIDEO: '0', CHECKOUT_API_UI_FALLBACK: '0',
    CHATGPT_SESSION_JSON: raw, CHATGPT_TOKEN: '', CHATGPT_SESSION_COOKIE: '', CHATGPT_SESSION_TOKEN: '',
    CDK_CODE: '', CDK_PLAN_TYPE: process.env.PREFLIGHT_PLAN || 'plus', PLAN_NAME_OVERRIDE: '', ACTIVATION_EMAIL: '',
    PAYMENT_REGION_OVERRIDE: process.env.PREFLIGHT_COUNTRY || 'PH',
    PROXY: '', BROWSER_PROXY_MODE: 'direct', HUMAN_VERIFICATION_MODE: 'manual'
} });
child.on('error', () => { console.error('Review worker failed to start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
