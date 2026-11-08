'use strict';

// Installed only after creation of the new Checkout session. Payment writes
// remain blocked, even if the UI unexpectedly submits while filling.
function isCheckoutTaxQuoteRequest(request) {
    const url = new URL(request.url);
    return request.method === 'POST' && url.origin === 'https://chatgpt.com'
        && url.pathname === '/backend-api/payments/checkout/taxes';
}

async function installPaymentReviewGuard(page) {
    if (page.__paymentReviewGuard) return;
    if (process.env.BROWSER_RUNTIME_MODE === 'persistent') {
        // Cover cross-origin payment frames as well as the main Checkout target.
        await page.context().route('**/*', async route => {
            const request = route.request();
            const host = new URL(request.url()).hostname;
            const auxiliary = host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')
                || ['r.stripe.com', 'm.stripe.com', 'm.stripe.network'].includes(host);
            if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || auxiliary
                || isCheckoutTaxQuoteRequest({ method: request.method(), url: request.url() })) return route.continue();
            return route.abort('blockedbyclient');
        });
    }
    const blockSubmit = () => {
        if (window.__paymentReviewGuardInstalled) return;
        window.__paymentReviewGuardInstalled = true;
        const controller = new AbortController();
        window.__paymentReviewGuardController = controller;
        window.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true, signal: controller.signal });
        window.addEventListener('click', event => {
            const button = event.target.closest?.('button, input[type="submit"], [role="button"]');
            if (!button) return;
            if (/^(subscribe|upgrade to pro|pay(?: now)?|confirm(?: payment)?|订阅|支付|立即支付|确认支付)$/i.test((button.innerText || button.value || '').trim()) || button.type === 'submit') {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }, { capture: true, signal: controller.signal });
    };
    const bounded = async (operation) => {
        let timer;
        try {
            return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('安装付款提交保护超时，停止填写')), 15000); })]);
        } finally { clearTimeout(timer); }
    };
    // Attach directly to the Checkout target: AdsPower can leave unrelated OOP
    // frame sessions pending, which makes Playwright's all-frame routing hang.
    const cdp = await bounded(page.context().newCDPSession(page));
    cdp.on('Fetch.requestPaused', async event => {
        try {
            const host = new URL(event.request.url).hostname;
            const readable = ['GET', 'HEAD', 'OPTIONS'].includes(event.request.method);
            const auxiliary = host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com') || ['r.stripe.com', 'm.stripe.com', 'm.stripe.network'].includes(host);
            // Verified in the official client: this endpoint only refreshes the
            // checkout tax quote through runServerUpdate; it never confirms pay.
            const taxQuote = isCheckoutTaxQuoteRequest(event.request);
            if (readable || auxiliary || taxQuote) return await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
            console.log(`[ReviewGuard] 已阻止 ${event.request.method} 写请求 (${host})`);
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        } catch (_) { /* Closing a target cannot resume a blocked write. */ }
    });
    await bounded(cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }));
    const source = `(${blockSubmit.toString()})();`;
    const script = await bounded(cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }));
    page.__paymentReviewGuardScript = script.identifier;
    const evaluation = await bounded(cdp.send('Runtime.evaluate', { expression: source }));
    if (evaluation.exceptionDetails) throw new Error('安装付款提交保护失败，停止填写');
    page.__paymentReviewGuard = cdp;
    console.log('[ReviewGuard] 付款提交保护已就绪');
}

async function releasePaymentReviewGuard(page) {
    const cdp = page.__paymentReviewGuard;
    if (!cdp) throw new Error('付款审查保护未安装，无法交接');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.__paymentReviewGuardScript });
    await cdp.send('Fetch.disable');
    const result = await cdp.send('Runtime.evaluate', { expression: 'window.__paymentReviewGuardController.abort(); window.__paymentReviewGuardInstalled = false;' });
    if (result.exceptionDetails) throw new Error('解除付款提交保护失败');
    await cdp.detach();
    delete page.__paymentReviewGuard;
    delete page.__paymentReviewGuardScript;
}

module.exports = { installPaymentReviewGuard, releasePaymentReviewGuard, isCheckoutTaxQuoteRequest };
