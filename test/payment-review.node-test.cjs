'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const { installPaymentReviewGuard, releasePaymentReviewGuard, isCheckoutTaxQuoteRequest } = require('../payment-review-guard');

test('billing name can stay empty when optional but stops when the page requires it', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<iframe id="billing"></iframe>');
        await page.locator('#billing').evaluate(frame => { frame.srcdoc = '<input autocomplete="billing name"><input autocomplete="billing address-line1"><input autocomplete="billing address-level2"><input autocomplete="billing postal-code">'; });
        const name = page.frameLocator('#billing').locator('[autocomplete="billing name"]');
        await name.waitFor();
        const address = { country: 'US', line1: 'Fixture street', city: 'Fixture city', postal_code: '97035' };
        const fill = require('../checkout-billing-frame').fillCheckoutBillingFrame;
        assert.equal((await fill(page, address, '')).holderName, '');
        await name.evaluate(node => { node.required = true; });
        await assert.rejects(fill(page, address, ''), /官网要求真实持卡人姓名/);
    } finally { await browser.close(); }
});

test('review permits only the verified official tax quote endpoint, never payment confirmation', () => {
    assert.equal(isCheckoutTaxQuoteRequest({method:'POST',url:'https://chatgpt.com/backend-api/payments/checkout/taxes'}),true);
    for (const url of ['https://chatgpt.com/backend-api/payments/checkout/confirm','https://chatgpt.com/backend-api/payments/checkout/approve','https://chatgpt.com/backend-api/payments/checkout/taxes/confirm','https://chatgpt.com.example.test/backend-api/payments/checkout/taxes','http://chatgpt.com/backend-api/payments/checkout/taxes','https://api.stripe.com/v1/payment_intents/example/confirm']) {
        assert.equal(isCheckoutTaxQuoteRequest({method:'POST',url}),false);
    }
});

test('tax review accepts a visible zero quote and rejects a remaining VAT charge', async () => {
    const {verifyCheckoutZeroTax}=require('../checkout-billing-frame');
    const page = text => ({locator:()=>({innerText:async()=>text}),waitForTimeout:async()=>{}});
    assert.equal(await verifyCheckoutZeroTax(page('Tax (0%)\n₱0.00\nDue today\n₱5,794.64')),true);
    await assert.rejects(verifyCheckoutZeroTax(page('VAT (12%)\n₱695.36\nDue today\n₱6,490.00'),{timeout:5}),/未确认免税/);
});

