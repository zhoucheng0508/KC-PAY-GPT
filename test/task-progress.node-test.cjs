'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

test('HTTP fallback displays failure and unlocks retry when WebSocket never connects', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        let polls = 0;
        await page.addInitScript(() => {
            window.lucide = { createIcons() {} };
            window.WebSocket = class {
                static CONNECTING = 0;
                static OPEN = 1;
                readyState = 0;
                send() { throw new Error('Cannot send while connecting'); }
                close() {}
            };
        });
        await page.route('**/*', async route => {
            if (route.request().url().endsWith('/api/task-status')) {
                polls++;
                assert.deepEqual(route.request().postDataJSON(), { jobKey: 'fixture-job', cdk: 'fixture-cdk' });
                return route.fulfill({ json: { success: true, data: { type: 'snapshot', jobKey: 'fixture-job', status: 'failed', progress: 0, message: '账号不一致，请重新复制 Session' } } });
            }
            if (route.request().url() === 'http://fixture.test/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8') });
            return route.fulfill({ body: '' });
        });
        await page.goto('http://fixture.test/');
        await page.evaluate(() => {
            verifiedCdk = 'fixture-cdk';
            taskCompleted = false;
            setActivationLock(true);
            initWebSocket('fixture-job');
            initWebSocket('fixture-job');
        });
        await page.waitForFunction(() => taskCompleted);
        assert.equal(await page.locator('#startBtn').isDisabled(), false);
        assert.ok((await page.locator('#statusMessage').innerText()).includes('账号不一致'));
        assert.equal(await page.evaluate(() => pollingJobKey), '');
        assert.equal(polls, 1);
    } finally { await browser.close(); }
});
