'use strict';

// Native Windows browser; reuse the existing Docker MySQL via its published port.
const path = require('node:path');
const fs = require('node:fs');
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

Object.assign(process.env, {
    PORT: process.env.LOCAL_PORT || '3000',
    DB_HOST: process.env.LOCAL_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.LOCAL_DB_PORT || '3310',
    HEADFUL: '1',
    CHROMIUM_CHANNEL: process.env.LOCAL_CHROMIUM_CHANNEL || 'chrome',
    BROWSER_POOL: '0',
    BROWSER_RUNTIME_MODE: process.env.BROWSER_RUNTIME_MODE === 'external' ? 'external' : 'standalone',
    BROWSER_POOL_CDP_URL: '',
    BROWSER_POOL_SLOT: '',
    BROWSER_PROXY_MODE: 'direct',
    PROXY: ''
});

console.log(process.env.BROWSER_RUNTIME_MODE === 'external' ? '[Local] 接入 AdsPower / 代理沿用环境配置' : '[Local] 本机 Chrome / 有头模式 / 不配置任务代理 / 独立浏览器');
require('../server');
