/**
 * Dashboard login: per-person username + password (scrypt), server-side sessions, lockout, audit log.
 * The old campaign PIN (x-campaign-pin header, ?pin=, PIN form, legacy campaign_pin cookie) keeps working as an
 * admin fallback so automation and the owner never break.
 *
 * Files (all gitignored, written 0600, atomically):
 *   dashboard_users.json     {users:[{username, salt, hash, algo:{N,r,p,keylen}, role, createdAt, updatedAt, disabled}]}
 *   dashboard_sessions.json  {sessions:[{id: sha256(token), username, role, via, createdAt, expiresAt}]}  (raw tokens never stored)
 *   dashboard_audit.jsonl    one JSON line per operator action {ts, username, role, via, action, label, method, path, status, detail}
 * Paths can be overridden with DASHBOARD_USERS_PATH / DASHBOARD_SESSIONS_PATH / DASHBOARD_AUDIT_PATH (tests).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_COOKIE = 'dash_session';
const LEGACY_PIN_COOKIE = 'campaign_pin';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS = 500;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;                 // per IP + username (or IP + PIN) per 15 min
const MAX_FAILS_PER_USER = 25;       // per username across all IPs per 15 min (distributed guessing)
const MAX_FAILS_PIN_GLOBAL = 100;    // all PIN guesses across all IPs per 15 min
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ROLES = ['admin', 'member'];
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const PIN_USER = 'PIN';

// Cloudflare edge ranges (https://www.cloudflare.com/ips-v4, /ips-v6). CF-Connecting-IP is trusted only from these.
const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

function v4ToInt(ip) {
    const p = String(ip).split('.');
    if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3]);
}
function v6ToBig(ip) {
    let s = String(ip).toLowerCase().split('%')[0];
    if (!s.includes(':')) return null;
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const a = halves[0] ? halves[0].split(':') : [];
    const b = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - a.length - b.length : 0;
    const parts = a.concat(new Array(Math.max(0, fill)).fill('0'), b);
    if (parts.length !== 8 || parts.some(h => !/^[0-9a-f]{1,4}$/.test(h))) return null;
    return parts.reduce((acc, h) => (acc << 16n) + BigInt(parseInt(h, 16)), 0n);
}
function inCidr(ip, cidr) {
    const [base, bitsS] = cidr.split('/');
    const bits = Number(bitsS);
    if (base.includes(':')) {
        const x = v6ToBig(ip), y = v6ToBig(base);
        if (x === null || y === null) return false;
        const shift = BigInt(128 - bits);
        return (x >> shift) === (y >> shift);
    }
    const x = v4ToInt(ip), y = v4ToInt(base);
    if (x === null || y === null) return false;
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return ((x & mask) >>> 0) === ((y & mask) >>> 0);
}
function normIp(ip) { return String(ip || '').trim().replace(/^::ffff:/, ''); }
function isCloudflare(ip) {
    const n = normIp(ip);
    if (!n) return false;
    return (n.includes(':') ? CF_V6 : CF_V4).some(c => inCidr(n, c));
}

/** The visitor's IP. req.ip (express, trust proxy) is the peer as nginx saw it; when that peer is a Cloudflare edge
 *  the CF-Connecting-IP header is the real visitor. A spoofed CF-Connecting-IP from anyone else is ignored.
 *  DASHBOARD_TRUST_CF=all trusts CF-Connecting-IP / first X-Forwarded-For unconditionally. */
function isLocalProxy(ip) { return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i.test(ip); }
/** The TCP peer, or — only when the peer is a local reverse proxy (nginx on the VM) — the address that proxy appended
 *  as the last X-Forwarded-For entry. Never trusts a client-written X-Forwarded-For on a direct connection. */
function peerIp(req) {
    const sock = normIp(req.socket && req.socket.remoteAddress);
    if (sock && isLocalProxy(sock)) {
        const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(normIp).filter(Boolean);
        const real = normIp(req.headers['x-real-ip']);
        return xs.length ? xs[xs.length - 1] : (real || sock);
    }
    return sock || normIp(req.ip);
}
function clientIp(req) {
    const peer = peerIp(req);
    const cf = normIp(req.headers['cf-connecting-ip']);
    if (cf && (isCloudflare(peer) || process.env.DASHBOARD_TRUST_CF === 'all')) return cf;
    if (process.env.DASHBOARD_TRUST_CF === 'all') {
        const xff = normIp(String(req.headers['x-forwarded-for'] || '').split(',')[0]);
        if (xff) return xff;
    }
    return peer || 'unknown';
}

function isHttps(req) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (xfp.split(',').map(s => s.trim()).includes('https')) return true;
    if (req.secure) return true;
    // nginx may overwrite X-Forwarded-Proto with "http" behind Cloudflare Flexible; CF-Visitor tells the real scheme.
    const peer = peerIp(req);
    if (isCloudflare(peer) || process.env.DASHBOARD_TRUST_CF === 'all') {
        try { return JSON.parse(String(req.headers['cf-visitor'] || '{}')).scheme === 'https'; } catch (e) { return false; }
    }
    return false;
}

