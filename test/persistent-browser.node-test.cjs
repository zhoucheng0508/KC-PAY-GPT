'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

test('headed Chromium preserves cookies and local storage after a full restart', {
    skip: process.platform !== 'linux' || !process.env.DISPLAY
}, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-browser-test-'));
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Local persistence test</title>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let context;
    try {
        const options = { headless: false, args: ['--no-sandbox'] };
        context = await chromium.launchPersistentContext(dir, options);
        const page = context.pages()[0];
        await page.goto(origin);
        await page.evaluate(() => localStorage.setItem('persistence-test', 'saved'));
        await context.addCookies([{ name: 'persistence-test', value: 'saved', url: origin, expires: Math.floor(Date.now()/1000)+3600 }]);
        await context.close();
        context = await chromium.launchPersistentContext(dir, options);
        const restored = context.pages()[0];
        await restored.goto(origin);
        assert.equal(await restored.evaluate(() => localStorage.getItem('persistence-test')), 'saved');
        assert.equal((await context.cookies(origin)).find(c => c.name === 'persistence-test')?.value, 'saved');
    } finally {
        await context?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(dir, { recursive: true, force: true });
    }
});
