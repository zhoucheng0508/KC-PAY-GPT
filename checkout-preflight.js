'use strict';

const { discoverCardInputs, readCheckoutDueAmount } = require('./stripe-payment');
const { isCloudflareWallPage, isBlockingHumanVerificationVisible, clearHumanVerification } = require('./human-verification');
const { isCheckoutLoginGate, hasVisibleLoginChrome } = require('./auth-page-detect');

async function waitForCheckoutForm(page, { currency, timeout = 60000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
            throw new Error('Checkout 登录状态失效，请在当前 AdsPower 环境重新登录');
        }
        if (await isCloudflareWallPage(page) || await isBlockingHumanVerificationVisible(page)) {
            const result = await clearHumanVerification(page, { manualOnly: true, requireCheckoutReady: false, phase: 'checkout-preflight', maxWaitMs: Math.max(1, deadline - Date.now()) });
            if (!result.cleared) throw new Error('等待人工验证超时：请在保留的 AdsPower 任务页检查');
            continue;
        }
        const inputs = await discoverCardInputs(page, Math.min(1500, Math.max(1, deadline - Date.now())));
        if (inputs?.card && inputs.expiry && inputs.cvc) {
            const due = await readCheckoutDueAmount(page);
            if (due && due.currency !== currency) throw new Error(`金额校验失败：应付币种 ${due.currency} 与任务 ${currency} 不一致`);
            if (due && Number.isFinite(due.amount) && due.amount > 0) {
                return { cardFieldsReady: true, amount: due.amount, currency: due.currency };
            }
        }
        await page.waitForTimeout(500);
    }
    throw new Error('Checkout 支付表单或应付金额未就绪，停止后续支付');
}

async function openVerifiedCheckout(page, checkout, { currency, timeout = 60000 } = {}) {
    const url = new URL(checkout.checkoutUrl);
    if (url.protocol !== 'https:' || !['chatgpt.com', 'pay.openai.com', 'checkout.stripe.com'].includes(url.hostname)) {
        throw new Error('Checkout API 返回了不受支持的支付页地址');
    }
    if (page.url().split('?')[0] !== url.href.split('?')[0]) {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
    } else {
        await page.waitForLoadState('domcontentloaded', { timeout });
    }
    const readiness = await waitForCheckoutForm(page, { currency, timeout });
    const current = new URL(page.url());
    if (current.protocol !== 'https:' || !['chatgpt.com', 'pay.openai.com', 'checkout.stripe.com'].includes(current.hostname)) {
        throw new Error('Checkout 跳转到了非支付站点，停止后续支付');
    }
    if (checkout.sessionId && !current.pathname.includes(checkout.sessionId)) {
        throw new Error('Checkout 页面与本次新建会话不一致，停止后续支付');
    }
    console.log(`[Checkout] 表单就绪，当前应付 ${readiness.currency} ${readiness.amount}`);
    return readiness;
}

module.exports = { openVerifiedCheckout, waitForCheckoutForm };
