'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyCheckoutFailure, shouldFallbackToCheckoutUi } = require('../checkout-api-policy');
const { openApiCheckout } = require('../chatgpt');

it('API rejection stops by default, UI fallback requires explicit opt-in', () => {
    assert.equal(shouldFallbackToCheckoutUi('api', {}), false);
    assert.equal(shouldFallbackToCheckoutUi('api', { CHECKOUT_API_UI_FALLBACK: '1' }), true);
    assert.equal(shouldFallbackToCheckoutUi('official_client', { CHECKOUT_API_UI_FALLBACK: '1' }), false);
});

it('distinguishes authentication, access, rate limits and upstream rejection', () => {
    assert.equal(classifyCheckoutFailure(400, 'unusual activity'), 'CHECKOUT_UPSTREAM_REJECTED');
    assert.equal(classifyCheckoutFailure(401), 'CHECKOUT_AUTH_REQUIRED');
    assert.equal(classifyCheckoutFailure(403), 'CHECKOUT_ACCESS_DENIED');
    assert.equal(classifyCheckoutFailure(429), 'CHECKOUT_RATE_LIMITED');
    assert.equal(classifyCheckoutFailure(503), 'CHECKOUT_UPSTREAM_UNAVAILABLE');
});

it('openApiCheckout preserves upstream status without navigating or retrying', async () => {
    let calls = 0;
    const page = {
        context: () => ({ request: {} }), url: () => 'https://chatgpt.com/',
        evaluate: async () => { calls++; return { status: 400, body: '{"detail":"unusual activity"}' }; },
        goto: () => { throw new Error('must not navigate'); }
    };
    await assert.rejects(openApiCheckout(page, { accessToken: 'test', planType: 'plus', verifyPage: false }),
        error => error.code === 'CHECKOUT_UPSTREAM_REJECTED' && error.httpStatus === 400);
    assert.equal(calls, 1);
});
