'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installChatGptSession } = require('../session-auth');
const base = '__Secure-next-auth.session-token';
const raw = extra => JSON.stringify({ user: { email: 'new@example.test' }, accessToken: 'new-access', ...extra });
function fixture({ reject = false, failWrite = false, loggedOut = false } = {}) {
    let cookies = [
        { name: `${base}.0`, value: 'old-part-0', domain: '.chatgpt.com', path: '/' },
        { name: `${base}.1`, value: 'old-part-1', domain: '.chatgpt.com', path: '/' },
        { name: '__Host-next-auth.csrf-token', value: 'old-csrf', domain: 'chatgpt.com', path: '/' },
        { name: 'cf_clearance', value: 'keep', domain: '.chatgpt.com', path: '/' },
        { name: base, value: 'unrelated', domain: 'other.test', path: '/' }
    ];
    const original = structuredClone(cookies);
    let mutations = 0;
    const context = {
        cookies: async () => cookies.filter(c => c.domain.includes('chatgpt.com')),
        clearCookies: async filter => { mutations++; cookies = cookies.filter(c => !(c.name === filter.name && c.domain === filter.domain && c.path === filter.path)); },
        addCookies: async added => {
            mutations++;
            if (failWrite && added.some(c => c.url)) { failWrite = false; throw new Error('secret-cookie-value'); }
            cookies.push(...added.map(c => ({ ...c, domain: c.domain || 'chatgpt.com', path: c.path || '/' })));
        },
        newPage: async () => ({
            goto: async () => ({ status: () => 200, headers: () => ({}), text: async () => {
                const switched = cookies.some(c => c.name === base && c.domain === 'chatgpt.com') || cookies.some(c => c.name === `${base}.0` && c.value !== 'old-part-0');
                return JSON.stringify(switched && !reject ? { user: { email: 'new@example.test' }, accessToken: 'verified-access' } : loggedOut ? {} : { user: { email: 'old@example.test' }, accessToken: 'old-access' });
            } }),
            close: async () => {}
        }),
        route: () => { throw new Error('Must not spoof authentication'); },
        addInitScript: () => { throw new Error('Must not spoof authentication'); }
    };
    return { context, original, cookies: () => cookies, mutations: () => mutations };
}

test('switches accounts, removes stale chunks and CSRF, preserves unrelated cookies', async () => {
    const f = fixture();
    const result = await installChatGptSession(f.context, raw({ sessionToken: 'new-cookie' }), { nativeSession: true });
    assert.equal(result.sessionData.accessToken, 'verified-access');
    assert.equal(result.cookieVerified, true);
    assert.equal(f.cookies().some(c => c.name === `${base}.1`), false);
    assert.equal(f.cookies().find(c => c.name === 'cf_clearance').value, 'keep');
    assert.equal(f.cookies().find(c => c.domain === 'other.test').value, 'unrelated');
});
test('can install a session when the browser is logged out', async () => {
    const f = fixture({ loggedOut: true });
    assert.equal((await installChatGptSession(f.context, raw({ sessionToken: 'new-cookie' }), { nativeSession: true })).cookieVerified, true);
});

test('fresh contexts install supplied cookies before the first real session probe', async () => {
    const f = fixture({ loggedOut: true });
    const newPage = f.context.newPage;
    let probes = 0;
    f.context.newPage = async () => {
        probes++;
        assert.ok(f.mutations() > 0, 'cookies must be installed before probing');
        return newPage();
    };
    const result = await installChatGptSession(f.context, raw({ sessionToken: 'new-cookie' }), { nativeSession: true, freshContext: true });
    assert.equal(result.cookieVerified, true);
    assert.equal(probes, 1);
});
test('chunks long session tokens and accepts cookieHeader or cookie exports', async () => {
    for (const extra of [{ sessionToken: 'x'.repeat(8000) }, { cookieHeader: `${base}=new-cookie` }, { cookies: [{ name: `${base}.0`, value: 'new-', domain: '.chatgpt.com' }, { name: `${base}.1`, value: 'cookie', domain: '.chatgpt.com' }] }]) {
        const f = fixture();
        assert.equal((await installChatGptSession(f.context, raw(extra), { nativeSession: true })).cookieVerified, true);
        if (extra.sessionToken) assert.equal(f.cookies().filter(c => c.domain === 'chatgpt.com' && c.name.startsWith(base)).length, 3);
    }
});
test('restores previous cookies when verification or injection fails', async () => {
    for (const options of [{ reject: true }, { failWrite: true }]) {
        const f = fixture(options);
        await assert.rejects(installChatGptSession(f.context, raw({ sessionToken: 'new-cookie' }), { nativeSession: true }), error => error.message.includes('已恢复原登录') && !error.message.includes('secret-cookie-value'));
        const sorted = array => array.slice().sort((a,b) => (a.domain+a.name).localeCompare(b.domain+b.name));
        assert.deepEqual(sorted(f.cookies()), sorted(f.original));
    }
});
test('rejects missing, fake, ambiguous and foreign credentials before changing cookies', async () => {
    for (const extra of [{}, { sessionToken: 'new-access' }, { cookies: [{ name: base, value: 'x', domain: 'evil-chatgpt.com' }] }, { cookieHeader: `${base}.1=x` }, { cookieHeader: `${base}=x; ${base}.0=y` }]) {
        const f = fixture();
        await assert.rejects(installChatGptSession(f.context, raw(extra), { nativeSession: true }));
        assert.equal(f.mutations(), 0);
    }
});
test('does not use global session credentials to switch a submitted account', async () => {
    const previous = process.env.CHATGPT_SESSION_COOKIE;
    process.env.CHATGPT_SESSION_COOKIE = 'global-cookie';
    try {
        const f = fixture();
        await assert.rejects(installChatGptSession(f.context, raw({}), { nativeSession: true }), /自动切换需要/);
        assert.equal(f.mutations(), 0);
    } finally {
        if (previous === undefined) delete process.env.CHATGPT_SESSION_COOKIE;
        else process.env.CHATGPT_SESSION_COOKIE = previous;
    }
});
