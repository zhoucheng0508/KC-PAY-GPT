'use strict';

const { selectPricingRegion } = require('./pricing-checkout');
const { ChatGPTService, formatApiErrorDetail } = require('./chatgpt');
const OFFICIAL_PLANS = Object.freeze({
    plus: { name: 'chatgptplusplan', title: /^Plus$|^ChatGPT Plus$/ },
    pro_5x: { name: 'chatgptprolite', title: /^Pro$|^ChatGPT Pro$/, tier: /Standard|标准/i },
    pro_20x: { name: 'chatgptpro', title: /^Pro$|^ChatGPT Pro$/, tier: /More usage|更多用量/i }
});

async function createOfficialClientCheckout(page, { planType = 'plus', country = 'PH', currency = 'PHP', timeout = 60000, onPricingPage } = {}) {
    const plan = OFFICIAL_PLANS[planType];
    if (!plan) throw new Error('官网客户端不支持此套餐');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable', { maxPostDataSize: 65536 });
    let observedPayload;
    let observedUpdate;
    const requests = [];
    let responseObserved = false;
    cdp.on('Network.requestWillBeSent', event => {
        if (event.request.method !== 'POST' || !['https://chatgpt.com/backend-api/payments/checkout', 'https://chatgpt.com/backend-api/payments/checkout/update'].includes(event.request.url.split('?')[0])) return;
        requests.push((async () => {
            const body = event.request.postData || (await cdp.send('Network.getRequestPostData', { requestId: event.requestId })).postData;
            if (event.request.url.split('?')[0].endsWith('/update')) observedUpdate = JSON.parse(body);
            else observedPayload = JSON.parse(body);
        })().catch(() => {}));
    });
    // Register before clicking; an existing tab/URL can never satisfy this observer.
    let timer;
    let listener;
    const responsePromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('官网客户端未返回本次 Checkout API 响应')), timeout);
        listener = response => {
            const request = response.request();
            if (request.method() !== 'POST' || response.url().split('?')[0] !== 'https://chatgpt.com/backend-api/payments/checkout') return;
            responseObserved = true;
            resolve(response);
        };
        page.on('response', listener);
    });
    // Attach a rejection handler immediately, including when clicking itself fails.
    responsePromise.catch(() => {});
    try {
        // Observe before navigation: mobile clients can start a new checkout
        // while the pricing modal is still being initialized or switched.
        const action = (async () => {
            await page.goto('https://chatgpt.com/#pricing', { waitUntil: 'domcontentloaded', timeout });
            if (onPricingPage && !responseObserved) await onPricingPage(page);
            if (responseObserved) return;
            const dialog = page.locator('[role="dialog"]:visible').first();
            // Same-document #pricing navigation is not consistently handled by
            // an already hydrated client. Open its visible Upgrade control once.
            await Promise.race([dialog.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) }).catch(() => {}), responsePromise]);
            if (responseObserved) return;
            if (!await dialog.isVisible()) {
                const upgrade = page.getByRole('button', { name: /^Upgrade$|^升级$/i }).first();
                await Promise.race([upgrade.click({ timeout: 10000 }), responsePromise]);
                if (responseObserved) return;
                // Some clients open the account menu first.
                const upgradePlan = page.getByText(/^Upgrade plan$|^升级套餐$/i).first();
                await Promise.race([dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {}), responsePromise]);
                if (responseObserved) return;
                if (!await dialog.isVisible() && await upgradePlan.isVisible()) {
                    await Promise.race([upgradePlan.click({ timeout: 10000 }), responsePromise]);
                }
            }
            if (responseObserved) return;
            await Promise.race([dialog.waitFor({ state: 'visible', timeout }), responsePromise]);
            if (responseObserved) return;
            await Promise.race([page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}), responsePromise]);
            if (responseObserved) return;
            const personal = dialog.locator('button').filter({ hasText: /^Personal$|^个人$/ }).first();
            let title = dialog.getByText(plan.title).first();
            if (!await title.isVisible() && await personal.count() && await personal.getAttribute('aria-checked') !== 'true') {
                await Promise.race([personal.press('Enter', { timeout: 10000 }), responsePromise]);
            }
            if (responseObserved) return;
            if (plan.tier && !await title.isVisible()) {
                const all = dialog.getByRole('button', { name: /^See all plans$|查看所有套餐/ });
                if (await all.count()) await all.press('Enter', { timeout: 10000 });
            }
            await Promise.race([title.waitFor({ state: 'visible', timeout: 15000 }), responsePromise]);
            if (responseObserved) return;
            await selectPricingRegion(page, country);
            if (responseObserved) return;
            const card = title.locator('xpath=ancestor::div[.//button[normalize-space()="Buy now" or normalize-space()="Get started" or normalize-space()="Rejoin Plus" or contains(.,"Upgrade") or contains(.,"升级")]][1]');
            const button = card.getByRole('button', { name: /^Buy now$|^Get started$|^Rejoin Plus$|Upgrade|升级|Subscribe|Get Plus/i });
            if (await button.count() !== 1) throw new Error(`无法唯一确认 ${planType} 建单按钮，未点击`);
            await Promise.race([button.press('Enter', { timeout: 10000 }), responsePromise]);
        })();
        action.catch(() => {});
        await Promise.race([action, responsePromise]);
        const response = await responsePromise;
        await Promise.all(requests);
        const payload = response.request().postDataJSON() || observedPayload;
        const acceptableInitialPlan = payload?.plan_name === plan.name || (plan.tier && ['chatgptprolite', 'chatgptpro', 'chatgptpromax'].includes(payload?.plan_name));
        if (!acceptableInitialPlan || payload?.billing_details?.country !== country || payload?.billing_details?.currency !== currency) {
            throw new Error('官网本次建单套餐或币种与任务不一致，停止后续支付');
        }
        if (payload.price_interval && payload.price_interval !== 'month') throw new Error('官网建单不是月付周期，停止后续支付');
        const data = await response.json();
        if (response.status() !== 200) throw new Error(`官网 Checkout API HTTP ${response.status()}: ${formatApiErrorDetail(data.detail ?? data.error ?? data.message, '建单失败')}`);
        const checkout = new ChatGPTService(null, '').resolveCheckoutUrl(data);
        if (!checkout.sessionId || !checkout.checkoutUrl) throw new Error('官网本次 API 未返回有效的新结账会话');
        if (plan.tier) {
            await page.goto(checkout.checkoutUrl, { waitUntil: 'domcontentloaded', timeout });
            const tier = page.getByRole('radio', { name: plan.tier });
            await tier.waitFor({ state: 'visible', timeout });
            if (payload.plan_name !== plan.name) {
                const updatePromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().split('?')[0] === 'https://chatgpt.com/backend-api/payments/checkout/update', { timeout });
                updatePromise.catch(() => {});
                await tier.press('Space', { timeout: 10000 });
                const update = await updatePromise;
                await Promise.all(requests);
                const body = update.request().postDataJSON() || observedUpdate;
                if (update.status() !== 200 || body?.plan_name !== plan.name) throw new Error('官网 Pro 档位更新失败或套餐不一致');
                await tier.waitFor({ state: 'visible', timeout: 10000 });
            }
            if (await tier.getAttribute('aria-checked') !== 'true') throw new Error('官网 Pro 档位未确认选中');
        }
        return { ...checkout, planName: plan.name, httpStatus: response.status(), source: 'official_client' };
    } finally {
        clearTimeout(timer);
        page.off('response', listener);
        await cdp.detach().catch(() => {});
    }
}

module.exports = { createOfficialClientCheckout, OFFICIAL_PLANS };
