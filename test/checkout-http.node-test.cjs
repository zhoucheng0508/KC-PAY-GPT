'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { createHostedCheckoutLink } = require('../chatgpt');

test('HTTP checkout sends the explicit proxy and never follows redirects with credentials', async () => {
    const previous = axios.defaults.adapter;
    let calls = 0;
    axios.defaults.adapter = async config => {
        calls++;
        assert.equal(config.proxy, false);
        assert.equal(config.maxRedirects, 0);
        assert.equal(config.timeout, 30000);
        assert.equal(config.httpsAgent.getProxyForUrl(), 'http://proxy.test:7890');
        assert.equal(config.httpAgent, config.httpsAgent);
        assert.equal(config.headers.Authorization, 'Bearer test-token');
        return { status: 200, data: { checkout_session_id: 'cs_test_created' }, headers: {}, config };
    };
    try {
        const result = await createHostedCheckoutLink({ accessToken: 'test-token', proxy: 'http://proxy.test:7890' });
        assert.equal(result.success, true);
        assert.equal(result.session_id, 'cs_test_created');
        assert.equal(calls, 1);
    } finally { axios.defaults.adapter = previous; }
});

test('HTTP rejection stays a failure and transport errors do not leak Axios credentials', async () => {
    const previous = axios.defaults.adapter;
    try {
        axios.defaults.adapter = async config => ({ status: 400, data: { detail: 'unusual activity' }, headers: {}, config });
        const rejected = await createHostedCheckoutLink({ accessToken: 'secret-test-token' });
        assert.equal(rejected.success, false);
        assert.equal(rejected.code, 'CHECKOUT_UPSTREAM_REJECTED');
        assert.equal(rejected.http_status, 400);
        axios.defaults.adapter = async () => { throw new Error('Authorization: Bearer secret-test-token'); };
        const failed = await createHostedCheckoutLink({ accessToken: 'secret-test-token' });
        assert.equal(failed.code, 'CHECKOUT_TRANSPORT_FAILED');
        assert.ok(!JSON.stringify(failed).includes('secret-test-token'));
    } finally { axios.defaults.adapter = previous; }
});
