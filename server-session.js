'use strict';
const { installChatGptSession } = require('./session-auth');
const { completeVisibleSiteVerification } = require('./visible-site-verification');
const { hasVisibleLoginChrome, isLoginPageContent, waitForLoggedInChatUi } = require('./auth-page-detect');

async function verifyServerPage(page, required = false, jsonDocument = false) {
    const result = await completeVisibleSiteVerification(page, { required, jsonDocument, timeout: 30000 });
    if (result.clicked) console.log('[Server browser] 正常验证交互后已收到官网成功响应');
    return result;
}

async function prepareServerSession(context, page, raw) {
    const response = await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const challenged = response?.headers()['cf-mitigated'] === 'challenge';
    await verifyServerPage(page, challenged);
    if (!challenged && (!response || !response.ok())) {
        throw Object.assign(new Error('官网访问失败'), { code: 'SITE_ACCESS_FAILED', httpStatus: response?.status() });
    }
    const login = await installChatGptSession(context, raw, {
        nativeSession: true, freshContext: true, sessionTransport: 'fetch', page,
        onVerificationRequired: (currentPage, options) => verifyServerPage(currentPage, true, options?.jsonDocument === true)
    });
    // Refresh the actual website client after installing the supplied credentials.
    const home = await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await verifyServerPage(page, home?.headers()['cf-mitigated'] === 'challenge');
    const ready = await waitForLoggedInChatUi(page, 15000);
    if (!ready || await hasVisibleLoginChrome(page) || await isLoginPageContent(page)) {
        throw Object.assign(new Error('真实 Session 已校验，但官网客户端未确认登录，停止建单'), { code: 'CLIENT_SESSION_NOT_READY' });
    }
    return login;
}
module.exports = { prepareServerSession, verifyServerPage };
