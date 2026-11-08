'use strict';

function classifyCheckoutFailure(status, detail = '') {
    if (/unusual activity/i.test(detail)) return 'CHECKOUT_UPSTREAM_REJECTED';
    if (status === 401) return 'CHECKOUT_AUTH_REQUIRED';
    if (status === 403) return 'CHECKOUT_ACCESS_DENIED';
    if (status === 429) return 'CHECKOUT_RATE_LIMITED';
    if (status >= 500) return 'CHECKOUT_UPSTREAM_UNAVAILABLE';
    return 'CHECKOUT_API_FAILED';
}

function shouldFallbackToCheckoutUi(mode, env = process.env) {
    return mode === 'api' && env.CHECKOUT_API_UI_FALLBACK === '1';
}

module.exports = { classifyCheckoutFailure, shouldFallbackToCheckoutUi };
