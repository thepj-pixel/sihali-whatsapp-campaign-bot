// Dashboard login tests: hashing, login/logout, lockout, PIN fallback, admin-only APIs, 401s, session persistence.
// Spawns server.js (DASHBOARD_ONLY) with temp user/session/audit files. `npm run test:login`.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const auth = require('./dashboard_auth.js');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-login-'));
const files = { DASHBOARD_USERS_PATH: path.join(tmp, 'users.json'), DASHBOARD_SESSIONS_PATH: path.join(tmp, 'sessions.json'), DASHBOARD_AUDIT_PATH: path.join(tmp, 'audit.jsonl') };
const PIN = '2026';

function start(port) {
    const proc = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, ...files, DASHBOARD_ONLY: 'true', PORT: String(port), CAMPAIGN_PIN: PIN,
        BROADCAST_STATE_PATH: path.join(tmp, 'bc.json'), OPERATOR_CONTROL_FILE: path.join(tmp, 'oc.json'), CONTACTS_DB_PATH: path.join(tmp, 'contacts.json'), CAMPAIGN_AGENDA_PATH: path.join(tmp, 'agenda.json') } });
    return proc;
}
async function waitUp(base) {
    for (let i = 0; i < 600; i++) { try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    return false;
}
const cookieOf = (r, name = 'dash_session') => {
    const all = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const c = all.find(x => x.startsWith(name + '='));
    return c || '';
};
const tokenOf = (sc) => (sc.match(/^dash_session=([^;]*)/) || [])[1] || '';

(async () => {
    // ---------- units ----------
    const h = await auth.hashPassword('correct horse');
    check('hash: salt + 128-hex scrypt hash, no plaintext', /^[0-9a-f]{32}$/.test(h.salt) && /^[0-9a-f]{128}$/.test(h.hash) && !JSON.stringify(h).includes('correct horse'));
    check('hash: verify ok', await auth.verifyPassword('correct horse', h));
    check('hash: verify wrong', !(await auth.verifyPassword('correct horsE', h)));
    const h2 = await auth.hashPassword('correct horse');
    check('hash: random salt per hash', h2.salt !== h.salt && h2.hash !== h.hash);
    check('cidr: CF v4', auth.isCloudflare('104.16.1.1') && auth.isCloudflare('::ffff:172.64.0.9') && !auth.isCloudflare('136.80.218.29') && !auth.isCloudflare('127.0.0.1'));
    check('cidr: CF v6', auth.isCloudflare('2606:4700::6810:1') && auth.isCloudflare('2a06:98c7::1') && !auth.isCloudflare('2001:db8::1'));

    const port = 34000 + Math.floor(Math.random() * 500);
    const base = `http://127.0.0.1:${port}`;
    let proc = start(port);
    try {
        check('server up', await waitUp(base));
        const PH = { 'x-campaign-pin': PIN, 'content-type': 'application/json' };
        const J = (o) => JSON.stringify(o);

        // ---------- 401s / public ----------
        for (const p of ['/api/messages', '/api/debug', '/api/dashboard-users', '/api/me', '/api/audit', '/api/overview']) {
            const r = await fetch(base + p);
            check('unauth 401 ' + p, r.status === 401);
        }
        const rPost = await fetch(base + '/api/send-message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ phone: '9999999999' }) });
        check('unauth POST /api/send-message 401', rPost.status === 401);
        const health = await (await fetch(base + '/health')).json();
        check('/health public, minimal', health.status === 'ok' && typeof health.uptime === 'number' && !('sessions' in health) && !('outbound' in health) && !('publicDashboardUrl' in health) && !('incomingQueue' in health), health);
        const healthPin = await (await fetch(base + '/health', { headers: PH })).json();
        check('/health detailed with PIN', Array.isArray(healthPin.sessions));
        const page0 = await fetch(base + '/');
        const html0 = await page0.text();
        check('unauth / -> login page (401), no dashboard', page0.status === 401 && html0.includes('name="pin"') && !html0.includes('tab-btn-bulk'));
        check('no users yet -> PIN form only', !html0.includes('name="password"'));
        check('wrong ?pin -> still login page', (await fetch(base + '/?pin=0000')).status === 401);

        // ---------- PIN fallback ----------
        const me = await (await fetch(base + '/api/me', { headers: PH })).json();
        check('PIN header -> admin', me.username === 'PIN' && me.role === 'admin' && me.via === 'pin', me);
        const rq = await fetch(base + '/?pin=' + PIN);
        const qc = cookieOf(rq);
        const qhtml = await rq.text();
        check('?pin= serves dashboard + sets session cookie (not the PIN)', rq.status === 200 && qhtml.includes('tab-btn-bulk') && /HttpOnly/.test(qc) && /SameSite=Lax/.test(qc) && !qc.includes('=' + PIN + ';') && tokenOf(qc).length >= 40, qc);
        const meQ = await (await fetch(base + '/api/me', { headers: { cookie: 'dash_session=' + tokenOf(qc) } })).json();
        check('PIN session cookie works', meQ.username === 'PIN' && meQ.role === 'admin');
        const leg = await fetch(base + '/api/me', { headers: { cookie: 'campaign_pin=' + PIN } });
        check('legacy campaign_pin cookie accepted + upgraded', leg.status === 200 && tokenOf(cookieOf(leg)).length >= 40 && /campaign_pin=;/.test(cookieOf(leg, 'campaign_pin')));
        const pinForm = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'mode=pin&pin=' + PIN + '&next=%2F' });
        check('PIN form login -> 303 + cookie', pinForm.status === 303 && tokenOf(cookieOf(pinForm)).length >= 40);
        check('admin dashboard has users section + logout', qhtml.includes('id="dash-users-section"') && qhtml.includes('action="/logout"') && qhtml.includes('👤 PIN'));

        // ---------- admin APIs ----------
        let r = await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'Alice', password: 'alice-pass-123', role: 'member' }) });
        let j = await r.json();
        check('create member (username lowercased)', r.status === 201 && j.created === true && j.user.username === 'alice' && j.user.role === 'member', j);
        r = await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'bob', password: 'bob-pass-12345', role: 'admin' }) });
        check('create admin', r.status === 201);
        r = await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'carol', password: 'carol-pass-123' }) });
        check('create default role member', (await r.json()).user.role === 'member');
        check('short password rejected', (await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'dave', password: 'short' }) })).status === 400);
        check('bad username rejected', (await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'a b<c>', password: 'longenough1' }) })).status === 400);
        check('bad role rejected', (await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'dave', password: 'longenough1', role: 'root' }) })).status === 400);
        check('reserved PIN username rejected', (await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'pin', password: 'longenough1' }) })).status === 400);
        const list = await (await fetch(base + '/api/dashboard-users', { headers: PH })).json();
        check('list has users, no hashes/salts', list.users.length === 3 && !JSON.stringify(list).match(/hash|salt/) && list.users.every(u => 'disabled' in u && 'createdAt' in u), list);
        const store = fs.readFileSync(files.DASHBOARD_USERS_PATH, 'utf8');
        check('store: scrypt hash, no plaintext', !store.includes('alice-pass-123') && !store.includes('bob-pass-12345') && /"hash": "[0-9a-f]{128}"/.test(store) && /"salt"/.test(store));
        check('store file mode 0600', (fs.statSync(files.DASHBOARD_USERS_PATH).mode & 0o777) === 0o600);

        const page1 = await (await fetch(base + '/login')).text();
        check('with users: username/password default + "PIN से लॉगिन" link', page1.includes('name="username"') && page1.includes('name="password"') && page1.includes('PIN से लॉगिन') && /font-size:16px/.test(page1));

        // ---------- password login ----------
        const login = (u, p, extra = {}) => fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...extra }, body: J({ username: u, password: p }) });
        r = await login('ALICE', 'alice-pass-123');
        const ac = cookieOf(r); j = await r.json();
        check('login case-insensitive -> session', r.status === 200 && j.username === 'alice' && j.role === 'member' && tokenOf(ac).length >= 40, j);
        check('cookie HttpOnly SameSite=Lax 30d, no Secure on http', /HttpOnly/.test(ac) && /SameSite=Lax/.test(ac) && /Max-Age=2592000/.test(ac) && !/Secure/.test(ac), ac);
        const rs = await login('bob', 'bob-pass-12345', { 'x-forwarded-proto': 'https' });
        check('Secure cookie behind https proxy', /; Secure/.test(cookieOf(rs)));
        const A = { cookie: 'dash_session=' + tokenOf(ac), 'content-type': 'application/json' };
        const B = { cookie: 'dash_session=' + tokenOf(cookieOf(rs)), 'content-type': 'application/json' };
        check('member /api/me', (await (await fetch(base + '/api/me', { headers: A })).json()).username === 'alice');
        check('member -> admin API 403', (await fetch(base + '/api/dashboard-users', { headers: A })).status === 403 && (await fetch(base + '/api/dashboard-users', { method: 'POST', headers: A, body: J({ username: 'eve', password: 'eve-pass-123', role: 'admin' }) })).status === 403);
        check('member -> /api/audit 403', (await fetch(base + '/api/audit', { headers: A })).status === 403);
        check('member -> /api/debug 403, /update 403', (await fetch(base + '/api/debug', { headers: A })).status === 403 && (await fetch(base + '/update', { headers: A })).status === 403);
        check('member can use operator APIs', (await fetch(base + '/api/overview', { headers: A })).status === 200);
        const mhtml = await (await fetch(base + '/', { headers: A })).text();
        check('member dashboard: username + logout, no users section, no Pull GitHub', mhtml.includes('👤 alice') && mhtml.includes('action="/logout"') && !mhtml.includes('id="dash-users-section"') && !mhtml.includes('href="/update"'));
        check('admin (bob) session can use admin API', (await fetch(base + '/api/dashboard-users', { headers: B })).status === 200);
        const form = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=carol&password=carol-pass-123&next=%2F%2Fevil.example' });
        check('form login 303, open redirect blocked', form.status === 303 && form.headers.get('location') === '/', form.headers.get('location'));
        const bad = await login('alice', 'wrong-pass');
        check('wrong password 401, no cookie', bad.status === 401 && !cookieOf(bad));
        const badForm = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=alice&password=nope' });
        const badHtml = await badForm.text();
        check('form wrong password -> page with Hindi error', badForm.status === 401 && badHtml.includes('यूज़रनेम या पासवर्ड गलत है'));

        // ---------- audit ----------
        r = await fetch(base + '/api/control/default-mode', { method: 'POST', headers: A, body: J({ mode: 'normal' }) });
        check('member edit ok', r.status === 200);
        await fetch(base + '/api/control/day', { method: 'POST', headers: B, body: J({ goal: 'audit test goal' }) });
        await new Promise(r => setTimeout(r, 100));
        const au = await (await fetch(base + '/api/audit?limit=50', { headers: PH })).json();
        const e1 = au.entries.find(e => e.action === 'default_mode');
        const e2 = au.entries.find(e => e.action === 'daily_lock');
        check('audit: who changed mode (alice)', e1 && e1.username === 'alice' && e1.label && e1.detail.mode === 'normal', e1);
        check('audit: who edited daily lock (bob)', e2 && e2.username === 'bob', e2);
        check('audit: user create by PIN recorded', au.entries.some(e => e.action === 'users_admin' && e.username === 'PIN'));
        check('audit: logins recorded', au.entries.some(e => e.action === 'login' && e.username === 'alice'));
        const auditRaw = fs.readFileSync(files.DASHBOARD_AUDIT_PATH, 'utf8');
        check('audit: no passwords/PIN in log', !auditRaw.includes('alice-pass-123') && !auditRaw.includes('carol-pass-123') && !/"pin":/.test(auditRaw) && !auditRaw.includes('"password":'));
        check('audit filter by user', (await (await fetch(base + '/api/audit?user=alice', { headers: PH })).json()).entries.every(e => e.username === 'alice'));

        // ---------- lockout ----------
        for (let i = 0; i < 5; i++) await login('carol', 'wrong-' + i);
        const lk = await login('carol', 'carol-pass-123');
        check('lockout after 5 fails (even correct pw) -> 429 + Retry-After', lk.status === 429 && Number(lk.headers.get('retry-after')) > 0);
        const spoof = await login('carol', 'carol-pass-123', { 'cf-connecting-ip': '203.0.113.9' });
        check('spoofed CF-Connecting-IP from non-CF peer does not bypass', spoof.status === 429);
        // From a local proxy (loopback peer) the last X-Forwarded-For hop is the visitor: a different visitor is not locked,
        // and a CF edge hop makes CF-Connecting-IP the visitor.
        check('different visitor via proxy XFF not locked', (await login('carol', 'carol-pass-123', { 'x-forwarded-for': '198.51.100.7' })).status === 200);
        for (let i = 0; i < 5; i++) await login('carol', 'bad-' + i, { 'x-forwarded-for': '162.158.1.1', 'cf-connecting-ip': '198.51.100.20' });
        check('CF visitor locked by CF-Connecting-IP', (await login('carol', 'carol-pass-123', { 'x-forwarded-for': '162.158.1.1', 'cf-connecting-ip': '198.51.100.20' })).status === 429);
        check('another CF visitor through same edge not locked', (await login('carol', 'carol-pass-123', { 'x-forwarded-for': '162.158.1.1', 'cf-connecting-ip': '198.51.100.21' })).status === 200);
        check('other username same IP not locked', (await login('alice', 'alice-pass-123')).status === 200);
        check('existing carol session unaffected? (bob ok)', (await fetch(base + '/api/me', { headers: B })).status === 200);

        // ---------- disable / enable / delete / password change ----------
        r = await fetch(base + '/api/dashboard-users/alice/disable', { method: 'POST', headers: PH });
        check('disable -> user.disabled', (await r.json()).user.disabled === true);
        check('disabled user session revoked', (await fetch(base + '/api/me', { headers: A })).status === 401);
        check('disabled user cannot log in', (await login('alice', 'alice-pass-123')).status === 401);
        check('enable', (await (await fetch(base + '/api/dashboard-users/alice/enable', { method: 'POST', headers: PH })).json()).user.disabled === false);
        const a2 = cookieOf(await login('alice', 'alice-pass-123'));
        const A2 = { cookie: 'dash_session=' + tokenOf(a2) };
        check('re-enabled login ok', (await fetch(base + '/api/me', { headers: A2 })).status === 200);
        r = await fetch(base + '/api/dashboard-users', { method: 'POST', headers: PH, body: J({ username: 'alice', password: 'alice-new-pass-1' }) });
        check('update password (200, created:false)', r.status === 200 && (await r.json()).created === false);
        check('password change ends old sessions', (await fetch(base + '/api/me', { headers: A2 })).status === 401);
        check('old password rejected, new accepted', (await login('alice', 'alice-pass-123')).status === 401 && (await login('alice', 'alice-new-pass-1')).status === 200);
        check('admin cannot delete self', (await fetch(base + '/api/dashboard-users/bob', { method: 'DELETE', headers: B })).status === 400);
        check('delete unknown 404', (await fetch(base + '/api/dashboard-users/nobody', { method: 'DELETE', headers: PH })).status === 404);

        // ---------- logout ----------
        const lo = await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie: B.cookie } });
        check('logout 303 -> /login, cookie cleared', lo.status === 303 && lo.headers.get('location') === '/login' && /Max-Age=0/.test(cookieOf(lo)));
        check('logged-out session 401', (await fetch(base + '/api/me', { headers: B })).status === 401);

        // ---------- persistence across restart ----------
        const c3 = cookieOf(await login('carol2', 'x')); // unknown user, no cookie
        check('unknown user no cookie', !c3);
        const bobTok = tokenOf(cookieOf(await login('bob', 'bob-pass-12345')));
        const sessRaw = fs.readFileSync(files.DASHBOARD_SESSIONS_PATH, 'utf8');
        check('sessions file stores token hashes only', !sessRaw.includes(bobTok) && /"id": "[0-9a-f]{64}"/.test(sessRaw));
        proc.kill(); await new Promise(r => setTimeout(r, 400));
        proc = start(port);
        check('server restarted', await waitUp(base));
        const meB = await (await fetch(base + '/api/me', { headers: { cookie: 'dash_session=' + bobTok } })).json();
        check('session survives restart', meB.username === 'bob' && meB.role === 'admin', meB);
        check('users survive restart', (await (await fetch(base + '/api/dashboard-users', { headers: PH })).json()).users.length === 3);
        r = await fetch(base + '/api/dashboard-users/carol', { method: 'DELETE', headers: PH });
        check('DELETE user', (await r.json()).deleted === 'carol');

        // ---------- PIN lockout (last: locks this IP's PIN attempts) ----------
        for (let i = 0; i < 5; i++) await fetch(base + '/api/me', { headers: { 'x-campaign-pin': '99' + i } });
        const pl = await fetch(base + '/api/me', { headers: PH });
        check('PIN lockout after 5 wrong header PINs -> 429', pl.status === 429);
        check('session still works during PIN lockout', (await fetch(base + '/api/me', { headers: { cookie: 'dash_session=' + bobTok } })).status === 200);
    } catch (e) {
        failed++; console.log('FAIL exception', e && e.stack);
    } finally {
        proc.kill();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
