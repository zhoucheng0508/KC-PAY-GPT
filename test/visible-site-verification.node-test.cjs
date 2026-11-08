'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeVisibleSiteVerification } = require('../visible-site-verification');
function fixture({ fails = false, width = 300, origin = 'https://chatgpt.com/' } = {}) {
    let title = 'Just a moment...';
    let clicks = 0;
    return {
        clicks: () => clicks,
        title: async () => title,
        url: () => origin,
        frames: () => [{ url: () => 'https://challenges.cloudflare.com/widget', frameElement: async () => ({ boundingBox: async () => ({ x: 100, y: 100, width, height: 65 }) }) }],
        mouse: { click: async (x, y) => { assert.equal(x, 121); assert.equal(y, 132.5); clicks++; } },
        waitForResponse: async () => fails ? null : {},
        waitForTimeout: async () => {},
        waitForFunction: async () => { if (!fails) title = 'ChatGPT'; }
    };
}
test('performs one normal visible click and checks the resulting page', async () => {
    const page = fixture();
    assert.equal((await completeVisibleSiteVerification(page)).clicked, true);
    assert.equal(page.clicks(), 1);
});
test('stops after one failed verification without retrying', async () => {
    const page = fixture({ fails: true });
    await assert.rejects(completeVisibleSiteVerification(page), { code: 'SESSION_HUMAN_VERIFICATION_REQUIRED' });
    assert.equal(page.clicks(), 1);
});
test('does not click an unknown widget shape or another origin', async () => {
    for (const options of [{ width: 600 }, { origin: 'https://example.test/' }]) {
        const page = fixture(options);
        await assert.rejects(completeVisibleSiteVerification(page, { timeout: 5 }));
        assert.equal(page.clicks(), 0);
    }
});
test('normal pages require no interaction', async () => {
    assert.deepEqual(await completeVisibleSiteVerification({ title: async () => 'ChatGPT' }), { required: false });
});

test('waits for a collapsed iframe to expand before clicking', async () => {
    const page = fixture();
    let boxes = 0;
    page.frames = () => [{ url: () => 'https://challenges.cloudflare.com/widget', frameElement: async () => ({
        boundingBox: async () => ({ x: 100, y: 100, width: 300, height: ++boxes === 1 ? 0 : 65 })
    }) }];
    assert.equal((await completeVisibleSiteVerification(page)).clicked, true);
    assert.equal(boxes, 2);
});
