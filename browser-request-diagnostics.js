'use strict';

// Record only endpoint categories and status. Never store URLs, query strings,
// response bodies, request payloads, headers or account identifiers.
function classifyRequest(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'other'; }
    if (parsed.hostname === 'chatgpt.com') {
        if (parsed.pathname === '/api/auth/session') return 'session';
        if (parsed.pathname === '/backend-api/me') return 'account';
        if (parsed.pathname.startsWith('/backend-api/accounts/')) return 'account';
        if (parsed.pathname.startsWith('/backend-api/payments/checkout')) return 'checkout';
        if (parsed.pathname.startsWith('/cdn-cgi/')) return 'challenge';
        if (parsed.pathname === '/') return 'homepage';
    }
    if (parsed.hostname === 'challenges.cloudflare.com' || parsed.hostname.endsWith('.challenges.cloudflare.com')) return 'challenge';
    return 'other';
}

function attachRequestDiagnostics(page, getStage) {
    const events = [];
    const add = event => { if (events.length < 100) events.push(event); };
    const response = res => {
        const category = classifyRequest(res.url());
        if (category === 'other') return;
        add({ stage: getStage(), category, status: res.status(), challenge: res.headers()['cf-mitigated'] === 'challenge' });
    };
    const failed = req => {
        const category = classifyRequest(req.url());
        if (category === 'other') return;
        add({ stage: getStage(), category, failed: true });
    };
    page.on('response', response);
    page.on('requestfailed', failed);
    return { events, detach() { page.off('response', response); page.off('requestfailed', failed); } };
}

module.exports = { classifyRequest, attachRequestDiagnostics };
