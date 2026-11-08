'use strict';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const {
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    shouldBlockLoginNavigation,
    isLoginPageContent,
    hasVisibleLoginChrome,
    hasLoggedInChatUi,
    waitForLoggedInChatUi,
    hasLoggedInSessionApi,
    buildSessionNotLoggedInError
} = require('./auth-page-detect');

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (_) {
        return null;
    }
}

function extractProfileFromToken(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
        return { email: '', accountId: '', userId: '' };
    }
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
        email: profile.email || '',
        accountId: authInfo.chatgpt_account_id || '',
        userId: authInfo.chatgpt_user_id || ''
    };
}

function buildSessionPayload(accessToken, sessionJson = null) {
    const token = String(accessToken || '').trim();
    const profile = extractProfileFromToken(token);
    const base = sessionJson && typeof sessionJson === 'object' ? { ...sessionJson } : {};
    const user = base.user || (profile.email || profile.userId ? {
        id: profile.userId || `user-${profile.accountId || 'session'}`,
        email: profile.email || undefined,
        name: profile.email || undefined
    } : null);

    const expires = base.expires
        || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    return {
        ...base,
        user,
        expires,
        accessToken: base.accessToken || base.access_token || token,
        authProvider: base.authProvider || 'google-oauth2'
    };
}

function parseSessionJson(raw) {
    const content = String(raw || '').trim();
    if (!content || !content.startsWith('{')) {
        return null;
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return data;
        }
    } catch (_) {
        return null;
    }
    return null;
}

const CHATGPT_COOKIE_URL = 'https://chatgpt.com';
const SESSION_TOKEN_BASE = '__Secure-next-auth.session-token';
/** 与 NextAuth SessionStore 一致：4096 - 160 */
const SESSION_COOKIE_CHUNK_SIZE = 3936;

function isSessionTokenCookieName(name) {
    return name === SESSION_TOKEN_BASE || name.startsWith(`${SESSION_TOKEN_BASE}.`);
}

/** 超长 sessionToken 按 NextAuth 规则拆成 .0 / .1 / … 多块 Cookie */
function expandSessionTokenCookies(value) {
    const token = sanitizeCookieValue(value);
    if (!token) {
        return [];
    }
    if (token.length <= SESSION_COOKIE_CHUNK_SIZE) {
        return [{ name: SESSION_TOKEN_BASE, value: token }];
    }
    const chunkCount = Math.ceil(token.length / SESSION_COOKIE_CHUNK_SIZE);
    const chunks = [];
    for (let i = 0; i < chunkCount; i++) {
        chunks.push({
            name: `${SESSION_TOKEN_BASE}.${i}`,
            value: token.substr(i * SESSION_COOKIE_CHUNK_SIZE, SESSION_COOKIE_CHUNK_SIZE)
        });
    }
    return chunks;
}

function hasStoredSessionToken(cookies) {
    return (cookies || []).some((item) => isSessionTokenCookieName(item.name));
}

function parseCookieHeader(header) {
    const pairs = [];
    for (const rawPart of String(header || '').split(';')) {
        const part = rawPart.trim();
        if (!part || !part.includes('=')) continue;
        const eq = part.indexOf('=');
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name && value) {
            pairs.push({ name, value });
        }
    }
    return pairs;
}

function isChatGptCookieDomain(domain) {
    const value = String(domain || '').toLowerCase();
    return !value || value.replace(/^\./, '') === 'chatgpt.com';
}

function normalizeSameSite(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'no_restriction' || value === 'none') {
        return 'None';
    }
    if (value === 'strict') {
        return 'Strict';
    }
    return 'Lax';
}