test('review blocks form submission, payment clicks and all mutating network calls', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let upstreamWrites = 0;
    const server = http.createServer((request, response) => {
        if (request.method !== 'GET') upstreamWrites++;
        response.setHeader('Content-Type','text/html');
        response.end('<form><input name="card"><button>Subscribe</button></form><script>window.submits=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submits++};document.querySelector("button").onclick=()=>window.submits++</script>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/checkout`);
        await installPaymentReviewGuard(page);
        await page.locator('input').fill('test');
        await page.locator('button').click();
        await page.evaluate(() => document.querySelector('form').requestSubmit());
        assert.equal(await page.evaluate(() => window.submits), 0);
        assert.equal(await page.evaluate(() => fetch('/confirm', {method:'POST'}).then(()=>false,()=>true)), true);
        assert.equal(upstreamWrites, 0);
        assert.equal(await page.locator('input').inputValue(), 'test');
        await releasePaymentReviewGuard(page);
        assert.equal(await page.evaluate(() => window.__paymentReviewGuardInstalled), false);
        assert.equal(await page.locator('input').inputValue(), 'test');
        assert.equal(await page.evaluate(() => window.submits), 0);
        await page.locator('button').click();
        assert.ok(await page.evaluate(() => window.submits) > 0);
        assert.equal(await page.evaluate(() => fetch('/confirm', {method:'POST'}).then(()=>true,()=>false)), true);
        assert.equal(upstreamWrites, 1);
    } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});

test('review releases reserved card without recording success, failure or card usage', async () => {
    const store = require('../mysql-store');
    const stripe = require('../stripe-payment');
    const addresses = require('../tax-free-address');
    const originals = [];
    let releases = 0;
    const replace = (object, key, value) => { const original=object[key]; originals.push(()=>{object[key]=original;}); object[key]=value; };
    try {
        replace(store, 'getAppConfigValue', async()=>null);
        replace(store, 'getPaymentRegion', async()=>'PH');
        replace(store, 'reserveCard', async()=>({id:123,card_number:'4242424242424242',card_expiry:'1230',card_cvc:'123'}));
        replace(store, 'releaseCard', async id=>{assert.equal(id,123); releases++;});
        for (const key of ['createBillingRecord','recordCardUsage','bindCardPaymentProfile','markCardExhausted']) replace(store,key,async()=>{throw new Error(`Forbidden review write: ${key}`);});
        replace(addresses, 'pickBillingAddressForCheckout', async()=>({id:1,line1:'fixture',city:'fixture',state:'DE',postal_code:'19701',country:'US'}));
        replace(stripe, 'readCheckoutDueAmount', async()=>({amount:1100,currency:'PHP'}));
        replace(stripe, 'completeStripeCardPayment', async(page, card, address, options)=>{assert.equal(options.stopBeforeSubmit,true);return {success:false,reviewReady:true,screenshot:'fixture.png'};});
        delete require.cache[require.resolve('../payment-retry')];
        const result=await require('../payment-retry').executePaymentWithRetry({}, {stopBeforeSubmit:true});
        assert.equal(result.reviewReady,true);
        assert.equal(result.success,false);
        assert.equal(releases,1);
    } finally {
        for (const restore of originals.reverse()) restore();
        delete require.cache[require.resolve('../payment-retry')];
    }
});

test('fills semantic card and billing fields in separate localized iframes without overwriting an existing name', async () => {
    const browser=await chromium.launch({channel:'chrome',headless:true});
    try {
        const page=await browser.newPage();
        await page.setContent('<iframe id="card"></iframe><iframe id="billing"></iframe>');
        await page.locator('#card').evaluate((frame,html)=>{frame.srcdoc=html;},'<input name="unrelated" value="keep"><input autocomplete="cc-number" name="number"><input autocomplete="cc-exp" name="expiry"><input autocomplete="cc-csc" name="cvc">');
        await page.locator('#billing').evaluate((frame,html)=>{frame.srcdoc=html;},'<input autocomplete="billing name" value="Existing Holder" required><select autocomplete="billing country"><option value="PH">Philippines</option><option value="US">United States</option></select><input autocomplete="billing address-line1" required><input autocomplete="billing address-level2" required><input autocomplete="billing postal-code" required><select autocomplete="billing address-level1" required><option value="">Choose</option><option value="OR">Oregon</option></select>');
        await page.frameLocator('#billing').locator('input').first().waitFor();
        const result=await require('../stripe-payment').fillCardFieldsOpenAiCheckout(page,{number:'4242424242424242',expiry:'1230',cvc:'123'},5000);
        assert.equal(result.ok,true);
        assert.equal(await page.frameLocator('#card').locator('[name="unrelated"]').inputValue(),'keep');
        assert.equal(await page.frameLocator('#card').locator('[name="number"]').inputValue(),'4242424242424242');
        const billing=await require('../checkout-billing-frame').fillCheckoutBillingFrame(page,{country:'US',line1:'Fixture street',city:'Fixture city',postal_code:'97035',state:'Oregon'},'Unused Generated Name');
        assert.equal(billing.holderName,'Existing Holder');
        assert.equal(await page.frameLocator('#billing').locator('[autocomplete~="country"]').inputValue(),'US');
        assert.equal(await page.frameLocator('#billing').locator('[autocomplete~="address-level1"]').inputValue(),'OR');
    } finally {await browser.close();}
});
