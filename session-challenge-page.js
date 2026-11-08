'use strict';

const SESSION_URL = 'https://chatgpt.com/api/auth/session';

// Display a challenged GET in the same browser. Only real network responses
// for this exact endpoint may establish the result; never retry payment POSTs.
async function openSessionChallenge(page, onChallenge) {
    let latest;
    const observe = response => {
        if (response.url().split('?')[0] === SESSION_URL
            && response.request().isNavigationRequest() && response.frame() === page.mainFrame()) latest = response;
    };
    page.on('response', observe);
    try {
        const initial = await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!latest) latest = initial;
        if (latest?.headers?.()['cf-mitigated'] === 'challenge') {
            await onChallenge(page, { jsonDocument: true });
        }
        if (page.url().split('?')[0] !== SESSION_URL) {
            throw Object.assign(new Error('Session 验证跳转离开认证端点'), { code: 'SESSION_LOGIN_REQUIRED' });
        }
        return latest;
    } finally {
        page.off('response', observe);
    }
}

module.exports = { openSessionChallenge };
