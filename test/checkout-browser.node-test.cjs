'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { ChatGPTService } = require('../chatgpt');

it('uses browser fetch for checkout without using Node request networking', async () => {
    const page = {
        url: () => 'https://chatgpt.com/',
        evaluate: async (callback, args) => {
            assert.equal(typeof callback, 'function');
            assert.equal(args.headers.Authorization, 'Bearer test-token');
            assert.equal(args.payload.billing_details.country, 'PH');
            return { status: 200, body: '{"checkout_session_id":"cs_test_example"}' };
        }
    };
    const request = { post: () => { throw new Error('Node transport must not be used'); } };
    const result = await new ChatGPTService(request, 'test-token', page).createCheckoutSession('plus', 'PH', 'PHP');
    assert.equal(result.checkoutUrl, 'https://chatgpt.com/checkout/openai_llc/cs_test_example');
});

it('does not send credentials to a page outside the expected origin', async () => {
    const page = {
        url: () => 'https://chatgpt.com.example.test/',
        evaluate: () => { throw new Error('must not evaluate'); }
    };
    const result = await new ChatGPTService(null, 'test-token', page).createCheckoutSession('plus', 'PH', 'PHP');
    assert.equal(result.checkoutUrl, null);
    assert.ok(result.error.includes('需要已登录的 chatgpt.com 页面'));
});

it('preserves upstream rejection without retrying or reporting success', async () => {
    let calls = 0;
    const page = {
        url: () => 'https://chatgpt.com/',
        evaluate: async () => {
            calls++;
            return { status: 400, body: '{"detail":"Our systems have detected unusual activity. Please try again later."}' };
        }
    };
    const result = await new ChatGPTService(null, 'test-token', page).createCheckoutSession('plus', 'PH', 'PHP');
    assert.equal(result.checkoutUrl, null);
    assert.ok(result.error.includes('unusual activity'));
    assert.equal(calls, 1);
});

it('limits legacy request duration and removes appended credential-bearing call logs', async () => {
    const request = {
        post: async (url, options) => {
            assert.equal(options.timeout, 30000);
            throw new Error('connect ETIMEDOUT\nCall log:\nAuthorization: Bearer secret-test-token\nCookie: secret-cookie');
        }
    };
    const result = await new ChatGPTService(request, 'test-token').createCheckoutSession('plus', 'PH', 'PHP');
    assert.equal(result.error, 'connect ETIMEDOUT');
});