function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(c => {
        const i = c.indexOf('=');
        if (i < 0) return;
        const k = c.slice(0, i).trim();
        if (!k) return;
        try { out[k] = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) { out[k] = c.slice(i + 1).trim(); }
    });
    return out;
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
    if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
    return crypto.timingSafeEqual(x, y);
}

function writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) {}
}
function readJson(file, fallback) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.warn('[DashAuth] unreadable', path.basename(file), e.message); }
    return fallback;
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function scryptAsync(password, salt, p) {
    return new Promise((resolve, reject) => crypto.scrypt(String(password), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));
}
async function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const key = await scryptAsync(password, s, SCRYPT);
    return { salt: s, hash: key.toString('hex'), algo: { ...SCRYPT } };
}
async function verifyPassword(password, rec) {
    const p = (rec && rec.algo) || SCRYPT;
    const key = await scryptAsync(password, rec.salt, p);
    const want = Buffer.from(String(rec.hash), 'hex');
    return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const normUser = (u) => String(u == null ? '' : u).trim().toLowerCase();

function create(opts = {}) {
    const dir = opts.dir || __dirname;
    const USERS_FILE = opts.usersPath || process.env.DASHBOARD_USERS_PATH || path.join(dir, 'dashboard_users.json');
    const SESS_FILE = opts.sessionsPath || process.env.DASHBOARD_SESSIONS_PATH || path.join(dir, 'dashboard_sessions.json');
    const AUDIT_FILE = opts.auditPath || process.env.DASHBOARD_AUDIT_PATH || path.join(dir, 'dashboard_audit.jsonl');
    let pin = String(opts.pin || '');
    const now = opts.now || (() => Date.now());
    let pinTag = crypto.createHash('sha256').update('dash-pin|' + pin).digest('hex').slice(0, 16);
    /** Change the admin PIN at runtime (old PIN sessions end via pinTag). */
    function setPin(p) { pin = String(p || ''); pinTag = crypto.createHash('sha256').update('dash-pin|' + pin).digest('hex').slice(0, 16); }

    let users = (readJson(USERS_FILE, { users: [] }).users || []).filter(u => u && u.username && u.hash && u.salt);
    const sessions = new Map();
    (readJson(SESS_FILE, { sessions: [] }).sessions || []).forEach(s => { if (s && s.id && s.expiresAt > now()) sessions.set(s.id, s); });
    const fails = new Map(); // key -> [timestamps]
    let dummy = null; // dummy hash for unknown usernames (same work, no enumeration by timing)

    const saveUsers = () => writeJsonAtomic(USERS_FILE, { users });
    const saveSessions = () => {
        const t = now();
        for (const [id, s] of sessions) if (s.expiresAt <= t) sessions.delete(id);
        writeJsonAtomic(SESS_FILE, { sessions: [...sessions.values()] });
    };
    const findUser = (u) => users.find(x => x.username === normUser(u)) || null;
    const publicUser = (u) => u && ({ username: u.username, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt || u.createdAt, disabled: !!u.disabled, lastLoginAt: u.lastLoginAt || null });
    const activeUsers = () => users.filter(u => !u.disabled);

    // ---------- rate limit ----------
    function recent(key) {
        const t = now();
        const arr = (fails.get(key) || []).filter(x => t - x < FAIL_WINDOW_MS);
        if (arr.length) fails.set(key, arr); else fails.delete(key);
        return arr;
    }
    function lockedFor(keys) {
        let wait = 0;
        for (const [key, max] of keys) {
            const arr = recent(key);
            if (arr.length >= max) wait = Math.max(wait, arr[arr.length - max] + FAIL_WINDOW_MS - now());
        }
        return wait > 0 ? Math.ceil(wait / 1000) : 0;
    }
    function addFail(keys) { const t = now(); for (const [key] of keys) { const a = recent(key); a.push(t); fails.set(key, a.slice(-200)); } }
    const userKeys = (ip, u) => [[`u|${ip}|${normUser(u)}`, MAX_FAILS], [`uall|${normUser(u)}`, MAX_FAILS_PER_USER]];
    const pinKeys = (ip) => [[`p|${ip}`, MAX_FAILS], ['pall', MAX_FAILS_PIN_GLOBAL]];
    // Unauthenticated requests carrying a wrong PIN are rejected but do not count against the lockout unless they
    // are explicit PIN attempts (header / ?pin= / PIN form) — a stale cookie never locks anyone out.

    // ---------- sessions ----------
    const tokenId = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex');
    function createSession(username, role, via, meta = {}) {
        const token = crypto.randomBytes(32).toString('base64url');
        const t = now();
        sessions.set(tokenId(token), { id: tokenId(token), username, role, via, createdAt: t, expiresAt: t + SESSION_TTL_MS, ua: String(meta.ua || '').slice(0, 120), ...(via === 'pin' ? { pinTag } : {}) });
        if (sessions.size > MAX_SESSIONS) { // automation opening ?pin= links must not grow the file forever: drop the oldest PIN sessions first
            const old = [...sessions.values()].sort((a, b) => (a.via === 'pin' ? 0 : 1) - (b.via === 'pin' ? 0 : 1) || a.createdAt - b.createdAt);
            for (const o of old.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(o.id);
        }
        saveSessions();
        return token;
    }
    function destroySession(token) { if (token && sessions.delete(tokenId(token))) saveSessions(); }
    function destroyUserSessions(username) {
        let n = 0;
        for (const [id, s] of sessions) if (s.via === 'password' && s.username === username) { sessions.delete(id); n++; }
        if (n) saveSessions();
        return n;
    }
    function sessionFor(token) {
        if (!token) return null;
        const s = sessions.get(tokenId(token));
        if (!s) return null;
        if (s.expiresAt <= now()) { sessions.delete(s.id); saveSessions(); return null; }
        if (s.via === 'pin' && s.pinTag !== pinTag) { sessions.delete(s.id); saveSessions(); return null; } // PIN changed -> PIN sessions end
        if (s.via === 'pin') return { username: PIN_USER, role: 'admin', via: 'pin', sessionId: s.id };
        const u = findUser(s.username);
        if (!u || u.disabled) { sessions.delete(s.id); saveSessions(); return null; }
        return { username: u.username, role: u.role, via: 'password', sessionId: s.id }; // role read live: a change applies at once
    }
    function cookieHeader(req, token, maxAgeSec) {
        return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
    }
    function setSessionCookie(req, res, token, extra = []) { res.setHeader('Set-Cookie', [cookieHeader(req, token, Math.floor(SESSION_TTL_MS / 1000))].concat(extra)); }
    const clearLegacyPinCookie = (req) => `${LEGACY_PIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;

    // ---------- users ----------
    async function upsertUser({ username, password, role, disabled } = {}) {
        const name = normUser(username);
        if (!USERNAME_RE.test(name)) throw Object.assign(new Error('username: 3-32 characters, only a-z 0-9 . _ -'), { status: 400 });
        if (name === PIN_USER.toLowerCase()) throw Object.assign(new Error('username reserved'), { status: 400 });
        const r = role == null || role === '' ? null : String(role);
        if (r && !ROLES.includes(r)) throw Object.assign(new Error('role must be admin or member'), { status: 400 });
        const existing = findUser(name);
        if (password != null && password !== '') {
            const pw = String(password);
            if (pw.length < 6 || pw.length > 200) throw Object.assign(new Error('password: at least 6 characters'), { status: 400 });
        } else if (!existing) throw Object.assign(new Error('password required for a new user'), { status: 400 });
        const t = new Date(now()).toISOString();
        if (existing) {
            if (password) { Object.assign(existing, await hashPassword(password)); destroyUserSessions(name); }
            if (r) existing.role = r;
            if (typeof disabled === 'boolean') existing.disabled = disabled;
            existing.updatedAt = t;
            saveUsers();
            return { created: false, user: publicUser(existing) };
        }
        const rec = { username: name, ...(await hashPassword(password)), role: r || 'member', createdAt: t, updatedAt: t, disabled: disabled === true };
        users.push(rec);
        saveUsers();
        return { created: true, user: publicUser(rec) };
    }
    function setDisabled(username, flag) {
        const u = findUser(username);
        if (!u) return null;
        u.disabled = !!flag; u.updatedAt = new Date(now()).toISOString();
        saveUsers();
        if (flag) destroyUserSessions(u.username);
        return publicUser(u);
    }
    function deleteUser(username) {
        const name = normUser(username);
        const before = users.length;
        users = users.filter(u => u.username !== name);
        if (users.length === before) return false;
        saveUsers();
        destroyUserSessions(name);
        return true;
    }

    /** Password login. Returns {ok, user} | {ok:false, locked:secs} | {ok:false, error} */
    async function loginPassword(req, username, password) {
        const ip = clientIp(req);
        const keys = userKeys(ip, username);
        const wait = lockedFor(keys);
        if (wait) return { ok: false, locked: wait };
        const u = findUser(username);
        let good = false;
        if (u && !u.disabled && password) good = await verifyPassword(String(password), u);
        else { if (!dummy) dummy = await hashPassword('dummy-password-x'); await verifyPassword(String(password || 'x'), dummy); }
        if (!good) {
            addFail(keys);
            const w2 = lockedFor(keys);
            return w2 ? { ok: false, locked: w2 } : { ok: false, error: 'bad_credentials' };
        }
        fails.delete(keys[0][0]);
        u.lastLoginAt = new Date(now()).toISOString(); saveUsers();
        return { ok: true, user: u };
    }
    /** PIN check with lockout (explicit attempts only). */
    function checkPin(req, candidate) {
        const ip = clientIp(req);
        const keys = pinKeys(ip);
        const wait = lockedFor(keys);
        if (wait) return { ok: false, locked: wait };
        if (pin && safeEqual(candidate, pin)) { fails.delete(keys[0][0]); return { ok: true }; }
        addFail(keys);
        const w2 = lockedFor(keys);
        return w2 ? { ok: false, locked: w2 } : { ok: false, error: 'bad_pin' };
    }

    // ---------- audit ----------
    const AUDIT_RULES = [
        [/^\/api\/send-message$/, 'send', 'Message sent'],
        [/^\/api\/quick-add-send$/, 'quick_add', 'Number added & sent'],
        [/^\/api\/quick-action(-legacy)?$/, 'quick_action', 'Quick action'],
        [/^\/api\/test-send$/, 'test_send', 'Test message'],
        [/^\/api\/broadcast\/create$/, 'bulk_create', 'Bulk send created'],
        [/^\/api\/broadcast\/(pause|resume|cancel)$/, 'bulk_control', 'Bulk send paused/resumed'],
        [/^\/api\/scheduled\/(create|from-agenda)$/, 'scheduled_create', 'Scheduled bulk created'],
        [/^\/api\/scheduled\/[^/]+\/(pause|resume|cancel)$/, 'scheduled_control', 'Scheduled bulk paused/resumed'],
        [/^\/api\/crm\/profile\//, 'brief_edit', 'Voter profile/brief changed'],
        [/^\/api\/control\/voter\//, 'mode_edit', 'Voter mode/brief changed'],
        [/^\/api\/control\/day$/, 'daily_lock', 'Today goal/lock'],
        [/^\/api\/control\/default-mode$/, 'default_mode', 'Default mode changed'],
        [/^\/api\/control\/followups\/run$/, 'followups_run', 'Follow-ups run'],
        [/^\/api\/dashboard-users/, 'users_admin', 'Login user changed'],
        [/^\/api\/virodhi\//, 'virodhi', 'Opponent (virodhi) list changed'],
        [/^\/api\/(samasya|mulaqat)\/(update|delete)$/, 'record_edit', 'Problem/meeting record changed'],
        [/^\/api\/contacts\//, 'contacts', 'Contacts changed'],
        [/^\/api\/media\/(upload|delete)$/, 'media', 'Media changed'],
        [/^\/api\/upload-media$/, 'media', 'Media uploaded'],
        [/^\/api\/settings\/outbound$/, 'settings', 'Sending settings changed'],
        [/^\/api\/toggle-autopilot$/, 'settings', 'AutoPilot changed'],
        [/^\/api\/ai-keys$/, 'settings', 'AI keys changed'],
        [/^\/api\/self-test\/(start|stop)$/, 'self_test', 'Self-test'],
        [/^\/api\/voter\/stage$/, 'stage', 'Voter stage changed'],
        [/^\/api\/(campaign-agenda|agenda\/day|campaign-profile(\/import)?|daily-target|update-tags|update-notes|clear-logs|toggle-demo-posters|test-records\/cleanup|request-pairing-code)$/, 'other', null],
    ];
    const SKIP = /^\/api\/(broadcast\/preview|scheduled\/preview|crm\/copilot|ai-draft|playground\/|test-ai|generate-poster|daily-goal\/summary)/;
    const SECRET_KEYS = /pass|pin|token|key|secret|cookie|auth/i;
    function auditDetail(req) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (/^\/api\/ai-keys$/.test(req.path)) return {};
        const d = {};
        const pick = ['phone', 'to', 'number', 'line', 'lineId', 'session', 'sessionId', 'action', 'type', 'mode', 'voteAsk', 'followup', 'date', 'locked', 'stage', 'name', 'username', 'role', 'slot', 'id', 'mediaOption', 'poster'];
        for (const k of pick) if (b[k] != null && !SECRET_KEYS.test(k) && typeof b[k] !== 'object') d[k] = String(b[k]).slice(0, 80);
        for (const k of ['phones', 'numbers', 'recipients', 'contacts', 'audience']) {
            if (Array.isArray(b[k])) d[k + 'Count'] = b[k].length;
            else if (typeof b[k] === 'string' && b[k].trim()) d[k + 'Count'] = b[k].split(/[\n,]+/).filter(x => x.trim()).length;
        }
        const text = b.message || b.text || b.goal || b.about || '';
        if (typeof text === 'string' && text) d.text = text.slice(0, 80);
        if (req.params && Object.keys(req.params).length) d.params = req.params;
        const m = req.path.match(/^\/api\/(crm\/profile|control\/voter|dashboard-users)\/([^/]+)/);
        if (m) d.target = decodeURIComponent(m[2]).slice(0, 40);
        return d;
    }
    function record(entry) {
        try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch (e) { console.warn('[DashAuth] audit write failed', e.message); }
    }
    function auditMiddleware(req, res, next) {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/') || SKIP.test(req.path)) return next();
        const rule = AUDIT_RULES.find(r => r[0].test(req.path));
        if (!rule) return next();
        const who = req.dashUser;
        res.on('finish', () => {
            if (!who) return;
            record({ ts: new Date(now()).toISOString(), username: who.username, role: who.role, via: who.via, action: rule[1], label: rule[2] || req.path.replace(/^\/api\//, ''), method: req.method, path: req.path, status: res.statusCode, ip: clientIp(req), detail: auditDetail(req) });
        });
        next();
    }
    function readAudit({ limit = 100, user = '' } = {}) {
        let lines = [];
        try { if (fs.existsSync(AUDIT_FILE)) lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n'); } catch (e) {}
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < Math.min(Number(limit) || 100, 1000); i--) {
            try { const e = JSON.parse(lines[i]); if (!user || normUser(e.username) === normUser(user)) out.push(e); } catch (e) {}
        }
        return out;
    }

    // ---------- the gate ----------
    const PUBLIC = (p) => p.startsWith('/media/') || p === '/media' || p === '/health' || p.startsWith('/webhook') || p === '/login' || p === '/logout' || p === '/favicon.ico';
    function identify(req) {
        const cookies = parseCookies(req);
        const s = sessionFor(cookies[SESSION_COOKIE]);
        if (s) return { user: s, cookies };
        return { user: null, cookies };
    }
    function wantsJson(req) { return req.path.startsWith('/api/') || /json/i.test(String(req.headers.accept || '')) && !/html/i.test(String(req.headers.accept || '')); }

    function gate(req, res, next) {
        const { user, cookies } = identify(req);
        if (user) { req.dashUser = user; return next(); }
        const headerPin = req.headers['x-campaign-pin'];
        const queryPin = typeof req.query.pin === 'string' ? req.query.pin : null;
        if (headerPin != null || queryPin != null) {
            const r = checkPin(req, headerPin != null ? headerPin : queryPin);
            if (r.ok) {
                req.dashUser = { username: PIN_USER, role: 'admin', via: 'pin' };
                // An old ?pin= link opened in a browser page gets a real session (the PIN itself is never put in a cookie).
                if (queryPin != null && req.method === 'GET' && !req.path.startsWith('/api/')) {
                    setSessionCookie(req, res, createSession(PIN_USER, 'admin', 'pin', { ua: req.headers['user-agent'] }), cookies[LEGACY_PIN_COOKIE] ? [clearLegacyPinCookie(req)] : []);
                }
                return next();
            }
            if (PUBLIC(req.path)) return next();
            if (r.locked) { res.setHeader('Retry-After', String(r.locked)); return wantsJson(req) ? res.status(429).json({ error: 'Too many attempts. Try later.', retryAfter: r.locked }) : res.status(429).send(loginPage(req, { error: `Too many wrong attempts — try again in ${Math.ceil(r.locked / 60)} min.`, mode: 'pin' })); }
        } else if (cookies[LEGACY_PIN_COOKIE] && pin && safeEqual(cookies[LEGACY_PIN_COOKIE], pin)) {
            // Legacy cookie that held the PIN: accept once and upgrade it to a server-side session.
            req.dashUser = { username: PIN_USER, role: 'admin', via: 'pin' };
            setSessionCookie(req, res, createSession(PIN_USER, 'admin', 'pin', { ua: req.headers['user-agent'] }), [clearLegacyPinCookie(req)]);
            return next();
        }
        if (PUBLIC(req.path)) return next();
        if (req.path.startsWith('/api/') || req.path === '/api') return res.status(401).json({ error: 'Unauthorized. Please log in.' });
        res.status(401).send(loginPage(req, {}));
    }

    const requireAdmin = (req, res, next) => (req.dashUser && req.dashUser.role === 'admin') ? next() : res.status(req.dashUser ? 403 : 401).json({ error: req.dashUser ? 'Admin only' : 'Unauthorized' });

    // ---------- pages ----------
    function safeNext(n) { const s = String(n || '/'); return /^\/(?![\/\\])[^\s]*$/.test(s) && !s.startsWith('/login') && !s.startsWith('/logout') ? s : '/'; }
    function loginPage(req, { error = '', mode = null, username = '' } = {}) {
        const hasUsers = activeUsers().length > 0;
        const m = mode || (req.query && req.query.mode === 'pin' ? 'pin' : (hasUsers ? 'user' : 'pin'));
        const next = safeNext((req.query && req.query.next) || (req.method === 'GET' && req.path !== '/login' ? req.originalUrl.replace(/([?&])pin=[^&]*&?/, '$1').replace(/[?&]$/, '') : '/'));
        const userForm = `
                <form method="POST" action="/login" autocomplete="on">
                    <input type="hidden" name="next" value="${escapeHtml(next)}">
                    <label for="lg-user">Username</label>
                    <input id="lg-user" type="text" name="username" value="${escapeHtml(username)}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
                    <label for="lg-pass">Password</label>
                    <input id="lg-pass" type="password" name="password" autocomplete="current-password" required>
                    <button type="submit" class="btn">🔓 Log in</button>
                </form>
                <a class="alt" href="/login?mode=pin&amp;next=${encodeURIComponent(next)}">Log in with PIN</a>`;
        const pinForm = `
                <form method="POST" action="/login" autocomplete="off">
                    <input type="hidden" name="next" value="${escapeHtml(next)}">
                    <input type="hidden" name="mode" value="pin">
                    <label for="lg-pin">Dashboard PIN</label>
                    <input id="lg-pin" type="password" name="pin" class="pin" placeholder="••••" maxlength="12" inputmode="numeric" autocomplete="off" required autofocus>
                    <button type="submit" class="btn">🔓 Open</button>
                </form>
                ${hasUsers ? `<a class="alt" href="/login?next=${encodeURIComponent(next)}">Log in with username & password</a>` : ''}`;
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>🔒 Login — Sihali Khurd 2026</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#1e293b;padding:28px 20px;border-radius:18px;width:100%;max-width:380px;text-align:center;box-shadow:0 20px 30px rgba(0,0,0,.5);border:1px solid #334155}
label{display:block;text-align:left;font-size:14px;color:#cbd5e1;margin:14px 0 6px;font-weight:600}
input{width:100%;padding:13px 14px;font-size:16px;border-radius:10px;border:2px solid #475569;background:#0f172a;color:#f8fafc;outline:none}
input:focus{border-color:#38bdf8}input.pin{font-size:24px;text-align:center;letter-spacing:8px;color:#38bdf8;font-weight:700}
.btn{width:100%;margin-top:18px;padding:14px;background:#2563eb;color:#fff;font-size:16px;font-weight:700;border:none;border-radius:10px;cursor:pointer}
.btn:active{transform:scale(.98)}.err{background:#7f1d1d;color:#fecaca;border-radius:10px;padding:10px;margin-top:14px;font-size:14px}
.alt{display:inline-block;margin-top:16px;color:#93c5fd;font-size:13px;text-decoration:none}
</style></head><body><div class="card">
<div style="font-size:40px;margin-bottom:8px">🔒</div>
<h2 style="margin:0;font-size:20px;color:#f8fafc">Gram Panchayat Sihali Khurd</h2>
<p style="color:#94a3b8;font-size:13px;margin:6px 0 0">Baba Abhay Singh Election 2026 — private control room</p>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
${m === 'pin' ? pinForm : userForm}
<p style="color:#64748b;font-size:11px;margin-top:18px">Campaign team only</p>
</div></body></html>`;
    }

    // ---------- routes ----------
    function install(app) {
        app.get('/login', (req, res) => {
            if (identify(req).user) return res.redirect(303, safeNext(req.query.next));
            res.setHeader('Cache-Control', 'no-store');
            res.send(loginPage(req, {}));
        });
        app.post('/login', async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            const b = req.body || {};
            const json = /json/i.test(String(req.headers['content-type'] || '')) || /json/i.test(String(req.headers.accept || ''));
            const next = safeNext(b.next);
            const fail = (status, msg, extra = {}, mode) => json ? res.status(status).json({ success: false, error: msg, ...extra }) : res.status(status).send(loginPage(req, { error: msg, mode, username: b.username || '' }));
            try {
                if (b.pin != null && (b.mode === 'pin' || b.username == null)) {
                    const r = checkPin(req, String(b.pin));
                    if (r.locked) { res.setHeader('Retry-After', String(r.locked)); return fail(429, `Too many wrong attempts — try again in ${Math.ceil(r.locked / 60)} min.`, { retryAfter: r.locked }, 'pin'); }
                    if (!r.ok) return fail(401, 'Wrong PIN', {}, 'pin');
                    setSessionCookie(req, res, createSession(PIN_USER, 'admin', 'pin', { ua: req.headers['user-agent'] }), [clearLegacyPinCookie(req)]);
                    record({ ts: new Date(now()).toISOString(), username: PIN_USER, role: 'admin', via: 'pin', action: 'login', label: 'Login (PIN)', method: 'POST', path: '/login', status: 200, ip: clientIp(req), detail: {} });
                    return json ? res.json({ success: true, username: PIN_USER, role: 'admin', via: 'pin' }) : res.redirect(303, next);
                }
                const r = await loginPassword(req, b.username, b.password);
                if (r.locked) { res.setHeader('Retry-After', String(r.locked)); return fail(429, `Too many wrong attempts — try again in ${Math.ceil(r.locked / 60)} min.`, { retryAfter: r.locked }, 'user'); }
                if (!r.ok) return fail(401, 'Wrong username or password', {}, 'user');
                setSessionCookie(req, res, createSession(r.user.username, r.user.role, 'password', { ua: req.headers['user-agent'] }), [clearLegacyPinCookie(req)]);
                record({ ts: new Date(now()).toISOString(), username: r.user.username, role: r.user.role, via: 'password', action: 'login', label: 'Login', method: 'POST', path: '/login', status: 200, ip: clientIp(req), detail: {} });
                return json ? res.json({ success: true, username: r.user.username, role: r.user.role, via: 'password' }) : res.redirect(303, next);
            } catch (e) {
                console.warn('[DashAuth] login error', e.message);
                return fail(500, 'Login problem — please try again');
            }
        });
        app.post('/logout', (req, res) => {
            const cookies = parseCookies(req);
            destroySession(cookies[SESSION_COOKIE]);
            res.setHeader('Set-Cookie', [cookieHeader(req, '', 0), clearLegacyPinCookie(req)]);
            if (/json/i.test(String(req.headers.accept || '')) || /json/i.test(String(req.headers['content-type'] || ''))) return res.json({ success: true });
            res.redirect(303, '/login');
        });
        app.get('/api/me', (req, res) => res.json({ success: true, username: req.dashUser.username, role: req.dashUser.role, via: req.dashUser.via }));

        app.get('/api/dashboard-users', requireAdmin, (req, res) => res.json({ success: true, users: users.map(publicUser), roles: ROLES }));
        app.post('/api/dashboard-users', requireAdmin, async (req, res) => {
            try { const r = await upsertUser(req.body || {}); res.status(r.created ? 201 : 200).json({ success: true, ...r }); }
            catch (e) { res.status(e.status || 500).json({ success: false, error: e.message }); }
        });
        const selfGuard = (req, res) => {
            if (req.dashUser.via === 'password' && normUser(req.params.u) === req.dashUser.username) { res.status(400).json({ success: false, error: 'You cannot disable/delete your own account' }); return true; }
            return false;
        };
        app.post('/api/dashboard-users/:u/disable', requireAdmin, (req, res) => {
            if (selfGuard(req, res)) return;
            const u = setDisabled(req.params.u, true);
            u ? res.json({ success: true, user: u }) : res.status(404).json({ success: false, error: 'not found' });
        });
        app.post('/api/dashboard-users/:u/enable', requireAdmin, (req, res) => {
            const u = setDisabled(req.params.u, false);
            u ? res.json({ success: true, user: u }) : res.status(404).json({ success: false, error: 'not found' });
        });
        app.delete('/api/dashboard-users/:u', requireAdmin, (req, res) => {
            if (selfGuard(req, res)) return;
            deleteUser(req.params.u) ? res.json({ success: true, deleted: normUser(req.params.u) }) : res.status(404).json({ success: false, error: 'not found' });
        });
        app.get('/api/audit', requireAdmin, (req, res) => res.json({ success: true, entries: readAudit({ limit: req.query.limit, user: req.query.user }) }));
    }

    // ---------- dashboard UI (ES5) ----------
    const ui = {
        headerBadge: (req) => {
            const u = req && req.dashUser;
            if (!u) return '';
            return `<span id="dash-user-badge" style="background:#ede9fe;color:#5b21b6;padding:6px 12px;border-radius:20px;font-size:13px;font-weight:700;border:1px solid #ddd6fe;">👤 ${escapeHtml(u.username)}${u.role === 'admin' ? ' · admin' : ''}</span>
                        <form method="POST" action="/logout" style="display:inline;margin:0;"><button type="submit" id="dash-logout" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;padding:7px 14px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">🚪 Logout</button></form>`;
        },
        pane: (req) => {
            if (!req || !req.dashUser || req.dashUser.role !== 'admin') return '';
            return `
                    <div id="dash-users-section" style="margin-top:22px;border-top:1px solid #e2e8f0;padding-top:16px;">
                        <h3 style="margin:0 0 4px 0;font-size:16px;">👥 Login users</h3>
                        <div style="color:#64748b;font-size:12px;margin-bottom:10px;">Each family member gets their own username and password. Passwords are never shown anywhere — if someone forgets, just set a new one here.</div>
                        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
                            <input id="du-name" type="text" placeholder="Username" autocapitalize="none" autocomplete="off" style="font-size:16px;padding:9px;border-radius:8px;border:1px solid #cbd5e1;min-width:140px;flex:1;">
                            <input id="du-pass" type="password" placeholder="New password (6+ characters)" autocomplete="new-password" style="font-size:16px;padding:9px;border-radius:8px;border:1px solid #cbd5e1;min-width:160px;flex:1;">
                            <select id="du-role" style="font-size:16px;padding:9px;border-radius:8px;border:1px solid #cbd5e1;"><option value="member">member</option><option value="admin">admin</option></select>
                            <button type="button" id="du-save" style="background:#2563eb;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-weight:700;cursor:pointer;">💾 Add / change password</button>
                        </div>
                        <div id="du-msg" style="font-size:13px;margin-top:6px;"></div>
                        <div class="table-responsive" style="margin-top:10px;"><table class="table"><thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody id="du-body"><tr><td colspan="5">…</td></tr></tbody></table></div>
                        <h4 style="margin:16px 0 6px 0;font-size:14px;">🧾 Who did what (last 50)</h4>
                        <div class="table-responsive"><table class="table"><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody id="du-audit"><tr><td colspan="4">…</td></tr></tbody></table></div>
                    </div>`;
        },
        script: () => `
            <script>
            (function(){
                var sec = document.getElementById('dash-users-section');
                if (!sec) return;
                function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
                function t(iso){ try { return iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; } catch(e){ return iso || '—'; } }
                function api(method, url, body){ return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined }).then(function(r){ return r.json().then(function(j){ j._status = r.status; return j; }); }); }
                function msg(text, ok){ var m = document.getElementById('du-msg'); m.style.color = ok ? '#15803d' : '#b91c1c'; m.textContent = text; }
                function load(){
                    api('GET', '/api/dashboard-users').then(function(j){
                        var rows = (j.users || []).map(function(u){
                            return '<tr><td><b>' + esc(u.username) + '</b></td><td>' + (u.role === 'admin' ? 'admin' : 'member') + '</td><td>' + (u.disabled ? '⛔ Disabled' : '✅ Active') + '</td><td>' + esc(t(u.lastLoginAt)) + '</td><td style="white-space:nowrap;">' +
                                (u.disabled ? '<button type="button" data-du="enable" data-u="' + esc(u.username) + '">Enable</button> ' : '<button type="button" data-du="disable" data-u="' + esc(u.username) + '">Disable</button> ') +
                                '<button type="button" data-du="delete" data-u="' + esc(u.username) + '" style="color:#b91c1c;">Delete</button></td></tr>';
                        });
                        document.getElementById('du-body').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" style="color:#94a3b8;">No users yet — add one above (PIN login always keeps working).</td></tr>';
                    });
                    api('GET', '/api/audit?limit=50').then(function(j){
                        var rows = (j.entries || []).map(function(e){
                            var d = e.detail || {}; var parts = [];
                            ['phone','target','line','action','mode','date','text'].forEach(function(k){ if (d[k]) parts.push(esc(d[k])); });
                            ['phonesCount','numbersCount','recipientsCount','audienceCount'].forEach(function(k){ if (d[k]) parts.push(d[k] + ' numbers'); });
                            if (e.status >= 400) parts.push('❌ ' + e.status);
                            return '<tr><td style="white-space:nowrap;">' + esc(t(e.ts)) + '</td><td><b>' + esc(e.username) + '</b></td><td>' + esc(e.label || e.action) + '</td><td style="font-size:12px;">' + parts.join(' · ') + '</td></tr>';
                        });
                        document.getElementById('du-audit').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4" style="color:#94a3b8;">Nothing recorded yet.</td></tr>';
                    });
                }
                document.getElementById('du-save').addEventListener('click', function(){
                    var name = document.getElementById('du-name').value.trim(), pass = document.getElementById('du-pass').value, role = document.getElementById('du-role').value;
                    if (!name) return msg('Enter a username', false);
                    api('POST', '/api/dashboard-users', { username: name, password: pass, role: role }).then(function(j){
                        if (!j.success) return msg(j.error || 'Did not work', false);
                        document.getElementById('du-pass').value = '';
                        msg(j.created ? ('✅ ' + j.user.username + ' added') : ('✅ ' + j.user.username + ' updated'), true); load();
                    });
                });
                document.getElementById('du-body').addEventListener('click', function(ev){
                    var b = ev.target; if (!b || !b.getAttribute) return;
                    var act = b.getAttribute('data-du'), u = b.getAttribute('data-u'); if (!act || !u) return;
                    if (act === 'delete' && !window.confirm('Delete ' + u + '?')) return;
                    var p = act === 'delete' ? api('DELETE', '/api/dashboard-users/' + encodeURIComponent(u)) : api('POST', '/api/dashboard-users/' + encodeURIComponent(u) + '/' + act);
                    p.then(function(j){ msg(j.success ? '✅ Done' : (j.error || 'Did not work'), !!j.success); load(); });
                });
                load();
            })();
            </script>`,
    };

    return {
        setPin,
        gate, install, requireAdmin, auditMiddleware, ui, clientIp, isHttps, loginPage,
        upsertUser, setDisabled, deleteUser, listUsers: () => users.map(publicUser), readAudit, record,
        _internal: { hashPassword, verifyPassword, sessions, fails, isCloudflare, USERS_FILE, SESS_FILE, AUDIT_FILE, SESSION_COOKIE },
    };
}

module.exports = { create, hashPassword, verifyPassword, isCloudflare, inCidr, SESSION_COOKIE, PIN_USER };