function sanitizeCookieValue(value) {
    return String(value || '')
        .replace(/^["']+|["']+$/g, '')
        .replace(/[\r\n\0]/g, '')
        .trim();
}

function isValidCookieName(name) {
    return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function toPlaywrightCookie(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }
    const name = String(spec.name || '').trim();
    const value = sanitizeCookieValue(spec.value);
    if (!name || !value || !isValidCookieName(name)) {
        return null;
    }

    const sameSite = normalizeSameSite(spec.sameSite);
    const secure = sameSite === 'None' || name.startsWith('__Host-') || name.startsWith('__Secure-')
        ? true
        : spec.secure !== false;
    const httpOnly = spec.httpOnly !== false;

    const base = { name, value, secure, httpOnly, sameSite };

    // __Host- / __Secure- 前缀：只能用 url，不能带 domain/path
    if (name.startsWith('__Host-') || name.startsWith('__Secure-')) {
        return { ...base, url: CHATGPT_COOKIE_URL };
    }

    const hostOnly = spec.hostOnly === true;
    const rawDomain = String(spec.domain || 'chatgpt.com').trim().toLowerCase() || 'chatgpt.com';
    const bareDomain = rawDomain.replace(/^\./, '');
    const domain = hostOnly ? bareDomain : (rawDomain.startsWith('.') ? rawDomain : `.${bareDomain}`);
    const path = String(spec.path || '/').trim() || '/';

    return { ...base, domain, path };
}

function toPlaywrightCookieFallback(cookie) {
    if (!cookie?.name || !cookie?.value) {
        return null;
    }
    const { name, value, secure, httpOnly, sameSite } = cookie;
    if (name.startsWith('__Host-')) {
        return { name, value, path: '/', secure: true, httpOnly, sameSite, url: CHATGPT_COOKIE_URL };
    }
    if (name.startsWith('__Secure-')) {
        return { name, value, domain: 'chatgpt.com', path: '/', secure: true, httpOnly, sameSite };
    }
    return null;
}

async function addCookieSafe(context, cookie) {
    try {
        await context.addCookies([cookie]);
        return null;
    } catch (primaryErr) {
        const fallback = toPlaywrightCookieFallback(cookie);
        if (!fallback) {
            return primaryErr.message;
        }
        try {
            await context.addCookies([fallback]);
            return null;
        } catch (fallbackErr) {
            return fallbackErr.message || primaryErr.message;
        }
    }
}

async function injectChatGptCookies(context, cookieSpecs) {
    if (!cookieSpecs.length) {
        return { injected: 0, hasSessionToken: false, failed: [] };
    }

    const warmup = await context.newPage();
    try {
        await warmup.goto(`${CHATGPT_COOKIE_URL}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
    } catch (_) { /* 代理慢时仍尝试写 Cookie */ }

    const playwrightCookies = cookieSpecs
        .map((spec) => toPlaywrightCookie(spec))
        .filter(Boolean);

    const failed = [];
    let injected = 0;
    for (const cookie of playwrightCookies) {
        const error = await addCookieSafe(context, cookie);
        if (error) {
            failed.push({ name: cookie.name, error });
            console.warn(`[Session] Cookie 注入跳过 ${cookie.name}: ${error}`);
            continue;
        }
        injected += 1;
    }

    if (failed.length) {
        console.warn(`[Session] ${failed.length}/${playwrightCookies.length} 个 Cookie 注入失败`);
    }

    const stored = await context.cookies(CHATGPT_COOKIE_URL);
    const hasSessionToken = hasStoredSessionToken(stored);
    await warmup.close().catch(() => {});

    return {
        injected,
        hasSessionToken,
        storedNames: stored.map((c) => c.name),
        failed
    };
}

function collectCookieSpecs(sessionData, sessionJson, options = {}) {
    const specs = [];
    const seen = new Set();
    const seenNames = new Set();

    const push = (name, value, extra = {}) => {
        const n = String(name || '').trim();
        const v = String(value || '').trim();
        if (!n || !v) return;
        const key = `${n}\0${v}`;
        if (seen.has(key)) return;
        seen.add(key);
        seenNames.add(n);
        specs.push({ name: n, value: v, ...extra });
    };

    for (const source of [sessionJson?.cookies, sessionData?.cookies]) {
        if (!Array.isArray(source)) continue;
        for (const item of source) {
            if (!item || typeof item !== 'object') continue;
            const name = String(item.name || '').trim();
            const value = String(item.value || '').trim();
            if (!name || !value) continue;
            if (!isChatGptCookieDomain(item.domain)) continue;
            push(name, value, {
                domain: item.domain,
                path: item.path,
                secure: item.secure,
                httpOnly: item.httpOnly,
                sameSite: item.sameSite,
                hostOnly: item.hostOnly
            });
        }
    }

    for (const header of [sessionData?.cookieHeader, sessionData?.cookie_header, sessionJson?.cookieHeader, sessionJson?.cookie_header]) {
        for (const pair of parseCookieHeader(header)) {
            push(pair.name, pair.value);
        }
    }

    const hasExportedSessionToken = [...seenNames].some((name) => isSessionTokenCookieName(name));

    const sessionToken = String(
        (options.useEnvironment !== false && process.env.CHATGPT_SESSION_COOKIE)
        || (options.useEnvironment !== false && process.env.CHATGPT_SESSION_TOKEN)
        || sessionData?.sessionToken
        || sessionData?.session_token
        || sessionData?.['__Secure-next-auth.session-token']
        || ''
    ).trim();

    if (sessionToken && !hasExportedSessionToken) {
        const chunks = expandSessionTokenCookies(sessionToken);
        if (chunks.length > 1) {
            console.log(`[Session] session-token 长度 ${sessionToken.length}，按 NextAuth 分 ${chunks.length} 块注入`);
        }
        for (const chunk of chunks) {
            push(chunk.name, chunk.value);
        }
    }

    const csrfToken = String(
        sessionData?.csrfToken
        || sessionData?.csrf_token
        || sessionData?.['__Host-next-auth.csrf-token']
        || ''
    ).trim();
    if (csrfToken && !seenNames.has('__Host-next-auth.csrf-token')) {
        push('__Host-next-auth.csrf-token', csrfToken);
    }

    const deviceId = String(sessionData?.deviceId || sessionData?.device_id || sessionData?.['oai-did'] || '').trim();
    if (deviceId && !seenNames.has('oai-did')) {
        push('oai-did', deviceId);
    }

    return specs;
}

async function verifyRealSessionApi(context, options = {}) {
    const borrowedPage = options.transport === 'fetch' && options.page;
    const probe = borrowedPage || await context.newPage();
    let verified = false;
    try {
        if (borrowedPage && (probe.context() !== context || new URL(probe.url()).origin !== CHATGPT_COOKIE_URL)) {
            return { ok: false, code: 'SESSION_LOGIN_REQUIRED', error: 'Session 校验页面不属于当前 chatgpt.com 浏览器上下文' };
        }
        let response = borrowedPage ? null : await probe.goto(options.transport === 'fetch' ? `${CHATGPT_COOKIE_URL}/` : `${CHATGPT_COOKIE_URL}/api/auth/session`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        // In a fresh browser, use the normal same-origin session request after
        // loading the site. Never retry a denied landing page or solve challenges.
        let fetchReady = !!borrowedPage || (response?.status() >= 200 && response.status() < 300);
        if (options.transport === 'fetch' && response?.headers?.()['cf-mitigated'] === 'challenge' && options.onChallenge) {
            await options.onChallenge(probe);
            fetchReady = true; // The actual session fetch below must still authenticate.
        }
        if (options.transport === 'fetch' && fetchReady) {
            if (new URL(probe.url()).origin !== CHATGPT_COOKIE_URL) {
                return { ok: false, code: 'SESSION_LOGIN_REQUIRED', error: 'Session 校验页面已离开 chatgpt.com，停止认证请求' };
            }
            const result = await probe.evaluate(async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 30000);
                try {
                    const result = await fetch('/api/auth/session', {
                        credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' },
                        signal: controller.signal, redirect: 'error'
                    });
                    return { status: result.status, headers: Object.fromEntries(result.headers), body: await result.text() };
                } finally { clearTimeout(timer); }
            });
            response = { status: () => result.status, headers: () => result.headers, text: async () => result.body };
            if (result.headers['cf-mitigated'] === 'challenge' && options.onChallenge) {
                response = await require('./session-challenge-page').openSessionChallenge(probe, options.onChallenge);
            }
        }
        const status = response?.status() || 0;
        const headers = response?.headers?.() || {};
        const headerText = Object.keys(headers).map((k) => `${k}:${headers[k]}`).join('\n').toLowerCase();
        // JSON and challenge responses can have an empty DOM even with a nonempty body.
        // Read the actual network response before falling back to the rendered page.
        let bodyText;
        try {
            bodyText = await response.text();
        } catch (_) {
            bodyText = await probe.evaluate(() => document.body?.innerText || '').catch(() => '');
        }
        let data = null;
        try {
            data = JSON.parse(bodyText);
        } catch (_) {
            data = null;
        }
        if (status >= 200 && status < 300 && (data?.accessToken || data?.user?.email || data?.user?.id)) {
            verified = true;
            return { ok: true, data, status };
        }
        const isCloudflareChallenge = /^cf-mitigated:\s*challenge\s*$/m.test(headerText)
            || /just a moment|verify you are human/i.test(bodyText);
        if (isCloudflareChallenge) {
            return {
                ok: false,
                status,
                challenge: true,
                code: 'SESSION_HUMAN_VERIFICATION_REQUIRED',
                error: `Cloudflare 真人验证拦截（HTTP ${status}），尚未验证 Session。`
                    + '请在运行任务的同一浏览器和代理环境中手动完成验证后重试；已停止后续流程'
            };
        }
        // A denied/empty response does not establish that the session Cookie expired.
        // Do not copy arbitrary response bodies into logs: they may contain credentials.
        const contentType = String(headers['content-type'] || '').split(';')[0];
        const responseKind = data !== null ? 'JSON' : /html/i.test(contentType) ? 'HTML' : bodyText.trim() ? '非 JSON' : '空响应';
        const diagnostic = `HTTP ${status}，${responseKind}`;
        if (status === 403) {
            return {
                ok: false,
                status,
                error: `Session 校验请求被拒绝（/api/auth/session，${diagnostic}）。`
                    + '尚无法确认 Cookie 是否有效；请检查浏览器中的访问限制或真人验证，以及代理连接'
            };
        }
        if (status !== 401 && !(status >= 200 && status < 300)) {
            return {
                ok: false,
                status,
                error: `Session 校验服务异常（/api/auth/session，${diagnostic}），未能确认登录状态，请稍后重试或检查网络`
            };
        }
        return {
            ok: false,
            status,
            error: `session-token 未被 ChatGPT 接受（/api/auth/session 无用户信息，${diagnostic}）。`
                + '请确认 Cookie 未过期，并尽量粘贴浏览器全部 chatgpt.com Cookies（cookies[] 或 cookieHeader）'
        };
    } catch (err) {
        return { ok: false, code: err.code === 'SESSION_HUMAN_VERIFICATION_REQUIRED' ? err.code : 'SESSION_TRANSPORT_FAILED', error: `无法验证 session Cookie: ${String(err.message).split(/\r?\n/)[0]}` };
    } finally {
        if (!verified && typeof options.onFailure === 'function') {
            try {
                await options.onFailure(probe);
            } catch (_) {
                console.warn('[Session] 校验失败页面截图未能保存');
            }
        }
        if (!borrowedPage) await probe.close().catch(() => {});
    }
}

function extractAccessTokenFromRaw(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return '';
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        return String(sessionJson.accessToken || sessionJson.access_token || '').trim();
    }

    const jwtMatch = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwtMatch) {
        return jwtMatch[0];
    }

    return content;
}

/**
 * 统一解析用户输入：优先完整 Session JSON，其次裸 AccessToken
 */
function resolveSessionInput(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return null;
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        const accessToken = extractAccessTokenFromRaw(content);
        if (!accessToken) {
            return null;
        }
        return {
            accessToken,
            sessionJson,
            sessionData: buildSessionPayload(accessToken, sessionJson),
            rawJson: JSON.stringify(sessionJson)
        };
    }

    const accessToken = extractAccessTokenFromRaw(content);
    if (!accessToken) {
        return null;
    }

    const sessionData = buildSessionPayload(accessToken, null);
    return {
        accessToken,
        sessionJson: null,
        sessionData,
        rawJson: JSON.stringify(sessionData)
    };
}

async function assertChatGptLoggedIn(page, label = '页面') {
    const url = page.url();
    if (isLoginRedirectUrl(url)) {
        throw new Error(`Session 未生效：${label} 跳转到 Google/登录页 (${url.slice(0, 80)})`);
    }
    if (await isLoginPageContent(page)) {
        throw new Error(`Session 未生效：${label} 显示 Google 登录界面，请粘贴完整 Session JSON`);
    }
}

function attachLoginRedirectGuard(page) {
    page.on('framenavigated', async (frame) => {
        if (frame !== page.mainFrame() || page.isClosed()) {
            return;
        }
        const url = frame.url();
        const current = page.url();
        if (isCheckoutPageUrl(current) || isCheckoutPageUrl(url)) {
            return;
        }
        if (!isHardLoginRedirectUrl(url)) {
            return;
        }
        console.warn(`[Warn] 检测到登录页跳转，正在拉回 ChatGPT: ${url.slice(0, 80)}`);
        await page.goto(`${CHATGPT_ORIGIN}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        }).catch(() => {});
    });
}

