'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { verifyRealSessionApi, installChatGptSession } = require('../session-auth');

describe('real session API verification', () => {
    it('reuses an authenticated-origin page without navigation or closing the caller tab', async () => {
        const context = { newPage: () => { throw new Error('must not create another tab'); } };
        const page = {
            context: () => context, url: () => 'https://chatgpt.com/',
            goto: () => { throw new Error('must not navigate'); },
            close: () => { throw new Error('must not close caller tab'); },
            evaluate: async () => ({ status: 200, headers: {}, body: '{"user":{"id":"test-user"},"accessToken":"test"}' })
        };
        assert.equal((await verifyRealSessionApi(context, { transport: 'fetch', page })).ok, true);
    });

    it('refuses borrowed pages from another context or origin before requesting a session', async () => {
        const context = {};
        for (const [owner, url] of [[{}, 'https://chatgpt.com/'], [context, 'https://example.test/']]) {
            const page = { context: () => owner, url: () => url, evaluate: () => { throw new Error('must not fetch'); } };
            const result = await verifyRealSessionApi(context, { transport: 'fetch', page });
            assert.equal(result.code, 'SESSION_LOGIN_REQUIRED');
        }
    });
    it('still requires real authenticated JSON after an optional visible challenge interaction', async () => {
        let interactions = 0;
        let fetches = 0;
        const page = {
            url: () => 'https://chatgpt.com/',
            goto: async () => ({ status: () => 403, headers: () => ({ 'cf-mitigated': 'challenge' }) }),
            evaluate: async () => { fetches++; return { status: 200, headers: {}, body: '{}' }; },
            close: async () => {}
        };
        const result = await verifyRealSessionApi({ newPage: async () => page }, {
            transport: 'fetch', onChallenge: async () => { interactions++; }
        });
        assert.equal(interactions, 1);
        assert.equal(fetches, 1);
        assert.equal(result.ok, false);
    });
    it('fetches a real session from the loaded origin and closes the probe', async () => {
        let closed = false;
        let calls = 0;
        const page = {
            url: () => 'https://chatgpt.com/',
            goto: async url => { assert.equal(url, 'https://chatgpt.com/'); return { status: () => 200 }; },
            evaluate: async () => { calls++; return { status: 200, headers: {}, body: '{"user":{"id":"test-user"},"accessToken":"test"}' }; },
            close: async () => { closed = true; }
        };
        assert.equal((await verifyRealSessionApi({ newPage: async () => page }, { transport: 'fetch' })).ok, true);
        assert.equal(calls, 1);
        assert.equal(closed, true);
    });

    it('does not fetch a session after the landing page is challenged', async () => {
        const page = {
            goto: async () => ({ status: () => 403, headers: () => ({ 'cf-mitigated': 'challenge' }), text: async () => '' }),
            evaluate: async () => { throw new Error('must not fetch'); },
            close: async () => {}
        };
        const result = await verifyRealSessionApi({ newPage: async () => page }, { transport: 'fetch' });
        assert.equal(result.code, 'SESSION_HUMAN_VERIFICATION_REQUIRED');
    });

    it('does not fetch credentials after navigation to another origin', async () => {
        const page = {
            goto: async () => ({ status: () => 200 }), url: () => 'https://example.test/',
            evaluate: async () => { throw new Error('must not fetch'); }, close: async () => {}
        };
        const result = await verifyRealSessionApi({ newPage: async () => page }, { transport: 'fetch' });
        assert.equal(result.code, 'SESSION_LOGIN_REQUIRED');
    });
    async function check(status, body, headers = {}) {
        let closed = false;
        const page = {
            goto: async () => ({ status: () => status, headers: () => headers }),
            evaluate: async () => body,
            close: async () => { closed = true; }
        };
        const result = await verifyRealSessionApi({ newPage: async () => page });
        assert.equal(closed, true);
        return result;
    }

    it('accepts authenticated successful responses', async () => {
        assert.equal((await check(200, '{"user":{"id":"test-user"}}')).ok, true);
    });

    it('does not treat an empty 403 as proof of an expired Cookie', async () => {
        const result = await check(403, '');
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('HTTP 403，空响应'));
        assert.ok(result.error.includes('尚无法确认 Cookie 是否有效'));
        assert.ok(!result.error.includes('未过期'));
    });

    it('recognizes Cloudflare headers without depending on header spacing', async () => {
        assert.equal((await check(403, '', { 'cf-mitigated': 'challenge' })).challenge, true);
    });

    it('recognizes a visible human verification page', async () => {
        assert.equal((await check(403, 'Just a moment... Verify you are human')).challenge, true);
    });

    for (const status of [401, 200]) it('reports missing authentication for HTTP ' + status, async () => {
        const result = await check(status, '{}');
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('Cookie 未过期'));
    });

    it('keeps upstream failures separate from rejected credentials', async () => {
        const result = await check(502, 'upstream unavailable', { 'content-type': 'text/html' });
        assert.ok(result.error.includes('服务异常'));
        assert.ok(result.error.includes('HTTP 502，HTML'));
        assert.ok(!result.error.includes('Cookie 未过期'));
    });

    it('rejects non-success responses even if they contain user data and does not log their body', async () => {
        const result = await check(403, '{"accessToken":"secret-test-token","user":{"id":"test-user"}}');
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('HTTP 403，JSON'));
        assert.ok(!result.error.includes('secret-test-token'));
        assert.ok(!result.error.includes('test-user'));
    });

    it('reads the network JSON even when the rendered DOM is empty', async () => {
        const page = {
            goto: async () => ({ status: () => 200, headers: () => ({}), text: async () => '{"user":{"id":"test-user"}}' }),
            evaluate: async () => '',
            close: async () => {}
        };
        assert.equal((await verifyRealSessionApi({ newPage: async () => page })).ok, true);
    });

    it('captures a failed probe before closing it, including when the callback throws', async () => {
        let closed = false;
        let captured = false;
        const page = {
            goto: async () => ({ status: () => 403, headers: () => ({}), text: async () => '<html>Verify you are human</html>' }),
            close: async () => { closed = true; }
        };
        const result = await verifyRealSessionApi({ newPage: async () => page }, {
            onFailure: (probe) => {
                assert.equal(probe, page);
                assert.equal(closed, false);
                captured = true;
                throw new Error('screenshot unavailable');
            }
        });
        assert.equal(result.code, 'SESSION_HUMAN_VERIFICATION_REQUIRED');
        assert.equal(captured, true);
        assert.equal(closed, true);
    });

    it('stops installation on a real challenge before installing any synthetic authentication', async () => {
        let routes = 0;
        let scripts = 0;
        let pagesClosed = 0;
        const context = {
            newPage: async () => ({
                goto: async () => ({ status: () => 403, headers: () => ({ 'cf-mitigated': 'challenge' }), text: async () => '' }),
                close: async () => { pagesClosed++; }
            }),
            addCookies: async () => {},
            cookies: async () => [{ name: '__Secure-next-auth.session-token', value: 'test-cookie' }],
            route: async () => { routes++; },
            addInitScript: async () => { scripts++; }
        };
        await assert.rejects(installChatGptSession(context, JSON.stringify({
            accessToken: 'test-access-token',
            sessionToken: 'test-cookie',
            user: { id: 'test-user' }
        })), { code: 'SESSION_HUMAN_VERIFICATION_REQUIRED' });
        assert.equal(routes, 0);
        assert.equal(scripts, 0);
        assert.equal(pagesClosed, 2);
    });
});
