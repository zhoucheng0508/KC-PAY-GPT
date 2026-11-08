'use strict';

const challengeTitle = /just a moment|verify.*human|请稍候|請稍候/i;

// Only the standard visible checkbox UI, once per call. Never solves image
// challenges or supplies/changes security tokens. Used by the persistent runtime.
async function completeVisibleSiteVerification(page, { timeout = 20000, required = false, jsonDocument = false } = {}) {
    if (!required && !challengeTitle.test(await page.title())) {
        // Navigation can briefly expose an empty title before the challenge UI mounts.
        if (!(await page.title()).trim()) await page.waitForFunction(() => !!document.title.trim(), null, { timeout: 5000 }).catch(() => {});
        if (!challengeTitle.test(await page.title())) return { required: false };
    }
    const fail = (reason = 'unexpected-page') => Object.assign(new Error(`可见验证未通过，已停止后续操作 (${reason})`), { code: 'SESSION_HUMAN_VERIFICATION_REQUIRED' });
    if (new URL(page.url()).origin !== 'https://chatgpt.com') throw fail();
    const deadline = Date.now() + timeout;
    let box;
    const supportedBox = candidate => candidate && candidate.width >= 280 && candidate.width <= 320
        && candidate.height >= 55 && candidate.height <= 90;
    while (Date.now() < deadline) {
        const frame = page.frames().find(item => {
            try { return new URL(item.url()).hostname === 'challenges.cloudflare.com'; } catch (_) { return false; }
        });
        if (frame) box = await (await frame.frameElement()).boundingBox().catch(() => null);
        if (supportedBox(box)) break;
        await page.waitForTimeout(250);
    }
    if (!supportedBox(box)) throw fail('widget-not-ready');
    // The frame reaches its final size before its interactive contents finish
    // loading. Do not send the single allowed click during that transition.
    await page.waitForTimeout(2000);
    const navigation = page.waitForResponse(response => response.request().isNavigationRequest()
        && response.frame() === page.mainFrame() && new URL(response.url()).origin === 'https://chatgpt.com'
        && response.status() === 200 && response.headers()['cf-mitigated'] !== 'challenge', { timeout }).catch(() => null);
    await page.mouse.click(box.x + 21, box.y + box.height / 2);
    const completed = await navigation;
    if (!completed) throw fail('no-success-response-after-click');
    if (jsonDocument && page.url().split('?')[0] === 'https://chatgpt.com/api/auth/session'
        && /application\/json/i.test(completed.headers()['content-type'] || '')) {
        return { required: true, clicked: true }; // Caller still validates actual Session JSON.
    }
    await page.waitForFunction(() => document.readyState !== 'loading' && !!document.title.trim()
        && !/just a moment|verify.*human|请稍候|請稍候/i.test(document.title), null, { timeout }).catch(() => {});
    if (!(await page.title()).trim() || challengeTitle.test(await page.title()) || new URL(page.url()).origin !== 'https://chatgpt.com') throw fail();
    return { required: true, clicked: true };
}

module.exports = { completeVisibleSiteVerification };