/**
 * 在浏览器上下文安装 Session：拦截 auth API + 注入 fetch 补丁
 * 注意：__Secure-next-auth.session-token 是加密 cookie，不能用 accessToken 冒充
 */
async function installChatGptSession(context, sessionRaw, options = {}) {
    if (options.nativeSession) {
        // Fresh server contexts have no previous login to probe or preserve.
        let switched = false;
        let check = options.freshContext ? { ok: false }
            : await verifyRealSessionApi(context, { onFailure: options.onVerificationFailure, transport: options.sessionTransport, onChallenge: options.onVerificationRequired, page: options.page });
        if (!check.ok && check.challenge) throw Object.assign(new Error(check.error), { code: check.code, httpStatus: check.status });
        const expectedEmail = extractEmailFromSession(sessionRaw).toLowerCase();
        if (!expectedEmail) throw new Error('Session 缺少账号邮箱，无法验证切换目标');
        const matches = result => result.ok && result.data?.accessToken
            && String(result.data.user?.email || '').trim().toLowerCase() === expectedEmail;
        if (!matches(check)) {
            const resolved = resolveSessionInput(sessionRaw);
            // Only use credentials provided for this task, never global account cookies.
            const specs = collectCookieSpecs(resolved.sessionData, resolved.sessionJson, { useEnvironment: false })
                .filter(cookie => isSessionTokenCookieName(cookie.name));
            if (!specs.length) {
                throw new Error('浏览器登录账号与粘贴的 Session 不一致或尚未登录；自动切换需要有效的 sessionToken（或 cookies[] / cookieHeader 中的登录 Cookie），仅 accessToken 不足以切换官网登录账号');
            }
            const names = specs.map(cookie => cookie.name);
            const chunks = specs.filter(cookie => cookie.name !== SESSION_TOKEN_BASE)
                .sort((a, b) => Number(a.name.split('.').at(-1)) - Number(b.name.split('.').at(-1)));
            if (new Set(names).size !== names.length || (chunks.length && names.includes(SESSION_TOKEN_BASE))
                || chunks.some((cookie, i) => cookie.name !== `${SESSION_TOKEN_BASE}.${i}`)) {
                throw new Error('Session 登录 Cookie 分块重复、缺失或格式不正确，请重新导出');
            }
            const tokenValue = (chunks.length ? chunks : specs).map(cookie => sanitizeCookieValue(cookie.value)).join('');
            if (!tokenValue || tokenValue === resolved.accessToken) throw new Error('sessionToken 不能使用 accessToken 代替，请提供真实登录 Cookie');
            const incoming = expandSessionTokenCookies(tokenValue).map(toPlaywrightCookie);
            const authCookie = cookie => isSessionTokenCookieName(cookie.name) || cookie.name === '__Host-next-auth.csrf-token';
            const previous = (await context.cookies(CHATGPT_COOKIE_URL)).filter(authCookie);
            const clearAuth = async () => {
                for (const cookie of (await context.cookies(CHATGPT_COOKIE_URL)).filter(authCookie)) {
                    await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
                }
            };
            console.log('[Session] 正在使用本次提交的登录 Cookie 切换浏览器账号...');
            try {
                await clearAuth();
                await context.addCookies(incoming);
                check = await verifyRealSessionApi(context, { onFailure: options.onVerificationFailure, transport: options.sessionTransport, onChallenge: options.onVerificationRequired, page: options.page });
                if (!matches(check)) throw new Error(check.error || '切换后的真实登录账号与目标 Session 不一致');
                switched = true;
            } catch (error) {
                try {
                    await clearAuth();
                    if (previous.length) await context.addCookies(previous);
                } catch (_) {
                    throw new Error('Session 切换失败且旧登录恢复失败，请更新有效登录 Session 后重试');
                }
                // Browser errors can include Cookie values; only expose our own verification message.
                const failure = new Error(`Session 自动切换失败，已恢复原登录：${check?.error || (matches(check) ? '写入登录 Cookie 失败' : '新登录 Cookie 无效或账号不匹配，请更新 Session 后重试')}`);
                failure.code = check?.code || 'SESSION_VERIFICATION_FAILED';
                failure.httpStatus = check?.status;
                throw failure;
            }
            console.log('[Session] 已切换并验证本次 Session 的真实登录账号');
        }
        console.log('[Session] 已验证浏览器的真实登录状态，使用当前 Session');
        return { sessionData: check.data, cookieVerified: true, switched };
    }
    const resolved = resolveSessionInput(sessionRaw);
    if (!resolved?.accessToken) {
        throw new Error('缺少 Session：请粘贴完整 Session JSON（来自 chatgpt.com/api/auth/session）');
    }

    const { accessToken: token, sessionData, sessionJson } = resolved;
    const sessionBody = JSON.stringify(sessionData);
    const cookieSpecs = collectCookieSpecs(sessionData, sessionJson);

    const sessionTokenValue = String(
        process.env.CHATGPT_SESSION_COOKIE
        || process.env.CHATGPT_SESSION_TOKEN
        || sessionData?.sessionToken
        || sessionData?.session_token
        || sessionData?.['__Secure-next-auth.session-token']
        || cookieSpecs.find((c) => c.name === SESSION_TOKEN_BASE)?.value
        || ''
    ).trim();

    if (sessionTokenValue && sessionTokenValue === token) {
        throw new Error(
            'sessionToken 与 accessToken 相同：请从浏览器 DevTools → Application → Cookies 复制 '
            + '__Secure-next-auth.session-token（不是 /api/auth/session JSON 里的 accessToken）'
        );
    }

    const injectResult = await injectChatGptCookies(context, cookieSpecs);

    const sessionTokenFailed = injectResult.failed?.filter((item) => isSessionTokenCookieName(item.name)) || [];

    if (sessionTokenValue && sessionTokenFailed.length) {
        throw new Error(
            `session-token Cookie 注入失败: ${sessionTokenFailed.map((item) => `${item.name}(${item.error})`).join('; ')}`
        );
    }

    if (!injectResult.hasSessionToken) {
        console.warn('[Session] 未提供 session-token Cookie，Checkout 会停留在登录页；'
            + '请导出 __Secure-next-auth.session-token，或粘贴完整 cookies[] / cookieHeader');
    } else {
        console.log(
            `[Session] 已注入 ${injectResult.injected} 个 Cookie（session-token ${sessionTokenValue ? `${sessionTokenValue.length} 字符` : '来自 cookies[]'}）`
        );
    }

    let cookieVerified = false;
    if (injectResult.hasSessionToken) {
        const apiCheck = await verifyRealSessionApi(context, { onFailure: options.onVerificationFailure });
        if (apiCheck.ok) {
            cookieVerified = true;
            const email = apiCheck.data?.user?.email || '';
            console.log(`[Session] Cookie 校验通过${email ? `: ${email}` : ''}`);
        } else {
            const error = new Error(apiCheck.error || 'Session 在线校验失败');
            error.code = apiCheck.code || 'SESSION_VERIFICATION_FAILED';
            throw error;
        }
    }

    await context.addInitScript((payload) => {
        const sessionStr = JSON.stringify(payload);
        try {
            window.__CHATGPT_BOOTSTRAP_SESSION__ = payload;
            localStorage.setItem('oai/apps/chat/bootstrap-session', sessionStr);
        } catch (_) { /* ignore */ }

        const originalFetch = window.fetch.bind(window);
        window.fetch = async function patchedFetch(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('/api/auth/session')) {
                return new Response(sessionStr, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.includes('/api/auth/csrf')) {
                return new Response(JSON.stringify({ csrfToken: 'bootstrap-csrf-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return originalFetch(input, init);
        };
    }, sessionData);

    await context.route(/\/api\/auth\/session(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: sessionBody
        });
    });

    await context.route(/\/api\/auth\/csrf(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ csrfToken: 'bootstrap-csrf-token' })
        });
    });

    await context.route('**/*', async (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();
        if (shouldBlockLoginNavigation(url, resourceType)) {
            await route.abort();
            return;
        }
        if (/\/api\/auth\/(session|csrf)/.test(url)) {
            await route.continue();
            return;
        }
        if (url.includes('auth.openai.com') || url.includes('chatgpt.com') || url.includes('openai.com') || url.includes('pay.openai.com')) {
            await route.continue({
                headers: {
                    ...route.request().headers(),
                    Authorization: `Bearer ${token}`
                }
            });
            return;
        }
        await route.continue();
    });

    return { sessionData, cookieVerified };
}

