'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createOfficialClientCheckout } = require('../official-client-checkout');
const { openVerifiedCheckout } = require('../checkout-preflight');
const { clearHumanVerification } = require('../human-verification');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(status, plan = 'chatgptplusplan', send = true, title = 'Plus', alternate = false) {
    const page = await browser.newPage();
    let calls = 0;
    await page.route('https://chatgpt.com/**', async route => {
        if (route.request().url().includes('/backend-api/payments/checkout')) {
            calls++;
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200
                ? { checkout_session_id: 'cs_test_new_order' }
                : { detail: 'upstream rejected' }) });
        }
        await route.fulfill({ contentType: 'text/html', body: `
          <meta charset="utf-8">${alternate ? '<div role="dialog" style="display:none">Hidden dialog</div><main>Chat history</main>' : ''}<div role="dialog"><button aria-checked="true">Personal</button>
            <div><h2>${title}</h2><p>₱1,100 / month</p><button id="buy">${alternate ? 'Get started' : 'Buy now'}</button></div>
          </div><script>
            document.querySelector('#buy').onclick=()=>${send ? '' : 'false && '}fetch('/backend-api/payments/checkout', {
              method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
                plan_name:${JSON.stringify(plan)},billing_details:{country:'PH',currency:'PHP'}
              })});
          </script>` });
    });
    return { page, calls: () => calls };
}

test('requires a new API response triggered by the selected Plus button', async () => {
    const f = await fixture(200);
    try {
        const result = await createOfficialClientCheckout(f.page, { timeout: 5000 });
        assert.equal(result.sessionId, 'cs_test_new_order');
        assert.equal(result.source, 'official_client');
        assert.equal(f.calls(), 1);
    } finally { await f.page.close(); }
});

test('Plus alternate pricing ignores hidden dialogs and uses Get started', async () => {
    const f = await fixture(200, 'chatgptplusplan', true, 'Plus', true);
    try {
        const result = await createOfficialClientCheckout(f.page, { timeout: 5000 });
        assert.equal(result.planName, 'chatgptplusplan');
        assert.equal(f.calls(), 1);
    } finally { await f.page.close(); }
});

test('opens Upgrade once when hash navigation leaves the pricing dialog closed', async () => {
    const f = await fixture(200);
    await f.page.route('https://chatgpt.com/', route => route.fulfill({ contentType: 'text/html', body: `
        <meta charset="utf-8"><button id="upgrade">Upgrade</button><div role="dialog" style="display:none">
        <div><h2>Plus</h2><p>₱1,100 / month</p><button id="buy">Buy now</button></div></div>
        <script>window.opens=0;document.querySelector('#upgrade').onclick=()=>{window.opens++;document.querySelector('[role=dialog]').style.display='block'};
        document.querySelector('#buy').onclick=()=>fetch('/backend-api/payments/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_name:'chatgptplusplan',billing_details:{country:'PH',currency:'PHP'}})});</script>
    ` }));
    try {
        const result = await createOfficialClientCheckout(f.page, { timeout: 15000 });
        assert.equal(result.httpStatus, 200);
        assert.equal(f.calls(), 1);
        assert.equal(await f.page.evaluate(() => window.opens), 1);
    } finally { await f.page.close(); }
});

for (const [planType, name, tier] of [['pro_5x','chatgptprolite','Standard'], ['pro_20x','chatgptpro','More usage']]) {
    test(`official ${planType} validates new order and selected Pro tier`, async () => {
        const f=await fixture(200,name,true,'Pro');
        await f.page.route('https://chatgpt.com/checkout/**',route=>route.fulfill({contentType:'text/html',body:`<button role="radio" aria-checked="true">${tier}</button>`}));
        try {
            const checkout=await createOfficialClientCheckout(f.page,{planType,timeout:5000});
            assert.equal(checkout.planName,name);
            assert.equal(f.calls(),1);
        }finally{await f.page.close();}
    });
}

test('Pro 20x switches the newly created Standard checkout through the official update request', async () => {
    const f=await fixture(200,'chatgptprolite',true,'Pro');
    let updates=0;
    await f.page.route('https://chatgpt.com/backend-api/payments/checkout/update',route=>{
        updates++;
        assert.equal(route.request().postDataJSON().plan_name,'chatgptpro');
        return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    });
    await f.page.route('https://chatgpt.com/checkout/**',route=>route.fulfill({contentType:'text/html',body:`
      <button role="radio" aria-checked="true">Standard</button>
      <button id="more" role="radio" aria-checked="false">More usage</button>
      <script>document.querySelector('#more').onclick=async()=>{await fetch('/backend-api/payments/checkout/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_name:'chatgptpro',checkout_session_id:'cs_test_new_order'})});document.querySelector('#more').setAttribute('aria-checked','true');}</script>`}));
    try {
        const result=await createOfficialClientCheckout(f.page,{planType:'pro_20x',timeout:5000});
        assert.equal(result.planName,'chatgptpro');
        assert.equal(f.calls(),1);
        assert.equal(updates,1);
    } finally {await f.page.close();}
});

test('propagates API rejection without retry or existing-link success', async () => {
    const f = await fixture(400);
    try {
        await assert.rejects(createOfficialClientCheckout(f.page, { timeout: 5000 }), /HTTP 400: upstream rejected/);
        assert.equal(f.calls(), 1);
    } finally { await f.page.close(); }
});

test('stops when the official request selected a different plan', async () => {
    const f = await fixture(200, 'business');
    try {
        await assert.rejects(createOfficialClientCheckout(f.page, { timeout: 5000 }), /套餐或币种与任务不一致/);
        assert.equal(f.calls(), 1);
    } finally { await f.page.close(); }
});

test('times out without a new response and removes the observer', async () => {
    const f = await fixture(200, 'chatgptplusplan', false);
    try {
        await assert.rejects(createOfficialClientCheckout(f.page, { timeout: 2000 }), /未返回本次 Checkout API 响应/);
        assert.equal(f.calls(), 0);
        assert.equal(f.page.listenerCount('response'), 0);
    } finally { await f.page.close(); }
});

async function paymentFixture({ fields = true, symbol = '₱' } = {}) {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html',body:`
      <meta charset="utf-8"><h1>Configure your plan</h1><p>Due today ${symbol}1,100.00</p>
      ${fields ? '<iframe srcdoc=\'<input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc">\'></iframe>' : ''}
      <button onclick="window.submissions++">Subscribe</button><script>window.submissions=0</script>`}));
    return page;
}

test('preflight verifies all card inputs inside an iframe and amount without entering or submitting anything', async () => {
    const page = await paymentFixture();
    try {
        const result = await openVerifiedCheckout(page, {checkoutUrl:'https://chatgpt.com/checkout/openai_llc/cs_test',sessionId:'cs_test'}, {currency:'PHP',timeout:5000});
        assert.deepEqual(result,{cardFieldsReady:true,amount:1100,currency:'PHP'});
        assert.equal(await page.evaluate(()=>window.submissions),0);
        assert.deepEqual(await page.frames()[1].locator('input').evaluateAll(inputs=>inputs.map(i=>i.value)),['','','']);
    } finally { await page.close(); }
});

test('preflight rejects a page belonging to a different checkout session', async () => {
    const page = await paymentFixture();
    try {
        await assert.rejects(openVerifiedCheckout(page,{checkoutUrl:'https://chatgpt.com/checkout/openai_llc/cs_test',sessionId:'cs_other'},{currency:'PHP',timeout:5000}),/页面与本次新建会话不一致/);
        assert.equal(await page.evaluate(()=>window.submissions),0);
    } finally { await page.close(); }
});

test('preflight rejects a mismatched currency before payment', async () => {
    const page = await paymentFixture({symbol:'$'});
    try {
        await assert.rejects(openVerifiedCheckout(page,{checkoutUrl:'https://chatgpt.com/checkout/openai_llc/cs_test'},{currency:'PHP',timeout:5000}),/币种 USD.*PHP/);
        assert.equal(await page.evaluate(()=>window.submissions),0);
    } finally { await page.close(); }
});

test('checkout headings alone cannot pass preflight', async () => {
    const page = await paymentFixture({fields:false});
    try {
        await assert.rejects(openVerifiedCheckout(page,{checkoutUrl:'https://chatgpt.com/checkout/openai_llc/cs_test'},{currency:'PHP',timeout:1000}),/支付表单或应付金额未就绪/);
        assert.equal(await page.evaluate(()=>window.submissions),0);
    } finally { await page.close(); }
});

test('captures a new checkout emitted during pricing initialization without requiring an old link', async () => {
    const page = await browser.newPage();
    let calls=0;
    await page.route('https://chatgpt.com/**',route=>{
        if(route.request().url().includes('/backend-api/payments/checkout')) {
            calls++;
            return route.fulfill({contentType:'application/json',body:JSON.stringify({checkout_session_id:'cs_test_during_navigation'})});
        }
        return route.fulfill({contentType:'text/html',body:`<script>fetch('/backend-api/payments/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_name:'chatgptplusplan',billing_details:{country:'PH',currency:'PHP'}})})</script>`});
    });
    try {
        const result=await createOfficialClientCheckout(page,{timeout:5000});
        assert.equal(result.sessionId,'cs_test_during_navigation');
        assert.equal(calls,1);
    }finally{await page.close();}
});

test('manual verification waits for the page state to clear without clicking a challenge',async()=>{
    const previous=process.env.HUMAN_VERIFICATION_MODE;
    process.env.HUMAN_VERIFICATION_MODE='manual';
    const page=await browser.newPage();
    try {
        await page.setContent('<div id="challenge">Verify you are human<button onclick="window.challengeClicks++">Checkbox</button></div><script>window.challengeClicks=0</script>');
        const pending=clearHumanVerification(page,{maxWaitMs:5000,requireCheckoutReady:false});
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(()=>window.challengeClicks),0);
        await page.evaluate(()=>document.querySelector('#challenge').remove());
        const result=await pending;
        assert.equal(result.cleared,true);
        assert.equal(result.via,'manual');
        assert.equal(await page.evaluate(()=>window.challengeClicks),0);
    }finally{
        if(previous===undefined)delete process.env.HUMAN_VERIFICATION_MODE;else process.env.HUMAN_VERIFICATION_MODE=previous;
        await page.close();
    }
});