/**
 * @deprecated 使用 installChatGptSession(context, sessionRaw)
 */
function setupChatGptSessionAuth(context, accessToken) {
    return installChatGptSession(context, accessToken);
}

/**
 * 打开 ChatGPT 并验证 Session 在浏览器 UI 中生效
 */
async function bootstrapChatGptSession(page, sessionRaw, options = {}) {
    const resolved = resolveSessionInput(sessionRaw);
    if (!resolved?.accessToken) {
        throw new Error('缺少 Session：请粘贴完整 Session JSON');
    }

    const sessionData = options.sessionData || resolved.sessionData;
    const email = sessionData?.user?.email || extractProfileFromToken(resolved.accessToken).email || '';

    if (!email && !sessionData?.user?.id) {
        throw new Error('Session 无效：JSON 中缺少 user 信息，请从 chatgpt.com/api/auth/session 复制完整内容');
    }

    console.log('🔐 [步骤] 正在使用 Session 登录 ChatGPT...');
    attachLoginRedirectGuard(page);

    await page.goto(`${CHATGPT_ORIGIN}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
    });
    await page.waitForTimeout(2500);

    const { clearHumanVerification } = require('./human-verification');
    const captchaResult = await clearHumanVerification(page, {
        phase: 'session-bootstrap',
        maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 180000),
        maxBypassRounds: 6
    });
    if (!captchaResult.cleared) {
        throw new Error('Cloudflare 人机验证未能通过，请换住宅代理 IP 或 HEADFUL=1 人工勾选');
    }

    if (await hasVisibleLoginChrome(page)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await page.waitForTimeout(2000);
    }

    await assertChatGptLoggedIn(page, '首页');

    const cookieVerified = options.cookieVerified === true;
    const uiReady = await waitForLoggedInChatUi(page, cookieVerified ? 12000 : 8000);
    const apiReady = cookieVerified ? await hasLoggedInSessionApi(page) : false;

    if (await hasVisibleLoginChrome(page)) {
        throw new Error(buildSessionNotLoggedInError('ChatGPT 首页'));
    }
    if (!uiReady && !apiReady) {
        throw new Error(buildSessionNotLoggedInError('ChatGPT 首页'));
    }
    if (!uiReady && apiReady) {
        console.log('[Session] 首页 UI 探针未命中，但 /api/auth/session 已确认登录，继续流程');
    }

    const resolvedEmail = sessionData?.user?.email || email || extractProfileFromToken(resolved.accessToken).email;
    console.log(`✅ [步骤] Session 登录成功: ${resolvedEmail}`);
    return {
        email: resolvedEmail,
        session: sessionData,
        hasSessionCookie: Boolean(
            process.env.CHATGPT_SESSION_COOKIE
            || process.env.CHATGPT_SESSION_TOKEN
            || sessionData.sessionToken
            || sessionData.session_token
            || sessionData['__Secure-next-auth.session-token']
            || (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0)
            || sessionData.cookieHeader
            || sessionData.cookie_header
        )
    };
}

function extractSessionPreview(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return String(raw || '').slice(0, 32);
    }
    const email = resolved.sessionData?.user?.email;
    if (email) {
        return email;
    }
    return `${resolved.accessToken.slice(0, 12)}...`;
}

function extractEmailFromSession(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return '';
    }
    return String(
        resolved.sessionData?.user?.email
        || resolved.sessionJson?.user?.email
        || extractProfileFromToken(resolved.accessToken).email
        || ''
    ).trim();
}

module.exports = {
    CHATGPT_ORIGIN,
    installChatGptSession,
    setupChatGptSessionAuth,
    bootstrapChatGptSession,
    assertChatGptLoggedIn,
    parseSessionJson,
    resolveSessionInput,
    extractAccessTokenFromRaw,
    extractProfileFromToken,
    extractSessionPreview,
    extractEmailFromSession,
    buildSessionPayload,
    verifyRealSessionApi,
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    isLoginPageContent
};
