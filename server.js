
// Proactive follow-ups (Brain v2): personalised by voter memory, via followup_planner.js.
// Rules: consented only, never opted-out, quiet hours 21:00-08:00 IST, pre-poll silence period (campaign_profile.json
// campaign.silenceStartIST), max 1 per voter per day, stop after 2 unanswered, per-line daily cap, never our own lines.
let proactiveBusy = {};
async function runProactiveNudges(sock, lineId = 'sim_636') {
    // Owner rule: no automatic outbound (follow-ups, nudges, consent reminders) unless the dashboard toggle is ON
    if (!require('./outbound_settings.js').proactiveEnabled()) return { disabled: true };
    if (proactiveBusy[lineId]) return;
    proactiveBusy[lineId] = true;
    try {
        const planner = require('./followup_planner.js');
        const now = new Date();
        const allUsers = userMemory.getAllUsers().filter(u => u.phone && !String(u.phone).includes('Self Device') && !(liveSelfTest && liveSelfTest.ownLineOf([u.phone])));
        // One consent reminder per cycle (also obeys quiet hours + silence period)
        if (!planner.inQuietHours(now) && !planner.inSilencePeriod(now)) {
            const r = allUsers.find(u => (u.assignedLine || 'sim_636') === lineId && !u.broadcastOptOut && engagementPolicy.canSendConsentReminder(u));
            if (r) {
                const reminder = engagementPolicy.buildConsentReminder(r.name);
                try {
                    await sendSafeMessage(sock, `${r.phone}@s.whatsapp.net`, { text: reminder });
                    r.consentReminderCount = (r.consentReminderCount || 0) + 1;
                    r.consentReminderAt = new Date().toISOString();
                    userMemory.recordMessage(r.phone, 'bot', reminder, 'consentReminder');
                    operationsTracker.record('consent_reminder', 'sent', { lineId });
                } catch (e) { operationsTracker.record('consent_reminder', 'failed', { lineId, reason: e.message }); }
            }
        }
        const result = await planner.runCycle({
            users: allUsers,
            lineId,
            goal: dailyGoal.get(),
            now,
            gapMs: () => 20000 + Math.floor(Math.random() * 25000),
            send: async (u, text) => {
                await sendSafeMessage(sock, `${u.phone}@s.whatsapp.net`, { text });
            },
            onSent: (u, plan) => {
                userMemory.recordMessage(u.phone, 'bot', plan.text, 'proactiveNudge');
                userMemory.save();
                operationsTracker.record('proactive_followup', 'sent', { lineId, kind: plan.kind });
                logMessage({ session: lineId, phone: u.phone, incoming: '[Proactive follow-up: ' + plan.kind + ']', reply: plan.text, status: 'PROACTIVE_SENT' });
            }
        });
        if (result.sent) console.log(`[Proactive] ${lineId}: sent ${result.sent}`, result.skipped);
    } catch (err) {
        console.error('[Proactive Runner Error]:', err.message);
    } finally {
        proactiveBusy[lineId] = false;
    }
}


const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { exec } = require('child_process');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const voterEngine = require('./voter_engine.js');
const slipFlow = require('./slip_flow.js');
const nluMod = require('./nlu.js');
const nluRouter = require('./nlu_router.js');
const voterCardGen = require('./voter_card_generator.js');
const aiService = require('./ai_assistant_service.js');
const userMemory = require('./user_memory.js');
const posterEngine = require('./poster_engine.js');
const mediaCatalog = require('./media_catalog.js');
const campaignAgenda = require('./campaign_agenda.js');
const visionService = require('./vision_service.js');
const mediaUnderstanding = require('./media_understanding.js');
const contactsManager = require('./contacts_manager.js');
const engagementPolicy = require('./engagement_policy.js');
const operationsTracker = require('./operations_tracker.js');
const dailyGoal = require('./daily_goal.js');
const operatorControl = require('./operator_control.js');
const conversationContext = require('./conversation_context.js');
const campaignProfile = require('./campaign_profile.js');
const { LiveSelfTest } = require('./self_test.js');
const followupPlanner = require('./followup_planner.js');

const MEDIA_UPLOAD_TARGETS = new Set(['poster.jpg', 'campaign_reel.mp4']);
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH || 'main';

function syncUploadedMediaToGit(target) {
    if (process.platform !== 'linux' || process.env.MEDIA_GIT_SYNC === 'false') {
        operationsTracker.record('media_git_sync', 'skipped', { mediaType: target, reason: 'disabled_or_non_linux' });
        return;
    }
    const relativePath = `media/${target}`;
    const command = `git add -- "${relativePath}" && (git diff --cached --quiet || (git commit -m "chore(media): update ${target}" && git push origin HEAD:${DEPLOY_BRANCH}))`;
    exec(command, (error) => {
        if (error) {
            operationsTracker.record('media_git_sync', 'failed', { mediaType: target, reason: error.message });
            return;
        }
        operationsTracker.record('media_git_sync', 'ok', { mediaType: target });
    });
}

function syncCampaignProfileToGit() {
    if (process.platform !== 'linux' || process.env.PROFILE_GIT_SYNC === 'false') return;
    const command = `git add -- campaign_profile.json && (git diff --cached --quiet || (git commit -m "chore(profile): update verified facts and talking style" && git push origin HEAD:${DEPLOY_BRANCH}))`;
    exec(command, error => operationsTracker.record('profile_git_sync', error ? 'failed' : 'ok', error ? { reason: error.message } : { feature: 'campaign_profile' }));
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));
app.use('/media', express.static(path.join(__dirname, 'media')));



const PORT = process.env.PORT || 3000;
// Optional explicit override; when empty, ai_assistant_service uses its key list (env NVIDIA_API_KEYS / api_config.json)
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
// Admin PIN: a PIN changed from the dashboard (gitignored dashboard_pin.json) wins over the env var.
const PIN_FILE = path.join(__dirname, 'dashboard_pin.json');
let CAMPAIGN_PIN = (() => { try { const p = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).pin; if (/^\d{4,12}$/.test(String(p))) return String(p); } catch (e) {} return process.env.CAMPAIGN_PIN || '1789'; })();
const DASHBOARD_ONLY = process.env.DASHBOARD_ONLY === 'true';
const PUBLIC_DASHBOARD_URL = String(process.env.PUBLIC_DASHBOARD_URL || '').replace(/\/$/, '');

// Persistent Live Message Feed Store (survives restarts)
const FEED_FILE = path.join(__dirname, 'messages_feed.json');
let LIVE_FEED = [];
try {
    if (fs.existsSync(FEED_FILE)) {
        LIVE_FEED = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8'));
    }
} catch (e) {
    LIVE_FEED = [];
}

// Purge past self-tests & errors so the real voter feed is 100% clean
LIVE_FEED = LIVE_FEED.filter(item => item.status !== 'SELF_IGNORED' && item.status !== 'BAD_MAC' && item.status !== 'SELF_DEVICE');
try {
    fs.writeFileSync(FEED_FILE, JSON.stringify(LIVE_FEED, null, 2), 'utf8');
} catch (e) {}

// Diagnostics & System Health Store
const DIAG_FILE = path.join(__dirname, 'diagnostics_feed.json');
let DIAG_FEED = [];
try {
    if (fs.existsSync(DIAG_FILE)) {
        DIAG_FEED = JSON.parse(fs.readFileSync(DIAG_FILE, 'utf8'));
    }
} catch (e) {
    DIAG_FEED = [];
}

function logDiagnostic(event) {
    DIAG_FEED.unshift({
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        ...event
    });
    if (DIAG_FEED.length > 100) DIAG_FEED.pop();
    try {
        fs.writeFileSync(DIAG_FILE, JSON.stringify(DIAG_FEED, null, 2), 'utf8');
    } catch (e) {}
}

function logMessage(event) {
    // If it's a self-device or decryption event, route strictly to diagnostics
    if (event.status === 'SELF_IGNORED' || event.status === 'BAD_MAC' || event.status === 'SELF_DEVICE') {
        return logDiagnostic(event);
    }
    LIVE_FEED.unshift({
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        ...event
    });
    if (LIVE_FEED.length > 200) LIVE_FEED.pop();
    try {
        fs.writeFileSync(FEED_FILE, JSON.stringify(LIVE_FEED, null, 2), 'utf8');
    } catch (e) {}
}

// Global process error handlers to swallow harmless libsignal Bad MAC loops
process.on('uncaughtException', (err) => {
    if (err && err.message && err.message.includes('Bad MAC')) {
        console.warn('[Signal] Handled transient Bad MAC session error.');
        return;
    }
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    if (reason && reason.message && reason.message.includes('Bad MAC')) {
        console.warn('[Signal] Handled transient Bad MAC unhandled rejection.');
        return;
    }
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Security gate: per-person username/password sessions (dashboard_auth.js) + the campaign PIN as admin fallback
// (x-campaign-pin header, ?pin=, PIN form). Public: /media, /health (sanitized), /webhook/*, /login, /logout.
const dashAuth = require('./dashboard_auth.js').create({ pin: CAMPAIGN_PIN, dir: __dirname });
app.use(dashAuth.gate);
app.use(dashAuth.auditMiddleware);
dashAuth.install(app);

// (moved below the PIN gate so complaint/intel data is no longer public)
// Endpoints to view registered complaints & ground intel
app.get('/api/baba-register', (req, res) => {
    const regFile = path.join(__dirname, 'baba_direct_register.json');
    if (fs.existsSync(regFile)) {
        try { return res.json(JSON.parse(fs.readFileSync(regFile, 'utf8'))); } catch(e) {}
    }
    res.json([]);
});

app.get('/api/ground-intel', (req, res) => {
    const intelFile = path.join(__dirname, 'ground_intelligence_feed.json');
    if (fs.existsSync(intelFile)) {
        try { return res.json(JSON.parse(fs.readFileSync(intelFile, 'utf8'))); } catch(e) {}
    }
    res.json([]);
});

// Incoming message queue (volume: 200+ simultaneous chats)
const { ChatQueue } = require('./chat_queue.js');
const incomingQueue = new ChatQueue({
    concurrency: Number(process.env.INCOMING_CONCURRENCY) || 12,
    jobTimeoutMs: Number(process.env.INCOMING_JOB_TIMEOUT_MS) || 45000
});

// Configured WhatsApp Sessions
const SESSIONS = [
    { id: 'sim_636', name: 'Primary Line (6367810227)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'baba_aux', name: 'Baba Aux Line (9509352067)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'canada', name: 'Canada Line (+1 Rented)', status: 'DISCONNECTED', qr: null, sock: null }
];

// Live Self-Test harness (one bot line plays a scripted voter to another). See self_test.js.
// Outside a test run, messages between our own lines are ignored (no bot-to-bot loops).
const liveSelfTest = new LiveSelfTest({
    getSessions: () => SESSIONS,
    lineContacts: engagementPolicy.LINE_CONTACTS,
    userMemory,
    // direct send: never create CRM records / goal events for our own line numbers
    sendText: (sock, jid, text) => sock.sendMessage(jid, { text }),
    resultsDir: process.env.SELF_TEST_DIR || path.join(__dirname, 'self_test_runs')
});

const sessionsDir = path.join(__dirname, 'sessions_auth');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Message store for Baileys retry requests & decrypt healing.
// Every message WE send is kept (all send paths, via the sock.sendMessage wrapper below) and persisted to
// msg_store.json (gitignored) so a phone that shows "Waiting for this message" can still get it re-sent
// after a restart/auto-deploy. Without this, retries for bulk/self-test/card sends failed forever.
const MSG_STORE_FILE = path.join(__dirname, 'msg_store.json');
const MSG_STORE_MAX = 5000;
const MSG_STORE = new Map();
try {
    const { BufferJSON: BJ } = require('@whiskeysockets/baileys');
    const raw = JSON.parse(fs.readFileSync(MSG_STORE_FILE, 'utf8'), BJ.reviver);
    for (const [k, v] of raw) MSG_STORE.set(k, v);
} catch (_) { /* first run */ }
const _msgStoreSet = MSG_STORE.set.bind(MSG_STORE);
let _msgStoreTimer = null;
MSG_STORE.set = (k, v) => {
    _msgStoreSet(k, v);
    while (MSG_STORE.size > MSG_STORE_MAX) MSG_STORE.delete(MSG_STORE.keys().next().value);
    if (!_msgStoreTimer) _msgStoreTimer = setTimeout(() => {
        _msgStoreTimer = null;
        try {
            const { BufferJSON: BJ } = require('@whiskeysockets/baileys');
            fs.writeFileSync(MSG_STORE_FILE + '.tmp', JSON.stringify([...MSG_STORE.entries()], BJ.replacer));
            fs.renameSync(MSG_STORE_FILE + '.tmp', MSG_STORE_FILE);
        } catch (e) { console.error('[MsgStore] save failed', e.message); }
    }, 3000);
    return MSG_STORE;
};
// Retry/decrypt health, shown in GET /api/msg-health (proves the "Waiting for this message" fix live)
const MSG_HEALTH = { since: new Date().toISOString(), retryServed: 0, retryMissing: 0, stored: 0, incomingUndecrypted: 0 };
// Disappearing messages (owner 5 Nov: auto-delete chats after the poll, on both sides). WhatsApp only allows
// 24h / 7 days / 90 days. Setting lives in gitignored disappearing.json; 0 = off.
const DISAPPEAR_FILE = path.join(__dirname, 'disappearing.json');
const DISAPPEAR_ALLOWED = [0, 86400, 604800, 7776000];
let DISAPPEAR = { seconds: 0, applied: {} };
try { DISAPPEAR = Object.assign(DISAPPEAR, JSON.parse(fs.readFileSync(DISAPPEAR_FILE, 'utf8'))); } catch (_) {}
function saveDisappear() { try { fs.writeFileSync(DISAPPEAR_FILE, JSON.stringify(DISAPPEAR)); } catch (e) { console.error('[Disappear] save', e.message); } }
// Per-chat timer state {exp, ts, forced} keyed "line|digits". WhatsApp phones show "This message won't disappear —
// timer conflict" when a message's expiration / ephemeralSettingTimestamp don't match the chat's setting, so we
// mirror the chat's real setting (learned from the other side's messages and setting changes) and always send the
// setting timestamp with it (Baileys 6.7 leaves ephemeralSettingTimestamp out).
DISAPPEAR.state = DISAPPEAR.state || {};
const _digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
function ephKeys(line, ...jids) { return [...new Set(jids.map(_digits).filter(Boolean))].map(d => line + '|' + d); }
function ephGet(line, ...jids) { for (const k of ephKeys(line, ...jids)) if (DISAPPEAR.state[k]) return DISAPPEAR.state[k]; return null; }
function ephSet(line, jids, st) { for (const k of ephKeys(line, ...jids)) DISAPPEAR.state[k] = Object.assign({}, DISAPPEAR.state[k] || {}, st); saveDisappear(); }
function ephLearnFromMessage(line, one) {
    try {
        const k = one && one.key; const msg = one && one.message; if (!k || !msg) return;
        const jid = k.remoteJid || ''; if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) return;
        const jids = [jid, k.remoteJidAlt, k.senderPn, k.participantAlt].filter(Boolean);
        const inner = msg.ephemeralMessage?.message || msg;
        const pm = inner.protocolMessage;
        const toN = (v) => (v == null ? null : Number(typeof v === 'object' && v.toNumber ? v.toNumber() : v));
        if (pm && Number(pm.type) === 3) { // EPHEMERAL_SETTING: someone changed the chat timer
            ephSet(line, jids, { exp: toN(pm.ephemeralExpiration) || 0, ts: toN(one.messageTimestamp) || Math.floor(Date.now() / 1000), forced: true });
            return;
        }
        if (k.fromMe) return;
        for (const t of Object.keys(inner)) {
            const ci = inner[t] && inner[t].contextInfo;
            if (ci && (ci.expiration != null || ci.ephemeralSettingTimestamp != null)) {
                const exp = toN(ci.expiration) || 0, ts = toN(ci.ephemeralSettingTimestamp);
                const cur = ephGet(line, ...jids);
                if (!cur || cur.exp !== exp || (ts && cur.ts !== ts)) ephSet(line, jids, { exp, ts: ts || (cur && cur.ts) || 0 });
                return;
            }
        }
    } catch (_) {}
}
// Short-lived device list cache (30 s instead of Baileys' 5 min): we always encrypt for the person's and our
// own CURRENT devices, so a newly linked phone/web never gets a copy it can't open ("Waiting for this message").
const USER_DEVICES = new Map();
const userDevicesCache = {
    get: k => { const e = USER_DEVICES.get(k); if (!e) return undefined; if (Date.now() > e.t) { USER_DEVICES.delete(k); return undefined; } return e.v; },
    set: (k, v) => { USER_DEVICES.set(k, { v, t: Date.now() + 30e3 }); if (USER_DEVICES.size > 5000) USER_DEVICES.delete(USER_DEVICES.keys().next().value); return true; },
    del: k => USER_DEVICES.delete(k), flushAll: () => USER_DEVICES.clear(),
    mget: ks => Object.fromEntries(ks.map(k => [k, userDevicesCache.get(k)]).filter(([, v]) => v !== undefined)),
};
const MSG_RETRY_COUNTER = new Map();
const msgRetryCounterCache = { get: k => MSG_RETRY_COUNTER.get(k), set: (k, v) => { MSG_RETRY_COUNTER.set(k, v); if (MSG_RETRY_COUNTER.size > 5000) MSG_RETRY_COUNTER.delete(MSG_RETRY_COUNTER.keys().next().value); return true; }, del: k => MSG_RETRY_COUNTER.delete(k), flushAll: () => MSG_RETRY_COUNTER.clear() };

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    if (message.ephemeralMessage?.message) return extractMessageText(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return extractMessageText(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return extractMessageText(message.viewOnceMessageV2.message);
    if (message.documentWithCaptionMessage?.message) return extractMessageText(message.documentWithCaptionMessage.message);
    if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
    if (message.templateButtonReplyMessage?.selectedId) return message.templateButtonReplyMessage.selectedId;
    if (message.listResponseMessage?.title) return message.listResponseMessage.title;
    return '';
}

/**
 * Non-text WhatsApp messages become a short token the brain understands ("[voice note]", "[sticker]" ...),
 * or 'IGNORE' for protocol noise (reactions, edits, deletes, key distribution) that must never get a reply.
 * Returns '' when nothing is recognisable (true decryption failure -> Bad MAC healing path).
 */
function mediaPlaceholder(message) {
    if (!message) return '';
    const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message;
    if (m.reactionMessage || m.protocolMessage || m.pollUpdateMessage || m.editedMessage || m.keepInChatMessage || m.pinInChatMessage) return 'IGNORE';
    if (m.audioMessage) return '[voice note]';
    if (m.stickerMessage) return '[sticker]';
    if (m.imageMessage) return '[photo]';
    if (m.videoMessage) return m.videoMessage.gifPlayback ? '[gif]' : '[video]';
    if (m.documentMessage || m.documentWithCaptionMessage) return '[document]';
    if (m.locationMessage || m.liveLocationMessage) return '[location]';
    if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
    const keys = Object.keys(m).filter(k => !['messageContextInfo', 'senderKeyDistributionMessage'].includes(k));
    if (!keys.length && (m.senderKeyDistributionMessage || m.messageContextInfo)) return 'IGNORE';
    return '';
}

// Persistent LID to Phone Number Mapping Store
const LID_MAP_FILE = path.join(__dirname, 'lid_mappings.json');
let LID_MAP = {
    '90959605924011': '916367810227' // Pre-mapped from verified chat
};
try {
    if (fs.existsSync(LID_MAP_FILE)) {
        LID_MAP = Object.assign(LID_MAP, JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8')));
    }
} catch (e) {}

function saveLidMapping(lid, pn) {
    if (!lid || !pn) return;
    const cleanLid = lid.split('@')[0].replace(/[^0-9]/g, '');
    const cleanPn = pn.split('@')[0].replace(/[^0-9]/g, '');
    if (cleanLid && cleanPn && cleanLid !== cleanPn) {
        LID_MAP[cleanLid] = cleanPn;
        try { fs.writeFileSync(LID_MAP_FILE, JSON.stringify(LID_MAP, null, 2), 'utf8'); } catch (e) {}
    }
}

function findLidForPhone(phone) {
    if (!phone) return null;
    const cleanPn = phone.replace(/[^0-9]/g, '');
    for (const [lid, pn] of Object.entries(LID_MAP)) {
        if (pn === cleanPn || pn.endsWith(cleanPn) || cleanPn.endsWith(pn)) {
            return lid + '@lid';
        }
    }
    return null;
}

// Auto-Heal: remove corrupted Signal session ratchet files for a specific contact without logging out
function healContactSession(sessionId, jid) {
    if (!jid) return;
    try {
        const authDir = path.join(sessionsDir, sessionId);
        if (!fs.existsSync(authDir)) return;
        const cleanId = jid.split('@')[0].replace(/[^0-9]/g, '');
        const files = fs.readdirSync(authDir);
        let cleaned = 0;
        for (const file of files) {
            if (file.startsWith('session-') && (file.includes(cleanId) || file.includes(jid.split('@')[0]))) {
                try {
                    fs.unlinkSync(path.join(authDir, file));
                    cleaned++;
                } catch (e) {}
            }
        }
        if (cleaned > 0) {
            console.log(`[AutoHeal] Removed ${cleaned} stale session files for ${cleanId} from ${sessionId}`);
        }
    } catch (e) {
        console.error('[AutoHeal Error]:', e.message);
    }
}

// Wrapper for sock.sendMessage that caches outgoing messages for WhatsApp retries
// One contact card per selected WhatsApp line.
function getCampaignVCard(lineId = 'sim_636') {
    return engagementPolicy.buildCampaignVCard(lineId);
}

async function sendMultiContactCard(sock, jid, senderPhone = null) {
    const vcard = engagementPolicy.buildCampaignVCard(senderPhone || 'sim_636');
    return await sock.sendMessage(jid, {
        contacts: {
            displayName: 'बाबा अभय सिंह (मोटी आंगली वाले)',
            contacts: [{ vcard }]
        }
    });
}

async function sendSafeMessage(sock, jid, content, options = {}) {
    try {
        const sent = await sock.sendMessage(jid, content, options);
        if (sent?.key?.id && sent?.message) {
            MSG_STORE.set(sent.key.id, sent.message);
            if (MSG_STORE.size > MSG_STORE_MAX) {
                const firstKey = MSG_STORE.keys().next().value;
                MSG_STORE.delete(firstKey);
            }
        }
        if (jid && jid.includes('@s.whatsapp.net')) {
            const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
            const trackedUser = userMemory.getUser(phone);
            if (trackedUser?.consentStatus === 'ACCEPTED' && !trackedUser.selfTest) dailyGoal.markContact(phone);
        }
        return sent;
    } catch (err) {
        console.error(`[sendSafeMessage Error to ${jid}]:`, err?.message || err);
        throw err;
    }
}

async function resolveTargetJid(sock, key) {
    if (!key) return '';
    let jid = key.remoteJid || '';

    // 1. If key already has remoteJidAlt (canonical Phone JID), use it!
    if (key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net')) {
        saveLidMapping(jid, key.remoteJidAlt);
        return key.remoteJidAlt;
    }

    // 2. If key has senderPn or participantAlt
    if (key.senderPn) {
        const pnJid = key.senderPn.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        saveLidMapping(jid, pnJid);
        return pnJid;
    }

    // 3. Check persistent LID map
    const cleanLid = jid.split('@')[0].replace(/[^0-9]/g, '');
    if (LID_MAP[cleanLid]) {
        return LID_MAP[cleanLid] + '@s.whatsapp.net';
    }

    // 4. Try resolving from Baileys signalRepository lidMapping
    if (jid.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const mappedPn = await sock.signalRepository.lidMapping.getPNForLID(jid);
            if (mappedPn && mappedPn.includes('@s.whatsapp.net')) {
                saveLidMapping(jid, mappedPn);
                return mappedPn;
            }
        } catch (e) {}
    }

    return jid;
}


// ---- Admin boot report: tells the campaign admin where the dashboard lives (once per boot) ----
let adminReportSent = false;
async function discoverDashboardUrls() {
    const urls = [];
    if (PUBLIC_DASHBOARD_URL) urls.push(PUBLIC_DASHBOARD_URL);
    try {
        const os = require('os');
        const logDir = path.join(os.homedir(), '.pm2', 'logs');
        if (fs.existsSync(logDir)) {
            const files = fs.readdirSync(logDir).map(f => path.join(logDir, f))
                .filter(f => fs.statSync(f).mtimeMs > Date.now() - 7 * 864e5)
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            for (const f of files) {
                const txt = fs.readFileSync(f, 'utf8').slice(-200000);
                const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
                if (m && m.length) { urls.push(m[m.length - 1]); break; }
            }
        }
    } catch (e) {}
    try {
        const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
        const ip = (await r.text()).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) urls.push(`http://${ip}`, `http://${ip}:${PORT}`);
    } catch (e) {}
    return [...new Set(urls)];
}

async function sendAdminBootReport(sessionObj) {
    if (adminReportSent || process.env.ADMIN_BOOT_REPORT !== 'on') return; // off by default: owner wants no WhatsApp pings
    const admin = String(process.env.ADMIN_PHONE || '917976410227').replace(/\D/g, '');
    if (!admin) return;
    adminReportSent = true;
    await new Promise(r => setTimeout(r, 8000));
    let commit = '';
    try { commit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (e) {}
    const urls = await discoverDashboardUrls();
    const lines = SESSIONS.map(s => `${s.status === 'CONNECTED' ? '🟢' : '🔴'} ${s.name}`).join('\n');
    const text = `🤖 Campaign bot online${commit ? ' (v ' + commit + ')' : ''}\n\nDashboard:\n${urls.length ? urls.join('\n') : '(URL not detected)'}\n\nLines:\n${lines}`;
    try {
        await sessionObj.sock.sendMessage(`${admin}@s.whatsapp.net`, { text });
        console.log('[AdminReport] Sent boot report to admin');
    } catch (e) { adminReportSent = false; throw e; }
}

// Start a WhatsApp Session
async function startSession(sessionObj) {
    if (sessionObj.reconnectTimer) {
        clearTimeout(sessionObj.reconnectTimer);
        sessionObj.reconnectTimer = null;
    }

    if (sessionObj.sock) {
        try {
            sessionObj.sock.ev.removeAllListeners();
            sessionObj.sock.end(undefined);
        } catch (e) {}
        sessionObj.sock = null;
    }

    const sessionAuthPath = path.join(sessionsDir, sessionObj.id);
    const { state, saveCreds } = await useMultiFileAuthState(sessionAuthPath);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    console.log(`[${sessionObj.id}] Starting WhatsApp Session...`);

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: false,
        defaultQueryTimeoutMs: 60000,
        msgRetryCounterCache,
        userDevicesCache,
        getMessage: async (key) => {
            if (key?.id && MSG_STORE.has(key.id)) {
                MSG_HEALTH.retryServed++;
                return MSG_STORE.get(key.id);
            }
            MSG_HEALTH.retryMissing++;
            return undefined;
        }
    });

    // keep every outgoing message for retry receipts (bulk, scheduled, self-test, cards, status — all paths)
    const _rawSend = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        const secs = Number(DISAPPEAR.seconds) || 0;
        const personal = typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
        try { noteTraffic(); } catch (_) {}
        if (personal && content && !('disappearingMessagesInChat' in content) && !content.delete && !content.react && !content.edit) {
            let st = ephGet(sessionObj.id, jid);
            // turn the chat's timer to our setting once; after that, if the voter changes it, we follow theirs (no fight)
            if (st ? (st.exp !== secs && !st.forced) : secs) { // also turns a chat's timer OFF once when our setting is 0
                try {
                    await _rawSend(jid, { disappearingMessagesInChat: secs });
                    st = { exp: secs, ts: Math.floor(Date.now() / 1000), forced: true };
                    ephSet(sessionObj.id, [jid], st);
                } catch (e) { console.warn('[Disappear]', e.message); }
            }
            if (st && st.exp > 0) {
                const ci = Object.assign({}, content.contextInfo || {}, { expiration: st.exp });
                if (st.ts) ci.ephemeralSettingTimestamp = st.ts;
                content = Object.assign({}, content, { contextInfo: ci });
            }
            if (options && options.ephemeralExpiration) { options = Object.assign({}, options); delete options.ephemeralExpiration; }
        }
        const sent = await _rawSend(jid, content, options);
        try { if (sent && sent.key && sent.key.id && sent.message) { MSG_STORE.set(sent.key.id, sent.message); MSG_HEALTH.stored++; } } catch (_) {}
        return sent;
    };

    sessionObj.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionObj.status = 'QR_READY';
            try {
                sessionObj.qr = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error(`[${sessionObj.id}] Error generating QR:`, err);
            }
            console.log(`[${sessionObj.id}] New QR code ready at /scan/${sessionObj.id}`);
        }

        if (connection === 'close') {
            sessionObj.status = 'DISCONNECTED';
            sessionObj.qr = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            console.log(`[${sessionObj.id}] Connection closed. StatusCode: ${statusCode}. LoggedOut: ${isLoggedOut}`);

            if (isLoggedOut) {
                console.log(`[${sessionObj.id}] Logged out. Wiping stale keys and generating fresh QR...`);
                const authPath = path.join(sessionsDir, sessionObj.id);
                try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {}
                sessionObj.reconnectTimer = setTimeout(() => startSession(sessionObj), 2000);
            } else {
                sessionObj.reconnectTimer = setTimeout(() => startSession(sessionObj), 5000);
            }
        } else if (connection === 'open') {
            sessionObj.status = 'CONNECTED';
            sessionObj.qr = null;
            console.log(`[${sessionObj.id}] ✅ WhatsApp Connected & Healthy!`);
            if (DISAPPEAR.seconds && sock.updateDefaultDisappearingMode) sock.updateDefaultDisappearingMode(Number(DISAPPEAR.seconds)).catch(e => console.warn('[Disappear] default', e.message));
            sendAdminBootReport(sessionObj).catch(e => console.warn('[AdminReport]', e.message));
        }
    });

    // Handle Incoming Messages
    const handleIncomingUpsert = async (m) => {
        try {
            console.log(`[${sessionObj.id}] Incoming messages.upsert: type=${m.type}, count=${m.messages?.length}`);
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                if (msg.key?.id && msg.message) {
                    MSG_STORE.set(msg.key.id, msg.message);
                    if (MSG_STORE.size > MSG_STORE_MAX) {
                        const firstKey = MSG_STORE.keys().next().value;
                        MSG_STORE.delete(firstKey);
                    }
                }

                console.log(`[${sessionObj.id}] Processing message: jid=${msg.key?.remoteJid}, fromMe=${msg.key?.fromMe}`);

                const rawJid = msg.key?.remoteJid || '';
                if (!rawJid || rawJid.includes('@g.us') || rawJid.includes('status@broadcast')) {
                    continue; // Skip group chats & status
                }

                // Resolve real target JID & phone number (maps @lid to real phone number!)
                const targetJid = await resolveTargetJid(sock, msg.key);
                const senderPhone = targetJid.split('@')[0].replace(/[^0-9]/g, '');
                // For direct replies, maintain the conversation's native thread identity (essential for @lid chats!)
                const replyJid = rawJid || targetJid;

                // If message is from me, log strictly to Diagnostics tab to keep main voter chat clean
                if (msg.key && msg.key.fromMe) {
                    const selfBody = extractMessageText(msg.message) || '[Self Device Activity]';
                    if (!selfBody.includes('ग्राम पंचायत') && !selfBody.includes('बाबा अभय सिंह')) {
                        logDiagnostic({
                            session: sessionObj.name,
                            phone: 'Self Device (' + sessionObj.id + ')',
                            incoming: selfBody,
                            reply: 'Self-message recorded in Diagnostics only. Voter chat table remains clean.',
                            status: 'SELF_DEVICE'
                        });
                    }
                    continue;
                }

                // Own-line routing: self-test capture / self-test voter / ignore (prevents bot-to-bot loops)
                const senderIds = [senderPhone, rawJid, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participant].filter(Boolean);
                const ownRoute = liveSelfTest.route(sessionObj.id, senderIds);
                if (ownRoute === 'capture') {
                    const capturedText = (msg.message?.imageMessage ? '[image] ' : (msg.message?.videoMessage ? '[video] ' : '')) + (extractMessageText(msg.message) || '') || (msg.message?.contactMessage || msg.message?.contactsArrayMessage ? '[contact card]' : '[media]');
                    liveSelfTest.capture(sessionObj.id, capturedText);
                    logDiagnostic({ session: sessionObj.name, phone: 'Self-Test (' + senderPhone + ')', incoming: capturedText, reply: 'Captured by Live Self-Test (tester line does not reply).', status: 'SELF_TEST_CAPTURE' });
                    continue;
                }
                if (ownRoute === 'ignore_own') {
                    logDiagnostic({ session: sessionObj.name, phone: 'Own line (' + senderPhone + ')', incoming: extractMessageText(msg.message) || '[non-text]', reply: 'Ignored: message from one of our own bot lines (loop guard).', status: 'OWN_LINE_IGNORED' });
                    continue;
                }
                const isSelfTestVoter = ownRoute === 'voter';
                if (isSelfTestVoter) liveSelfTest.prepareRecord(senderPhone);

                // Extract message body from all possible structures
                let body = extractMessageText(msg.message).trim();

                // Multimodal Vision: Check for incoming image message
                const hasImage = !!(msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
                let imageAnalysis = null;
                if (hasImage) {
                    try {
                        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                        if (imgBuffer) {
                            const uploadFilename = `${senderPhone}_${Date.now()}.jpg`;
                            const uploadPath = path.join(__dirname, 'media', 'uploads', uploadFilename);
                            try { fs.writeFileSync(uploadPath, imgBuffer); } catch(e) {}
                            imageAnalysis = await visionService.analyzeImage(imgBuffer);
                            if (imageAnalysis) imageAnalysis.localUrl = `/media/uploads/${uploadFilename}`;
                            try {
                                const uObj = userMemory.getUser(senderPhone);
                                if (uObj) {
                                    uObj.lastUploadedPhotoPath = uploadPath;
                                    userMemory.save();
                                }
                            } catch (e) {}
                            console.log(`[${sessionObj.id}] 📷 Vision Analysis for ${senderPhone}:`, imageAnalysis);
                        }
                    } catch (imgErr) {
                        console.error(`[${sessionObj.id}] Vision decode error for ${senderPhone}:`, imgErr.message);
                    }
                }

                const imageCaption = hasImage ? body : '';
                // Caption + a photo we could not classify (or a plain personal photo): the caption text drives the reply
                // a short caption ("ye dekhiye", "ye lo") says nothing on its own: the photo reply (ack + one-line ask) is used instead
                const captionSays = imageCaption && (imageCaption.trim().split(/\s+/).length > 4 || /\?/.test(imageCaption) || /(naali|nali|sadak|road|paani|pani|bijli|kachra|नाली|सड़क|पानी|बिजली|कचरा|गड्ढ|parchi|पर्ची)/i.test(imageCaption));
                if (hasImage && imageAnalysis && imageCaption && captionSays && (imageAnalysis.fallback || ['other', 'personal_photo'].includes(imageAnalysis.category))) {
                    try { const um = userMemory.getUser(senderPhone); if (um) { require('./voter_memory.js').ensure(um).photoOpenAt = new Date().toISOString(); } } catch (e) {}
                    imageAnalysis = null;
                }
                if (!body && hasImage) {
                    body = (imageAnalysis && imageAnalysis.summaryHindi)
                        ? `[फोटो: ${imageAnalysis.summaryHindi}]`
                        : '[photo]';
                }
                if (!body && msg.message) {
                    const token = mediaPlaceholder(msg.message);
                    if (token === 'IGNORE') {
                        logDiagnostic({ session: sessionObj.name, phone: senderPhone, incoming: '[protocol/reaction]', reply: 'Ignored (no reply needed).', status: 'IGNORED_NON_TEXT' });
                        continue;
                    }
                    if (token) body = token;
                }

                // If body is empty (e.g. Meta Cloud encryption Bad MAC or initial handshake)
                if (!body) {
                    console.log(`[${sessionObj.id}] Decryption empty or Bad MAC for ${targetJid} (raw: ${rawJid})`);
                    healContactSession(sessionObj.id, rawJid);
                    healContactSession(sessionObj.id, targetJid);
                    logDiagnostic({
                        session: sessionObj.name,
                        phone: senderPhone,
                        incoming: '[Encrypted Packet / Bad MAC Decryption Error]',
                        reply: 'Purged stale contact session and sent auto-handshake to ' + replyJid + '.',
                        status: 'BAD_MAC'
                    });

                    // Send auto-handshake welcome message so voter gets an instant reply and Signal session re-synchronizes!
                    try {
                        const existingUser = userMemory.getUser(senderPhone);
                        if (existingUser && existingUser.lastHandshakeTime && (Date.now() - existingUser.lastHandshakeTime < 60000)) {
                            console.log(`[${sessionObj.id}] Handshake already sent recently to ${senderPhone}, skipping duplicate`);
                            continue;
                        }
                        if (existingUser) {
                            existingUser.lastHandshakeTime = Date.now();
                            userMemory.save();
                        }
                        const handshakeText = "राम राम भाई जी! 🙏\nबाबा अभय सिंह जनसंपर्क (ग्राम पंचायत सिहाली खुर्द) में आपका स्वागत है।\nवोटर लिस्ट में नाम व पर्ची देखने के लिए अपना नाम लिखकर भेजें! 🚩";
                        await sendSafeMessage(sock, replyJid, { text: handshakeText });
                        console.log(`[${sessionObj.id}] ✅ Sent handshake reply to ${replyJid}`);
                        userMemory.recordMessage(senderPhone, 'bot', handshakeText, null, sessionObj.name);
                        logMessage({
                            session: sessionObj.name,
                            phone: senderPhone,
                            incoming: '[New Contact / Welcome Handshake]',
                            reply: handshakeText,
                            status: 'HANDSHAKE_SENT'
                        });
                    } catch (handshakeErr) {
                        console.error(`[${sessionObj.id}] Handshake reply error to ${replyJid}:`, handshakeErr?.message);
                    }
                    continue;
                }

                console.log(`[${sessionObj.id}] Received from ${senderPhone} (${replyJid}): "${body}"`);

                // First contact: save to Contacts (voter match / pushName) and pin this line (sticky)
                if (!isSelfTestVoter) {
                    autoSaveContact({ phone: senderPhone, pushName: msg.pushName, lineId: sessionObj.id, sock, jid: replyJid, source: 'inbound' });
                    try { dailyGoal.recordEvent && dailyGoal.recordEvent('reply', { phone: senderPhone, line: sessionObj.id, ward: (userMemory.users[senderPhone] || {}).ward }); } catch (e) {}
                }

                // Record user message in memory
                userMemory.recordMessage(senderPhone, 'user', body, null, sessionObj.name);

                // Anti-Rogue Protection: Check if AutoPilot is PAUSED for this specific contact
                const user = userMemory.getUser(senderPhone);

                // Explicit opt-out (STOP / बंद / रुको …) — permanent for automation AND bulk broadcasts.
                // Checked before the consent flow so a broadcast recipient replying STOP never gets a consent prompt.
                if (engagementPolicy.isOptOutMessage(body)) {
                    const firstTime = !user.broadcastOptOut;
                    engagementPolicy.applyOptOut(user);
                    userMemory.save();
                    broadcastEngine.markOptOut(senderPhone, body);
                    operationsTracker.record('opt_out', 'recorded', { lineId: sessionObj.id });
                    if (firstTime) {
                        // voter-facing text is Hindi unless the voter chose Hinglish
                        const ack = engagementPolicy.buildOptOutAck(replyBrain.scriptPrefOf(user) === 'hinglish' ? 'hinglish' : 'hi');
                        try {
                            await sendSafeMessage(sock, replyJid, { text: ack });
                            userMemory.recordMessage(senderPhone, 'bot', ack, 'opt_out_ack', sessionObj.name);
                        } catch (e) {}
                    }
                    logMessage({ session: sessionObj.name, phone: senderPhone, incoming: body, reply: '[Opted out of all campaign messages]', status: 'OPTED_OUT' });
                    continue;
                }
                if (user.broadcastOptOut && engagementPolicy.isOptInMessage(body)) {
                    engagementPolicy.applyOptIn(user);
                    userMemory.save();
                    broadcastEngine.removeOptOut(senderPhone);
                    operationsTracker.record('opt_in', 'recorded', { lineId: sessionObj.id });
                    const welcomeBack = 'धन्यवाद! 🙏 आप फिर से जुड़ गए हैं। बताइए—मतदाता पर्ची, वार्ड जानकारी या गाँव की कोई समस्या?';
                    await sendSafeMessage(sock, replyJid, { text: welcomeBack });
                    userMemory.recordMessage(senderPhone, 'bot', welcomeBack, 'opt_in_ack', sessionObj.name);
                    continue;
                }

                // Consent is a real state transition, not just message copy.
                // New contacts receive the permission prompt before campaign automation starts.
                const consentDecision = engagementPolicy.parseConsentResponse(body);
                // A new contact who opens with a real message (question, problem, parchi ask) gets that answered right away;
                // only a bare greeting / emoji gets the short 1-line intro. No long welcome block.
                const firstIsSubstantive = user.consentStatus === 'PENDING' && consentDecision !== 'rejected' && !engagementPolicy.isOptOutMessage(body) &&
                    String(body || '').trim().split(/\s+/).length >= 2 && !/^(hi+|hello|hey|hlo|ram ram|raam raam|namaste|namaskar|pranam|jai shri ram|radhe radhe|राम राम|नमस्ते|नमस्कार|प्रणाम)[\s\p{L}\p{M}!.,🙏]{0,12}$/iu.test(String(body || '').trim());
                if (firstIsSubstantive) {
                    engagementPolicy.applyConsentDecision(user, 'accepted');
                    userMemory.save();
                    operationsTracker.record('consent', 'accepted', { lineId: sessionObj.id, via: 'substantive_first_message' });
                }
                if (user.consentStatus === 'PENDING') {
                    engagementPolicy.markConsentPrompted(user);
                    userMemory.save();
                    const consentPrompt = engagementPolicy.buildConsentPrompt(user.name, engagementPolicy.messageLanguage(body));
                    await sendSafeMessage(sock, replyJid, { text: consentPrompt });
                    userMemory.recordMessage(senderPhone, 'bot', consentPrompt, 'consent_prompt', sessionObj.name);
                    operationsTracker.record('consent_prompt', 'sent', { lineId: sessionObj.id });
                    // Owner (5 Nov): this line's vCard arrives instantly after the first reply, once per contact per line.
                    // Card only — no extra "please save" text stacked on the short intro.
                    sendLineContactCardOnce(sock, replyJid, senderPhone, sessionObj, { withPrompt: false }).catch(() => {});
                    continue;
                }

                const substantiveFirstReply = consentDecision === 'accepted' &&
                    !/^(1|1\.|ha+n?|haa|हाँ|हां|ji|जी|ok+|okay|yes|theek( hai)?|thik( hai)?|ठीक है|bilkul|बिल्कुल|zaroor|ज़रूर|जरूर)[\s!.🙏👍]*$/i.test(body.trim());
                if (user.consentStatus === 'PROMPTED' && consentDecision === 'accepted' && substantiveFirstReply) {
                    // A real question/statement in reply to the intro: accept consent and answer it (no canned menu)
                    engagementPolicy.applyConsentDecision(user, 'accepted');
                    userMemory.save();
                    operationsTracker.record('consent', 'accepted', { lineId: sessionObj.id, via: 'substantive_reply' });
                } else if (user.consentStatus === 'PROMPTED' && consentDecision) {
                    engagementPolicy.applyConsentDecision(user, consentDecision);
                    userMemory.save();
                    const consentReply = consentDecision === 'accepted'
                        ? `धन्यवाद! 🙏 बताइए—अपनी मतदाता पर्ची देखनी है, वार्ड की जानकारी चाहिए, या गाँव की कोई समस्या साझा करनी है?`
                        : `जी, आपके निर्णय का सम्मान है। अब कोई स्वचालित चुनावी संदेश नहीं भेजा जाएगा। 🙏`;
                    await sendSafeMessage(sock, replyJid, { text: consentReply });
                    userMemory.recordMessage(senderPhone, 'bot', consentReply, `consent_${consentDecision}`, sessionObj.name);
                    operationsTracker.record('consent', consentDecision, { lineId: sessionObj.id });
                    continue;
                }

                if (user.consentStatus === 'PROMPTED' && !consentDecision) {
                    const retryPrompt = engagementPolicy.buildConsentPrompt(user.name, engagementPolicy.messageLanguage(body));
                    await sendSafeMessage(sock, replyJid, { text: retryPrompt });
                    userMemory.recordMessage(senderPhone, 'bot', retryPrompt, 'consent_retry', sessionObj.name);
                    continue;
                }

                if (user.autoPilot === false) {
                    console.log(`[${sessionObj.id}] ⏸️ AutoPilot is PAUSED for ${senderPhone}. Admin manual takeover active.`);
                    logMessage({
                        session: sessionObj.name,
                        phone: senderPhone,
                        incoming: body,
                        reply: '[AutoPilot PAUSED: Admin Direct Mode Active]',
                        status: 'MANUAL_TAKEOVER'
                    });
                    continue; // Skip automated AI reply! Admin can reply manually from dashboard
                }

                let replyText = '';
                let mediaTypeSent = null;

                try {
                    const lower = body.toLowerCase().trim();

                    // Anti-Spam Consent Gate (Option 1: Haan / Option 2: Nahi)
                    const isConsentPromptActive = (user && user.consentStatus === 'PROMPTED');
                    const isConsentYes = lower === '1' || lower === '1.' || lower === 'haan' || lower === 'ha' || lower === 'हाँ' || lower === 'yes';
                    const isConsentNo = lower === '2' || lower === '2.' || lower === 'nahi' || lower === 'nhi' || lower === 'नहीं' || lower === 'no';

                    if (isConsentPromptActive && isConsentYes) {
                        user.consented = true;
                        user.consentStatus = 'ACCEPTED';
                        user.conversationStage = 'ASKED_LANGUAGE';
                        userMemory.save();
                        replyText = `राम राम ${user.name || 'भाई जी'}! 🙏\nहम बाबा अभय सिंह (मोटी आंगली वाले) के साथ जुड़े हैं।\nकृपया यह नंबर 'बाबा अभय सिंह' नाम से ज़रूर सेव कर लें ताकि मतदाता पर्ची आप तक आसानी से पहुँच सके! 📲\n\nआप बातचीत हिंदी (देवनागरी) में पसंद करेंगे या Hinglish (English अक्षरों) में?\n1️⃣ Hinglish (ABC format)\n2️⃣ Hindi (देवनागरी)\n\n*(या सीधे अपनी वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें! 🚩)*`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        try { require('./voter_memory.js').ensure(user).scriptAskedAt = new Date().toISOString(); } catch (e) {} // language asked here; the brain won't ask again
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'consent_ack', sessionObj.name);
                        logMessage({ session: sessionObj.name, phone: senderPhone, incoming: body, reply: replyText, status: 'CONSENT_ACCEPTED' });
                        continue;
                    }

                    // Dynamic Language Preference Choice
                    if (user && user.conversationStage === 'ASKED_LANGUAGE') {
                        if (lower === '1' || lower === '1.' || lower.includes('hinglish') || lower.includes('english')) {
                            replyBrain.setScriptPref(user, 'hinglish', 'voter');
                            user.conversationStage = 'ASKED_OCCUPATION';
                            userMemory.save();
                            replyText = `Bahut badhiya ${user.name || 'bhai ji'}! Ab se aapse Hinglish (ABC format) me hi baat hogi. 😊\nAap kya karte ho — student, kisan, army, police ya apna koi kaam? 🚩`;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_choice', sessionObj.name);
                            continue;
                        } else if (lower === '2' || lower === '2.' || lower.includes('hindi') || lower.includes('हिंदी')) {
                            replyBrain.setScriptPref(user, 'hindi', 'voter');
                            user.conversationStage = 'ASKED_OCCUPATION';
                            userMemory.save();
                            replyText = `बहुत बढ़िया ${user.name || 'भैया'}! अब से आपसे हिंदी (देवनागरी) में बातचीत होगी। 😊\nआप क्या करते हैं — पढ़ाई, किसानी, फौज, पुलिस या अपना कोई काम? 🚩`;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_choice', sessionObj.name);
                            continue;
                        }
                    }

                    // On-the-fly Language Switch
                    // script preference switch (5 Nov): saved as memory.scriptPref and honoured by every later reply
                    if ((lower.includes('hinglish me') || lower.includes('english me') || lower.includes('roman me')) && body.trim().split(/\s+/).length <= 10) {
                        replyBrain.setScriptPref(user, 'hinglish', 'voter');
                        userMemory.save();
                        replyText = `Zaroor ji 🙏 Ab se Hinglish (Roman) me hi baat karungi. Bataiye, kya madad karun—parchi, booth ya gaon ka koi kaam?`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_switch', sessionObj.name);
                        continue;
                    }
                    if ((lower.includes('hindi me') || lower.includes('हिंदी में') || lower.includes('हिन्दी में')) && body.trim().split(/\s+/).length <= 10) {
                        replyBrain.setScriptPref(user, 'hindi', 'voter');
                        userMemory.save();
                        replyText = `ज़रूर जी 🙏 अब से हिंदी में ही बात करूँगी। बताइए, क्या मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_switch', sessionObj.name);
                        continue;
                    }

                    if (isConsentPromptActive && isConsentNo) {
                        user.consented = false;
                        user.consentStatus = 'REJECTED';
                        user.autoPilot = false; // Stop automated outreach permanently
                        userMemory.save();
                        replyText = `जी भाई जी, आपके निर्णय का पूरा सम्मान है। आपको आगे कोई चुनावी संदेश नहीं भेजा जाएगा। बहुत-बहुत धन्यवाद! 🙏`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'consent_rejected', sessionObj.name);
                        logMessage({ session: sessionObj.name, phone: senderPhone, incoming: body, reply: replyText, status: 'CONSENT_REJECTED' });
                        continue;
                    }

                    // Extract Ward if mentioned (reuse the outer `user`; re-declaring it here caused a TDZ ReferenceError
                    // on EVERY consented message, which silently routed all replies to the fallback template)
                    const wardMatch = lower.match(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/i);
                    if (wardMatch) {
                        user.ward = parseInt(wardMatch[1]);
                        userMemory.save();
                    }

                    const isMediaToken = replyBrain.MEDIA_RX.test(body.trim());
                    // 5 Nov: only a REQUEST for a poster/video sends one ("poster bhejo", "video dikhao"); a voter who is sending us a
                    // photo ("photo bhej raha hu, dekhiye") or whose message came with an image is never answered with our poster.
                    const mediaAsk = /(bhejo|bhej do|bhejiye|bhej dijiye|dikhao|dikhaiye|dikha do|chahiye|chaiye|de do|send|भेजो|भेज दो|भेजिए|भेज दीजिए|दिखाओ|दिखाइए|दिखा दो|चाहिए|दे दो)/i.test(lower) && !/(bhej raha|bhej rahi|bhej rha|bhej rhi|bhej diya|bhej di|bhejta|dekhiye|dekho|dekh lo|भेज रहा|भेज रही|भेज दिया|भेज दी|देखिए|देखो|देख लो)/i.test(lower);
                    const isPhotoQuery = !isMediaToken && !hasImage && mediaAsk && /(photo|poster|फोटो|पोस्टर|तस्वीर|banner|image)/i.test(lower);
                    const isVideoQuery = !isMediaToken && !hasImage && mediaAsk && /(video|reel|वीडियो|रील|clip)/i.test(lower);
                    const isPosterGenQuery = lower.includes('poster bana') || lower.includes('status bana') || lower.includes('फोटो बना') || lower.includes('पोस्टर बना');

                    // Check if user is confirming previous query ("ye hie details h", "yahi h", "itna hi pata h", etc.)
                    // Context-loss fix: "yahi"/"nahi pata" re-ran the last voter search on ANY later message ("nahi pata kab banegi
                    // sadak" -> a slip again). It now counts only as a short answer right after our own slip prompt.
                    const lastBotForSlip = ((user.history || []).filter(h => h.role === 'bot').slice(-1)[0] || {}).text || '';
                    const isFollowUpDetails = (lower.includes('ye hie') || lower.includes('yahi') || lower.includes('yehi') || lower.includes('itna hi') || lower.includes('nahi pata')) &&
                        /(पर्ची|वोटर लिस्ट|parchi)/i.test(lastBotForSlip) && body.trim().split(/\s+/).length <= 5 && !/(डिजिटल मतदाता पर्ची|परिवार की मतदाता पर्ची)/.test(lastBotForSlip);
                    let effectiveSearchText = body;
                    if (isFollowUpDetails && user && user.lastSearchedQuery) {
                        effectiveSearchText = user.lastSearchedQuery;
                        console.log(`[${sessionObj.id}] Contextual follow-up detected for ${senderPhone}. Using last query: "${effectiveSearchText}"`);
                    }

                    // High-accuracy voter slip intent
                    const hasEpicPattern = /\b([A-Za-z]{3}\d{7}|RJ\/\d+\/\d+\/\d+|[Ww]\d{1,2}-\d{1,4})\b/i.test(effectiveSearchText);
                    const hasExplicitParchiKeyword = lower.includes('parchi') || lower.includes('पर्ची') || lower.includes('voter slip') || lower.includes('मतदाता पर्ची') || lower.includes('voter card') || lower.includes('voter id') || lower.includes('पहचान पत्र');
                    const hasParchiPhrase = lower.includes('bhej do') || lower.includes('bhejo') || lower.includes('nikalo') || lower.includes('निकालो') || lower.includes('भेज दो') || lower.includes('भेजो') || lower.includes('naam dekhna') || lower.includes('naam check') || lower.includes('list me naam') || lower.includes('naam list');

                    const isConversational = voterEngine.isConversationalInquiry(body);
                    const isGreetingMsg = voterEngine.isGreeting(body);

                    // While the voter is answering our samasya/mulaqat questions ("shiv mandir ke paas", "Ramesh ke ghar ke saamne"),
                    // a name-like answer must not be hijacked by the voter-slip search — only an explicit parchi ask is.
                    const inBrainFlow = replyBrain.inFlow(user) && !hasExplicitParchiKeyword && !hasEpicPattern;
                    // "main ward 4 se hu, mera naam Suresh hai" is an introduction (the brain remembers name + ward), not a slip ask
                    const isSelfIntro = /((mera|meri|mero|mhara|my)\s+(naam|name|nam)|(मेरा|म्हारा)\s+नाम)/i.test(body) && !hasExplicitParchiKeyword && !hasEpicPattern && !hasParchiPhrase && !/(pita|pitaji|father|pati|husband|पिता|पति|s\/o|w\/o)/i.test(body);
                    const isVoterSlipIntent = !inBrainFlow && !isSelfIntro && !isConversational && !isGreetingMsg && !isPhotoQuery && !isVideoQuery && !isPosterGenQuery && (
                        hasEpicPattern ||
                        hasExplicitParchiKeyword ||
                        (hasParchiPhrase && !lower.includes('photo') && !lower.includes('video') && !lower.includes('poster')) ||
                        voterEngine.isLikelyNameOrVoterQuery(effectiveSearchText) ||
                        isFollowUpDetails
                    );

                    // Answers to our own slip questions (ward asked / family card offered) skip the NLU (slip_flow.preempt)
                    let slipPre = null;
                    if (!imageAnalysis) { try { slipPre = slipFlow.preempt(body, user); } catch (e) { slipPre = null; } }
                    // NLU v5: understand the message (LLM JSON, ~4s, rules fallback) before routing
                    let nluPlan = null;
                    if (!slipPre && !imageAnalysis && !isMediaToken && !isPosterGenQuery && !isVideoQuery && process.env.NLU !== 'off') {
                        try {
                            const llmOn = process.env.NLU_LLM !== 'off' && aiService.aiStatus().anyLLM;
                            const n = await nluMod.understand(body, user, { callLLM: llmOn ? (sys, prompt, budget) => aiService.callLLMCascade(sys, [], prompt, null, budget) : null });
                            nluPlan = nluRouter.plan(n, user, { text: body, line: sessionObj.id, test: !!isSelfTestVoter, lineDisplay: (engagementPolicy.getLineContact ? engagementPolicy.getLineContact(sessionObj.id).display : '') });
                            user.lastNlu = { at: new Date().toISOString(), msg: String(body).slice(0, 80), intent: n.intent, target: n.target_person, name: n.person_name_hi || n.person_name_roman || null, source: n.source, llmFailed: !!n.llm_failed };
                            console.log(`[${sessionObj.id}] NLU ${senderPhone}: ${n.intent} (${n.source}${n.llm_failed ? ', llm failed' : ''}) target=${n.target_person || '-'} name=${n.person_name_hi || n.person_name_roman || '-'}`);
                        } catch (e) { console.error(`[${sessionObj.id}] NLU error:`, e.message); nluPlan = null; }
                    }
                    if (nluPlan && nluPlan.reply && (isPhotoQuery)) nluPlan.reply = null;

                    let slipPlan = slipPre || null;
                    if (!slipPre && !imageAnalysis && !isPosterGenQuery && !isVideoQuery && !isPhotoQuery && !(nluPlan && nluPlan.reply)) {
                        const slipOpts = nluPlan && nluPlan.slipOpts ? { ...nluPlan.slipOpts, blocked: false }
                            : { slipIntent: isVoterSlipIntent && !(nluPlan && nluPlan.noSlip), searchText: effectiveSearchText, blocked: inBrainFlow || isSelfIntro, noSlip: !!(nluPlan && nluPlan.noSlip) };
                        try { slipPlan = slipFlow.decide(body, user, slipOpts); }
                        catch (e) { console.error(`[${sessionObj.id}] slip flow error:`, e.message); slipPlan = null; }
                    }

                    if (imageAnalysis) {
                        // Photo understanding (media_understanding.js): civic photo -> samasya with "photo received"; poster -> thanks;
                        // unreadable -> warm ack + one-line ask (next problem-like answer is logged). Never promises a fix or a date.
                        if (imageAnalysis.suggestedTag) {
                            userMemory.updateTags(senderPhone, [imageAnalysis.suggestedTag]);
                        }
                        let pr = null;
                        if (imageAnalysis.category === 'voter_id') {
                            const searchQ = imageAnalysis.details?.epic || '';
                            const parchiMatches = searchQ ? voterEngine.searchVoters(searchQ) : [];
                            if (parchiMatches && parchiMatches.length === 1) {
                                replyText = `राम राम जी! 🙏 आपकी वोटर आईडी की पहचान हो गई है:\n\n` + voterEngine.formatVoterSlip(parchiMatches[0]);
                            }
                        }
                        if (!replyText) {
                            pr = mediaUnderstanding.replyForPhoto({ user, analysis: imageAnalysis, caption: imageCaption, meta: { phone: senderPhone, line: sessionObj.id, test: !!isSelfTestVoter, localUrl: imageAnalysis.localUrl } });
                            replyText = pr.text;
                            userMemory.save();
                        }
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        mediaTypeSent = 'visionResponse';
                    } else if (isPosterGenQuery) {
                        // On-the-fly personalized status poster generation
                        let voterName = (matches && matches.length > 0) ? matches[0].name : (userMemory.getUser(senderPhone).name || 'समर्थक');
                        // Clean query to see if voter gave an explicit name e.g. "mera poster banao Ramesh"
                        const cleanExtracted = body.replace(/.*?(poster|status|फोटो|पोस्टर).*?(banao|bana|बनाओ|बना)?/i, '').replace(/mere naam ka|mera|naam|hai|mera naam/gi, '').trim();
                        if (cleanExtracted.length >= 2 && cleanExtracted.length <= 25) {
                            voterName = cleanExtracted;
                        }

                        const statusPosterBuffer = await posterEngine.generatePoster({
                            name: voterName,
                            aspect: '9:16'
                        });

                        replyText = `राम राम ${voterName} जी! 🙏\nबाबा अभय सिंह टीम द्वारा आपके नाम का विशेष WhatsApp Status पोस्टर तैयार कर दिया गया है।\nइसे अपने स्टेटस व प्रोफाइल पर जरूर लगाएं! 🚩`;

                        await sendSafeMessage(sock, replyJid, {
                            image: statusPosterBuffer,
                            caption: replyText
                        });

                        mediaTypeSent = 'customPoster';
                        console.log(`[${sessionObj.id}] ✅ Sent personalized poster to ${senderPhone} (${voterName})`);
                    } else if (isVideoQuery) {
                        const video = mediaCatalog.getNextVideo(senderPhone);
                        replyText = video.caption;
                        if (video.remoteUrl) {
                            await sendSafeMessage(sock, replyJid, {
                                video: { url: video.remoteUrl },
                                caption: replyText
                            });
                        } else if (video.localPath && fs.existsSync(video.localPath)) {
                            await sendSafeMessage(sock, replyJid, {
                                video: fs.readFileSync(video.localPath),
                                caption: replyText
                            });
                        } else {
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                        }
                        mediaTypeSent = 'video';
                        console.log(`[${sessionObj.id}] ✅ Sent video (${video.id}) to ${senderPhone}`);
                    } else if (isPhotoQuery) {
                        const poster = mediaCatalog.getNextPoster(senderPhone, body);
                        replyText = poster.caption;
                        if (poster.localPath && fs.existsSync(poster.localPath)) {
                            await sendSafeMessage(sock, replyJid, {
                                image: fs.readFileSync(poster.localPath),
                                caption: replyText
                            });
                        } else if (poster.remoteUrl) {
                            await sendSafeMessage(sock, replyJid, {
                                image: { url: poster.remoteUrl },
                                caption: replyText
                            });
                        } else {
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                        }
                        mediaTypeSent = poster.id.includes('demo') ? 'demoPoster' : 'poster';
                        console.log(`[${sessionObj.id}] ✅ Sent poster (${poster.id}) to ${senderPhone}`);
                    } else if (nluPlan && nluPlan.reply) {
                        // NLU v5 direct reply: contact ask (+ card), voter card not received, "who am I", campaign talk / concern
                        try { require('./voter_memory.js').updateFromVoterMessage(user, body, { lastBotText: lastBotForSlip, intent: nluPlan.reply.intent, topic: null }); } catch (e) {}
                        replyText = nluPlan.reply.text;
                        userMemory.save();
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        mediaTypeSent = 'nlu_' + nluPlan.reply.intent;
                        if (nluPlan.reply.contactCard) {
                            try { contactCard.markSent(user, sessionObj.id); userMemory.save(); } catch (e) {}
                            setTimeout(() => { sendMultiContactCard(sock, replyJid, sessionObj.id).then(() => userMemory.recordMessage(senderPhone, 'bot', '📇 [Line contact card sent]', null, sessionObj.name)).catch(() => {}); }, 1500);
                        }
                    } else if (slipPlan) {
                        // Voter slip (slip_flow.js): numbered choice, "हाँ" confirmation, remembered name, full-name match
                        const targetVoter = slipPlan.voter || null;
                        // keep the conversation memory growing on slip turns too (name/ward/concerns said alongside)
                        try { require('./voter_memory.js').updateFromVoterMessage(user, body, { lastBotText: lastBotForSlip, intent: 'voter_slip', topic: null }); } catch (e) {}
                        if (slipPlan.kind === 'family' && targetVoter) {
                            const fam = slipPlan.members || [targetVoter];
                            replyText = `🏠 आपके परिवार की मतदाता पर्ची (${fam.length} मतदाता) 🙏`;
                            let famBuf = null;
                            try { famBuf = await voterCardGen.generateFamilyCard(targetVoter, fam); } catch (e) { console.error(`[${sessionObj.id}] family card error:`, e.message); }
                            if (famBuf) await sendSafeMessage(sock, replyJid, { image: famBuf, caption: replyText });
                            else { replyText += '\n\n' + fam.map((m, i) => `${i + 1}. ${m.name_hi} — क्रमांक ${m.sr_no}`).join('\n'); await sendSafeMessage(sock, replyJid, { text: replyText }); }
                            mediaTypeSent = famBuf ? 'familySlipCard' : 'familySlip';
                            try { const m = require('./voter_memory.js').ensure(user); m.familyCardSent = { ward: Number(targetVoter.ward), house: targetVoter.house_no, n: fam.length, at: new Date().toISOString() }; } catch (e) {}
                            userMemory.save();
                        } else if (slipPlan.kind === 'deliver' && targetVoter) {
                            userMemory.save();
                            const slipEn = !!(user.memory && user.memory.scriptPref === 'hinglish');
                            // Prince 19:04: the card + one short caption line (+ one short family line); full text only if the card fails
                            replyText = slipFlow.deliverCaption(user, targetVoter, slipEn, !!slipPlan.other);
                            let cardBuffer = null;
                            try { cardBuffer = await voterCardGen.generateVoterCard(targetVoter); }
                            catch (cardErr) { console.error(`[${sessionObj.id}] Error generating voter card:`, cardErr.message); }
                            if (!cardBuffer) replyText = voterEngine.formatShortSlipResponse(targetVoter) + slipFlow.familyTail(user, targetVoter, slipEn, !!slipPlan.other);
                            if (cardBuffer) {
                                try { fs.writeFileSync(path.join(__dirname, 'media', 'uploads', `parchi_${targetVoter.id || targetVoter.sr_no}.jpg`), cardBuffer); } catch (e) {}
                                await sendSafeMessage(sock, replyJid, { image: cardBuffer, caption: replyText });
                                mediaTypeSent = 'voterSlipCard';
                            } else {
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'voterSlip';
                            }
                            console.log(`[${sessionObj.id}] ✅ Sent voter slip to ${senderPhone} (${targetVoter.name_hi})`);
                        } else {
                            if (slipPlan.kind === 'confirm' && targetVoter) voterCardGen.generateVoterCard(targetVoter).catch(() => {});
                            userMemory.save();
                            replyText = slipPlan.text;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            mediaTypeSent = { confirm: 'parchiConfirmation', choose: 'disambiguation', ask_name: 'parchiNamePrompt', not_found: 'parchiNotFound', recall: 'parchiRecall' }[slipPlan.kind] || 'parchi';
                        }
                    } else if (body.toLowerCase().trim() === 'prince' || body.toLowerCase().trim() === 'admin') {
                        replyText = `राम राम प्रिंस भाई जी! 🙏\nआप बाबा अभय सिंह (मोटी आंगली वाले) के मुख्य चुनाव प्रचारक व डिजिटल सेवा प्रभारी हैं।\nसिहाली खुर्द 2026 का डिजिटल अभियान 24/7 पूरे दम-खम के साथ लाइव है! 🚩\nबताइए भाई जी, आज के प्रचार या सिस्टम में क्या नया अपडेट करना है?`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        console.log(`[${sessionObj.id}] ✅ Recognized Campaign Lead Prince (${senderPhone})`);
                    } else {
                        // AI Assistant query
                        const history = userMemory.getUserHistory(senderPhone).slice(0, -1).map(h => ({
                            role: h.role === 'bot' ? 'assistant' : 'user',
                            content: h.text
                        }));

                        const clar = nluPlan && nluPlan.nlu && nluPlan.nlu.intent === 'unclear' && ['unclear', 'short_reply'].includes(replyBrain.classify(body, user).intent) ? nluRouter.clarify(user) : null; // the brain's own rules (e.g. English "who is this?") win over a bare 'unclear'
                        replyText = clar || await aiService.getAIResponse(body, NVIDIA_API_KEY, history, senderPhone, { line: sessionObj.id, test: !!isSelfTestVoter, nlu: nluPlan ? nluPlan.nlu : null, noSlip: !!(nluPlan && (nluPlan.noSlip || nluPlan.slipOpts)) });
                        replyText = stripBallotNumber(replyText);
                        if (!replyText || replyText.trim() === '') {
                            replyText = aiService.getSafeFallback(body, senderPhone);
                        }
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        console.log(`[${sessionObj.id}] ✅ Replied via AI/local to ${senderPhone}`);
                    }
                } catch (err) {
                    console.error(`[${sessionObj.id}] Error resolving reply:`, err);
                    replyText = aiService.getSafeFallback(body, senderPhone);
                    await sendSafeMessage(sock, replyJid, { text: replyText }).catch(e => console.error('Fallback send failed:', e));
                }

                // Record bot reply in memory
                userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);

                // v6 daily lock: the day's operator media, once per voter per day, after a real exchange (or when relevant)
                try {
                    const uDm = userMemory.getUser(senderPhone);
                    const dm = operatorControl.dayMediaFor(uDm, { intent: replyBrain.classify(body, uDm).intent });
                    if (dm && replyText && (!mediaTypeSent || /^nlu_/.test(String(mediaTypeSent)))) {
                        operatorControl.markDayMedia(uDm); userMemory.save();
                        setTimeout(async () => {
                            try {
                                const full = path.join(__dirname, 'media', dm.file);
                                const content = dm.type === 'video' ? { video: fs.readFileSync(full), caption: dm.caption || undefined } : { image: fs.readFileSync(full), caption: dm.caption || undefined };
                                await sendSafeMessage(sock, replyJid, content);
                                userMemory.recordMessage(senderPhone, 'bot', dm.caption || ('📎 [आज का मीडिया: ' + dm.file + ']'), 'dayMedia', sessionObj.name, '/media/' + encodeURIComponent(dm.file));
                                operationsTracker.record('day_media', 'sent', { lineId: sessionObj.id, mediaType: dm.type });
                                logMessage({ session: sessionObj.name, phone: senderPhone, incoming: '[आज का मीडिया]', reply: dm.caption || dm.file, status: 'MEDIA_SENT' });
                            } catch (e) { console.warn('[DayMedia] send failed:', e.message); }
                        }, 4000);
                    }
                } catch (e) { console.warn('[DayMedia hook]', e.message); }

                // Anti-Ban Shield: Auto-send 3-in-1 Campaign Contact Card during early interactions (turns 1 to 3)
                try {
                    const u = userMemory.getUser(senderPhone);
                    const userMsgCount = (u.history || []).filter(h => h.role === 'user').length;

                    // Send on interaction 1, 2, or 3 if not already sent
                    if (contactCard.needsCard(u, sessionObj.id) && userMsgCount >= 1) {
                        contactCard.markSent(u, sessionObj.id);
                        userMemory.save();

                        setTimeout(async () => {
                            try {
                                console.log(`[AntiBan] Auto-sending 3-in-1 Contact Card to ${senderPhone} (turn ${userMsgCount})...`);
                                await sendMultiContactCard(sock, replyJid, sessionObj.id);

                                const isElder = (u.age && u.age >= 50) || body.toLowerCase().includes('bacha') || body.toLowerCase().includes('tau') || body.toLowerCase().includes('chacha');
                                const honorific = u.gender === 'F' ? 'दीदी' : (isElder ? 'ताऊजी' : 'भैया');
                                const savePrompt = `राम राम ${honorific}! 🙏 ${engagementPolicy.buildSaveContactPrompt(sessionObj.id, u.languagePreference)}`;

                                await sendSafeMessage(sock, replyJid, { text: savePrompt });
                                userMemory.recordMessage(senderPhone, 'bot', '📇 [Auto Anti-Ban Contact Card Sent]', null, sessionObj.name);
                            } catch (cardErr) {
                                console.warn(`[AntiBan] Error auto-sending contact card to ${replyJid}:`, cardErr?.message);
                            }
                        }, 1500);
                    }
                } catch (cardHookErr) {
                    console.warn('[AntiBan Hook Error]:', cardHookErr?.message);
                }

                // Log to live dashboard feed
                logMessage({
                    session: sessionObj.name,
                    phone: senderPhone,
                    incoming: body,
                    reply: replyText,
                    status: mediaTypeSent ? 'MEDIA_SENT' : 'DELIVERED'
                });
            }
        } catch (err) {
            console.error(`[${sessionObj.id}] Error in messages.upsert:`, err);
        }
    };

    // Volume safety: every message goes through the shared queue (per-chat serialization,
    // global concurrency limit, duplicate-id suppression). See chat_queue.js.
    sock.ev.on('messages.upsert', (m) => {
        if (!m || !Array.isArray(m.messages) || !m.messages.length) return;
        try { noteTraffic(); } catch (_) {}
        for (const one of m.messages) {
            ephLearnFromMessage(sessionObj.id, one);
            // decrypt failure on our side (Baileys asks the sender's phone to re-send automatically); counted in /api/msg-health
            if (one.messageStubType === 2 && !one.message) { MSG_HEALTH.incomingUndecrypted = (MSG_HEALTH.incomingUndecrypted || 0) + 1; MSG_HEALTH.lastUndecryptedAt = new Date().toISOString(); (MSG_HEALTH.undecryptedFrom = MSG_HEALTH.undecryptedFrom || []).push({ line: sessionObj.id, chat: String(one.key?.remoteJid || '').replace(/^(\d{4})\d+/, '$1…'), fromMe: !!one.key?.fromMe, participant: one.key?.participant ? 1 : 0, at: new Date().toISOString().slice(11, 19), err: one.messageStubParameters && String(one.messageStubParameters[0]).slice(0, 40) }); if (MSG_HEALTH.undecryptedFrom.length > 20) MSG_HEALTH.undecryptedFrom.shift(); }
            const chatKey = one.key?.remoteJid || 'unknown';
            const dedupeId = one.key?.id ? `${sessionObj.id}:${chatKey}:${one.key.id}:${one.key.fromMe ? 1 : 0}` : null;
            incomingQueue.enqueue(chatKey, () => handleIncomingUpsert({ ...m, messages: [one] }), dedupeId);
        }
    });
}

// Start WhatsApp only in live mode. Dashboard-only mode is safe for browser tests.
if (!DASHBOARD_ONLY) {
    SESSIONS.forEach(sess => {
        startSession(sess).catch(e => console.error(`Failed to start ${sess.id}:`, e));
    });
} else {
    SESSIONS.forEach(sess => { sess.status = 'DASHBOARD_ONLY'; });
    console.log('[Server] Dashboard-only mode active; WhatsApp sessions and proactive sends are disabled.');
}

let opFollowBusy = false;
async function runOperatorFollowups() {
    if (opFollowBusy) return { busy: true };
    opFollowBusy = true;
    try {
        const users = userMemory.getAllUsers().filter(u => u.phone && u.memory && u.memory.op && u.memory.op.followup && u.memory.op.followup !== 'off' && !(liveSelfTest && liveSelfTest.ownLineOf && liveSelfTest.ownLineOf([u.phone])));
        const r = await operatorControl.runFollowups({
            users,
            send: async (u, { text, media }) => {
                const line = SESSIONS.find(s => s.id === (u.assignedLine || 'sim_636') && s.status === 'CONNECTED' && s.sock) || SESSIONS.find(s => s.status === 'CONNECTED' && s.sock);
                if (!line) throw new Error('no connected line');
                const jid = `${u.phone}@s.whatsapp.net`;
                await sendSafeMessage(line.sock, jid, { text });
                userMemory.recordMessage(u.phone, 'bot', text, 'operatorFollowup', line.name);
                if (media) {
                    const full = path.join(__dirname, 'media', media.file);
                    await new Promise(r2 => setTimeout(r2, 3000));
                    await sendSafeMessage(line.sock, jid, media.type === 'video' ? { video: fs.readFileSync(full), caption: media.caption || undefined } : { image: fs.readFileSync(full), caption: media.caption || undefined });
                    userMemory.recordMessage(u.phone, 'bot', media.caption || ('📎 [आज का मीडिया: ' + media.file + ']'), 'dayMedia', line.name, '/media/' + encodeURIComponent(media.file));
                }
                logMessage({ session: line.name, phone: u.phone, incoming: '[Operator follow-up]', reply: text, status: 'PROACTIVE_SENT' });
                operationsTracker.record('operator_followup', 'sent', { lineId: line.id });
            }
        });
        userMemory.save();
        if (r.sent) console.log('[OpFollowup] sent', r.sent, r.skipped);
        return r;
    } finally { opFollowBusy = false; }
}

// Helper to get connected socket
function getActiveSocket(preferredId = 'sim_636') {
    const pref = SESSIONS.find(s => s.id === preferredId && s.status === 'CONNECTED' && s.sock);
    if (pref) return { session: pref, sock: pref.sock };
    const anyConnected = SESSIONS.find(s => s.status === 'CONNECTED' && s.sock);
    if (anyConnected) return { session: anyConnected, sock: anyConnected.sock };
    return null;
}



// ==================== FIRST CONTACT: auto-save, sticky line, contact card ====================
const replyBrain = require('./reply_brain.js');
const WA_SYNC_CONTACTS = process.env.WA_SYNC_CONTACTS !== 'false';
const waContactSyncQueue = [];
let waContactSyncBusy = false;

/** Best-effort: also add the person to the WhatsApp line's own address book (Baileys >= 6.7 app-state contactAction). */
function queueWhatsAppContactSync(sock, jid, fullName) {
    if (!WA_SYNC_CONTACTS || !sock || typeof sock.addOrEditContact !== 'function' || !jid || !fullName) return;
    waContactSyncQueue.push({ sock, jid, fullName });
    if (waContactSyncBusy) return;
    waContactSyncBusy = true;
    (async () => {
        while (waContactSyncQueue.length) {
            const job = waContactSyncQueue.shift();
            try {
                await job.sock.addOrEditContact(job.jid, { fullName: job.fullName, firstName: job.fullName.split(' ')[0], saveOnPrimaryAddressbook: true });
                operationsTracker.record('wa_contact_sync', 'ok', {});
            } catch (e) {
                operationsTracker.record('wa_contact_sync', 'failed', { reason: e.message });
            }
            await new Promise(r => setTimeout(r, 3000)); // gentle: one app-state patch every 3s
        }
        waContactSyncBusy = false;
    })();
}

/**
 * Every new number that messages us or that we message is saved to Contacts with the best name we have
 * (voter match > WhatsApp pushName > given name) and pinned to the line it first talked to.
 */
function autoSaveContact({ phone, name, pushName, lineId, sock, jid, source }) {
    try {
        const clean = contactUtils.normalizeIndianPhone(phone) || userMemory.cleanPhone(phone);
        if (!clean || clean.length < 10) return null;
        const user = userMemory.getUser(clean);
        if (user && !user.assignedLine && lineId) user.assignedLine = lineId;
        if (user && pushName && !user.pushName) user.pushName = String(pushName).slice(0, 60);
        const voterName = user && user.lastFoundVoter && (user.lastFoundVoter.name_hi || user.lastFoundVoter.name);
        const bestName = voterName || (user && user.name && !/ग्रामवासी/.test(user.name) ? user.name : '') || name || pushName || '';
        const existing = contactsManager.findByPhone(clean);
        const isNew = !existing;
        if (isNew || (bestName && (!existing.name || /ग्रामवासी|^Contact$/.test(existing.name)))) {
            contactsManager.add({
                ...(existing || {}),
                phone: clean,
                name: bestName || 'ग्रामवासी',
                ward: (existing && existing.ward) || (user && user.ward) || null,
                line: (existing && existing.line) || (user && user.assignedLine) || lineId || 'sim_636',
                tags: (existing && existing.tags) || [source === 'bulk' ? '📣 Bulk Send' : '📥 WhatsApp Inbound']
            });
        }
        if (isNew && bestName) queueWhatsAppContactSync(sock, jid || `${clean}@s.whatsapp.net`, bestName);
        return { isNew, user };
    } catch (e) {
        console.warn('[AutoSave] contact save failed:', e.message);
        return null;
    }
}

/** Send this line's contact card + "please save" line exactly once per person. */
const contactCard = require('./contact_card.js');
async function sendLineContactCardOnce(sock, jid, phone, sessionObj, { withPrompt = true } = {}) {
    const u = userMemory.getUser(phone);
    if (!u || !contactCard.needsCard(u, sessionObj.id)) return false; // once per contact PER LINE (contact_card.js)
    contactCard.markSent(u, sessionObj.id);
    userMemory.save();
    try {
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 1500));
        await sendMultiContactCard(sock, jid, sessionObj.id);
        if (!withPrompt) {
            userMemory.recordMessage(phone, 'bot', '📇 [Line contact card sent]', null, sessionObj.name);
            operationsTracker.record('contact_card', 'sent', { lineId: sessionObj.id, withPrompt: false });
            return true;
        }
        const l = u.languagePreference === 'hinglish' ? 'hinglish' : 'hi';
        const hon = replyBrain.honorific(replyBrain.personOf(u, ''), l === 'hi' ? 'hi' : 'en');
        const savePrompt = `${l === 'hi' ? 'राम राम' : 'Ram Ram'} ${hon}! 🙏 ${engagementPolicy.buildSaveContactPrompt(sessionObj.id, u.languagePreference)}`;
        await sendSafeMessage(sock, jid, { text: savePrompt });
        userMemory.recordMessage(phone, 'bot', '📇 [Line contact card sent]', null, sessionObj.name);
        operationsTracker.record('contact_card', 'sent', { lineId: sessionObj.id });
        return true;
    } catch (e) {
        console.warn(`[ContactCard] ${phone}:`, e.message);
        return false;
    }
}

// ==================== BULK SEND (BROADCAST ENGINE) ====================
// Anti-ban bulk sender. Consent/opt-out rules come from engagement_policy.js; the engine keeps its
// own durable opt-out list + queue in broadcast_state.json (gitignored) so pm2 restarts resume safely.
const { BroadcastEngine } = require('./broadcast_engine.js');
const contactUtils = require('./contact_utils.js');
const broadcastEngine = new BroadcastEngine({
    stateFile: process.env.BROADCAST_STATE_PATH || path.join(__dirname, 'broadcast_state.json'),
    mediaDir: path.join(__dirname, 'media'),
    getSessions: () => SESSIONS,
    isBlocked: (phone) => (liveSelfTest.ownLineOf([phone]) ? 'own_line' : engagementPolicy.broadcastBlockReason(userMemory.users[phone])),
    isSilenced: (ms) => followupPlanner.inSilencePeriod(new Date(ms)),
    quietHoursEnabled: () => require('./outbound_settings.js').quietHoursEnabled(),
    getAssignedLine: (phone) => (userMemory.users[phone] && userMemory.users[phone].assignedLine) || null,
    onSent: ({ phone, name, text, line, lineName, media, sent, contactCard }) => {
        const sess = SESSIONS.find(x => x.id === line);
        const jid = (sent && sent.key && sent.key.remoteJid) || `${phone}@s.whatsapp.net`;
        autoSaveContact({ phone, name, lineId: line, sock: sess && sess.sock, jid, source: 'bulk' });
        // line contact card once per contact per line (Scheduled Bulk can switch it off per campaign)
        if (sess && sess.sock && contactCard !== false) sendLineContactCardOnce(sess.sock, jid, phone, sess).catch(() => {});
        try { dailyGoal.recordEvent && dailyGoal.recordEvent('reached', { phone, line, ward: (userMemory.users[phone] || {}).ward }); } catch (e) {}
        try {
            const u = userMemory.getUser(phone, name || '');
            if (u && !u.name && name) u.name = name;
            userMemory.recordMessage(phone, 'bot', text, media ? `broadcast_${media.type}` : 'broadcast', lineName);
            userMemory.save();
        } catch (e) {}
        logMessage({ session: lineName, phone, incoming: '[Bulk Send]', reply: text, status: media ? 'MEDIA_SENT' : 'DELIVERED' });
        operationsTracker.record('broadcast_send', 'sent', { lineId: line, mediaType: media ? media.type : 'text' });
    }
});
broadcastEngine.start(2000);

function isBroadcastOptedOut(phone) {
    const p = contactUtils.normalizeIndianPhone(phone) || String(phone || '');
    return broadcastEngine.isOptedOut(p) || !!engagementPolicy.broadcastBlockReason(userMemory.users[p]);
}

/** Prince 5 Nov 19:04: no voter-facing text ever states a ballot serial number — drop any sentence that does. */
function stripBallotNumber(text) {
    if (!text || typeof text !== 'string' || !replyBrain.BALLOT_NUMBER.test(text)) return text;
    const kept = text.split(/(?<=[।?!.])\s+/).filter(x => !replyBrain.BALLOT_NUMBER.test(x)).join(' ').trim();
    return kept || 'मतपत्र में अभय सिंह जी (मोटी आंगली वाले) का नाम देखकर उनके आगे मुहर लगाइए 🙏';
}
function resolveBroadcastAudience(body = {}) {
    let contacts = [];
    const useContacts = body.useContacts === true || body.useContacts === 'true' || body.audience === 'contacts';
    if (useContacts) {
        contacts = contactsManager.getAll({ line: body.contactLine, ward: body.contactWard, village: body.contactVillage, search: body.contactSearch, tag: body.contactTag });
    } else if (body.contactTag) {
        // audience by import tag (e.g. "📥 Bulk 6 Nov") without ticking "saved contacts"
        contacts = contactsManager.getAll({ tag: body.contactTag, ward: body.contactWard, village: body.contactVillage });
    }
    return { phones: body.phones || '', csvText: body.csvText || '', contacts };
}

// ==================== ONE IDENTITY ACROSS TABS ====================
// Every tab API returns the same phone format and the same name for a voter (identity.js).
const identity = require('./identity.js');
const identityResolver = identity.makeResolver({ contactsManager, userMemory, voterMemory: require('./voter_memory.js') });
const IDENTITY_ROUTES = /^\/api\/(messages|voters|contacts|samasya|mulaqat|voter-plan|overview|scheduled|virodhi|voter\/[^/]+|daily-goal\/progress|broadcast\/status)(\/|$)/;
app.use((req, res, next) => {
    if (req.method !== 'GET' || !IDENTITY_ROUTES.test(req.path)) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
        try { return json(identityResolver.harmonize(body, { addName: req.path === '/api/messages' })); } catch (e) { return json(body); }
    };
    next();
});

// ==================== REST APIS ====================

// API: change the admin PIN (admin only). POST /api/admin/pin {newPin}
app.post('/api/admin/pin', (req, res) => {
    if (!req.dashUser || req.dashUser.role !== 'admin') return res.status(403).json({ success: false, error: 'admin only' });
    const p = String((req.body && req.body.newPin) || '').trim();
    if (!/^\d{4,12}$/.test(p)) return res.status(400).json({ success: false, error: 'PIN must be 4–12 digits' });
    try { fs.writeFileSync(PIN_FILE, JSON.stringify({ pin: p, changedAt: new Date().toISOString(), by: req.dashUser.username }), { mode: 0o600 }); } catch (e) { return res.status(500).json({ success: false, error: 'save failed' }); }
    CAMPAIGN_PIN = p; dashAuth.setPin(p);
    res.json({ success: true });
});

// API: message delivery health (retry receipts served from our store vs missing)
app.get('/api/msg-health', (req, res) => res.json({ success: true, ...MSG_HEALTH, deployHold: deployHoldReason(), storeSize: MSG_STORE.size, disappearingSeconds: DISAPPEAR.seconds || 0, chatsWithTimer: Object.keys(DISAPPEAR.state || {}).length }));
// API: let an urgent update through the deploy hold for N minutes (admin). POST {minutes}
app.post('/api/admin/deploy-force', (req, res) => {
    if (!req.dashUser || req.dashUser.role !== 'admin') return res.status(403).json({ success: false, error: 'admin only' });
    const m = Math.max(0, Math.min(30, Number((req.body || {}).minutes) || 10));
    try { fs.writeFileSync(path.join(__dirname, 'deploy_force.json'), JSON.stringify({ until: Date.now() + m * 60e3 })); } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    res.json({ success: true, minutes: m });
});
// API: disappearing messages for all our chats (admin). POST {seconds: 0|86400|604800|7776000}
app.get('/api/admin/disappearing', (req, res) => res.json({ success: true, seconds: DISAPPEAR.seconds || 0, allowed: DISAPPEAR_ALLOWED }));
app.post('/api/admin/disappearing', async (req, res) => {
    if (!req.dashUser || req.dashUser.role !== 'admin') return res.status(403).json({ success: false, error: 'admin only' });
    const secs = Number((req.body || {}).seconds);
    if (!DISAPPEAR_ALLOWED.includes(secs)) return res.status(400).json({ success: false, error: 'WhatsApp allows only 0 (off), 86400 (24h), 604800 (7 days), 7776000 (90 days)' });
    DISAPPEAR.seconds = secs; for (const k of Object.keys(DISAPPEAR.state || {})) DISAPPEAR.state[k].forced = false; saveDisappear();
    const out = [];
    for (const s of SESSIONS) { if (s.sock && s.status === 'CONNECTED' && s.sock.updateDefaultDisappearingMode) { try { await s.sock.updateDefaultDisappearingMode(secs); out.push(s.id); } catch (e) { out.push(s.id + ': ' + e.message); } } }
    res.json({ success: true, seconds: secs, defaultSetOn: out, note: 'Existing chats get the timer on our next message to them; new chats get it by default.' });
});

// API: Mobile "➕ Add contact & send now" (operator-triggered). Saves the contact on the chosen line, sends the
// message (+ optional Media Bank poster) and then the line's contact card. Respects STOP / declined consent.
const QUICK_INTRO = (name) => `राम राम ${name ? name + ' जी' : 'जी'} 🙏\nमैं बाबा अभय सिंह (मोटी आंगली वाले) की टीम से — ग्राम पंचायत सिहाली खुर्द। ये हमारा नंबर है, कृपया सेव कर लीजिए। गाँव की कोई भी बात या समस्या हो तो यहीं लिखिए। 🚩`;
app.post('/api/quick-add-send', async (req, res) => {
    const b = req.body || {};
    try {
        const phone = identity.normalizePhone(b.phone);
        if (!phone || phone.length < 11) return res.status(400).json({ success: false, error: 'Enter a valid mobile number (10 digits or +country code)' });
        const lineId = String(b.lineId || 'sim_636');
        const sess = SESSIONS.find(x => x.id === lineId);
        if (!sess || sess.status !== 'CONNECTED' || !sess.sock) return res.status(503).json({ success: false, error: 'Selected line (' + lineId + ') is not connected' });
        const u = userMemory.getUser(phone);
        if (isBroadcastOptedOut(phone) || (u && (u.broadcastOptOut || u.consentStatus === 'REJECTED'))) {
            operationsTracker.record('quick_add_send', 'blocked_stop', { lineId });
            return res.status(409).json({ success: false, error: 'This number said STOP / refused — message not sent', optedOut: true });
        }
        const name = String(b.name || '').trim().slice(0, 60);
        const ward = parseInt(b.ward) || null;
        // 1) save contact on the line (one name source of truth: Contacts book)
        const existing = contactsManager.findByPhone(phone);
        const contact = contactsManager.add({ ...(existing || {}), phone, name: (identity.isRealName(name) ? name : '') || (existing && existing.name) || identityResolver.nameFor(phone) || 'ग्रामवासी',
            ward: ward || (existing && existing.ward) || (u && u.ward) || null, line: lineId,
            tags: Array.from(new Set([...((existing && existing.tags) || []), '➕ Quick Add'])) });
        if (u) {
            if (identity.isRealName(name)) u.name = name;
            if (ward) u.ward = ward;
            if (!u.assignedLine) u.assignedLine = lineId;
        }
        const jid = `${phone}@s.whatsapp.net`;
        if (identity.isRealName(name) && !existing) queueWhatsAppContactSync(sess.sock, jid, name);
        // 2) message (+ optional poster from the Media Bank)
        const text = (b.message === 'custom' && String(b.customText || '').trim()) ? String(b.customText).trim().slice(0, 2000) : QUICK_INTRO(identity.isRealName(name) ? name : (contact && identity.isRealName(contact.name) ? contact.name : ''));
        let media = null;
        if (b.poster) {
            const f = path.basename(String(b.poster));
            if (require('./media_policy.js').isRetired(f)) return res.status(400).json({ success: false, error: 'This poster is retired and can not be sent: ' + f });
            const full = path.join(MEDIA_DIR, f);
            const t = mediaTypeOf(path.extname(f).toLowerCase());
            if (!fs.existsSync(full) || !t) return res.status(400).json({ success: false, error: 'Poster not found in Media Bank: ' + f });
            media = { file: f, type: t, full };
        }
        let sent;
        if (media && media.type === 'image') sent = await sendSafeMessage(sess.sock, jid, { image: fs.readFileSync(media.full), caption: text });
        else if (media && media.type === 'video') sent = await sendSafeMessage(sess.sock, jid, { video: fs.readFileSync(media.full), caption: text });
        else if (media) sent = await sendSafeMessage(sess.sock, jid, { document: fs.readFileSync(media.full), fileName: media.file, mimetype: 'application/pdf', caption: text });
        else sent = await sendSafeMessage(sess.sock, jid, { text });
        userMemory.recordMessage(phone, 'bot', text, media ? 'quickadd_' + media.type : 'quickadd', sess.name);
        // 3) the line's contact card (once per contact per line unless the operator asks to resend)
        let card = 'already_sent';
        if (b.forceCard || contactCard.needsCard(u, lineId)) {
            await new Promise(r => setTimeout(r, 800));
            await sendMultiContactCard(sess.sock, jid, lineId);
            contactCard.markSent(u, lineId);
            userMemory.recordMessage(phone, 'bot', '📇 [Line contact card sent]', null, sess.name);
            card = 'sent';
        }
        userMemory.save();
        logMessage({ session: sess.name, phone, incoming: `[Quick Add${name ? ': ' + name : ''}]`, reply: text, by: req.dashUser ? req.dashUser.username : undefined, status: media ? 'MEDIA_SENT' : 'DELIVERED' });
        operationsTracker.record('quick_add_send', 'sent', { lineId, mediaType: media ? media.type : 'text', card });
        res.json({ success: true, phone, name: identityResolver.nameFor(phone), line: lineId, lineName: sess.name, message: text, poster: media ? media.file : null, contactCard: card,
            messageId: sent && sent.key ? sent.key.id : null, contactId: contact && contact.id });
    } catch (e) {
        operationsTracker.record('quick_add_send', 'failed', { reason: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== OPERATOR: find a voter in the roll, then send the slip (or the list to choose from) ====================
// GET /api/voter-lookup?q=name&rel=father/husband&ward=3 -> up to 40 roll matches (own name must match)
function lookupVoters(q, rel, ward) {
    q = String(q || '').trim().slice(0, 60); if (q.length < 2) return [];
    const w = parseInt(ward) || null;
    let list = slipFlow.search(q, {}, q + (w ? ` ward ${w}` : ''), false) || [];
    if (w) list = list.filter(v => Number(v.ward) === w);
    const relT = String(rel || '').toLowerCase().split(/\s+/).filter(x => x.length >= 2);
    if (relT.length) {
        const tr = x => (voterEngine.translit ? voterEngine.translit(x) : x);
        const hit = list.filter(v => { const r = `${String(v.rel_name_hi || '')} ${String(v.rel_name_en || v.re || '').toLowerCase()}`; return relT.every(t => r.includes(t) || r.includes(tr(t))); });
        list = hit;
    }
    return list.slice(0, 40);
}
const voterKey = v => `W${Number(v.ward)}-${Number(v.sr_no || v.s)}`;
app.get('/api/voter-lookup', (req, res) => {
    try {
        const list = lookupVoters(req.query.q, req.query.rel, req.query.ward);
        const RL = require('./relation_label');
        res.json({ success: true, count: list.length, results: list.map(v => ({ key: voterKey(v), name: v.name_hi || v.name, nameEn: v.name_en || v.ne || '', rel: RL.relLabel(v), relName: v.rel_name_hi || '', ward: Number(v.ward) || null, sr: v.sr_no || v.s || null, age: v.age || v.a || null, house: v.house_no || v.h || null })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
function voterByKey(key) {
    key = String(key || ''); if (!key) return null;
    const all = voterEngine.getAllVoters ? voterEngine.getAllVoters() : null;
    if (Array.isArray(all)) { const f = all.find(v => voterKey(v) === key); if (f) return f; }
    const r = voterEngine.searchVoters(key, 5) || [];
    return r.find(v => voterKey(v) === key) || null;
}
// POST /api/operator-slip {phone, lineId, mode:'send'|'choose', key | keys[], query?, forceCard?}
//  send   -> the operator knows this person: save the contact as that voter and send their parchi card now
//  choose -> send the numbered list (max 5); the voter replies with a number and the bot sends that parchi
app.post('/api/operator-slip', async (req, res) => {
    const b = req.body || {};
    try {
        const phone = identity.normalizePhone(b.phone);
        if (!phone || phone.length < 11) return res.status(400).json({ success: false, error: 'Enter a valid mobile number (10 digits or +country code)' });
        const lineId = String(b.lineId || 'sim_636');
        const sess = SESSIONS.find(x => x.id === lineId);
        if (!sess || sess.status !== 'CONNECTED' || !sess.sock) return res.status(503).json({ success: false, error: 'Selected line (' + lineId + ') is not connected' });
        const u = userMemory.getUser(phone);
        if (isBroadcastOptedOut(phone) || (u && (u.broadcastOptOut || u.consentStatus === 'REJECTED'))) return res.status(409).json({ success: false, error: 'This number said STOP / refused — message not sent', optedOut: true });
        const mode = b.mode === 'choose' ? 'choose' : 'send';
        const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).filter(Boolean).slice(0, 5);
        const voters = keys.map(voterByKey).filter(Boolean);
        if (!voters.length) return res.status(400).json({ success: false, error: 'Voter not found — search again' });
        const jid = `${phone}@s.whatsapp.net`;
        const existing = contactsManager.findByPhone(phone);
        let text, sent, kind;
        if (mode === 'send') {
            const v = voters[0];
            const nm = String(v.name_hi || v.name || '').replace(/^कृ\s+/, '');
            const keepName = existing && identity.isRealName(existing.name) ? existing.name : '';
            contactsManager.add({ ...(existing || {}), phone, name: keepName || nm || 'ग्रामवासी', ward: Number(v.ward) || (existing && existing.ward) || null, line: lineId,
                tags: Array.from(new Set([...((existing && existing.tags) || []), '📄 पर्ची (टीम)'])) });
            if (!u.name || !identity.isRealName(u.name)) u.name = nm;
            u.ward = Number(v.ward) || u.ward; if (!u.assignedLine) u.assignedLine = lineId;
            u.identityConfirmedBy = { by: req.dashUser ? req.dashUser.username : 'team', at: new Date().toISOString(), key: voterKey(v) };
            slipFlow.deliverTo(u, v, false);
            text = slipFlow.deliverCaption(u, v, false, false);
            let cardBuffer = null;
            try { cardBuffer = await voterCardGen.generateVoterCard(v); } catch (e) { console.error('operator slip card:', e.message); }
            if (!cardBuffer) text = voterEngine.formatShortSlipResponse(v) + slipFlow.familyTail(u, v, false);
            sent = cardBuffer ? await sendSafeMessage(sess.sock, jid, { image: cardBuffer, caption: text }) : await sendSafeMessage(sess.sock, jid, { text });
            kind = cardBuffer ? 'voterSlipCard' : 'voterSlip';
        } else {
            if (!existing) contactsManager.add({ phone, name: identityResolver.nameFor(phone) || 'ग्रामवासी', line: lineId, tags: ['📄 पर्ची (टीम)'] });
            if (!u.assignedLine) u.assignedLine = lineId;
            const q = String(b.query || voters[0].name_hi || '').trim().slice(0, 40);
            u.lastSlipQuery = q;
            slipFlow.setPending(u, 'choose', voters, 'self');
            text = 'राम राम जी 🙏 आपकी मतदाता पर्ची निकाल रही हूँ।\n\n' + slipFlow.listText(voters, voters[0].name_hi || q, false);
            sent = await sendSafeMessage(sess.sock, jid, { text });
            kind = 'disambiguation';
        }
        userMemory.recordMessage(phone, 'bot', text, kind, sess.name);
        let card = 'already_sent';
        if (b.forceCard || contactCard.needsCard(u, lineId)) {
            await new Promise(r => setTimeout(r, 800));
            await sendMultiContactCard(sess.sock, jid, lineId);
            contactCard.markSent(u, lineId);
            userMemory.recordMessage(phone, 'bot', '📇 [Line contact card sent]', null, sess.name);
            card = 'sent';
        }
        userMemory.save();
        logMessage({ session: sess.name, phone, incoming: mode === 'send' ? `[टीम ने पर्ची भेजी: ${voters[0].name_hi}]` : `[टीम ने सूची भेजी: ${voters.length}]`, reply: text, by: req.dashUser ? req.dashUser.username : undefined, status: kind === 'voterSlipCard' ? 'MEDIA_SENT' : 'DELIVERED' });
        operationsTracker.record('operator_slip', 'sent', { lineId, mode, n: voters.length, card });
        res.json({ success: true, mode, phone, lineName: sess.name, voter: voters[0].name_hi, count: voters.length, contactCard: card, messageId: sent && sent.key ? sent.key.id : null });
    } catch (e) {
        operationsTracker.record('operator_slip', 'failed', { reason: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: Send Message directly from Dashboard (Quick-Add / Field Mode)
app.post('/api/send-message', async (req, res) => {
    try {
        const { phone, name, template, customText, lineId } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        const cleanedPhone = userMemory.cleanPhone(phone);
        const jid = `${cleanedPhone}@s.whatsapp.net`;
        const targetUser = userMemory.getUser(cleanedPhone, name);

        if (targetUser.consentStatus === 'REJECTED') {
            return res.status(409).json({
                error: 'This contact declined automated outreach. Ask them to initiate a new conversation before sending again.'
            });
        }

        const active = getActiveSocket(lineId || targetUser.assignedLine || 'sim_636');
        if (!active) {
            return res.status(503).json({ error: 'No WhatsApp line is currently connected. Please scan QR code first.' });
        }

        const sock = active.sock;
        const sessionName = active.session.name;
        let messageText = '';
        let mediaType = null;

        const posterPath = path.join(__dirname, 'media', 'poster.jpg');
        const videoPath = path.join(__dirname, 'media', 'campaign_reel.mp4');

        const voterDisplayName = name ? `${name} जी` : 'भाई जी';
        const { mediaOption, voterId } = req.body;

        if (template === 'consent_check') {
            messageText = engagementPolicy.buildConsentPrompt(name || '');
        } else if (template === 'permission_casual') {
            messageText = `राम राम ${voterDisplayName}! 🙏 सब कुशल मंगल?\n\nमैं बाबा अभय सिंह जनसंपर्क (ग्राम पंचायत सिहाली खुर्द) से हूँ।\nक्या हम आपको पंचायत आम चुनाव 2026 के जरूरी अपडेट, विकास कार्यों व जरूरी सूचनाओं की जानकारी WhatsApp पर भेज सकते हैं? 😊🚩`;
        } else if (template === 'offer_parchi') {
            messageText = `राम राम ${voterDisplayName}! 🚩\n\nग्राम पंचायत सिहाली खुर्द का चुनाव सोमवार, 16 नवम्बर 2026 को है।\nक्या मैं आपकी और आपके पूरे परिवार की अधिकृत डिजिटल वोटर पर्ची (मतदान केंद्र, कमरा नं, भाग संख्या) निकाल कर भेज दूँ भैया? बस हाँ लिख कर भेजें! 🗳️`;
        } else if (template === 'ground_feedback') {
            messageText = `राम राम ${voterDisplayName}! 😊\n\nबाबा अभय सिंह जनसंपर्क में आपका स्वागत है। आपके वार्ड में इस बार विकास का क्या माहौल लग रहा है भैया? गाँव की सड़क, पानी या अस्पताल से जुड़ी कोई समस्या या सुझाव हो तो जरूर बताइएगा! 🙏🚩`;
        } else if (template === 'direct_appeal') {
            messageText = `राम राम ${voterDisplayName}! 🙏🚩\n\nग्राम पंचायत सिहाली खुर्द के सर्वांगीण विकास हेतु 16 नवम्बर 2026 को मतपत्र में अभय सिंह (मोटी आंगली वाले) के नाम के आगे मुहर लगाकर भारी मतों से विजयी बनाएं!\n\nथारी उंगली से... मोटी आंगली वाले के नाम के आगे मुहर लगाइए! 🙏`;
        } else if (template === 'welcome') {
            messageText = `राम राम ${voterDisplayName}! 🙏\n\nबाबा अभय सिंह (मोटी आंगली वाले) जनसंपर्क टीम में आपका स्वागत है।\nगांव के विकास और अपनी वोटर पर्ची की जानकारी के लिए यहाँ कभी भी मैसेज कर सकते हैं! 🚩`;
        } else if (template === 'slogan') {
            const slogan = userMemory.getNextSlogan(cleanedPhone);
            messageText = `राम राम भाई जी! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
        } else {
            messageText = customText || `राम राम ${voterDisplayName}! 🙏`;
        }

        // Determine media to send (via mediaOption radio or legacy template)
        const chosenMedia = mediaOption || (template === 'poster' ? 'poster' : (template === 'video' ? 'video' : (template === 'custom_poster' ? 'custom_poster' : 'none')));

        if (chosenMedia === 'slip') {
            // Find voter and generate real JPG card
            let targetVoter = null;
            if (voterId) {
                targetVoter = voterEngine.getVoterById(voterId);
            }
            if (!targetVoter && name) {
                const s = voterEngine.searchVoters(name, 1);
                if (s && s.length > 0) targetVoter = s[0];
            }
            if (targetVoter) {
                const cardBuf = await voterCardGen.generateVoterCard(targetVoter);
                const caption = messageText + '\n\n' + voterEngine.formatShortSlipResponse(targetVoter);
                await sock.sendMessage(jid, { image: cardBuf, caption: caption });
                mediaType = 'voterSlipCard';
            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        } else if (chosenMedia === 'poster') {
            if (fs.existsSync(posterPath)) {
                await sock.sendMessage(jid, { image: fs.readFileSync(posterPath), caption: messageText });
                mediaType = 'poster';
            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        } else if (chosenMedia === 'custom_poster') {
            const buf = await posterEngine.generatePoster({ name: name || 'ग्रामवासी', aspect: '9:16' });
            await sock.sendMessage(jid, { image: buf, caption: messageText });
            mediaType = 'customPoster';
        } else if (chosenMedia === 'video') {
            if (fs.existsSync(videoPath)) {
                await sock.sendMessage(jid, { video: fs.readFileSync(videoPath), caption: messageText });
                mediaType = 'video';
            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        } else {
            await sock.sendMessage(jid, { text: messageText });
        }

        const savedUser = targetUser;
        if (savedUser && !savedUser.assignedLine) savedUser.assignedLine = active.session.id;
        if (template === 'consent_check' || template === 'permission_casual') {
            engagementPolicy.markConsentPrompted(savedUser);
            operationsTracker.record('consent_prompt', 'sent', { lineId: active.session.id, template });
        }
        if (req.body.linkedWard) savedUser.ward = parseInt(req.body.linkedWard);
        if (req.body.linkedEpic) savedUser.epic = req.body.linkedEpic;
        userMemory.recordMessage(cleanedPhone, 'bot', messageText, mediaType, sessionName);
        userMemory.save();

        try {
            contactsManager.add({
                name: name || 'ग्रामवासी',
                phone: cleanedPhone,
                ward: req.body.linkedWard || 1,
                line: lineId || 'sim_636',
                notes: req.body.linkedEpic ? `EPIC: ${req.body.linkedEpic} | Field Connect` : 'Field Connect',
                tags: ['🤝 फील्ड संपर्क', req.body.linkedWard ? `वार्ड ${req.body.linkedWard}` : 'वार्ड 1']
            });
        } catch(e) {}

        logMessage({
            session: sessionName,
            phone: cleanedPhone,
            incoming: `[Quick Add: ${name || 'Voter'}]`,
            reply: messageText,
            by: req.dashUser ? req.dashUser.username : undefined,
            status: mediaType ? 'MEDIA_SENT' : 'DELIVERED'
        });
        operationsTracker.record('dashboard_send', 'ok', {
            lineId: active.session.id,
            mediaType: mediaType || 'text',
            template: template || 'custom'
        });

        // Operator single-send: attach this line's contact card once (per contact per line) if they don't have it yet
        let contactCardQueued = false;
        if (!(targetUser.broadcastOptOut) && contactCard.needsCard(targetUser, active.session.id)) {
            contactCardQueued = true;
            sendLineContactCardOnce(sock, jid, cleanedPhone, active.session).catch(() => {});
        }
        res.json({
            success: true,
            phone: cleanedPhone,
            line: sessionName,
            message: messageText,
            contactCardQueued
        });
    } catch (err) {
        console.error('Error in /api/send-message:', err);
        operationsTracker.record('dashboard_send', 'failed', { reason: err.message });
        res.status(500).json({ error: err.message });
    }
});

// API: Generate Dynamic Poster
app.post('/api/generate-poster', async (req, res) => {
    try {
        const { name, aspect, customSlogan } = req.body;
        const posterBuffer = await posterEngine.generatePoster({
            name: name || 'ग्रामवासी',
            aspect: aspect || '1:1',
            customSlogan: customSlogan
        });

        res.type('image/jpeg').send(posterBuffer);
    } catch (e) {
        console.error('Error generating poster:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: Direct Media Upload from Browser (Photos/Videos)
app.post('/api/upload-media', (req, res) => {
    try {
        const { target, base64Data } = req.body;
        if (!target || !base64Data) {
            return res.status(400).json({ error: 'Target filename and file data required' });
        }
        if (!MEDIA_UPLOAD_TARGETS.has(target)) {
            return res.status(400).json({ error: 'Unsupported media target' });
        }

        const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
        const targetPath = path.join(__dirname, 'media', target);
        fs.writeFileSync(targetPath, Buffer.from(cleanBase64, 'base64'));

        console.log(`[Upload] Uploaded new media: ${target} (${cleanBase64.length} chars)`);
        operationsTracker.record('media_upload', 'ok', { mediaType: target });
        syncUploadedMediaToGit(target);
        res.json({ success: true, message: `Successfully updated ${target}!`, gitSync: process.platform === 'linux' ? 'queued' : 'skipped-local' });
    } catch (e) {
        console.error('Error in /api/upload-media:', e);
        operationsTracker.record('media_upload', 'failed', { reason: e.message });
        res.status(500).json({ error: e.message });
    }
});

// API: Test AI Directly in Dashboard Playground
// API: Campaign Agenda (Get & Update)
app.get('/api/campaign-agenda', (req, res) => {
    res.json(campaignAgenda.getAgenda());
});

app.post('/api/campaign-agenda', (req, res) => {
    const updated = campaignAgenda.updateAgenda(req.body);
    res.json({ success: true, agenda: updated });
});

app.get('/api/campaign-profile', (req, res) => {
    res.json(campaignProfile.load());
});

app.post('/api/campaign-profile', (req, res) => {
    try {
        const updated = campaignProfile.update(req.body || {});
        operationsTracker.record('campaign_profile', 'updated', { factCount: updated.verifiedFacts.length });
        syncCampaignProfileToGit();
        res.json({ success: true, profile: updated });
    } catch (error) {
        operationsTracker.record('campaign_profile', 'failed', { reason: error.message });
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/campaign-profile/import', (req, res) => {
    try {
        const updated = campaignProfile.importFile(req.body?.content, req.body?.fileName, req.body?.mode);
        operationsTracker.record('campaign_profile_import', 'updated', { factCount: updated.verifiedFacts.length });
        syncCampaignProfileToGit();
        res.json({ success: true, profile: updated, factCount: updated.verifiedFacts.length });
    } catch (error) {
        operationsTracker.record('campaign_profile_import', 'failed', { reason: error.message });
        res.status(400).json({ error: error.message });
    }
});

// API: Direct Fuzzy Voter Search
app.get('/api/search-voters', (req, res) => {
    const q = req.query.q || '';
    const ward = req.query.ward ? parseInt(req.query.ward) : null;
    const matches = voterEngine.searchVoters(q, 10, ward);
    res.json({ count: matches.length, results: matches });
});

// API: Playground Chat with Live Goal, Agenda, Model Cascade, & Vision Test
app.post('/api/playground/chat', async (req, res) => {
    try {
        const { message, history, phone, voterName, campaignGoal, dailyAgenda, provider, imageBase64, mimeType } = req.body;
        const start = Date.now();
        const testPhone = phone || '919876543000';

        let visionAnalysis = null;
        let effectiveMessage = message || '';

        if (imageBase64) {
            visionAnalysis = await visionService.analyzeImage(imageBase64, mimeType || 'image/jpeg');
            if (!effectiveMessage.trim()) {
                effectiveMessage = visionAnalysis.summaryHindi ? `[फोटो: ${visionAnalysis.summaryHindi}]` : '[फोटो]';
            }
        }

        const user = userMemory.getUser(testPhone);
        if (voterName) user.name = voterName;
        if (campaignGoal !== undefined) user.campaignGoal = campaignGoal;
        if (visionAnalysis && visionAnalysis.suggestedTag) {
            userMemory.updateTags(testPhone, [visionAnalysis.suggestedTag]);
        }

        let reply = '';
        if (visionAnalysis && (!message || message.trim().length === 0)) {
            reply = visionService.getConversationalReply(visionAnalysis, user.name || 'भैया');
            if (visionAnalysis.category === 'voter_id' && visionAnalysis.details?.epic) {
                const parchiMatches = voterEngine.searchVoters(visionAnalysis.details.epic);
                if (parchiMatches.length > 0) {
                    reply += '\n\n' + voterEngine.formatVoterSlip(parchiMatches[0]);
                }
            }
        } else {
            reply = await aiService.getAIResponse(effectiveMessage, null, history || [], testPhone);
        }

        const nextDrip = campaignAgenda.getNextDripMedia(user);

        res.json({
            success: true,
            reply: reply,
            timeMs: Date.now() - start,
            provider: provider || 'Cascade (NVIDIA / Groq / Gemini)',
            user: {
                name: user.name,
                phone: user.phone,
                tags: user.tags || [],
                sentiment: user.voterSentiment,
                campaignGoal: user.campaignGoal
            },
            visionAnalysis: visionAnalysis,
            nextDripMedia: nextDrip
        });
    } catch (e) {
        console.error('Playground chat error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/test-ai', async (req, res) => {
    try {
        const { message, history } = req.body;
        const start = Date.now();
        const reply = await aiService.getAIResponse(message, NVIDIA_API_KEY, history || []);
        res.json({
            reply: reply,
            timeMs: Date.now() - start,
            model: 'openai/gpt-oss-20b'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Get Live Messages Feed (Voters Only)

// API: Conversations View (Grouped by Real Voters, Hiding Self-Device)
app.get('/api/conversations', (req, res) => {
    try {
        const all = userMemory.getAllUsers().filter(u => u.phone && !u.phone.includes('Self Device') && u.phone.length >= 10);
        const list = all.map(u => {
            const lastMsg = (u.history && u.history.length > 0) ? u.history[u.history.length - 1] : null;
            return {
                phone: u.phone,
                name: u.name || (u.lastFoundVoter ? u.lastFoundVoter.name_hi : 'मतदाता'),
                ward: u.ward || (u.lastFoundVoter ? u.lastFoundVoter.ward : null),
                lastMessage: lastMsg ? lastMsg.text : '',
                lastTime: lastMsg ? lastMsg.time : '',
                lastSeen: u.lastSeen,
                interactionCount: u.interactionCount || 0,
                voterSentiment: u.voterSentiment || 'neutral',
                history: u.history || []
            };
        });
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/messages', (req, res) => {
    res.json(LIVE_FEED);
});

// API: Get Diagnostics Feed & Session Health
app.get('/api/diagnostics', (req, res) => {
    res.json({
        sessions: SESSIONS.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            hasQr: !!s.qr
        })),
        feed: DIAG_FEED
    });
});

// API: Clear All Chat and Diagnostic Logs
app.post('/api/clear-logs', (req, res) => {
    LIVE_FEED = [];
    DIAG_FEED = [];
    try { fs.writeFileSync(FEED_FILE, '[]', 'utf8'); } catch (e) {}
    try { fs.writeFileSync(DIAG_FILE, '[]', 'utf8'); } catch (e) {}
    res.json({ success: true, message: 'All logs cleared successfully!' });
});

// API: Send Test WhatsApp Message from Diagnostics
app.post('/api/test-send', async (req, res) => {
    try {
        const { sessionId, phone, message } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone number and message text are required.' });
        }

        const sessionObj = SESSIONS.find(s => s.id === (sessionId || 'sim_636'));
        if (!sessionObj || !sessionObj.sock || sessionObj.status !== 'CONNECTED') {
            return res.status(400).json({ error: `Selected line (${sessionId || 'sim_636'}) is not connected.` });
        }

        const clean = phone.replace(/[^0-9]/g, '');
        const jid = (clean.length === 10 ? '91' + clean : clean) + '@s.whatsapp.net';

        await sessionObj.sock.sendMessage(jid, { text: message });
        logMessage({
            session: sessionObj.name,
            phone: clean,
            incoming: '[Direct Dashboard Test]',
            reply: message,
            status: 'TEST_SENT'
        });
        res.json({ success: true, message: `Successfully sent test message to +${clean}!` });
    } catch (e) {
        console.error('Error in /api/test-send:', e);
        res.status(500).json({ error: 'WhatsApp send failed: ' + e.message });
    }
});

// API: Get All Contacted Voters with Memory Stats
app.get('/api/voters', (req, res) => {
    res.json(userMemory.getAllUsers());
});

// API: Get Single Voter History

// API: Toggle AutoPilot for a voter
app.post('/api/toggle-autopilot', (req, res) => {
    const { phone, autoPilot } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    const state = userMemory.toggleAutoPilot(phone, autoPilot);
    res.json({ success: true, phone, autoPilot: state });
});

// API: Update tags and sentiment for a voter
app.post('/api/update-tags', (req, res) => {
    const { phone, tags, sentiment } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    if (tags !== undefined) userMemory.updateTags(phone, tags);
    if (sentiment !== undefined) userMemory.setSentiment(phone, sentiment);
    const user = userMemory.getUser(phone);
    res.json({ success: true, phone, tags: user.tags, sentiment: user.voterSentiment });
});

// API: Update voter intelligence notes (Family, Mahool, Baba, Campaign Goal)
app.post('/api/update-notes', (req, res) => {
    const { phone, familyNotes, mahoolNotes, babaNotes, campaignGoal } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    if (campaignGoal !== undefined) userMemory.setCampaignGoal(phone, campaignGoal);
    const user = userMemory.updateNotes(phone, { familyNotes, mahoolNotes, babaNotes });
    res.json({ success: true, phone, user });
});

// API: AI Copilot / Assisted Message Drafting for Admin
app.post('/api/ai-draft', async (req, res) => {
    try {
        const { phone, instruction } = req.body;
        if (!instruction || !instruction.trim()) {
            return res.status(400).json({ error: 'Instruction prompt is required' });
        }

        const user = phone ? userMemory.getUser(phone) : null;
        const voterName = (user && user.name) ? user.name : 'भैया';
        const ragContext = phone ? userMemory.getUserContextRAG(phone) : '';

        const systemInstruction = `आप बाबा अभय सिंह जनसंपर्क से उनकी डिजिटल सारथी व सेवा सहायिका हैं।
प्रबंधक प्रिंस ने आपको मतदाता '${voterName}' के लिए यह संदेश तैयार करने को कहा है:
"${instruction.trim()}"

🎯 नियम:
1. एडमिन के इस निर्देश को बाबा अभय सिंह जनसंपर्क की मीठी, आत्मीय व विनम्र आवाज़ में 1 से 2 छोटी असरदार WhatsApp पंक्तियों में बदलो।
2. कोई भारी-भरकम किताबी भाषण नहीं।
3. सीधे वही संदेश आउटपुट करो जो WhatsApp पर भेजा जाना है (Zero Meta-talk, Zero Quotes).`;

        let draft = '';
        try {
            draft = await aiService.getAIResponse(instruction, NVIDIA_API_KEY, [{ role: 'system', content: systemInstruction }], phone);
            if (!draft || draft.includes('जनसंपर्क टीम में आपका स्वागत')) {
                draft = `राम राम ${voterName}! 🙏 ${instruction} 😊🚩`;
            }
        } catch (e) {
            draft = `राम राम ${voterName}! 🙏 ${instruction} 😊🚩`;
        }

        res.json({ success: true, draft: draft.trim() });
    } catch (e) {
        console.error('Error in /api/ai-draft:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: Stable public dashboard URL (normally a fixed domain through Nginx)
app.get('/api/tunnel-status', (req, res) => {
    const url = PUBLIC_DASHBOARD_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, url, provider: PUBLIC_DASHBOARD_URL ? 'Fixed domain' : 'Current host' });
});

app.post('/api/daily-target', (req, res) => {
    try {
        const updated = dailyGoal.update(req.body || {});
        operationsTracker.record('daily_goal', 'updated', { feature: updated.targetType });
        res.json({ success: true, dailyTarget: updated });
    } catch (error) {
        operationsTracker.record('daily_goal', 'failed', { reason: error.message });
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/daily-target', (req, res) => {
    res.json(dailyGoal.get());
});

app.get('/api/operations-status', (req, res) => {
    res.json({
        ...operationsTracker.getStatus(),
        dailyGoal: dailyGoal.get(),
        sessions: SESSIONS.map(session => ({
            id: session.id,
            name: session.name,
            status: session.status,
            contact: engagementPolicy.getLineContact(session.id).display
        }))
    });
});

// API: Toggle Demo Poster mode
app.post('/api/toggle-demo-posters', (req, res) => {
    const { enabled } = req.body;
    const mode = mediaCatalog.setDemoMode(enabled);
    res.json({ success: true, demoMode: mode });
});

// API: Get current demo poster status
app.get('/api/demo-poster-status', (req, res) => {
    res.json({ demoMode: mediaCatalog.isDemoMode() });
});

// API: Quick Actions for Chat (Demo Poster, Video, Slip, Ram Ram, Meeting, Baba Register)
app.post('/api/quick-action-legacy', async (req, res) => {
    if (req.body && req.body.action === 'demo_poster') return res.status(410).json({ error: 'Use /api/quick-action (approved posters only)' });
    try {
        const { phone, action, lineId, customNote } = req.body;
        if (!phone || !action) return res.status(400).json({ error: 'Phone and action are required' });

        const cleanedPhone = userMemory.cleanPhone(phone);
        const jid = `${cleanedPhone}@s.whatsapp.net`;
        const active = getActiveSocket(lineId || 'sim_636');
        if (!active) return res.status(503).json({ error: 'No WhatsApp line connected' });

        const sock = active.sock;
        const sessionName = 'Admin Quick Action';
        let replyText = '';
        let mediaType = null;

        if (action === 'contact_card') {
            await sendMultiContactCard(sock, jid, active.session.id);
            const cardMsg = engagementPolicy.buildSaveContactPrompt(active.session.id, userMemory.getUser(cleanedPhone)?.languagePreference);
            await sock.sendMessage(jid, { text: cardMsg });

            userMemory.recordMessage(cleanedPhone, 'bot', '📇 [Contact Card Sent]');
            return res.json({ success: true, message: 'Contact card sent successfully!' });
        } else if (action === 'demo_poster') {
            const poster = mediaCatalog.getDemoPoster();
            replyText = poster.caption;
            if (poster.localPath && fs.existsSync(poster.localPath)) {
                await sock.sendMessage(jid, { image: fs.readFileSync(poster.localPath), caption: replyText });
            } else if (poster.remoteUrl) {
                await sock.sendMessage(jid, { image: { url: poster.remoteUrl }, caption: replyText });
            } else {
                await sock.sendMessage(jid, { text: replyText });
            }
            mediaType = 'demoPoster';
        } else if (action === 'video') {
            const video = mediaCatalog.getNextVideo(cleanedPhone);
            replyText = video.caption;
            if (video.remoteUrl) {
                await sock.sendMessage(jid, { video: { url: video.remoteUrl }, caption: replyText });
            } else if (video.localPath && fs.existsSync(video.localPath)) {
                await sock.sendMessage(jid, { video: fs.readFileSync(video.localPath), caption: replyText });
            } else {
                await sock.sendMessage(jid, { text: replyText });
            }
            mediaType = 'video';
        } else if (action === 'slip') {
            const user = userMemory.getUser(cleanedPhone);
            const matches = voterEngine.searchVoters(user.name || cleanedPhone, 1, user.ward);
            if (matches && matches.length > 0) {
                replyText = voterEngine.formatSlipResponse(matches[0]);
            } else {
                replyText = `राम राम जी! 🙏\nआपकी वोटर पर्ची निकालने के लिए कृपया अपना सही नाम या वोटर आईडी (EPIC) नंबर लिखकर भेजें।\nबाबा अभय सिंह जनसंपर्क टीम 🚩`;
            }
            await sock.sendMessage(jid, { text: replyText });
            mediaType = 'voterSlip';
        } else if (action === 'ramram') {
            replyText = userMemory.getDynamicGreeting(cleanedPhone);
            await sock.sendMessage(jid, { text: replyText });
        } else if (action === 'meeting') {
            replyText = mediaCatalog.getMeetingDetails();
            await sock.sendMessage(jid, { text: replyText });
        } else if (action === 'baba_register') {
            const user = userMemory.getUser(cleanedPhone);
            const entry = mediaCatalog.recordDirectComplaint(cleanedPhone, user.name, user.ward, customNote || 'विशेष समस्या/मुद्दा');
            replyText = `भैया, आपकी यह बात मैंने सीधे बाबा अभय सिंह के प्राथमिकता रजिस्टर (क्रमांक: ${entry.id}) में नोट करवा दी है! 🚩\nबाबा अभय सिंह स्वयं इसे संज्ञान में लेंगे।`;
            await sock.sendMessage(jid, { text: replyText });
        }

        userMemory.recordMessage(cleanedPhone, 'bot', replyText, mediaType, sessionName);
        logMessage({
            session: active.session.name,
            phone: cleanedPhone,
            incoming: `[Action: ${action}]`,
            reply: replyText,
            status: mediaType ? 'MEDIA_SENT' : 'DELIVERED'
        });
        operationsTracker.record('quick_action', 'ok', {
            lineId: active.session.id,
            mediaType: mediaType || 'text',
            feature: action
        });

        res.json({ success: true, action, message: replyText });
    } catch (e) {
        console.error('Error in /api/quick-action:', e);
        operationsTracker.record('quick_action', 'failed', { reason: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/voter/:phone', (req, res) => {
    const phone = req.params.phone;
    const user = userMemory.getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// API: Contacts Manager (VCF, CSV & Multi-Line Sync)
app.get('/api/contacts', (req, res) => {
    try {
        const contacts = contactsManager.getAll(req.query);
        res.json({ success: true, count: contacts.length, contacts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/contacts/add', (req, res) => {
    try {
        const c = contactsManager.add(req.body);
        res.json({ success: true, contact: c });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/contacts/delete', (req, res) => {
    try {
        const { id } = req.body;
        contactsManager.delete(id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/contacts/import-voters', (req, res) => {
    try {
        const { ward, line, limit } = req.body;
        const count = contactsManager.importFromVoterDB(ward, line, parseInt(limit) || 100);
        res.json({ success: true, added: count });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Contact import (6 Nov): CSV (any headers) / XLSX / VCF / pasted lines. dryRun=true → preview only, nothing saved.
// POST /api/contacts/import {fileName?, fileText? | fileBase64?, text?, tag?, line?, dryRun?}
const contactImport = require('./contact_import.js');
function importDeps() {
    return {
        contactsManager,
        isOptedOut: (p) => { try { return isBroadcastOptedOut(p); } catch (e) { return false; } },
        isVirodhi: (p) => { try { return require('./contact_tags.js').isVirodhi(p) || !!(userMemory.users[p] && userMemory.users[p].virodhi === true); } catch (e) { return false; } },
        matchVoter: (r) => contactsManager.matchVoter(r)
    };
}
app.post('/api/contacts/import', (req, res) => {
    try {
        const b = req.body || {};
        const parsed = contactImport.parseInput(b);
        if (!parsed.rows.length) return res.status(400).json({ success: false, error: 'No contacts found in the file / text. Expected columns like Name + Mobile, a .vcf export, or one "name number" per line.' });
        const a = contactImport.analyze(parsed.rows, importDeps());
        const tag = contactImport.cleanTag(b.tag) || contactImport.defaultTag(b.date);
        const out = contactImport.summary(a, { tag, format: parsed.format });
        if (b.dryRun === true || b.dryRun === 'true') return res.json({ success: true, dryRun: true, ...out });
        if (!a.valid.length) return res.status(400).json({ success: false, error: 'No valid Indian mobile numbers to import', ...out });
        const saved = contactImport.commit(a, { contactsManager, tag, line: b.line });
        res.json({ success: true, dryRun: false, saved, ...out });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.get('/api/contacts/tags', (req, res) => res.json({ success: true, tags: contactImport.tagCounts(contactsManager.contacts) }));
app.post('/api/contacts/import-batch/delete', (req, res) => {
    try { res.json({ success: true, ...contactImport.deleteBatch(contactsManager, (req.body || {}).tag) }); }
    catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Legacy endpoint (Contacts tab upload) — now uses the same parser; saves straight away.
app.post('/api/contacts/import-vcf', (req, res) => {
    try {
        const { vcfText, fileText, fileName, fileBase64, tag } = req.body || {};
        const parsed = contactImport.parseInput({ fileName, fileText: fileText || vcfText || '', fileBase64 });
        const a = contactImport.analyze(parsed.rows, importDeps());
        const saved = a.valid.length ? contactImport.commit(a, { contactsManager, tag: contactImport.cleanTag(tag) || contactImport.defaultTag() }) : { created: 0, tagged: 0, tag: '' };
        res.json({
            success: true,
            format: parsed.format,
            count: a.valid.length,
            matched: a.counts.voterMatched,
            unmatched: a.valid.length - a.counts.voterMatched,
            invalid: a.counts.invalid,
            duplicates: a.counts.duplicatesInFile,
            saved
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/api/contacts/export-vcf', (req, res) => {
    try {
        const vcf = contactsManager.generateVCF(req.query);
        res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="sihali_voter_contacts.vcf"');
        res.send(vcf);
    } catch (e) {
        res.status(500).send('Error generating VCF');
    }
});

app.get('/api/contacts/export-csv', (req, res) => {
    try {
        const csv = contactsManager.generateCSV(req.query);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="sihali_voter_contacts.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).send('Error generating CSV');
    }
});

// ---------- Bulk Send API (behind PIN middleware) ----------
function sendEngineResult(res, r) {
    if (r.ok) return res.json({ success: true, campaign: r.campaign });
    return res.status(r.status || 400).json({ success: false, error: r.error, code: r.code, preview: r.preview });
}

app.post('/api/broadcast/preview', (req, res) => {
    try {
        res.json({ success: true, preview: broadcastEngine.preview({ ...resolveBroadcastAudience(req.body), message: req.body.message, caps: req.body.caps }) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/broadcast/create', (req, res) => {
    try {
        const body = req.body || {};
        const audience = resolveBroadcastAudience(body);
        // Optionally save pasted / uploaded contacts into the Contacts list
        let savedContacts = 0;
        if (body.saveToContacts === true || body.saveToContacts === 'true') {
            const rows = [...contactUtils.parsePastedContacts(audience.phones), ...(audience.csvText ? contactUtils.parseContactCsv(audience.csvText) : [])];
            savedContacts = contactsManager.addMany(rows, { tags: ['📣 Bulk Send'] }).length;
        }
        const r = broadcastEngine.create({ ...audience, message: body.message, mediaFile: body.mediaFile || null, lines: body.lines, caps: body.caps });
        operationsTracker.record('broadcast_create', r.ok ? 'ok' : 'rejected', { reason: r.ok ? undefined : r.error, statusCode: r.status });
        if (r.ok) return res.json({ success: true, campaign: r.campaign, savedContacts });
        return sendEngineResult(res, r);
    } catch (e) {
        console.error('Error in /api/broadcast/create:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Outbound rules (owner): proactive outbound default OFF; Bulk Send quiet hours default ON. Stored in outbound_settings.json.
app.get('/api/settings/outbound', (req, res) => res.json({ success: true, settings: require('./outbound_settings.js').get() }));
app.post('/api/settings/outbound', (req, res) => {
    const b = req.body || {};
    const ch = {};
    if (b.proactiveOutbound !== undefined) ch.proactiveOutbound = b.proactiveOutbound === true || b.proactiveOutbound === 'true' || b.proactiveOutbound === 'on';
    if (b.quietHours !== undefined) ch.quietHours = !(b.quietHours === false || b.quietHours === 'false' || b.quietHours === 'off');
    res.json({ success: true, settings: require('./outbound_settings.js').set(ch) });
});

app.get('/api/broadcast/status', (req, res) => {
    try { res.json({ success: true, ...broadcastEngine.status() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/broadcast/pause', (req, res) => sendEngineResult(res, broadcastEngine.pause('manual')));
app.post('/api/broadcast/resume', (req, res) => sendEngineResult(res, broadcastEngine.resume()));
app.post('/api/broadcast/cancel', (req, res) => sendEngineResult(res, broadcastEngine.cancel()));

app.get('/api/broadcast/media', (req, res) => {
    res.json({ success: true, media: broadcastEngine.listMedia() });
});

app.get('/api/broadcast/results.csv', (req, res) => {
    const csv = broadcastEngine.resultsCsv(req.query.id);
    if (!csv) return res.status(404).json({ success: false, error: 'No broadcast found' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bulk_send_results_${String(req.query.id || 'latest').replace(/[^a-z0-9_]/gi, '')}.csv"`);
    res.send(csv);
});

app.get('/api/broadcast/opt-outs', (req, res) => {
    res.json({ success: true, optOuts: broadcastEngine.state.optOuts });
});

// Dialer / IVR export: plain CSV with name, phone_10, phone_91, ward, village. Opted-out excluded by default.
// source=contacts (filters: line, ward, village, search) | source=broadcast (id, status=sent,failed,skipped, reason=not_on_whatsapp,...)
app.get('/api/export/dialer.csv', (req, res) => {
    try {
        const q = req.query || {};
        const includeOptedOut = q.includeOptedOut === '1' || q.includeOptedOut === 'true';
        const excluded = includeOptedOut ? null : (phone => isBroadcastOptedOut(phone));
        let rows;
        let label = 'contacts';
        if (q.source === 'broadcast') {
            const statuses = q.status ? String(q.status).split(',').map(s => s.trim()).filter(Boolean) : null;
            const reasons = q.reason ? String(q.reason).split(',').map(s => s.trim()).filter(Boolean) : null;
            const list = broadcastEngine.campaignRecipients(q.id, { statuses, reasons });
            if (!list) return res.status(404).json({ success: false, error: 'No broadcast found' });
            rows = list.map(r => {
                const c = contactsManager.findByPhone(r.phone);
                return { name: r.name || c?.name || '', phone: r.phone, ward: r.ward || c?.ward || '', village: r.village || c?.village || '' };
            });
            label = 'broadcast_' + (statuses ? statuses.join('-') : 'all') + (reasons ? '_' + reasons.join('-') : '');
        } else {
            rows = contactsManager.getAll({ line: q.line, ward: q.ward, village: q.village, search: q.search });
            if (q.ward || q.village) label += '_filtered';
        }
        const { csv, count } = contactsManager.generateDialerCSV({}, excluded, rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('X-Row-Count', String(count));
        res.setHeader('Content-Disposition', `attachment; filename="dialer_${label.replace(/[^a-z0-9_-]/gi, '')}.csv"`);
        res.send(csv);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---------- Media Bank: one-click upload (image / video / pdf) ----------
const { mediaTypeOf } = require('./broadcast_engine.js');
const MEDIA_DIR = path.join(__dirname, 'media');
const PROTECTED_MEDIA = new Set(['poster.jpg', 'campaign_reel.mp4', 'NotoSansDevanagari-Bold.ttf', 'NotoSansDevanagari-Regular.ttf', 'baba_face.jpg', 'baba_33_transparent.png']);
const MEDIA_MAX_BYTES = 45 * 1024 * 1024;

function safeMediaName(original) {
    const ext = path.extname(String(original || '')).toLowerCase();
    let base = path.basename(String(original || 'file'), ext).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'media';
    let name = base + ext;
    let n = 1;
    while (fs.existsSync(path.join(MEDIA_DIR, name))) name = `${base}_${n++}${ext}`;
    return name;
}

app.get('/api/media/list', (req, res) => {
    res.json({ success: true, media: broadcastEngine.listMedia().map(m => ({ ...m, protected: PROTECTED_MEDIA.has(m.file) })) });
});

app.post('/api/media/upload', (req, res) => {
    try {
        const { fileName, base64Data } = req.body || {};
        if (!fileName || !base64Data) return res.status(400).json({ success: false, error: 'fileName and base64Data required' });
        const ext = path.extname(String(fileName)).toLowerCase();
        const type = mediaTypeOf(ext);
        if (!type) return res.status(400).json({ success: false, error: 'Only images (jpg/png/webp), videos (mp4/3gp/mov) or PDF' });
        const buf = Buffer.from(String(base64Data).replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (!buf.length) return res.status(400).json({ success: false, error: 'Empty file' });
        if (buf.length > MEDIA_MAX_BYTES) return res.status(413).json({ success: false, error: 'File too large (max 45 MB)' });
        const name = safeMediaName(fileName);
        fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
        operationsTracker.record('media_bank_upload', 'ok', { mediaType: type });
        res.json({ success: true, file: name, type, size: buf.length, url: '/media/' + encodeURIComponent(name) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/media/delete', (req, res) => {
    const file = path.basename(String((req.body || {}).file || ''));
    if (!file || PROTECTED_MEDIA.has(file) || !mediaTypeOf(path.extname(file).toLowerCase())) return res.status(400).json({ success: false, error: 'This file cannot be deleted here' });
    const full = path.join(MEDIA_DIR, file);
    if (!fs.existsSync(full)) return res.status(404).json({ success: false, error: 'Not found' });
    fs.unlinkSync(full);
    res.json({ success: true });
});

// ---------- Daily agenda per day ----------
app.get('/api/agenda/day', (req, res) => {
    const date = String(req.query.date || dailyGoal.currentIstDate());
    res.json({ success: true, date, day: campaignAgenda.getDay(date), merged: campaignAgenda.getAgenda(date), days: campaignAgenda.listDays() });
});
app.post('/api/agenda/day', (req, res) => {
    try {
        const { date, topic, talkingPoints, slots } = req.body || {};
        for (const slot of Object.keys(slots || {})) {
            const f = slots[slot] && slots[slot].mediaFile;
            if (f && !fs.existsSync(path.join(MEDIA_DIR, path.basename(f)))) return res.status(400).json({ success: false, error: `Media not found for ${slot}: ${f}` });
        }
        const day = campaignAgenda.updateDay(date || dailyGoal.currentIstDate(), { topic, talkingPoints, slots });
        res.json({ success: true, day });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ---------- Daily goal: live progress, persuasion funnel, night summary ----------
function persuasionTotals() {
    const t = { unknown: 0, undecided: 0, leaning: 0, committed: 0, opposed: 0, needsAdmin: 0 };
    const byWard = {};
    for (const u of userMemory.getAllUsers()) {
        if (!u.phone || String(u.phone).includes('Self')) continue;
        const st = u.persuasionStage || 'unknown';
        t[st] = (t[st] || 0) + 1;
        if (u.needsAdmin) t.needsAdmin++;
        const w = u.ward || 'unknown';
        byWard[w] = byWard[w] || { unknown: 0, undecided: 0, leaning: 0, committed: 0, opposed: 0 };
        byWard[w][st] = (byWard[w][st] || 0) + 1;
    }
    return { ...t, byWard };
}
app.get('/api/daily-goal/progress', (req, res) => {
    res.json({ success: true, progress: dailyGoal.progress(req.query.date || undefined), totals: persuasionTotals(), history: dailyGoal.history(7) });
});
app.post('/api/daily-goal/summary', (req, res) => {
    res.json({ success: true, summary: dailyGoal.buildSummary(req.body?.date || undefined, persuasionTotals()) });
});
app.post('/api/voter/stage', (req, res) => {
    const { phone, stage } = req.body || {};
    const u = userMemory.users[userMemory.cleanPhone(phone)];
    if (!u || !replyBrain.STAGES.includes(stage)) return res.status(400).json({ success: false, error: 'Unknown voter or stage' });
    const from = u.persuasionStage || 'unknown';
    u.persuasionStage = stage;
    u.persuasionHistory = (u.persuasionHistory || []).concat([{ from, to: stage, at: new Date().toISOString(), intent: 'admin' }]).slice(-20);
    if (u.needsAdmin && req.body.clearFlag) u.needsAdmin = null;
    userMemory.save();
    dailyGoal.recordEvent('stage', { phone: u.phone, line: u.assignedLine, ward: u.ward, from, to: stage });
    res.json({ success: true });
});
// ==================== LIVE SELF-TEST (PIN-protected via the global gate) ====================
// POST /api/self-test/start {testerLine, targetLine, script?}  -> tester line plays a scripted voter to the target line
// GET  /api/self-test/status | /api/self-test/runs | /api/self-test/result/:id.json | /api/self-test/result/:id.md
// POST /api/self-test/stop
function selfTestPinOk(req) {
    // Defence in depth: the global gate already requires the PIN; require it explicitly here too.
    const cookiePin = (String(req.headers.cookie || '').match(/(?:^|;\s*)campaign_pin=([^;]+)/) || [])[1];
    const pin = req.headers['x-campaign-pin'] || req.query.pin || (req.body && req.body.pin) || (cookiePin && decodeURIComponent(cookiePin));
    return pin === CAMPAIGN_PIN || !!(req.dashUser && req.dashUser.role === 'admin');
}
// POST /api/ai-keys {nvidia_keys?:[..], groq_api_key?, gemini_api_key?} -> writes gitignored api_config.json and hot-reloads (PIN required)
app.post('/api/ai-keys', (req, res) => {
    try {
        const cfgPath = path.join(__dirname, 'api_config.json');
        let cur = {};
        try { if (fs.existsSync(cfgPath)) cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (e) {}
        const b = req.body || {};
        if (Array.isArray(b.nvidia_keys)) cur.nvidia_keys = b.nvidia_keys.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof b.groq_api_key === 'string') cur.groq_api_key = b.groq_api_key.trim();
        if (typeof b.gemini_api_key === 'string') cur.gemini_api_key = b.gemini_api_key.trim();
        fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2), { mode: 0o600 });
        const providers = aiService.reloadKeys();
        res.json({ success: true, providers });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/self-test/status', (req, res) => {
    if (!selfTestPinOk(req)) return res.status(401).json({ error: 'PIN required' });
    res.json({ ...liveSelfTest.status(), lines: SESSIONS.map(s => ({ id: s.id, name: s.name, status: s.status })), defaultScript: require('./self_test.js').DEFAULT_SCRIPT });
});
app.post('/api/self-test/start', (req, res) => {
    if (!selfTestPinOk(req)) return res.status(401).json({ error: 'PIN required' });
    try {
        const st = liveSelfTest.start({ testerLine: req.body.testerLine, targetLine: req.body.targetLine, script: req.body.script && String(req.body.script).trim() ? req.body.script : null, freshContact: req.body.freshContact === true, keepRecord: req.body.keepRecord === true, op: req.body.op && typeof req.body.op === 'object' ? req.body.op : null });
        operationsTracker.record('self_test', 'started', { lineId: req.body.targetLine });
        res.json({ success: true, ...st });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});
app.post('/api/self-test/stop', (req, res) => {
    if (!selfTestPinOk(req)) return res.status(401).json({ error: 'PIN required' });
    res.json({ success: true, ...liveSelfTest.stop() });
});
app.get('/api/self-test/runs', (req, res) => {
    if (!selfTestPinOk(req)) return res.status(401).json({ error: 'PIN required' });
    res.json({ runs: liveSelfTest.listRuns() });
});
app.get('/api/self-test/result/:file', (req, res) => {
    if (!selfTestPinOk(req)) return res.status(401).json({ error: 'PIN required' });
    const m = String(req.params.file || '').match(/^(st_[\w]+)\.(json|md)$/);
    if (!m) return res.status(400).json({ error: 'Use <runId>.json or <runId>.md' });
    const run = liveSelfTest.readRun(m[1]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${m[1]}.${m[2]}"`);
    if (m[2] === 'json') return res.json(run);
    res.type('text/markdown').send(liveSelfTest.toMarkdown(run));
});

// ==================== BRAIN v3: SAMASYA / MULAQAT / VOTER PLAN / AI STATUS (PIN-protected via the global gate) ====================
const samasyaStore = require('./samasya_store.js');
const mulaqatStore = require('./mulaqat_store.js');
const kbV3 = require('./knowledge_base.js');
function storeFilter(q) {
    return { status: q.status || '', village: q.village || '', ward: q.ward || '', category: q.category || '', q: q.q || '', phone: q.phone || '', includeTest: q.includeTest === '1' || q.includeTest === 'true', onlyTest: q.onlyTest === '1' || q.onlyTest === 'true' };
}
app.get('/api/samasya', (req, res) => {
    const f = storeFilter(req.query);
    res.json({ records: samasyaStore.list(f), counts: samasyaStore.counts(dailyGoal.currentIstDate()), categories: kbV3.CATEGORY_LABEL, statuses: samasyaStore.statuses });
});
app.get('/api/samasya.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="samasya_' + dailyGoal.currentIstDate() + '.csv"');
    res.send(samasyaStore.toCSV(storeFilter(req.query)));
});
app.post('/api/samasya/update', (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ['status', 'notes', 'assignedTo', 'category', 'ward', 'location']) if (b[k] !== undefined) patch[k] = typeof b[k] === 'string' ? b[k].slice(0, 500) : b[k];
    const r = samasyaStore.update(String(b.id || ''), patch, 'dashboard');
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    operationsTracker.record('samasya', 'updated', { id: r.id, status: r.status });
    res.json({ success: true, record: r });
});
app.post('/api/samasya/delete', (req, res) => {
    const ok = samasyaStore.remove(String((req.body || {}).id || ''));
    res.json({ success: ok });
});
app.get('/api/mulaqat', (req, res) => {
    const f = storeFilter(req.query);
    res.json({ records: mulaqatStore.list(f), counts: mulaqatStore.counts(dailyGoal.currentIstDate()), statuses: mulaqatStore.statuses });
});
app.get('/api/mulaqat.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mulaqat_' + dailyGoal.currentIstDate() + '.csv"');
    res.send(mulaqatStore.toCSV(storeFilter(req.query)));
});
app.post('/api/mulaqat/update', (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ['status', 'notes', 'confirmedWhen', 'assignedTo', 'place', 'preferredWhen']) if (b[k] !== undefined) patch[k] = typeof b[k] === 'string' ? b[k].slice(0, 500) : b[k];
    const r = mulaqatStore.update(String(b.id || ''), patch, 'dashboard');
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    operationsTracker.record('mulaqat', 'updated', { id: r.id, status: r.status });
    res.json({ success: true, record: r });
});
app.post('/api/mulaqat/delete', (req, res) => {
    const ok = mulaqatStore.remove(String((req.body || {}).id || ''));
    res.json({ success: ok });
});
// ==================== OPS v4: Overview / विरोधी list / Scheduled bulk (logic in ops_routes.js) ====================
const opsRoutes = require('./ops_routes.js');
const ops = opsRoutes.install(app, { SESSIONS, broadcastEngine, userMemory, liveSelfTest, engagementPolicy, followupPlanner, contactsManager, samasyaStore, mulaqatStore, campaignAgenda, replyBrain, logMessage, onBulkSent: (info) => broadcastEngine.onSent(info), dailyIstDate: () => dailyGoal.currentIstDate(), resolveAudience: resolveBroadcastAudience });
// CRM (WhatsApp Web Live): full chat, voter profile & memory, AI co-pilot, safe quick actions (crm_routes.js)
const statusRoutes = require('./status_routes.js');
const statusPosts = statusRoutes.install(app, { SESSIONS, contactsManager, isOptedOut: (p) => isBroadcastOptedOut(p), lineContacts: engagementPolicy.LINE_CONTACTS });
const ocRoutes = require('./operator_control_routes.js');
ocRoutes.install(app, { userMemory, runFollowups: () => runOperatorFollowups() });
const crmRoutes = require('./crm_routes.js');
const crmUi = require('./crm_ui.js');
require('./instruction_routes.js').install(app, { userMemory, getActiveSocket, sendSafeMessage, logMessage,
    getLLM: () => { const C = aiService.CONFIG || {}; const any = NVIDIA_API_KEY || (C.nvidia_keys && C.nvidia_keys.length) || C.groq_api_key || C.gemini_api_key; return any ? (sys, hist, msg) => aiService.callLLMCascade(sys, hist, msg, NVIDIA_API_KEY || null, 9000) : null; } });
crmRoutes.install(app, { userMemory, getActiveSocket, sendSafeMessage, sendMultiContactCard, engagementPolicy, contactCard, logMessage, samasyaStore, mulaqatStore, voterEngine, voterCardGen, slipFlow, replyBrain,
    getLLM: () => { const C = aiService.CONFIG || {}; const any = NVIDIA_API_KEY || (C.nvidia_keys && C.nvidia_keys.length) || C.groq_api_key || C.gemini_api_key; return any ? (sys, hist, msg) => aiService.callLLMCascade(sys, hist, msg, NVIDIA_API_KEY || null, 7000) : null; } });
// Vision probe: does an NVIDIA vision model answer with the VM's keys? (uses an approved Media Bank poster)
app.get('/api/vision/probe', async (req, res) => {
    try {
        const p = require('./media_policy.js').approved('poster')[0];
        if (!p) return res.json({ success: false, error: 'no approved poster to probe with' });
        visionService.reloadConfig();
        const t0 = Date.now();
        let r;
        if (req.query.models) {
            const b64 = fs.readFileSync(p.path).toString('base64');
            r = await visionService.analyzeWithNvidia(b64, 'image/jpeg', 'Describe this image in one short Hindi sentence and classify it. Reply ONLY JSON: {"category":"voter_id|civic_issue|campaign_material|personal_photo|other","summaryHindi":"..."}', { models: String(req.query.models).split(','), timeoutMs: Math.min(Number(req.query.timeout) || 20000, 60000), perCallMs: 20000 }) || { fallback: true };
        } else r = await visionService.analyzeImage(fs.readFileSync(p.path), 'image/jpeg');
        res.json({ success: !r.fallback, ms: Date.now() - t0, category: r.category, summary: r.summaryHindi, model: r.model || null, provider: r.provider || (r.fallback ? 'none' : 'gemini'), nvidia: visionService.lastNvidia || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
/** Removes every samasya/mulaqat record created by a Live Self-Test (flag test=true). */
app.post('/api/test-records/cleanup', (req, res) => {
    const s1 = samasyaStore.removeWhere(r => !!r.test);
    const s2 = mulaqatStore.removeWhere(r => !!r.test);
    // brain v7: a STOP sent during a self-test opts our OWN test line out (bulk list + its record) — undo it here.
    // Only numbers of our connected lines are touched; real voters' opt-outs are never changed.
    const ownCleared = [];
    try {
        const own = new Set();
        for (const s of SESSIONS) for (const id of liveSelfTest.identitiesFor(s.id)) if (id && id.length >= 10) own.add(id);
        for (const id of own) {
            const keys = [id, id.length === 10 ? '91' + id : id];
            for (const k of keys) {
                let hit = false;
                try { if (broadcastEngine.removeOptOut(k)) hit = true; } catch (e) {}
                const u = userMemory.users[k];
                if (u && u.broadcastOptOut) { engagementPolicy.applyOptIn(u); hit = true; }
                if (hit) ownCleared.push(k);
            }
        }
        if (ownCleared.length) userMemory.save();
    } catch (e) { console.warn('[cleanup] own-line opt-out reset failed:', e.message); }
    res.json({ success: true, removed: { samasya: s1, mulaqat: s2 }, ownLineOptOutsCleared: ownCleared });
});
function voterPlanRow(u) {
    const vm = require('./voter_memory.js');
    const m = vm.ensure(u);
    const openS = samasyaStore.list({ phone: u.phone, includeTest: true }).filter(r => r.status !== 'resolved');
    const meet = mulaqatStore.list({ phone: u.phone, includeTest: true })[0] || null;
    let next = null;
    try { next = followupPlanner.nextAction(u); } catch (e) { next = { whenLabel: 'error: ' + e.message }; }
    return {
        phone: u.phone, name: m.name || u.name || '', line: u.assignedLine || u.lastSessionId || '', stage: u.persuasionStage || 'unknown',
        consent: u.consentStatus || '', optedOut: !!u.broadcastOptOut, lastSeen: u.lastSeen || null, test: !!u.selfTest,
        card: vm.cardObject(u),
        samasya: openS.map(r => ({ id: r.id, category: r.category, status: r.status, ward: r.ward, createdAtIST: r.createdAtIST })),
        mulaqat: meet ? { id: meet.id, status: meet.status, preferredWhen: meet.preferredWhen, place: meet.place } : null,
        flow: m.flow ? m.flow.type + ':' + (m.flow.step || '') : null,
        next
    };
}
app.get('/api/voter-plan', (req, res) => {
    const includeTest = req.query.includeTest === '1';
    const stage = req.query.stage || '';
    const q = String(req.query.q || '').toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const users = Object.values(userMemory.users || {}).filter(u => u && u.phone && String(u.phone).length >= 10 && (includeTest || !u.selfTest));
    users.sort((a, b) => (Date.parse(b.lastSeen || 0) || 0) - (Date.parse(a.lastSeen || 0) || 0));
    const rows = [];
    for (const u of users) {
        if (stage && (u.persuasionStage || 'unknown') !== stage) continue;
        if (q && !JSON.stringify([u.phone, u.name, u.memory && u.memory.name]).toLowerCase().includes(q)) continue;
        rows.push(voterPlanRow(u));
        if (rows.length >= limit) break;
    }
    res.json({ total: users.length, rows });
});
app.get('/api/voter-plan/:phone', (req, res) => {
    const u = userMemory.users[userMemory.cleanPhone ? userMemory.cleanPhone(req.params.phone) : req.params.phone];
    if (!u) return res.status(404).json({ error: 'Voter not found' });
    res.json({ ...voterPlanRow(u), history: (u.history || []).slice(-20).map(h => ({ role: h.role, text: h.text })) });
});
app.get('/api/ai-status', async (req, res) => {
    const st = aiService.aiStatus();
    if (req.query.probe === '1') st.probe = await aiService.probeProviders();
    res.json(st);
});

// Night summary at ~21:45 IST, once per day
setInterval(() => {
    try {
        const now = new Date();
        const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
        if (ist.getUTCHours() === 21 && ist.getUTCMinutes() >= 45) {
            const p = dailyGoal.progress();
            if (!p.summary) dailyGoal.buildSummary(undefined, persuasionTotals());
        }
    } catch (e) {}
}, 5 * 60 * 1000).unref();

// Manual contact entry / paste (one per line: phone, name, ward, village)
app.post('/api/contacts/bulk-add', (req, res) => {
    try {
        const rows = [...contactUtils.parsePastedContacts(req.body.text || req.body.rows || ''), ...(req.body.csvText ? contactUtils.parseContactCsv(req.body.csvText) : [])];
        const valid = rows.filter(r => contactUtils.normalizeIndianPhone(r.phone));
        const added = contactsManager.addMany(valid, { line: req.body.line, tags: ['✍️ Manual Entry'] });
        res.json({ success: true, added: added.length, invalid: rows.length - valid.length });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// API: Request Pairing Code (for Canada + Baba accounts)
app.post('/api/request-pairing-code', dashAuth.requireAdmin, async (req, res) => {
    try {
        const { sessionId, phone } = req.body;
        const sessionObj = SESSIONS.find(s => s.id === sessionId);
        if (!sessionObj || !sessionObj.sock) {
            return res.status(404).json({ error: 'Session not active yet. Please wait 5s.' });
        }
        let clean = String(phone).replace(/[^0-9]/g, '');
        if (!clean) return res.status(400).json({ error: 'Valid phone number required' });
        const code = await sessionObj.sock.requestPairingCode(clean);
        res.json({ success: true, code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: PM2 Bot Debug Logs
app.get('/api/debug', dashAuth.requireAdmin, (req, res) => {
    exec('pm2 logs whatsapp-bot --lines 80 --nostream', (err, stdout, stderr) => {
        res.type('text/plain').send(stdout || stderr || 'No PM2 logs available');
    });
});

// Meta Cloud / Facebook Ads Webhook (Verification endpoint for Meta Ads Manager)
app.get('/webhook/meta-ads', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === 'sihali2026') {
        console.log('[MetaWebhook] Verification successful!');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// Meta Cloud / Facebook Ads Webhook (Incoming lead dispatcher from FB/IG Click-To-WhatsApp Ads)
app.post('/webhook/meta-ads', async (req, res) => {
    try {
        const body = req.body;
        console.log('[MetaWebhook] Incoming webhook payload:', JSON.stringify(body));

        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const change = entry?.changes?.[0]?.value;
            const message = change?.messages?.[0];

            if (message) {
                const senderPhone = message.from;
                const textBody = message.text?.body || message.button?.text || 'Ram Ram';
                console.log(`[MetaWebhook] Received from +${senderPhone}: "${textBody}"`);

                const sessionObj = SESSIONS.find(s => s.status === 'CONNECTED') || SESSIONS[0];
                if (sessionObj && sessionObj.sock) {
                    const jid = (senderPhone.includes('@') ? senderPhone : senderPhone + '@s.whatsapp.net');
                    const reply = await aiService.getAIResponse(textBody, NVIDIA_API_KEY, [], senderPhone);
                    await sessionObj.sock.sendMessage(jid, { text: reply });
                    logMessage({
                        session: 'Meta Ads Webhook',
                        phone: senderPhone,
                        incoming: textBody,
                        reply: reply,
                        status: 'FB_AD_LEAD'
                    });
                }
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('[MetaWebhook Error]:', err);
        res.sendStatus(500);
    }
});

// Auto-Update Endpoint: Pulls latest code from GitHub and reloads PM2
// API: Clear generated card cache (forces fresh rendering with installed fonts)
app.get('/api/clear-card-cache', (req, res) => {
    try {
        if (voterCardGen && voterCardGen.clearCardCache) {
            voterCardGen.clearCardCache();
        }
        res.json({ success: true, message: 'Voter card cache cleared' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/update', dashAuth.requireAdmin, (req, res) => {
    console.log('[AutoDeploy] Pulling latest code from GitHub...');
    exec('git pull origin main && mkdir -p ~/.fonts && cp media/*.ttf ~/.fonts/ 2>/dev/null || true && fc-cache -f ~/.fonts 2>/dev/null || true && rm -rf parchi_cache/* && pm2 restart all', (err, stdout, stderr) => {
        if (err) {
            console.error('[AutoDeploy Error]:', stderr);
            return res.status(500).send(`
                <body style="font-family: sans-serif; padding: 30px;">
                    <h2 style="color: #dc2626;">❌ Auto-Update Failed</h2>
                    <pre style="background: #f1f5f9; padding: 15px; border-radius: 8px;">${stderr || err.message}</pre>
                    <a href="/">← Return to Dashboard</a>
                </body>
            `);
        }
        res.send(`
            <body style="font-family: sans-serif; padding: 30px; text-align: center;">
                <h2 style="color: #16a34a;">✅ Successfully Updated & Reloaded from GitHub!</h2>
                <p>Google Cloud VM has pulled all latest changes and restarted the bot.</p>
                <pre style="background: #f1f5f9; padding: 15px; border-radius: 8px; text-align: left; display: inline-block;">${stdout}</pre>
                <br><br>
                <a href="/" style="background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Return to Dashboard</a>
                <script>setTimeout(() => window.location.href = '/', 3000);</script>
            </body>
        `);
    });
});

// Quick Repair: Purges corrupted contact sessions and prekeys while keeping creds.json (NO QR SCAN NEEDED!)
app.get('/repair/:id', async (req, res) => {
    const session = SESSIONS.find(s => s.id === req.params.id);
    if (!session) return res.status(404).send('Session not found');

    console.log(`[Repair] Repairing session ${session.id} (purging stale keys, keeping creds.json)...`);
    try {
        if (session.sock) {
            session.sock.ev.removeAllListeners();
            session.sock.end(undefined);
            session.sock = null;
        }
    } catch (e) {}

    const authPath = path.join(sessionsDir, session.id);
    let deletedCount = 0;
    if (fs.existsSync(authPath)) {
        try {
            const files = fs.readdirSync(authPath);
            for (const file of files) {
                if (file !== 'creds.json') {
                    try {
                        fs.unlinkSync(path.join(authPath, file));
                        deletedCount++;
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('Error during session repair:', e);
        }
    }

    session.status = 'CONNECTING';

    setTimeout(() => {
        startSession(session);
    }, 1500);

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Repairing Session</title></head>
        <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
            <h2 style="color: #38bdf8;">⚡ Encryption Keys Repaired for ${session.name}!</h2>
            <p>Purged <b>${deletedCount}</b> stale Signal cryptographic ratchets & Bad MAC keys.</p>
            <p style="color: #4ade80; font-weight: bold; font-size: 16px;">✅ Login credentials preserved — NO QR scan needed!</p>
            <p style="color: #94a3b8;">WhatsApp is re-synchronizing fresh pre-keys right now...</p>
            <br>
            <a href="/" style="display:inline-block; padding:12px 24px; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:bold;">← Return to Dashboard</a>
            <script>setTimeout(() => window.location.href = '/', 3500);</script>
        </body>
        </html>
    `);
});

// Clean Reset / Re-link Session (removes corrupted Signal keys and regenerates QR)
app.get('/reset/:id', async (req, res) => {
    const session = SESSIONS.find(s => s.id === req.params.id);
    if (!session) return res.status(404).send('Session not found');

    console.log(`[Reset] Resetting session auth for ${session.id}...`);
    try {
        if (session.sock) {
            session.sock.end(undefined);
            session.sock = null;
        }
    } catch (e) {}

    const authPath = path.join(sessionsDir, session.id);
    if (fs.existsSync(authPath)) {
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {
            console.error('Error removing auth path:', e);
        }
    }

    session.status = 'DISCONNECTED';
    session.qr = null;

    setTimeout(() => {
        startSession(session);
    }, 1500);

    res.send(`
        <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px; background: #f8fafc;">
            <h2>🔄 Session Reset for ${session.name}!</h2>
            <p>Corrupted encryption keys cleared. Generating fresh QR code now...</p>
            <p>Please open WhatsApp -> <b>Linked Devices</b>, tap any existing session to log out, and scan the new QR code.</p>
            <br>
            <a href="/scan/${session.id}" style="display:inline-block; padding:10px 20px; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:bold;">📲 Scan New QR Code Now</a>
            <script>setTimeout(() => window.location.href = '/scan/${session.id}', 3000);</script>
        </body>
    `);
});

// QR Scan Page
app.get('/scan/:id', (req, res) => {
    const session = SESSIONS.find(s => s.id === req.params.id);
    if (!session) return res.status(404).send('Session not found');

    if (session.status === 'CONNECTED') {
        return res.send(`
            <div style="font-family: sans-serif; text-align:center; padding: 50px;">
                <h2 style="color: #16a34a;">✅ ${session.name} is ALREADY CONNECTED!</h2>
                <a href="/" style="color: #2563eb; text-decoration:none; font-weight:bold;">← Return to Dashboard</a>
            </div>
        `);
    }

    if (!session.qr) {
        return res.send(`
            <div style="font-family: sans-serif; text-align:center; padding: 50px;">
                <h2>⏳ Generating QR Code for ${session.name}...</h2>
                <p>Please wait 3-5 seconds and refresh.</p>
                <script>setTimeout(() => window.location.reload(), 3000);</script>
            </div>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Scan WhatsApp QR - ${session.name}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: -apple-system, sans-serif; background: #f8fafc; display: flex; align-items:center; justify-content:center; min-height: 100vh; margin:0; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align:center; max-width: 400px; width: 100%;">
                <h2 style="margin-top:0; color:#0f172a; font-size: 20px;">📲 ${session.name}</h2>
                <p style="color: #64748b; font-size: 14px; margin-bottom: 20px;">Open WhatsApp -> <b>Linked Devices</b> -> <b>Link a Device</b>:</p>
                <img src="${session.qr}" style="width: 250px; height: 250px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 100%;" />
                <br>
                <div style="margin-top: 20px;">
                    <a href="/" style="color: #2563eb; text-decoration:none; font-size: 14px; font-weight: bold;">← Back to Dashboard</a>
                </div>
                <script>setTimeout(() => window.location.reload(), 20000);</script>
            </div>
        </body>
        </html>
    `);
});

// UI: Unified Mobile-First Master Dashboard
app.get('/', (req, res) => {
    let sessionPills = SESSIONS.map(s => {
        let isConn = s.status === 'CONNECTED';
        let color = isConn ? '#16a34a' : (s.status === 'QR_READY' ? '#eab308' : '#dc2626');
        let scanLink = isConn 
            ? `<div style="text-align:right;"><span style="color:#16a34a; font-weight:700; font-size:12px;">🟢 ONLINE</span><br><a href="/repair/${s.id}" style="color:#0284c7; font-size:11px; text-decoration:none; font-weight:700; margin-right:8px;">⚡ Repair</a><a href="/reset/${s.id}" onclick="return confirm('Clean reset and re-link ${s.name}?')" style="color:#64748b; font-size:11px; text-decoration:underline;">Re-link</a></div>`
            : `<a href="/scan/${s.id}" style="background:#2563eb; color:white; padding:6px 12px; border-radius:6px; font-size:11px; text-decoration:none; font-weight:700;">📲 SCAN QR</a>`;

        return `
            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; min-width: 260px; flex: 1;">
                <div>
                    <div style="font-weight: 700; font-size: 14px; color: #1e293b;">${s.name}</div>
                    <div style="font-size: 12px; color: ${color}; font-weight: 600;">● ${s.status}</div>
                </div>
                <div>${scanLink}</div>
            </div>
        `;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Sihali Khurd Campaign Assistant - Command Tower</title>
            <link rel="icon" href="data:,">
            <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
            <style>
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; margin: 0; padding: 15px; color: #0f172a; }
                .container { max-width: 1200px; margin: 0 auto; }
                
                /* Top Header */
                .header-bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; background: white; padding: 16px 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 20px; gap: 15px; }
                .brand h1 { margin: 0; font-size: 20px; color: #0f172a; }
                .brand p { margin: 3px 0 0 0; font-size: 13px; color: #64748b; }
                .top-actions { display: flex; gap: 10px; align-items: center; }
                
                /* Quick Add Box - Mobile Optimized */
                .quick-box { background: linear-gradient(135deg, #1e293b, #0f172a); color: white; border-radius: 14px; padding: 20px; margin-bottom: 25px; box-shadow: 0 8px 20px rgba(15,23,42,0.15); }
                .quick-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-top: 15px; }
                .form-group label { display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px; }
                .input-field { width: 100%; padding: 11px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-size: 15px; outline: none; }
                .input-field:focus { border-color: #3b82f6; }
                .btn-add { background: #16a34a; color: white; border: none; padding: 13px 20px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 700; width: 100%; transition: background 0.2s; margin-top: 22px; }
                .btn-add:hover { background: #15803d; }
                .btn-add:active { transform: scale(0.98); }

                /* Tab Navigation */
                .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; position: relative; z-index: 5; }
                .tab-btn { background: #ffffff80; border: 1px solid #e2e8f0; padding: 10px 14px; min-height: 40px; font-size: 13px; font-weight: 700; color: #475569; cursor: pointer; border-radius: 8px; white-space: nowrap; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
                .tab-btn:hover { background: #fff; color: #1d4ed8; }
                .tab-btn.active { background: white; color: #2563eb; box-shadow: 0 2px 4px rgba(0,0,0,0.06); }

                /* Cards & Tables */
                .card { background: white; border-radius: 12px; padding: 20px; border: 1px solid #e2e8f0; box-shadow: 0 2px 5px rgba(0,0,0,0.04); }
                .table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }
                .table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
                .table th { background: #f8fafc; padding: 12px; color: #475569; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
                .table td { padding: 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
                
                /* Badges */
                .badge { padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; display: inline-block; }
                .badge-success { background: #dcfce7; color: #15803d; }
                .badge-warning { background: #fef3c7; color: #b45309; }
                .badge-info { background: #e0f2fe; color: #0369a1; }
                .badge-danger { background: #fee2e2; color: #b91c1c; }

                /* Layout Grids */
                .studio-grid { display: grid; grid-template-columns: 1fr 340px; gap: 20px; }
                .chat-view-container { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
                @media (max-width: 850px) {
                    .studio-grid, .chat-view-container { grid-template-columns: 1fr; }
                    .header-bar { flex-direction: column; align-items: flex-start; }
                }
                /* 📱 Simple mobile view: only the header + "Add contact & send now" unless "Show full dashboard" is tapped */
                .mobile-full-toggle { display: none; }
                @media (max-width: 760px) {
                    .mobile-full-toggle { display: block; width: 100%; margin: 0 0 14px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff; color: #0f172a; font-size: 15px; font-weight: 700; cursor: pointer; }
                    body:not(.show-full) .container > *:not(.header-bar):not(#qa-panel):not(.mobile-full-toggle):not(script):not(style) { display: none !important; }
                    body:not(.show-full) .header-bar .brand p, body:not(.show-full) #public-url-badge, body:not(.show-full) .header-bar .top-actions > span:not([class]) , body:not(.show-full) .header-bar .top-actions > a { display: none !important; }
                    body:not(.show-full) .header-bar h1 { font-size: 17px; }
                    body:not(.show-full) .qa-row { grid-template-columns: 1fr; }
                }
                .qa-vbox { background: rgba(255,255,255,.1); border-radius: 12px; padding: 8px 10px; }
                .qa-vbox summary { cursor: pointer; font-weight: 800; font-size: 15px; padding: 4px 0; }
                .qa-vbox > * + * { margin-top: 8px; }
                .qa-vbtn { width: 100%; min-height: 44px; border: 0; border-radius: 10px; background: #e2e8f0; color: #0f172a; font-size: 15px; font-weight: 800; cursor: pointer; }
                .qa-vgo { background: #facc15; }
                .qa-vres { display: grid; gap: 6px; max-height: 340px; overflow-y: auto; }
                .qa-vitem { display: flex; gap: 10px; align-items: flex-start; background: #fff; color: #0f172a; border-radius: 10px; padding: 9px 10px; font-size: 14px; cursor: pointer; }
                .qa-vitem input { width: 20px; height: 20px; margin-top: 2px; flex: none; }
                .qa-vitem b { font-size: 15px; }
                .qa-vitem small { color: #475569; display: block; }
                .qa-vhint { font-size: 12px; opacity: .85; }
                .qa-panel { background: linear-gradient(135deg, #065f46, #0f766e); color: #fff; border-radius: 14px; padding: 14px; margin-bottom: 16px; box-shadow: 0 6px 18px rgba(6,95,70,.25); }
                .qa-head { font-weight: 800; font-size: 17px; margin-bottom: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
                .qa-panel form { display: grid; gap: 8px; max-width: 760px; }
                .qa-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
                .qa-panel input[type=tel], .qa-panel input[type=text], .qa-panel input[type=number], .qa-panel select, .qa-panel textarea { width: 100%; min-height: 46px; padding: 10px 12px; border-radius: 10px; border: 0; font-size: 16px; color: #0f172a; background: #fff; }
                .qa-panel #qa-phone { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
                .qa-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
                .qa-send { min-height: 52px; border: 0; border-radius: 12px; background: #facc15; color: #111827; font-size: 18px; font-weight: 800; cursor: pointer; }
                .qa-send:disabled { opacity: .6; }
                .qa-status { font-size: 14px; font-weight: 700; min-height: 18px; word-break: break-word; }
                /* Mobile-first: wrap tabs into a tap grid, scroll wide tables, 16px inputs (no iOS zoom) */
                .table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
                img, video, canvas { max-width: 100%; height: auto; }
                @media (max-width: 700px) {
                    body { padding: 8px; }
                    .tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
                    .tab-btn { white-space: normal; text-align: left; min-height: 48px; font-size: 13px; padding: 10px 10px; line-height: 1.2; }
                    .card { padding: 14px !important; border-radius: 10px; overflow-x: auto; }
                    table { min-width: 560px; }
                    .table-responsive table, .card > table { display: table; }
                    input, select, textarea { font-size: 16px !important; max-width: 100%; }
                    button, .btn { min-height: 44px; }
                    .wa-wrapper { flex-direction: column; height: auto; }
                    .wa-left { width: 100%; max-height: 360px; border-right: none; border-bottom: 1px solid #e2e8f0; }
                    [style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
                }
                .voter-list { max-height: 500px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 8px; }
                .voter-item { padding: 12px; border-bottom: 1px solid #f1f5f9; cursor: pointer; transition: background 0.15s; }
                .voter-item:hover, .voter-item.selected { background: #eff6ff; }
                .chat-box { border: 1px solid #e2e8f0; border-radius: 8px; height: 500px; display: flex; flex-direction: column; background: #fafafa; }
                .chat-messages { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
                .bubble { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.4; word-wrap: break-word; }
                .bubble-user { align-self: flex-start; background: white; border: 1px solid #e2e8f0; color: #0f172a; }
                .bubble-bot { align-self: flex-end; background: #dcfce7; color: #064e3b; }

                /* WhatsApp Web Master Replica UI */
                .wa-wrapper { display: flex; height: 720px; border-radius: 12px; overflow: hidden; border: 1px solid #cbd5e1; background: #ffffff; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                .wa-left { width: 360px; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; background: #ffffff; }
                .wa-left-header { background: #f8fafc; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
                .wa-search-bar { padding: 8px 12px; background: #ffffff; border-bottom: 1px solid #f1f5f9; }
                .wa-filter-chips { display: flex; gap: 6px; padding: 8px 12px; background: #f8fafc; overflow-x: auto; border-bottom: 1px solid #e2e8f0; white-space: nowrap; -webkit-overflow-scrolling: touch; }
                .filter-chip { padding: 4px 10px; border-radius: 14px; font-size: 11px; font-weight: 600; cursor: pointer; background: white; border: 1px solid #cbd5e1; color: #475569; transition: all 0.15s; }
                .filter-chip:hover { border-color: #00a884; }
                .filter-chip.active { background: #00a884; color: white; border-color: #00a884; }
                .wa-contacts-list { flex: 1; overflow-y: auto; }
                .wa-contact-item { display: flex; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #f1f5f9; cursor: pointer; transition: background 0.15s; align-items: flex-start; }
                .wa-contact-item:hover { background: #f8fafc; }
                .wa-contact-item.selected { background: #e0f2fe; border-left: 4px solid #0284c7; }
                .wa-avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, #00a884, #128c7e); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                .wa-contact-info { flex: 1; min-width: 0; }
                .wa-contact-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
                .wa-contact-name { font-weight: 700; font-size: 14px; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .wa-contact-time { font-size: 11px; color: #64748b; flex-shrink: 0; }
                .wa-contact-sub { font-size: 12px; color: #0284c7; margin-bottom: 3px; display: flex; justify-content: space-between; align-items: center; }
                .wa-contact-snippet { font-size: 12px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
                .wa-tag-pill { display: inline-block; padding: 2px 7px; border-radius: 8px; font-size: 10px; font-weight: 600; margin-right: 4px; margin-top: 2px; border: 1px solid; }
                .wa-right { flex: 1; display: flex; flex-direction: column; background: #efeae2; position: relative; }
                .wa-header { background: #f8fafc; padding: 10px 16px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
                .wa-intel-bar { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 14px 18px; display: none; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
                .wa-chat-scroll { flex: 1; overflow-y: auto; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; background-color: #efeae2; }
                .wa-bubble { max-width: 78%; padding: 8px 12px 6px 12px; border-radius: 8px; font-size: 13.5px; line-height: 1.45; position: relative; box-shadow: 0 1px 2px rgba(15,23,42,0.12); word-break: break-word; }
                .wa-bubble-user { align-self: flex-start; background: #ffffff; color: #0f172a; border-top-left-radius: 0; }
                .wa-bubble-bot { align-self: flex-end; background: #d9fdd3; color: #0f172a; border-top-right-radius: 0; }
                .wa-bubble-admin { align-self: flex-end; background: #e0f2fe; color: #0369a1; border-top-right-radius: 0; }
                .wa-bubble-meta { display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-top: 4px; gap: 8px; }
                .wa-quick-actions { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 7px 14px; display: flex; gap: 8px; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
                .wa-action-btn { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 16px; padding: 6px 14px; font-size: 12px; font-weight: 600; color: #1e293b; cursor: pointer; transition: all 0.15s; }
                .wa-action-btn:hover { background: #e2e8f0; border-color: #00a884; }
                .wa-input-container { background: #f8fafc; padding: 10px 16px; display: flex; gap: 10px; align-items: center; border-top: 1px solid #e2e8f0; }
                .wa-input-field { flex: 1; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 20px; padding: 11px 18px; font-size: 14px; color: #0f172a; outline: none; }
                .wa-input-field:focus { border-color: #00a884; }
                .wa-send-btn { width: 42px; height: 42px; border-radius: 50%; background: #00a884; color: white; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; transition: background 0.15s; }
                .wa-send-btn:hover { background: #028066; }
                ${crmUi.css()}
                ${ocRoutes.ui.css()}

            </style>
        </head>
        <body>
            <div class="container">
                <!-- Top Header -->
                <div class="header-bar">
                    <div class="brand">
                        <h1>🏛️ Sihali Khurd Election 2026 — Baba Abhay Singh</h1>
                        <p>24/7 Multi-Session Campaign Tower • Mobile Field & AI Studio</p>
                    </div>
                    <div class="top-actions">
                        <span id="public-url-badge" style="background: #e0f2fe; color: #0369a1; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; border: 1px solid #bae6fd;">🔗 Fixed dashboard address</span>
                        <span style="background: #dcfce7; color: #15803d; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700;">🟢 Iowa Cloud 24/7</span>
${req.dashUser && req.dashUser.role === 'admin' ? `<a href="/update" onclick="return confirm('Sync latest code from GitHub?')" style="background: #0f172a; color: white; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 700;">🔄 Pull GitHub</a>` : ''}
                        ${dashAuth.ui.headerBadge(req)}
                    </div>
                </div>

                <!-- ➕ Mobile-first quick add & send -->
                <div id="qa-panel" class="qa-panel">
                    <div class="qa-head">➕ Add contact &amp; send now <span style="font-weight:500;font-size:12px;opacity:.85;">Enter number → send (never goes to people who said STOP)</span></div>
                    <form id="qa-form" autocomplete="off" onsubmit="return false;">
                        <input id="qa-phone" type="tel" inputmode="tel" placeholder="📱 Mobile number (10 digits / +1…)" required>
                        <div class="qa-row">
                            <input id="qa-name" type="text" placeholder="Name (optional)">
                            <input id="qa-ward" type="number" inputmode="numeric" min="1" max="30" placeholder="Ward">
                        </div>
                        <div class="qa-row">
                            <select id="qa-line">${SESSIONS.map(s => `<option value="${s.id}"${s.status === 'CONNECTED' ? '' : ' disabled'}>${s.status === 'CONNECTED' ? '🟢' : '⚪'} ${s.name}</option>`).join('')}</select>
                            <select id="qa-msg"><option value="intro">👋 Short intro (default)</option><option value="custom">✍️ My own message</option></select>
                        </div>
                        <textarea id="qa-custom" rows="3" placeholder="Type your message…" style="display:none;"></textarea>
                        <div class="qa-row">
                            <select id="qa-poster"><option value="">🖼️ No poster</option></select>
                            <label class="qa-check"><input id="qa-forcecard" type="checkbox" checked> Send contact card</label>
                        </div>
                        <details id="qa-vbox" class="qa-vbox">
                            <summary>🔎 Search voter list → send slip (parchi)</summary>
                            <div class="qa-row">
                                <input id="qa-vq" type="text" placeholder="Voter name (e.g. rajesh devi)">
                                <input id="qa-vrel" type="text" placeholder="Father / husband name (optional)">
                            </div>
                            <button id="qa-vsearch" type="button" class="qa-vbtn">🔎 Search</button>
                            <div id="qa-vres" class="qa-vres"></div>
                            <div id="qa-vact" class="qa-row" style="display:none;">
                                <button id="qa-vsend" type="button" class="qa-vbtn qa-vgo">📄 Send this voter's slip</button>
                                <button id="qa-vchoose" type="button" class="qa-vbtn">📋 Send list, voter picks</button>
                            </div>
                            <div class="qa-vhint">Know the person? Tick one → "Send this voter's slip". Not sure? Tick 2–5 → "Send list, voter picks" — the voter replies with a number and gets their own slip.</div>
                        </details>
                        <button id="qa-send" type="button" class="qa-send">📲 Save &amp; Send now</button>
                        <div id="qa-status" class="qa-status" role="status" aria-live="polite"></div>
                    </form>
                </div>
                <button type="button" id="mobile-full-toggle" class="mobile-full-toggle" onclick="(function(){var on=document.body.classList.toggle('show-full');try{localStorage.setItem('dashFull',on?'1':'0')}catch(e){};document.getElementById('mobile-full-toggle').textContent=on?'📱 Show only quick send':'📋 Show full dashboard';})()">📋 Show full dashboard</button>
                <script>try{if(localStorage.getItem('dashFull')==='1'){document.body.classList.add('show-full');document.getElementById('mobile-full-toggle').textContent='📱 Show only quick send';}}catch(e){}</script>
                <script>
                (function () {
                    function $(id) { return document.getElementById(id); }
                    function setStatus(t, ok) { var s = $('qa-status'); s.textContent = t; s.style.color = ok === false ? '#fecaca' : (ok ? '#bbf7d0' : '#e2e8f0'); }
                    var line = $('qa-line'); if (line) { for (var i = 0; i < line.options.length; i++) if (!line.options[i].disabled) { line.selectedIndex = i; break; } }
                    $('qa-msg').addEventListener('change', function () { $('qa-custom').style.display = this.value === 'custom' ? 'block' : 'none'; });
                    fetch('/api/media/list', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
                        var sel = $('qa-poster');
                        (d.media || []).filter(function (m) { return m.type === 'image'; }).forEach(function (m) { var o = document.createElement('option'); o.value = m.file; o.textContent = '🖼️ ' + m.file; sel.appendChild(o); });
                    }).catch(function () {});
                    var busy = false;
                    $('qa-send').addEventListener('click', function () {
                        if (busy) return;
                        var phone = $('qa-phone').value.trim();
                        if (phone.replace(/[^0-9]/g, '').length < 10) { setStatus('❌ Enter a valid mobile number', false); $('qa-phone').focus(); return; }
                        if ($('qa-msg').value === 'custom' && !$('qa-custom').value.trim()) { setStatus('❌ Type a message', false); return; }
                        busy = true; this.disabled = true; setStatus('⏳ Sending…');
                        var btn = this;
                        fetch('/api/quick-add-send', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                            phone: phone, name: $('qa-name').value.trim(), ward: $('qa-ward').value, lineId: $('qa-line').value,
                            message: $('qa-msg').value, customText: $('qa-custom').value, poster: $('qa-poster').value, forceCard: $('qa-forcecard').checked
                        }) }).then(function (r) { return r.json(); }).then(function (d) {
                            if (d.success) {
                                setStatus('✅ Sent: ' + (d.name ? d.name + ' • ' : '') + d.phone + ' via ' + d.lineName + (d.poster ? ' + poster' : '') + ' • Card: ' + (d.contactCard === 'sent' ? 'sent' : 'already has it'), true);
                                $('qa-phone').value = ''; $('qa-name').value = ''; $('qa-ward').value = '';
                            } else setStatus('❌ ' + (d.error || 'Failed'), false);
                        }).catch(function (e) { setStatus('❌ Network error: ' + e.message, false); })
                          .then(function () { busy = false; btn.disabled = false; });
                    });
                    // 🔎 voter search -> send parchi / send list to choose
                    var vSel = {};
                    function vEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                    function vKeys() { return Object.keys(vSel).filter(function (k) { return vSel[k]; }); }
                    function vRender(list) {
                        vSel = {}; var box = $('qa-vres');
                        if (!list.length) { box.innerHTML = '<div class="qa-vhint">No one found — type the name as on the voter card, or clear the ward and try again.</div>'; $('qa-vact').style.display = 'none'; return; }
                        box.innerHTML = '<div class="qa-vhint">' + list.length + ' found' + (list.length > 15 ? ' — add father/husband name or ward to narrow it down' : '') + '</div>' + list.map(function (v) {
                            return '<label class="qa-vitem"><input type="checkbox" data-k="' + vEsc(v.key) + '" data-n="' + vEsc(v.name) + '" data-w="' + vEsc(v.ward) + '"><span><b>' + vEsc(v.name) + '</b><small>' + vEsc(v.rel) + ': ' + vEsc(v.relName) + ' • Ward ' + vEsc(v.ward) + ' • Age ' + vEsc(v.age) + ' • House ' + vEsc(v.house) + '</small></span></label>';
                        }).join('');
                        $('qa-vact').style.display = 'grid';
                        box.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.addEventListener('change', function () {
                            vSel[this.dataset.k] = this.checked;
                            var ks = vKeys();
                            if (ks.length === 1 && this.checked) { if (!$('qa-name').value.trim()) $('qa-name').value = this.dataset.n; if (!$('qa-ward').value) $('qa-ward').value = this.dataset.w; }
                            $('qa-vsend').disabled = ks.length !== 1; $('qa-vchoose').disabled = ks.length < 2 || ks.length > 5;
                        }); });
                        $('qa-vsend').disabled = true; $('qa-vchoose').disabled = true;
                    }
                    function vSearch() {
                        var q = $('qa-vq').value.trim(); if (q.length < 2) { setStatus('❌ Type the voter name', false); return; }
                        setStatus('🔎 Searching…');
                        fetch('/api/voter-lookup?q=' + encodeURIComponent(q) + '&rel=' + encodeURIComponent($('qa-vrel').value.trim()) + '&ward=' + encodeURIComponent($('qa-ward').value || ''), { credentials: 'same-origin' })
                          .then(function (r) { return r.json(); }).then(function (d) { setStatus(''); vRender(d.results || []); }).catch(function (e) { setStatus('❌ ' + e.message, false); });
                    }
                    $('qa-vsearch').addEventListener('click', vSearch);
                    $('qa-vq').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); vSearch(); } });
                    $('qa-vrel').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); vSearch(); } });
                    function vSend(mode) {
                        if (busy) return;
                        var phone = $('qa-phone').value.trim();
                        if (phone.replace(/[^0-9]/g, '').length < 10) { setStatus('❌ Enter the mobile number above', false); $('qa-phone').focus(); return; }
                        var ks = vKeys();
                        if (mode === 'send' && ks.length !== 1) { setStatus('❌ Tick exactly one voter to send a slip', false); return; }
                        if (mode === 'choose' && (ks.length < 2 || ks.length > 5)) { setStatus('❌ Tick 2 to 5 voters to send a list', false); return; }
                        busy = true; setStatus('⏳ Sending…');
                        fetch('/api/operator-slip', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                            phone: phone, lineId: $('qa-line').value, mode: mode, key: ks[0], keys: ks, query: $('qa-vq').value.trim(), forceCard: $('qa-forcecard').checked
                        }) }).then(function (r) { return r.json(); }).then(function (d) {
                            if (d.success) { setStatus(d.mode === 'send' ? ('✅ Slip sent: ' + d.voter + ' → ' + d.phone + ' via ' + d.lineName) : ('✅ List of ' + d.count + ' names sent → ' + d.phone + ' (when the voter replies with a number, their slip goes automatically)'), true); $('qa-vres').innerHTML = ''; $('qa-vact').style.display = 'none'; $('qa-vq').value = ''; $('qa-vrel').value = ''; }
                            else setStatus('❌ ' + (d.error || 'Failed'), false);
                        }).catch(function (e) { setStatus('❌ Network error: ' + e.message, false); }).then(function () { busy = false; });
                    }
                    $('qa-vsend').addEventListener('click', function () { vSend('send'); });
                    $('qa-vchoose').addEventListener('click', function () { vSend('choose'); });
                })();
                </script>

                <!-- Session Status Pills -->
                <div style="display: flex; gap: 15px; flex-wrap: wrap; margin-bottom: 20px;">
                    ${sessionPills}
                </div>

                <!-- Quick-Add / Instant Connect Box (Field Mode) -->
                <div class="quick-box">
                    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <h2 style="margin: 0; font-size: 18px; color: #f8fafc;">⚡ Field Mode: Instant Voter Connect</h2>
                            <p style="margin: 4px 0 0 0; font-size: 13px; color: #94a3b8;">Meeting a villager? Type their number and tap send — their WhatsApp buzzes instantly!</p>
                        </div>
                        <span id="send-status" style="font-weight: 700; font-size: 13px; padding: 4px 12px; border-radius: 20px; display: none;"></span>
                    </div>

                    <form id="quick-add-form" onsubmit="sendInstantMessage(event)">
                        <div class="quick-grid">
                            <div class="form-group">
                                <label>📱 Voter Mobile Number *</label>
                                <input type="tel" id="v-phone" class="input-field" placeholder="e.g. 9829xxxxxx or 6367810227" required autocomplete="off">
                            </div>
                            <div class="form-group" style="position: relative;">
                                <label>🔍 Search & Link Voter (name in voter list)</label>
                                <input type="text" id="v-name" class="input-field" placeholder="Type name or EPIC..." autocomplete="off" oninput="onVoterSearchInput(this.value)">
                                <div id="voter-search-dropdown" style="position: absolute; left: 0; right: 0; top: 100%; z-index: 999; background: white; border: 1px solid #cbd5e1; border-radius: 8px; max-height: 220px; overflow-y: auto; display: none; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.15);"></div>
                                <div id="voter-linked-badge" style="display: none; margin-top: 6px; padding: 6px 12px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; font-size: 12px; color: #065f46; font-weight: 700;"></div>
                                <input type="hidden" id="v-voter-id">
                                <input type="hidden" id="v-linked-ward">
                                <input type="hidden" id="v-linked-epic">
                            </div>
                            <div class="form-group">
                                <label>📡 WhatsApp Sending Line</label>
                                <select id="v-line" class="input-field">
                                    <option value="sim_636">Primary Line (6367810227)</option>
                                    <option value="baba_aux">Baba Aux Line (Secondary)</option>
                                    <option value="canada">Canada Line (+1)</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>💬 Action Template (Soft & Casual)</label>
                                <select id="v-template" class="input-field" onchange="onTemplateChange(this.value)">
                                    <option value="consent_check">🛡️ 0. Anti-spam consent check (1. Yes / 2. No)</option>
                                    <option value="permission_casual">🤝 1. Permission + how are you (soft, non-spam)</option>
                                    <option value="offer_parchi">🎫 2. Offer voter slip (parchi)</option>
                                    <option value="ground_feedback">📢 3. Ward problems & feedback</option>
                                    <option value="direct_appeal">🗳️ 4. Ballot No. 1 — direct appeal (16 Nov)</option>
                                    <option value="welcome">👋 5. Quick welcome ("Aapko jod liya h...")</option>
                                    <option value="custom">✍️ 6. Custom message...</option>
                                </select>
                            </div>
                            <div class="form-group" style="grid-column: 1 / -1; display: none;" id="custom-text-group">
                                <label>Write custom message</label>
                                <input type="text" id="v-custom-text" class="input-field" placeholder="Type message...">
                            </div>

                            <!-- Media Attachment Radios -->
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label style="margin-bottom: 6px; display: block; font-size: 12px; font-weight: 700; color: #cbd5e1;">📎 Media attachment:</label>
                                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="none" checked> 💬 Text only
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="slip" id="media-opt-slip"> 🎫 Voter slip JPG card
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="poster"> 📸 Campaign poster
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="video"> 📹 3D video reel
                                    </label>
                                </div>
                            </div>
                        </div>

                        <button type="submit" class="btn-add" id="btn-submit" style="margin-top: 10px; font-size: 15px; font-weight: 800; padding: 12px;">
                            📲 Jod Lo & Send WhatsApp Instantly
                        </button>
                    </form>
                </div>

                <!-- Tabbed Navigation -->
                <div class="tabs">
                    <button id="tab-btn-feed" class="tab-btn active" onclick="switchTab('feed', this)">💬 Live Voter Chat</button>
                    <button id="tab-btn-diagnostics" class="tab-btn" onclick="switchTab('diagnostics', this)">🛠️ Diagnostics & Self-Test Log</button>
                    <button id="tab-btn-studio" class="tab-btn" onclick="switchTab('studio', this)">🎨 Live Poster Studio</button>
                    <button id="tab-btn-playground" class="tab-btn" onclick="switchTab('playground', this)">🤖 AI Playground & Lab</button>
                    <button id="tab-btn-voters" class="tab-btn" onclick="switchTab('voters', this)">💬 WhatsApp Web Live CRM (<span id="voter-count">0</span>)</button>
                    <button id="tab-btn-contacts" class="tab-btn" onclick="switchTab('contacts', this)">📇 Voter Contacts & VCF/CSV (<span id="contacts-count">0</span>)</button>
                    <button id="tab-btn-media" class="tab-btn" onclick="switchTab('media', this)">📸 Media Bank & Uploader</button>
                    <button id="tab-btn-bulk" class="tab-btn" type="button" data-tab="bulk">📣 Bulk Send</button>
                    <button id="tab-btn-goal" class="tab-btn" type="button" data-tab="goal">🎯 Goal & Agenda</button>
                    <button id="tab-btn-selftest" class="tab-btn" type="button" data-tab="selftest">🧪 Live Self-Test</button>
                    <button id="tab-btn-samasya" class="tab-btn" type="button" data-tab="samasya">📋 Samasya</button>
                    <button id="tab-btn-mulaqat" class="tab-btn" type="button" data-tab="mulaqat">🤝 Mulaqat</button>
                    <button id="tab-btn-plan" class="tab-btn" type="button" data-tab="plan">🗺️ Voter Plan</button>${opsRoutes.ui.tabButtons()}${statusRoutes.ui.tabButtons()}${ocRoutes.ui.tabButtons()}
                </div>

                <!-- TAB 1: Live Chat Stream (Voters Only) -->
                <div id="tab-feed" class="card tab-content">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <h3 style="margin: 0; font-size: 16px;">💬 Real-Time Incoming & Outgoing Chats</h3>
                            <span style="color: #64748b; font-size: 12px;">Real voters only • Auto-refreshing every 4s • Permanent Storage</span>
                        </div>
                        <button onclick="clearAllLogs()" style="background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">
                            🧹 Clear Feed
                        </button>
                    </div>
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 85px;">Time</th>
                                    <th style="width: 140px;">Line</th>
                                    <th style="width: 130px;">Voter</th>
                                    <th>Incoming Message</th>
                                    <th>Bot Reply Sent</th>
                                    <th style="width: 105px;">Status</th>
                                </tr>
                            </thead>
                            <tbody id="live-table-body">
                                <tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 35px;">💬 Waiting for voter messages... Real incoming chats will appear here in real time!</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- TAB: Diagnostics & Self-Test Log -->
                <div id="tab-diagnostics" class="card tab-content" style="display: none;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <h3 style="margin: 0; font-size: 16px;">🛠️ System Diagnostics & Self-Test Activity</h3>
                            <span style="color: #64748b; font-size: 12px;">Self-messages, encryption alerts & line controls</span>
                        </div>
                        <button onclick="clearAllLogs()" style="background: #ef4444; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                            🧹 Clear Diagnostics Logs
                        </button>
                    </div>

                    <!-- Line Cards Grid -->
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 15px; margin-bottom: 20px;">
                        <!-- Primary 636 -->
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <strong style="font-size: 14px; color: #0f172a;">Primary Line (6367810227)</strong>
                                <span class="badge ${SESSIONS[0].status === 'CONNECTED' ? 'badge-success' : 'badge-warning'}">
                                    ● ${SESSIONS[0].status}
                                </span>
                            </div>
                            <div style="font-size: 12px; color: #64748b; margin-bottom: 12px;">
                                Main election campaign line. If Meta FB Ads linked, disconnect Facebook in WhatsApp Business to restore direct Signal encryption.
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <a href="/scan/sim_636" target="_blank" style="flex: 1; text-align: center; background: #2563eb; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">📱 View QR</a>
                                <a href="/repair/sim_636" style="flex: 1; text-align: center; background: #0284c7; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">⚡ Quick Repair (No QR)</a>
                                <a href="/reset/sim_636" onclick="return confirm('Reset and generate fresh QR for Primary Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Full Reset</a>
                            </div>
                        </div>

                        <!-- Baba Aux -->
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <strong style="font-size: 14px; color: #0f172a;">Baba Aux Line (Secondary)</strong>
                                <span class="badge ${SESSIONS[1].status === 'CONNECTED' ? 'badge-success' : 'badge-warning'}">
                                    ● ${SESSIONS[1].status}
                                </span>
                            </div>
                            <div style="font-size: 12px; color: #64748b; margin-bottom: 12px;">
                                Dedicated secondary SIM (100% clean, no Meta Ads interference). Scan any standard WhatsApp here!
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <a href="/scan/baba_aux" target="_blank" style="flex: 1; text-align: center; background: #2563eb; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">📱 View QR</a>
                                <a href="/repair/baba_aux" style="flex: 1; text-align: center; background: #0284c7; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">⚡ Quick Repair</a>
                                <a href="/reset/baba_aux" onclick="return confirm('Reset Baba Aux Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Full Reset</a>
                            </div>
                        </div>

                        <!-- Canada Line -->
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <strong style="font-size: 14px; color: #0f172a;">Canada Line (+1 Virtual)</strong>
                                <span class="badge ${SESSIONS[2].status === 'CONNECTED' ? 'badge-success' : 'badge-warning'}">
                                    ● ${SESSIONS[2].status}
                                </span>
                            </div>
                            <div style="font-size: 12px; color: #64748b; margin-bottom: 12px;">
                                International virtual line for high-capacity broadcasts and auxiliary campaign pings.
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <a href="/scan/canada" target="_blank" style="flex: 1; text-align: center; background: #2563eb; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">📱 View QR</a>
                                <a href="/repair/canada" style="flex: 1; text-align: center; background: #0284c7; color: white; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">⚡ Quick Repair</a>
                                <a href="/reset/canada" onclick="return confirm('Reset Canada Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Full Reset</a>
                            </div>
                        </div>
                    </div>

                    <!-- Direct Send Test Tool -->
                    <div style="background: #f1f5f9; border-radius: 10px; padding: 15px; margin-bottom: 20px;">
                        <strong style="font-size: 14px; color: #0f172a; display: block; margin-bottom: 8px;">🧪 Send Direct WhatsApp Test Message</strong>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <select id="diag-line" class="input-field" style="width: auto; background: white; color: #0f172a; border: 1px solid #cbd5e1;">
                                <option value="sim_636">Primary (6367810227)</option>
                                <option value="baba_aux">Baba Aux Line</option>
                                <option value="canada">Canada Line</option>
                            </select>
                            <input type="tel" id="diag-phone" placeholder="Enter recipient mobile (e.g. 9876543210)" class="input-field" style="width: 240px; background: white; color: #0f172a; border: 1px solid #cbd5e1;">
                            <input type="text" id="diag-msg" placeholder="Test message text..." class="input-field" style="flex: 1; min-width: 200px; background: white; color: #0f172a; border: 1px solid #cbd5e1;" value="राम राम भाई जी! यह बाबा अभय सिंह जनसंपर्क का लाइव टेस्ट मैसेज है। 🚩">
                            <button onclick="sendDiagnosticTest()" style="background: #2563eb; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer;">
                                🚀 Send Test
                            </button>
                        </div>
                        <div id="diag-send-status" style="margin-top: 8px; font-size: 12px; font-weight: 600;"></div>
                    </div>

                    <!-- Diagnostics Log Table -->
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 85px;">Time</th>
                                    <th style="width: 140px;">Line</th>
                                    <th style="width: 130px;">Sender / Type</th>
                                    <th>Payload / Log Summary</th>
                                    <th style="width: 110px;">Status</th>
                                </tr>
                            </thead>
                            <tbody id="diag-table-body">
                                <tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 25px;">No system events or self-tests recorded yet.</td></tr>
                            </tbody>
                        </table>
                    </div>
                ${dashAuth.ui.pane(req)}
                </div>

                <!-- TAB 2: Live Poster Studio (Personalized Status Posters) -->
                <div id="tab-studio" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🎨 Dynamic Voter Status Poster Studio</h3>
                    <p style="color: #64748b; font-size: 14px;">Generate personalized high-resolution campaign posters with voter names on the fly. Ready for WhatsApp DP and Status stories!</p>
                    
                    <div class="studio-grid" style="margin-top: 20px;">
                        <div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                <div class="form-group">
                                    <label style="color:#334155;">Voter / Supporter Name</label>
                                    <input type="text" id="p-name" class="input-field" style="background:#f8fafc; color:#0f172a; border:1px solid #cbd5e1;" value="सत्यनारायण शर्मा" placeholder="Enter voter name">
                                </div>
                                <div class="form-group">
                                    <label style="color:#334155;">Poster Aspect Ratio</label>
                                    <select id="p-aspect" class="input-field" style="background:#f8fafc; color:#0f172a; border:1px solid #cbd5e1;">
                                        <option value="9:16">9:16 (WhatsApp Status Story - 1080x1920)</option>
                                        <option value="1:1" selected>1:1 (WhatsApp Profile DP - 1080x1080)</option>
                                        <option value="3:4">3:4 (Portrait Feed Card - 1080x1440)</option>
                                    </select>
                                </div>
                            </div>
                            <div class="form-group" style="margin-top: 15px;">
                                <label style="color:#334155;">Slogan</label>
                                <input type="text" id="p-slogan" class="input-field" style="background:#f8fafc; color:#0f172a; border:1px solid #cbd5e1;" value="सच्चा विकास, ईमानदार नेतृत्व 🚩">
                            </div>
                            <div style="margin-top: 20px; display: flex; gap: 10px;">
                                <button onclick="generatePosterPreview()" style="background:#2563eb; color:white; border:none; padding:12px 24px; border-radius:8px; font-weight:700; cursor:pointer;">
                                    ✨ Generate & Preview Poster
                                </button>
                                <button onclick="downloadPoster()" id="btn-download" style="background:#0f172a; color:white; border:none; padding:12px 20px; border-radius:8px; font-weight:700; cursor:pointer; display:none;">
                                    ⬇️ Download High-Res
                                </button>
                            </div>
                        </div>

                        <!-- Live Preview Box -->
                        <div style="text-align: center; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; background: #f8fafc;">
                            <div style="font-weight: 700; font-size: 13px; color: #64748b; margin-bottom: 10px;">Live Preview</div>
                            <img id="poster-preview-img" src="/media/poster.jpg" style="max-height: 380px; width: auto; max-width: 100%; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.15);" />
                        </div>
                    </div>
                </div>

                <!-- TAB 3: Advanced AI Playground, Vision & Agenda Lab -->
                <div id="tab-playground" class="card tab-content" style="display: none;">
                    <div style="display: grid; grid-template-columns: 1fr 380px; gap: 20px;">
                        <div>
                            <!-- Header & Context Controls -->
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;">
                                <div>
                                    <h3 style="margin: 0; font-size: 18px; color: #0f172a;">🎮 AI Playground (live testing lab)</h3>
                                    <p style="color: #64748b; font-size: 13px; margin: 4px 0 0 0;">Test a real-time voter chat, photo (vision) analysis and campaign goals live.</p>
                                </div>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <span style="font-size: 12px; font-weight: 700; color: #475569;">Model:</span>
                                    <select id="pg-provider" style="padding: 6px 10px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 12px; background: white; color: #0f172a; font-weight: 600;">
                                        <option value="cascade">⚡ Auto cascade (NVIDIA ➡️ Groq ➡️ Gemini)</option>
                                        <option value="groq">🟠 Groq Qwen (27B Ultra-Fast)</option>
                                        <option value="gemini">🔵 Gemini 3.8 Flash (Vision & Text)</option>
                                        <option value="nvidia">🟢 NVIDIA Nemotron</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Voter Simulation Context Bar -->
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; background: #f8fafc; padding: 12px; border-radius: 10px; border: 1px solid #e2e8f0; margin-bottom: 15px;">
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">👤 Voter name:</label>
                                    <input type="text" id="pg-voter-name" placeholder="e.g. Vikram Yadav" value="विक्रम यादव" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">📱 Phone number:</label>
                                    <input type="text" id="pg-voter-phone" placeholder="919876543210" value="919876543210" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">🎯 Special goal for this chat (campaign goal):</label>
                                    <input type="text" id="pg-campaign-goal" placeholder="e.g. invite to the chaupal tomorrow morning" value="कल सुबह चौपाल पर चाय पर बुलाना और बिजली सबस्टेशन की बात छेड़ना" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
                                </div>
                            </div>

                            <!-- WhatsApp Style Chat Simulator -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 12px; height: 380px; display: flex; flex-direction: column; background: #efeae2; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                                <div id="ai-chat-ui" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px;">
                                    <div class="bubble bubble-bot">
                                        राम राम विक्रम भैया! 🙏 बाबा अभय सिंह जनसंपर्क में आपका स्वागत है। बताइए भैया, घर-परिवार में सब कुशल मंगल? आज अपने मोहल्ले में क्या चुनावी माहौल लग रहा है? 😊🚩
                                    </div>
                                </div>

                                <!-- Image Preview Bar (if selected) -->
                                <div id="pg-image-preview-bar" style="display: none; padding: 6px 14px; background: #e2e8f0; font-size: 12px; color: #1e293b; align-items: center; justify-content: space-between;">
                                    <span id="pg-image-filename">📷 Photo selected</span>
                                    <button onclick="clearPlaygroundImage()" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer;">✕ Remove</button>
                                </div>

                                <!-- Input Bar -->
                                <div style="padding: 10px 14px; background: #f0f2f5; border-top: 1px solid #cbd5e1; display: flex; gap: 8px; align-items: center;">
                                    <input type="file" id="pg-file-input" accept="image/*" style="display: none;" onchange="onPlaygroundFileSelected(event)">
                                    <button onclick="document.getElementById('pg-file-input').click()" style="background: white; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 20px; font-size: 14px; cursor: pointer;" title="Upload photo (voter card, broken road, poster)">
                                        📷
                                    </button>
                                    <input type="text" id="ai-test-input" placeholder="Type a voter message (e.g. 'बिजली का क्या माहौल है', 'वोटर पर्ची चाहिए', 'दारू बांटेगा क्या')..." class="input-field" style="flex: 1; background: white; color: #0f172a; border: 1px solid #cbd5e1; border-radius: 20px; padding: 8px 16px; font-size: 13px;" onkeydown="if(event.key==='Enter') sendPlaygroundChat()">
                                    <button onclick="sendPlaygroundChat()" id="btn-pg-send" style="background: #2563eb; color: white; border: none; padding: 8px 18px; border-radius: 20px; font-weight: 700; font-size: 13px; cursor: pointer;">
                                        Send 🚀
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Right Panel: Daily Campaign Agenda, Voter Search & Diagnostics -->
                        <div style="display: flex; flex-direction: column; gap: 14px;">
                            <!-- 1. Daily Campaign Agenda & Multi-Media Drip Box -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <span style="font-weight: 700; color: #0f172a; font-size: 13px;">📢 Today's campaign agenda</span>
                                    <span style="font-size: 11px; background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 10px; font-weight: 700;">Active RAG</span>
                                </div>
                                <div style="margin-bottom: 8px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">Topic:</label>
                                    <input type="text" id="agenda-topic" style="width: 100%; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 2px; color:#0f172a;">
                                </div>
                                <div style="margin-bottom: 8px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">Talking points:</label>
                                    <textarea id="agenda-points" rows="2" style="width: 100%; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 2px; color:#0f172a; resize: vertical;"></textarea>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-size: 11px; color: #64748b;">3-4 step media drip sequence active</span>
                                    <button onclick="saveCampaignAgendaUI()" style="background: #15803d; color: white; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer;">
                                        💾 Save agenda
                                    </button>
                                </div>
                            </div>

                            <!-- 2. Fuzzy Voter Search Engine -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <div style="font-weight: 700; color: #0f172a; font-size: 13px; margin-bottom: 6px;">🔍 Smart search of 3,636 voters (typo-tolerant)</div>
                                <div style="display: flex; gap: 6px; margin-bottom: 8px;">
                                    <input type="text" id="pg-voter-search-input" placeholder="e.g. rina, pirnce, w1 45..." style="flex: 1; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; color:#0f172a;" onkeydown="if(event.key==='Enter') testPlaygroundVoterSearch()">
                                    <button onclick="testPlaygroundVoterSearch()" style="background: #2563eb; color: white; border: none; padding: 5px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer;">Search</button>
                                </div>
                                <div id="pg-voter-search-result" style="max-height: 110px; overflow-y: auto; font-size: 11px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px; color: #334155;">
                                    Search results will show here...
                                </div>
                            </div>

                            <!-- 3. Live AI Inspection Metrics -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; background: #f8fafc; font-size: 12px;">
                                <div style="font-weight: 700; color: #0f172a; margin-bottom: 6px;">⚡ Live AI debug & analysis:</div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">Provider / model:</span>
                                    <span id="pg-metric-provider" style="font-weight: 700; color: #2563eb;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">Latency:</span>
                                    <span id="pg-metric-latency" style="font-weight: 700; color: #16a34a;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">Detected tags:</span>
                                    <span id="pg-metric-tags" style="font-weight: 700; color: #d97706;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between;">
                                    <span style="color: #64748b;">Next media drip:</span>
                                    <span id="pg-metric-drip" style="font-weight: 700; color: #7c3aed;">-</span>
                                </div>
                            </div>

                            <!-- 4. Quick Sample Chips -->
                            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                                <button onclick="quickPlaygroundQuery('kon ho bhai tum')" style="background: white; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 12px; font-size: 11px; cursor: pointer;">"kon ho tum"</button>
                                <button onclick="quickPlaygroundQuery('baba ne kya kaam kiya')" style="background: white; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 12px; font-size: 11px; cursor: pointer;">"kya kaam kiya"</button>
                                <button onclick="quickPlaygroundQuery('virodhi daaru baant rahe hain')" style="background: white; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 12px; font-size: 11px; cursor: pointer;">"daaru mudda"</button>
                                <button onclick="quickPlaygroundQuery('voter parchi kaise milegi')" style="background: white; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 12px; font-size: 11px; cursor: pointer;">"parchi"</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB 4: WhatsApp Web Replica Master Dashboard -->
                <div id="tab-voters" class="card tab-content" style="display: none; padding: 0; overflow: hidden; border: none;">
                    <div class="wa-wrapper">
                        <!-- Left Contacts Sidebar -->
                        <div class="wa-left">
                            <div class="wa-left-header">
                                <div>
                                    <h3 style="margin: 0; font-size: 14px; color: #0f172a; font-weight: 700;">💬 Voter chat room</h3>
                                    <span style="font-size: 11px; color: #64748b;">WhatsApp Web Replica • Ground CRM</span>
                                </div>
                                <button onclick="toggleDemoPosterMode()" id="demo-mode-badge" style="font-size: 11px; padding: 3px 8px; border-radius: 12px; border: 1px solid #16a34a; background: #dcfce7; color: #15803d; font-weight: 700; cursor: pointer;">
                                    🖼️ Poster mode…
                                </button>
                            </div>
                            <div class="wa-search-bar">
                                <select id="crm-line-filter" onchange="applyVoterFilters()" style="width:100%;margin-bottom:7px;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:white;color:#0f172a;font-size:12px;">
                                    <option value="all">All WhatsApp lines</option>
                                    <option value="sim_636">Primary (6367810227)</option>
                                    <option value="baba_aux">Baba Aux line</option>
                                    <option value="canada">Canada line (+1)</option>
                                </select>
                                <select id="crm-stage-filter" style="width:100%;margin-bottom:7px;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:white;color:#0f172a;font-size:12px;">
                                    <option value="all">All persuasion stages</option>
                                    <option value="unknown">⚪ Unknown</option>
                                    <option value="undecided">🟡 Undecided</option>
                                    <option value="leaning">🟢 Leaning</option>
                                    <option value="committed">✅ Committed (sure vote)</option>
                                    <option value="opposed">🔴 Opposed</option>
                                    <option value="needsAdmin">🚩 Needs admin</option>
                                </select>
                                <input type="text" id="voter-search" placeholder="🔍 Search by name, phone or tag..." style="width: 100%; padding: 8px 12px; border-radius: 16px; border: 1px solid #cbd5e1; font-size: 13px; outline: none; background: #f8fafc; color: #0f172a;" oninput="filterVoters(this.value)">
                            </div>
                            <!-- 17 Smart Filter Chips -->
                            <div class="wa-filter-chips">
                                <span class="filter-chip active" onclick="applyTagFilter('ALL', this)">All (<span id="voter-count-badge">0</span>)</span>
                                <span class="filter-chip" onclick="applyTagFilter('🟢 पक्का समर्थक', this)">🟢 Supporters</span>
                                <span class="filter-chip" onclick="applyTagFilter('🟡 सोच विचार', this)">🟡 Undecided</span>
                                <span class="filter-chip" onclick="applyTagFilter('🔴 विरोधी / नाराज', this)">🔴 Opponents (virodhi)</span>
                                <span class="filter-chip" onclick="applyTagFilter('📝 काम की शिकायत', this)">📝 Complaints</span>
                                <span class="filter-chip" onclick="applyTagFilter('📢 चुनावी माहौल', this)">📢 Ground mood (mahool)</span>
                                <span class="filter-chip" onclick="applyTagFilter('👨‍👩‍👧 परिवार विवरण', this)">👨‍👩‍👧 Family</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚩 युवा टीम', this)">🚩 Youth team</span>
                                <span class="filter-chip" onclick="applyTagFilter('🌾 किसान व पशुपालक', this)">🌾 Farmers</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚆 प्रवासी मतदाता', this)">🚆 Migrants (pravasi)</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚨 धांधली अलर्ट', this)">🚨 Rigging alert</span>
                                <span class="filter-chip" onclick="applyTagFilter('👵 बुजुर्ग व पेंशन', this)">👵 Elderly</span>
                                <span class="filter-chip" onclick="applyTagFilter('👩‍🦰 महिला शक्ति', this)">👩‍🦰 Women</span>
                                <span class="filter-chip" onclick="applyTagFilter('📜 संकल्प पत्र', this)">📜 Pledge (sankalp)</span>
                                <span class="filter-chip" onclick="applyTagFilter('🤝 सीधी मुलाकात', this)">🤝 Meetings (mulaqat)</span>
                                <span class="filter-chip" onclick="applyTagFilter('🎫 वोटर पर्ची', this)">🎫 Slips (parchi)</span>
                                <span class="filter-chip" onclick="applyTagFilter('MANUAL', this)">⏸️ Manual</span>
                            </div>
                            <div class="wa-contacts-list" id="voter-list-ui">
                                <div style="padding: 30px; text-align: center; color: #94a3b8;">Loading...</div>
                            </div>
                        </div>

                        <!-- Right WhatsApp Chat Conversation -->
                        <div class="wa-right">
                            <!-- Chat Top Bar -->
                            <div class="wa-header" id="wa-chat-header" style="display: none;">
                                <div style="display: flex; gap: 12px; align-items: center;">
                                    <div class="wa-avatar" id="header-avatar" style="width: 38px; height: 38px; font-size: 14px;">👤</div>
                                    <div>
                                        <div style="font-weight: 700; font-size: 14px; color: #0f172a;" id="header-name">Voter Name</div>
                                        <div style="font-size: 12px; color: #64748b;" id="header-details">+91 00000 00000 • Ward: --</div>
                                    </div>
                                </div>

                                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                    <!-- AutoPilot AI Toggle Button -->
                                    <button id="btn-toggle-autopilot" onclick="toggleCurrentAutoPilot()" style="padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 700; border: none; cursor: pointer; background: #16a34a; color: white;">
                                        🤖 AutoPilot AI: ON
                                    </button>

                                    <!-- Sentiment Dropdown -->
                                    <select id="voter-sentiment-select" onchange="updateVoterSentiment(this.value)" style="padding: 5px 8px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 600; background: white; color: #0f172a;">
                                        <option value="positive">🟢 Sure supporter</option>
                                        <option value="swing">🟡 Undecided / thinking</option>
                                        <option value="critical">🔴 Opponent / upset</option>
                                        <option value="neutral">⚪ Normal contact</option>
                                    </select>

                                    <button type="button" onclick="crmToggleProfile()" id="btn-crm-profile" style="padding: 6px 10px; border-radius: 8px; border: 1px solid #6366f1; background: #eef2ff; font-size: 12px; font-weight: 700; cursor: pointer; color: #4338ca;">🧾 Profile & memory</button>
                                    <!-- Toggle Intelligence Notes Drawer -->
                                    <button onclick="toggleIntelDrawer()" style="padding: 6px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 12px; font-weight: 600; cursor: pointer; color: #0f172a;">
                                        📋 Voter notes & tags
                                    </button>
                                </div>
                            </div>

                            <!-- Collapsible Voter Intelligence & Memory Drawer -->
                            <div class="wa-intel-bar" id="wa-intel-drawer">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <h4 style="margin: 0; font-size: 13px; color: #0f172a;">🧠 Voter memory, tags & ground intel</h4>
                                    <button onclick="toggleIntelDrawer()" style="background: none; border: none; font-size: 14px; cursor: pointer; color: #64748b;">✕</button>
                                </div>

                                <!-- Active Tags -->
                                <div style="margin-bottom: 10px;">
                                    <span style="font-size: 11px; font-weight: 700; color: #64748b; margin-right: 6px;">Active tags:</span>
                                    <span id="active-tags-container"></span>
                                    <select id="add-tag-select" onchange="addTagToCurrentVoter(this.value)" style="padding: 2px 6px; font-size: 11px; border-radius: 6px; border: 1px solid #cbd5e1; margin-left: 6px; background:white; color:#0f172a;">
                                        <option value="">+ Add new tag...</option>
                                        <option value="🟢 पक्का समर्थक">🟢 Sure supporter</option>
                                        <option value="🟡 सोच विचार">🟡 Thinking / undecided</option>
                                        <option value="🔴 विरोधी / नाराज">🔴 Opponent / upset</option>
                                        <option value="👨‍👩‍👧 परिवार विवरण">👨‍👩‍👧 Family details</option>
                                        <option value="📢 चुनावी माहौल">📢 Election mood</option>
                                        <option value="📝 काम की शिकायत">📝 Work complaint</option>
                                        <option value="🎫 वोटर पर्ची जारी">🎫 Voter slip given</option>
                                        <option value="🤝 सीधी मुलाकात">🤝 Direct meeting (mulaqat)</option>
                                        <option value="🚩 युवा टीम">🚩 Youth team</option>
                                        <option value="🌾 किसान व पशुपालक">🌾 Farmer / livestock</option>
                                        <option value="👵 बुजुर्ग व पेंशन">👵 Elderly / pension</option>
                                        <option value="👩‍🦰 महिला शक्ति">👩‍🦰 Women</option>
                                        <option value="🚨 धांधली अलर्ट">🚨 Rigging alert</option>
                                        <option value="📜 संकल्प पत्र">📜 Pledge letter (sankalp)</option>
                                        <option value="🚆 प्रवासी मतदाता">🚆 Migrant voter</option>
                                    </select>
                                </div>

                                <!-- Notes Form -->
                                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;">
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">👨‍👩‍👧 Family info</label>
                                        <input type="text" id="intel-family" placeholder="e.g. 5 votes, uncle is with us..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">📢 Ground mood & talk (mahool)</label>
                                        <input type="text" id="intel-mahool" placeholder="e.g. good mood in ward, opponents are talking about..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">📝 Baba Abhay Singh priority register</label>
                                        <input type="text" id="intel-baba" placeholder="e.g. promise to fix the street drain..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                </div>
                                <div style="margin-top: 10px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">🎯 Special goal for chats with this voter (campaign goal)</label>
                                    <input type="text" id="intel-goal" placeholder="e.g. invite to chaupal tomorrow morning, explain the water fix, calm ward 3 anger..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                </div>
                                <div style="text-align: right; margin-top: 8px;">
                                    <button onclick="saveVoterIntelligence()" style="background: #2563eb; color: white; border: none; padding: 5px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                        💾 Save Notes & Intelligence
                                    </button>
                                    <span id="intel-save-status" style="font-size: 11px; font-weight: 600; color: #16a34a; margin-left: 8px; display: none;">✅ Saved!</span>
                                </div>
                            </div>

                            <div class="crm-profile" id="crm-profile-panel" style="display: none;"></div>
                            <!-- Messages Stream -->
                            <div class="wa-chat-scroll" id="wa-chat-scroll">
                                <div style="text-align: center; color: #8696a0; margin-top: 180px;">
                                    <div style="font-size: 44px; margin-bottom: 10px;">💬</div>
                                    <div style="font-weight: 700; font-size: 16px; color: #334155;">Welcome to the voter chat room</div>
                                    <p style="font-size: 13px; max-width: 420px; margin: 6px auto 0 auto; color: #64748b;">Click any voter on the left. You can see their full chat, talk to them directly, or let AutoPilot handle it.</p>
                                </div>
                            </div>

                            <!-- Quick Action Bar -->
                            <div class="wa-quick-actions" id="wa-quick-actions" style="display: none;">
                                <button type="button" class="wa-action-btn" id="qa-card" style="background: #0284c7; color: white; border-color: #0369a1; font-weight: 700;" onclick="sendQuickAction('contact_card')">📇 Contact card (anti-ban)</button>
                                <button type="button" class="wa-action-btn" id="qa-ramram" onclick="sendQuickAction('ramram')">🙏 Ram Ram greeting</button>
                                <button type="button" class="wa-action-btn" id="qa-poster" onclick="sendQuickAction('poster')">📸 Send poster (approved)</button>
                                <button type="button" class="wa-action-btn" id="qa-video" onclick="sendQuickAction('video')">📹 3D video reel</button>
                                <button type="button" class="wa-action-btn" id="qa-slip" onclick="sendQuickAction('slip')">🎫 Get voter slip</button>
                                <button type="button" class="wa-action-btn" id="qa-register" onclick="sendQuickAction('baba_register')">📝 Add to Baba register</button>
                                <button type="button" class="wa-action-btn" id="qa-meeting" onclick="sendQuickAction('meeting')">🤝 Chaupal meeting</button>
                            </div>

                            <!-- AI Co-pilot: reads the full chat + voter memory, suggests the best next reply (validated) -->
                            <div id="wa-copilot-container" class="crm-copilot">
                                <div class="crm-copilot-row">
                                    <span style="font-size: 12px; font-weight: 700; color: #6366f1; white-space: nowrap;">✨ AI co-pilot</span>
                                    <input type="text" id="wa-ai-instruction" placeholder="Optional instruction (e.g. 'invite to chaupal') — leave empty for the next best reply" onkeydown="if(event.key==='Enter') crmSuggest(false)">
                                    <button type="button" class="crm-btn" id="crm-cp-suggest" onclick="crmSuggest(false)">✨ Suggest</button>
                                </div>
                                <div id="crm-cp-info" style="font-size: 11px; color: #5b21b6;"></div>
                                <textarea id="crm-suggestion" style="display: none;"></textarea>
                                <div class="crm-copilot-row" id="crm-cp-actions" style="display: none;">
                                    <button type="button" class="crm-btn go" id="crm-cp-send" onclick="crmSendSuggestion()">📤 Send</button>
                                    <button type="button" class="crm-btn alt" id="crm-cp-again" onclick="crmSuggest(true)">🔁 Another suggestion</button>
                                </div>
                            </div>

                            <!-- Instruction mode: operator's short Hinglish instruction -> natural Hindi message (safety-filtered, parcha facts only) -->
                            <div id="wa-instr-container" class="crm-copilot" style="background:#fff7ed;border-top:1px solid #fed7aa;">
                                <div class="crm-copilot-row">
                                    <span style="font-size: 12px; font-weight: 700; color: #c2410c; white-space: nowrap;">🧭 Instruction</span>
                                    <input type="text" id="crm-instr-input" maxlength="400" placeholder="e.g. isko paani ki tanki ke baare me bata do" style="border-color:#fdba74;" onkeydown="if(event.key==='Enter') crmInstrDraft()">
                                    <button type="button" class="crm-btn" id="crm-instr-draft" style="background:#ea580c;" onclick="crmInstrDraft()">✍️ Draft &amp; send now</button>
                                    <button type="button" class="crm-btn alt" id="crm-instr-pending" style="color:#c2410c;border-color:#fdba74;" onclick="crmInstrPending()">⏭️ Use in next reply</button>
                                </div>
                                <div id="crm-instr-info" style="font-size: 11.5px; color: #9a3412;"></div>
                                <textarea id="crm-instr-draft-box" style="display:none;width:100%;box-sizing:border-box;min-height:58px;padding:8px 10px;border-radius:10px;border:1px solid #fdba74;font-size:13px;background:#fff;color:#0f172a;resize:vertical;"></textarea>
                                <div class="crm-copilot-row" id="crm-instr-actions" style="display:none;">
                                    <button type="button" class="crm-btn go" id="crm-instr-send" onclick="crmInstrSend()">📤 Send</button>
                                    <span style="font-size:11px;color:#64748b;">You can edit the text before sending. Sent from this voter's line.</span>
                                </div>
                                <div class="crm-copilot-row" id="crm-instr-status" style="font-size:11.5px;color:#334155;"></div>
                            </div>

                            <!-- Chat Direct Input Bar -->
                            <div class="wa-input-container" id="wa-input-container" style="display: none;">
                                <input type="text" id="wa-direct-input" class="wa-input-field" placeholder="Type a direct WhatsApp message (press Enter or click Send)..." onkeydown="if(event.key==='Enter') sendManualWhatsAppReply()">
                                <button class="wa-send-btn" onclick="sendManualWhatsAppReply()" title="Send WhatsApp Message">➤</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB: Voter Contacts & VCF/CSV Manager -->
                <div id="tab-contacts" class="card tab-content" style="display: none;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <h3 style="margin: 0; font-size: 16px;">📇 Voter Contacts & VCF/CSV Manager</h3>
                            <span style="color: #64748b; font-size: 12px;">Saved contacts for Primary (6367810227), Baba Account, and Canada Line (+1) • Import & Export VCF/CSV</span>
                        </div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <a href="/api/contacts/export-vcf" download="sihali_voter_contacts.vcf" style="background: #16a34a; color: white; border: none; padding: 7px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 5px;">
                                📲 Export to VCF (Mobile Contacts)
                            </a>
                            <a href="/api/contacts/export-csv" download="sihali_voter_contacts.csv" style="background: #0284c7; color: white; border: none; padding: 7px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 5px;">
                                📊 Export to CSV
                            </a>
                            <a href="/api/export/dialer.csv?source=contacts" download style="background: #7c3aed; color: white; border: none; padding: 7px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 5px;" title="name, phone_10, phone_91, ward, village — opted-out excluded">
                                📞 Dialer/IVR CSV
                            </a>
                            <a href="/api/contacts/export-vcf?line=sim_636" download="contacts_sim_636.vcf" style="background:#334155;color:white;padding:7px 10px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;">📲 VCF Primary</a>
                            <a href="/api/contacts/export-vcf?line=baba_aux" download="contacts_baba_aux.vcf" style="background:#334155;color:white;padding:7px 10px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;">📲 VCF Baba Aux</a>
                            <a href="/api/contacts/export-vcf?line=canada" download="contacts_canada.vcf" style="background:#334155;color:white;padding:7px 10px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;">📲 VCF Canada</a>
                        </div>
                    </div>

                    <!-- Quick Action Toolbars -->
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
                        <!-- Import from Voter DB -->
                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                            <span style="font-size: 12px; font-weight: 700; color: #334155;">📥 Import from 3,636 voter list:</span>
                            <select id="import-ward-select" style="padding: 5px 8px; font-size: 12px; border-radius: 6px; border: 1px solid #cbd5e1; background: white;">
                                <option value="all">All wards (1-11)</option>
                                <option value="1">Ward No. 1</option>
                                <option value="2">Ward No. 2</option>
                                <option value="3">Ward No. 3</option>
                                <option value="4">Ward No. 4</option>
                                <option value="5">Ward No. 5</option>
                                <option value="6">Ward No. 6</option>
                                <option value="7">Ward No. 7</option>
                                <option value="8">Ward No. 8</option>
                                <option value="9">Ward No. 9</option>
                                <option value="10">Ward No. 10</option>
                                <option value="11">Ward No. 11</option>
                            </select>
                            <select id="import-line-select" style="padding: 5px 8px; font-size: 12px; border-radius: 6px; border: 1px solid #cbd5e1; background: white;">
                                <option value="sim_636">Primary Line (6367810227)</option>
                                <option value="baba_aux">Baba Aux Line</option>
                                <option value="canada">Canada Line (+1)</option>
                            </select>
                            <button onclick="importVotersToContacts()" style="background: #ea580c; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                📥 Import
                            </button>
                        </div>

                        <!-- Direct Upload CSV / VCF -->
                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                            <span style="font-size: 12px; font-weight: 700; color: #334155;">📂 Upload VCF / CSV file:</span>
                            <input type="file" id="vcf-upload-input" accept=".vcf,.csv,.xlsx,.txt" style="font-size: 12px;">
                            <button onclick="uploadContactsFile()" style="background: #2563eb; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                ⬆️ Upload
                            </button>
                        </div>
                    </div>

                    <!-- Add Single Contact Form (Collapsible/Inline) -->
                    <div style="background: white; border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 16px;">
                        <h4 style="margin: 0 0 10px 0; font-size: 13px; color: #0f172a;">➕ Add a new contact directly</h4>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
                            <input type="text" id="new-c-name" placeholder="Voter name (e.g. Rajesh Yadav)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <input type="text" id="new-c-phone" placeholder="Mobile number (10 digits)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <select id="new-c-ward" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                                <option value="1">Ward No. 1</option>
                                <option value="2">Ward No. 2</option>
                                <option value="3" selected>Ward No. 3</option>
                                <option value="4">Ward No. 4</option>
                                <option value="5">Ward No. 5</option>
                                <option value="6">Ward No. 6</option>
                                <option value="7">Ward No. 7</option>
                                <option value="8">Ward No. 8</option>
                                <option value="9">Ward No. 9</option>
                                <option value="10">Ward No. 10</option>
                                <option value="11">Ward No. 11</option>
                            </select>
                            <select id="new-c-line" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                                <option value="sim_636">Primary Line (6367810227)</option>
                                <option value="baba_aux">Baba Aux Line</option>
                                <option value="canada">Canada Line (+1)</option>
                            </select>
                            <input type="text" id="new-c-notes" placeholder="Notes (e.g. sure supporter, 4 votes)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <button onclick="saveSingleContact()" style="background: #16a34a; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                💾 Save
                            </button>
                        </div>
                    </div>

                    <!-- Filter & Search Bar -->
                    <div style="display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap;">
                        <input type="text" id="contact-search-input" placeholder="🔍 Search by name or phone..." onkeyup="filterContactsTable()" style="flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
                        <select id="contact-filter-line" onchange="loadContacts()" style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; background: white;">
                            <option value="all">All lines (all WhatsApp)</option>
                            <option value="sim_636">Primary (6367810227)</option>
                            <option value="baba_aux">Baba Aux Line</option>
                            <option value="canada">Canada Line (+1)</option>
                        </select>
                        <select id="contact-filter-ward" onchange="loadContacts()" style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; background: white;">
                            <option value="all">All wards (1-11)</option>
                            <option value="1">Ward 1</option>
                            <option value="2">Ward 2</option>
                            <option value="3">Ward 3</option>
                            <option value="4">Ward 4</option>
                            <option value="5">Ward 5</option>
                            <option value="6">Ward 6</option>
                            <option value="7">Ward 7</option>
                            <option value="8">Ward 8</option>
                            <option value="9">Ward 9</option>
                            <option value="10">Ward 10</option>
                            <option value="11">Ward 11</option>
                        </select>
                    </div>

                    <!-- Contacts Table -->
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 40px;"><input type="checkbox" id="select-all-contacts" onclick="toggleSelectAllContacts(this)"></th>
                                    <th>Voter name</th>
                                    <th>Phone number</th>
                                    <th>Ward</th>
                                    <th>WhatsApp line</th>
                                    <th>Notes / identity</th>
                                    <th style="width: 140px;">Action</th>
                                </tr>
                            </thead>
                            <tbody id="contacts-table-body">
                                <tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 30px;">⏳ Loading contacts...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- TAB 5: Media Bank & Direct Uploader -->
                <div id="tab-media" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📸 Campaign Media Bank & Mobile Uploader</h3>
                    <!-- One-click Media Bank upload (image / video / pdf) -->
                    <div id="hm-drop" style="border: 2px dashed #94a3b8; border-radius: 12px; padding: 18px; text-align: center; margin-bottom: 16px; background: #f8fafc; cursor: pointer;">
                        <div style="font-size: 28px;">📤</div>
                        <div style="font-weight: 800;">Drop photo / video / PDF here or tap to choose</div>
                        <div style="font-size: 11px; color: #64748b;">Max 45 MB • shows up in the list below right away; you can use it in Bulk Send and the agenda</div>
                        <input type="file" id="hm-file" accept="image/*,video/*,application/pdf" multiple style="display:none;">
                        <div id="hm-status" style="margin-top: 8px; font-size: 13px; font-weight: 600;"></div>
                    </div>
                    <div id="hm-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px;"></div>

                    <div style="background:#ffffff; border:1px solid #cbd5e1; border-radius:12px; padding:16px; margin-bottom:18px;">
                        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap;">
                            <h4 style="margin:0; color:#0f172a;">Daily Goal & Operations</h4>
                            <span id="ops-summary" style="font-size:12px; color:#475569;">Loading status...</span>
                        </div>
                        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-top:12px;">
                            <input id="daily-goal-title" class="input-field" placeholder="Daily goal title" style="background:white;color:#0f172a;border:1px solid #cbd5e1;">
                            <input id="daily-goal-target" type="number" min="0" class="input-field" placeholder="Target contacts" style="background:white;color:#0f172a;border:1px solid #cbd5e1;">
                            <input id="daily-goal-completed" type="number" min="0" class="input-field" placeholder="Completed" style="background:white;color:#0f172a;border:1px solid #cbd5e1;">
                        </div>
                        <textarea id="daily-goal-instruction" rows="2" placeholder="Assistance focus for today" style="width:100%;margin-top:10px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;"></textarea>
                        <button onclick="saveDailyGoalUI()" style="margin-top:10px;background:#2563eb;color:white;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;">Save Daily Goal</button>
                        <span id="daily-goal-status" style="margin-left:10px;font-size:12px;color:#475569;"></span>
                        <div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:14px;">
                            <h4 style="margin:0 0 8px;color:#0f172a;">Verified Facts & Talking Pattern</h4>
                            <textarea id="campaign-verified-facts" rows="6" placeholder="Paste one verified fact per line. The bot will not invent missing details." style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;"></textarea>
                            <textarea id="campaign-talking-style" rows="4" placeholder="Describe the natural talking pattern, tone, word length, and phrases to avoid." style="width:100%;margin-top:8px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;"></textarea>
                            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
                                <input id="campaign-facts-file" type="file" accept=".txt,.md,.json,.csv" style="font-size:12px;">
                                <select id="campaign-facts-import-mode" style="padding:7px;border:1px solid #cbd5e1;border-radius:7px;">
                                    <option value="replace">Replace old facts</option>
                                    <option value="append">Add to existing facts</option>
                                </select>
                                <button onclick="uploadCampaignFactsFile()" style="background:#0f766e;color:white;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;">One-click Facts Upload</button>
                            </div>
                            <button onclick="saveCampaignProfileUI()" style="margin-top:8px;background:#7c3aed;color:white;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;">Save Facts & Style</button>
                            <span id="campaign-profile-status" style="margin-left:10px;font-size:12px;color:#475569;"></span>
                        </div>
                    </div>
                    <!-- Daily Media Drip Schedule (4 Active Slots) -->
                    <div style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px 0; color: #0f172a;">⏰ Daily 4-slot automatic schedule (drip slots)</h4>
                        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin-bottom:12px;">
                            <label style="font-size:12px;">Morning <input id="schedule-morning-start" type="time"> to <input id="schedule-morning-end" type="time"></label>
                            <label style="font-size:12px;">Afternoon <input id="schedule-dopahar-start" type="time"> to <input id="schedule-dopahar-end" type="time"></label>
                            <label style="font-size:12px;">Evening <input id="schedule-evening-start" type="time"> to <input id="schedule-evening-end" type="time"></label>
                            <label style="font-size:12px;">Night <input id="schedule-night-start" type="time"> to <input id="schedule-night-end" type="time"></label>
                        </div>
                        <button onclick="saveCampaignAgendaUI()" style="margin-bottom:12px;background:#15803d;color:white;border:0;border-radius:7px;padding:7px 12px;font-weight:700;cursor:pointer;">Save Media Times</button>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #ea580c; font-size: 13px;">🌅 Morning slot</div>
                                <div style="font-size: 11px; color: #64748b;">08:30 AM - 10:30 AM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">Daily agenda poster + mood hook</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #0284c7; font-size: 13px;">☀️ Afternoon slot</div>
                                <div style="font-size: 11px; color: #64748b;">01:30 PM - 03:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">Development work fact report card</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #16a34a; font-size: 13px;">🌇 Evening slot</div>
                                <div style="font-size: 11px; color: #64748b;">05:30 PM - 07:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">Pledge (sankalp) & status poster</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #7c3aed; font-size: 13px;">🌙 Night slot</div>
                                <div style="font-size: 11px; color: #64748b;">08:00 PM - 09:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">3D development pledge video reel</div>
                            </div>
                        </div>
                    </div>
                    <p style="color: #64748b; font-size: 14px;">Upload new campaign photos or videos directly from your mobile gallery or PC. Updates the bot instantly!</p>
                    
                    <!-- Direct Uploader Box -->
                    <div style="background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; padding: 20px; margin-bottom: 25px; text-align: center;">
                        <h4 style="margin: 0 0 10px 0;">📤 Upload Media from Device</h4>
                        <div style="display: flex; gap: 15px; justify-content: center; align-items: center; flex-wrap: wrap;">
                            <input type="file" id="media-file-input" accept="image/*,video/mp4" style="font-size: 14px;">
                            <select id="media-target-select" class="input-field" style="width: auto; background: white; color: #0f172a; border: 1px solid #cbd5e1;">
                                <option value="poster.jpg">Campaign Poster (poster.jpg)</option>
                                <option value="campaign_reel.mp4">Campaign Video Reel (campaign_reel.mp4)</option>
                            </select>
                            <button onclick="uploadMediaFile()" style="background: #16a34a; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 700; cursor: pointer;">
                                ⬆️ Upload to Cloud
                            </button>
                        </div>
                        <div id="upload-status" style="margin-top: 10px; font-weight: 600; font-size: 13px;"></div>
                    </div>

                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px;">
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; text-align: center;">
                            <img src="/media/poster.jpg?t=${Date.now()}" id="poster-asset-img" style="max-height: 200px; border-radius: 8px; margin-bottom: 10px;" />
                            <div style="font-weight: 700;">Official Campaign Poster</div>
                            <div style="font-size: 12px; color: #64748b; margin-bottom: 10px;">Triggered by: "photo", "poster", "tasveer"</div>
                            <a href="/media/poster.jpg" target="_blank" style="color: #2563eb; font-size: 13px; font-weight: 600;">Open High-Res Poster →</a>
                        </div>
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; text-align: center;">
                            <div style="height: 200px; display: flex; align-items:center; justify-content:center; background:#0f172a; border-radius:8px; margin-bottom: 10px; color:white; font-size: 32px;">
                                📹
                            </div>
                            <div style="font-weight: 700;">3D Campaign Video Reel (MP4)</div>
                            <div style="font-size: 12px; color: #64748b; margin-bottom: 10px;">Triggered by: "video", "reel"</div>
                            <a href="/media/campaign_reel.mp4" target="_blank" style="color: #2563eb; font-size: 13px; font-weight: 600;">Play Campaign Video Reel →</a>
                        </div>
                    </div>
                </div>

                <!-- ===== Bulk Send Tab (broadcast_engine.js) ===== -->
                <div id="tab-bulk" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📣 Bulk Send (Safe Broadcast)</h3>
                    <div style="font-size: 12px; color: #64748b; margin-bottom: 14px;">20-60 second gap on each line, hourly/daily limits, paused from 9 pm to 8 am, never sent to anyone who wrote STOP/बंद/रुको. Only send to people who gave permission to contact them.</div>

                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                            <h4 style="margin: 0 0 8px 0;">1️⃣ Audience</h4>
                            <label style="font-size: 12px; font-weight: 700;">Paste numbers (one per line: phone, name, ward, village)</label>
                            <textarea id="bulk-phones" rows="6" style="width: 100%; box-sizing: border-box; font-size: 13px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;" placeholder="9876543210, Ram Lal, 5, Sihali Khurd&#10;+91 98290 12345"></textarea>
                            <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                                <label style="font-size: 12px; font-weight: 700;">📄 CSV upload:</label>
                                <input type="file" id="bulk-csv-file" accept=".csv,.txt,text/csv" style="font-size: 12px;">
                                <span id="bulk-csv-info" style="font-size: 12px; color: #0369a1;"></span>
                                <button type="button" id="bulk-csv-clear" data-action="csv-clear" style="display:none; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid #cbd5e1; background: white; cursor: pointer;">✕ Remove CSV</button>
                            </div>
                            <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Columns: phone/mobile/number, name, ward, village (any order, header optional). +91, spaces, 0 and 10-digit numbers are all fine.</div>
                            <div style="margin-top: 10px; padding: 8px; background: #f8fafc; border-radius: 6px;">
                                <label style="font-size: 12px; font-weight: 700;"><input type="checkbox" id="bulk-use-contacts"> 📇 Saved contacts also</label>
                                <span style="font-size: 12px;"> — ward <input id="bulk-contact-ward" style="width: 50px; font-size: 12px;" placeholder="all"> village <input id="bulk-contact-village" style="width: 110px; font-size: 12px;" placeholder="all"></span>
                            </div>
                            <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                                <label style="font-size: 12px;"><input type="checkbox" id="bulk-save-contacts" checked> Save pasted/CSV numbers to Contacts</label>
                                <button type="button" data-action="save-contacts" style="font-size: 12px; padding: 5px 10px; border-radius: 6px; border: none; background: #0f766e; color: white; font-weight: 700; cursor: pointer;">💾 Save to Contacts now</button>
                            </div>
                        </div>

                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                            <h4 style="margin: 0 0 8px 0;">2️⃣ Message</h4>
                            <textarea id="bulk-message" rows="6" style="width: 100%; box-sizing: border-box; font-size: 13px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;" placeholder="{राम राम|नमस्ते} {name}! 🙏 ..."></textarea>
                            <div style="font-size: 11px; color: #64748b;">{name} = recipient name • {राम राम|नमस्ते} = random choice per person, so no two messages are identical.</div>
                            <div style="margin-top: 8px; font-size: 12px;">
                                <label style="font-weight: 700;">🗓️ Fill from today's agenda slot:</label>
                                <select id="bulk-agenda-slot" style="font-size: 12px; padding: 3px;"><option value="">—</option><option value="morning">🌅 Morning</option><option value="dopahar">☀️ Afternoon</option><option value="evening">🌇 Evening</option><option value="night">🌙 Night</option></select>
                            </div>
                            <div style="margin-top: 8px;">
                                <label style="font-size: 12px; font-weight: 700;">🖼️ Media (optional):</label>
                                <select id="bulk-media" style="font-size: 12px; padding: 4px; max-width: 220px;"><option value="">— text only —</option></select>
                            </div>
                            <div style="margin-top: 10px; font-size: 12px; font-weight: 700;">Preview:</div>
                            <div id="bulk-preview" style="white-space: pre-wrap; background: #dcf8c6; border-radius: 8px; padding: 8px; font-size: 13px; min-height: 40px;"></div>
                            <div id="bulk-preview-counts" style="font-size: 12px; color: #334155; margin-top: 6px;"></div>
                            <button type="button" data-action="preview" style="margin-top: 6px; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid #cbd5e1; background: white; cursor: pointer;">🔍 Check audience & preview</button>
                        </div>

                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                            <h4 style="margin: 0 0 8px 0;">3️⃣ Lines & Safety Caps</h4>
                            <div id="outbound-settings" style="border: 1px dashed #94a3b8; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; background: #f8fafc;">
                                <div style="font-weight: 800; margin-bottom: 4px;">🔒 Outbound rules (saved on the server)</div>
                                <label style="display: block; margin: 3px 0;"><input type="checkbox" id="ob-proactive" onchange="saveOutboundSettings()"> <b>Proactive outbound</b> (bot starts chats on its own: follow-ups, nudges, consent reminders) — <span id="ob-proactive-state">OFF</span></label>
                                <label style="display: block; margin: 3px 0;"><input type="checkbox" id="ob-quiet" onchange="saveOutboundSettings()"> <b>Quiet hours for Bulk Send</b> (no bulk sends 21:00–08:00 IST; replies always go) — <span id="ob-quiet-state">OFF</span></label>
                                <div style="color: #64748b;">Replies to incoming messages and the sends you trigger here always work.</div>
                            </div>

                            <div id="bulk-lines" style="font-size: 13px;">Loading lines…</div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; font-size: 12px;">
                                <label>Per line / hour <input type="number" id="bulk-hourly" value="60" min="1" max="200" style="width: 60px;"></label>
                                <label>Per line / day <input type="number" id="bulk-daily" value="250" min="1" max="1000" style="width: 60px;"></label>
                                <label>Min delay (s) <input type="number" id="bulk-min-delay" value="20" min="10" max="600" style="width: 60px;"></label>
                                <label>Max delay (s) <input type="number" id="bulk-max-delay" value="60" min="10" max="1800" style="width: 60px;"></label>
                                <label>Quiet from (IST h) <input type="number" id="bulk-quiet-start" value="21" min="0" max="23" style="width: 50px;"></label>
                                <label>Quiet until (IST h) <input type="number" id="bulk-quiet-end" value="8" min="0" max="23" style="width: 50px;"></label>
                            </div>
                            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px;">
                                <button type="button" data-action="start" style="padding: 8px 14px; border-radius: 6px; border: none; background: #16a34a; color: white; font-weight: 800; cursor: pointer;">▶️ Start</button>
                                <button type="button" data-action="pause" style="padding: 8px 14px; border-radius: 6px; border: none; background: #f59e0b; color: white; font-weight: 800; cursor: pointer;">⏸️ Pause</button>
                                <button type="button" data-action="resume" style="padding: 8px 14px; border-radius: 6px; border: none; background: #2563eb; color: white; font-weight: 800; cursor: pointer;">⏯️ Resume</button>
                                <button type="button" data-action="cancel" style="padding: 8px 14px; border-radius: 6px; border: none; background: #dc2626; color: white; font-weight: 800; cursor: pointer;">⏹️ Cancel</button>
                            </div>
                            <div id="bulk-action-status" style="margin-top: 8px; font-size: 13px; font-weight: 600;"></div>
                        </div>
                    </div>

                    <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-top: 16px;">
                        <h4 style="margin: 0 0 8px 0;">📊 Live Progress</h4>
                        <div id="bulk-progress-summary" style="font-size: 14px;">No broadcast yet.</div>
                        <div style="background: #e2e8f0; border-radius: 6px; height: 12px; margin: 8px 0; overflow: hidden;"><div id="bulk-progress-bar" style="background: #16a34a; height: 12px; width: 0%;"></div></div>
                        <a id="bulk-results-link" href="/api/broadcast/results.csv" download style="font-size: 12px; font-weight: 700; color: #0284c7;">⬇️ Download results CSV</a>
                        <div class="table-responsive" style="max-height: 280px; overflow-y: auto; margin-top: 8px;">
                            <table class="table"><thead><tr><th>Phone</th><th>Name</th><th>Status</th><th>Reason</th><th>Line</th><th>Time</th></tr></thead><tbody id="bulk-recent-body"></tbody></table>
                        </div>
                    </div>

                    <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-top: 16px;">
                        <h4 style="margin: 0 0 8px 0;">📞 Export for bulk calling / IVR (CSV: name, phone_10, phone_91, ward, village)</h4>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 12px;">
                            <label>Source <select id="export-source" style="font-size: 12px;"><option value="contacts">All saved contacts</option><option value="broadcast">Latest broadcast results</option></select></label>
                            <span id="export-contact-filters">ward <input id="export-ward" style="width: 50px;" placeholder="all"> village <input id="export-village" style="width: 110px;" placeholder="all"></span>
                            <span id="export-broadcast-filters" style="display: none;">
                                <label><input type="checkbox" class="export-status" value="sent" checked> sent</label>
                                <label><input type="checkbox" class="export-status" value="failed"> failed</label>
                                <label><input type="checkbox" class="export-status" value="skipped"> skipped</label>
                                <label><input type="checkbox" class="export-status" value="pending"> pending</label>
                                reason <select id="export-reason" style="font-size: 12px;"><option value="">any</option><option value="not_on_whatsapp">not on WhatsApp</option><option value="cancelled">cancelled</option></select>
                            </span>
                            <label><input type="checkbox" id="export-include-optout"> include opted-out (not recommended)</label>
                            <button type="button" data-action="export" style="font-size: 12px; padding: 6px 12px; border-radius: 6px; border: none; background: #0284c7; color: white; font-weight: 700; cursor: pointer;">⬇️ Export CSV</button>
                        </div>
                    </div>
                </div>

                <!-- ===== Goal & Agenda Tab ===== -->
                <div id="tab-goal" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🎯 Today's goal, progress and agenda</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                            <h4 style="margin: 0 0 8px 0;">Daily goal / task</h4>
                            <input id="hg-title" placeholder="e.g. talk to 300 people today, 100 sure votes" style="width:100%; box-sizing:border-box; padding:7px; margin-bottom:6px; border:1px solid #cbd5e1; border-radius:6px;">
                            <textarea id="hg-instruction" rows="2" placeholder="Today's focus for the bot (used in conversations)" style="width:100%; box-sizing:border-box; padding:7px; border:1px solid #cbd5e1; border-radius:6px;"></textarea>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:12px; margin-top:6px;">
                                <label>Target people <input id="hg-target" type="number" min="0" style="width:70px;"></label>
                                <label>Target sure votes <input id="hg-target-committed" type="number" min="0" style="width:70px;"></label>
                                <label>Task ward <input id="hg-ward" style="width:50px;" placeholder="—"></label>
                            </div>
                            <textarea id="hg-task" rows="2" placeholder="Message for that ward (e.g. कल शाम 5 बजे चौपाल पर ज़रूर आइए) — exactly what you write is sent" style="width:100%; box-sizing:border-box; padding:7px; margin-top:6px; border:1px solid #cbd5e1; border-radius:6px;"></textarea>
                            <button type="button" data-goal-action="save-goal" style="margin-top:8px; padding:7px 14px; border:none; border-radius:6px; background:#16a34a; color:white; font-weight:800; cursor:pointer;">💾 Save goal</button>
                            <span id="hg-goal-status" style="font-size:12px; margin-left:8px;"></span>
                        </div>
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                            <h4 style="margin: 0 0 8px 0;">📈 Live progress (today)</h4>
                            <div id="hg-progress" style="font-size:14px;">Loading…</div>
                            <div id="hg-funnel" style="font-size:13px; margin-top:8px;"></div>
                            <button type="button" data-goal-action="summary" style="margin-top:8px; padding:6px 12px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer; font-size:12px;">🌙 Build day summary now</button>
                            <div id="hg-summary" style="font-size:12px; margin-top:8px; white-space:pre-wrap; background:#f8fafc; padding:8px; border-radius:6px;"></div>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-top:16px;">
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;"><h4 style="margin:0 0 8px 0;">Per line</h4><div id="hg-by-line" style="font-size:12px;"></div></div>
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;"><h4 style="margin:0 0 8px 0;">Per ward</h4><div id="hg-by-ward" style="font-size:12px; max-height:260px; overflow-y:auto;"></div></div>
                    </div>
                    <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-top:16px;">
                        <h4 style="margin: 0 0 8px 0;">🗓️ Daily agenda (per day)</h4>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px;">
                            <label>Date <input type="date" id="ha-date"></label>
                            <button type="button" data-goal-action="load-day" style="padding:5px 10px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer; font-size:12px;">Load</button>
                            <span id="ha-days" style="color:#64748b;"></span>
                        </div>
                        <input id="ha-topic" placeholder="Today's topic" style="width:100%; box-sizing:border-box; padding:7px; margin-top:8px; border:1px solid #cbd5e1; border-radius:6px;">
                        <textarea id="ha-points" rows="3" placeholder="Main talking points (verified facts only)" style="width:100%; box-sizing:border-box; padding:7px; margin-top:6px; border:1px solid #cbd5e1; border-radius:6px;"></textarea>
                        <div id="ha-slots" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:10px; margin-top:8px;"></div>
                        <button type="button" data-goal-action="save-day" style="margin-top:8px; padding:7px 14px; border:none; border-radius:6px; background:#2563eb; color:white; font-weight:800; cursor:pointer;">💾 Save day agenda</button>
                        <span id="ha-status" style="font-size:12px; margin-left:8px;"></span>
                    </div>
                </div>

                <!-- ===== Live Self-Test Tab ===== -->
                <div id="tab-selftest" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🧪 Live Self-Test — one bot line plays a voter to another</h3>
                    <p style="font-size:12px; color:#64748b; margin-top:0;">The tester line sends each scripted message to the target line and waits up to 60s for the real reply. Only during a run does the target treat the tester as a voter; the tester never replies. Outside a run our own lines ignore each other (no bot-to-bot loops). The tester's temporary voter record is deleted after the run.</p>
                    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:13px;">
                        <label>Tester line <select id="st-tester"></select></label>
                        <label>Target line (bot under test) <select id="st-target"></select></label>
                        <button type="button" id="st-start" style="padding:7px 14px; border:none; border-radius:6px; background:#16a34a; color:white; font-weight:800; cursor:pointer;">▶ Start test</button>
                        <button type="button" id="st-stop" style="padding:7px 14px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;">■ Stop</button>
                        <span id="st-status" style="font-weight:700;"></span>
                    </div>
                    <label style="display:block; font-size:12px; margin-top:10px;">Script — one voter message per line; optional <code>|| word1, word2</code> = the reply must mention one of these (context check). Empty = default 8-turn script.</label>
                    <textarea id="st-script" rows="8" style="width:100%; box-sizing:border-box; padding:7px; border:1px solid #cbd5e1; border-radius:6px; font-family:monospace; font-size:12px;"></textarea>
                    <div id="st-summary" style="font-size:13px; margin-top:10px;"></div>
                    <div id="st-transcript" style="font-size:13px; margin-top:8px; max-height:520px; overflow-y:auto;"></div>
                    <h4 style="margin:14px 0 6px 0;">Past runs</h4>
                    <div id="st-runs" style="font-size:12px;"></div>
                </div>

                <!-- ===== Brain v3: Samasya / Mulaqat / Voter Plan tabs ===== -->
                <div id="tab-samasya" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📋 Samasya register — problems voters reported on WhatsApp</h3>
                    <p style="font-size:12px; color:#64748b; margin-top:0;">The bot asks what / where (ward, gali, landmark) / since when, logs it here and tells the voter it reached Abhay Singh ji. It never promises a date. Update the status as the team works on it.</p>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:12px;">
                        <select id="sm-village"><option value="">All villages</option><option value="sihali_khurd">Sihali Khurd</option><option value="sihali_kalan">Sihali Kalan</option><option value="hadahedi">Hadahedi</option></select>
                        <input id="sm-ward" placeholder="Ward" style="width:56px;">
                        <select id="sm-status"><option value="">All status</option><option value="new">new</option><option value="in-progress">in-progress</option><option value="resolved">resolved</option></select>
                        <select id="sm-category"><option value="">All categories</option></select>
                        <input id="sm-q" placeholder="Search" style="width:140px;">
                        <label><input type="checkbox" id="sm-test"> include test</label>
                        <button type="button" id="sm-refresh" style="padding:5px 10px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;">↻ Refresh</button>
                        <a id="sm-csv" href="/api/samasya.csv" style="padding:5px 10px; border-radius:6px; background:#16a34a; color:white; text-decoration:none; font-weight:700;">⬇ CSV</a>
                        <span id="sm-counts" style="color:#475569;"></span>
                    </div>
                    <div id="sm-list" style="font-size:12px; margin-top:10px; max-height:620px; overflow:auto;"></div>
                </div>
                <div id="tab-mulaqat" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🤝 Mulaqat — requests to meet / invite Abhay Singh ji home</h3>
                    <p style="font-size:12px; color:#64748b; margin-top:0;">The bot only collects the request (preferred day+time, place/landmark, family members, purpose) and tells the voter the team will confirm. Mark confirmed once you have called them.</p>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:12px;">
                        <select id="mq-village"><option value="">All villages</option><option value="sihali_khurd">Sihali Khurd</option><option value="sihali_kalan">Sihali Kalan</option><option value="hadahedi">Hadahedi</option></select>
                        <input id="mq-ward" placeholder="Ward" style="width:56px;">
                        <select id="mq-status"><option value="">All status</option><option value="requested">requested</option><option value="confirmed">confirmed</option><option value="done">done</option><option value="cancelled">cancelled</option></select>
                        <input id="mq-q" placeholder="Search" style="width:140px;">
                        <label><input type="checkbox" id="mq-test"> include test</label>
                        <button type="button" id="mq-refresh" style="padding:5px 10px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;">↻ Refresh</button>
                        <a id="mq-csv" href="/api/mulaqat.csv" style="padding:5px 10px; border-radius:6px; background:#16a34a; color:white; text-decoration:none; font-weight:700;">⬇ CSV</a>
                        <span id="mq-counts" style="color:#475569;"></span>
                    </div>
                    <div id="mq-list" style="font-size:12px; margin-top:10px; max-height:620px; overflow:auto;"></div>
                </div>
                <div id="tab-plan" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🗺️ Voter Plan — what the bot knows and will do next</h3>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:12px;">
                        <select id="vp-stage"><option value="">All stages</option><option value="unknown">unknown</option><option value="undecided">undecided</option><option value="leaning">leaning</option><option value="committed">committed</option><option value="opposed">opposed</option></select>
                        <input id="vp-q" placeholder="Search name / phone" style="width:160px;">
                        <label><input type="checkbox" id="vp-test"> include test</label>
                        <button type="button" id="vp-refresh" style="padding:5px 10px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;">↻ Refresh</button>
                        <span id="vp-total" style="color:#475569;"></span>
                    </div>
                    <div id="vp-list" style="font-size:12px; margin-top:10px; max-height:640px; overflow:auto;"></div>
                </div>${opsRoutes.ui.tabPanes()}${statusRoutes.ui.tabPanes()}${ocRoutes.ui.tabPanes()}
            </div>

            <!-- Dashboard JavaScript -->
            <script>
                let allVoters = [];
                let selectedVoterPhone = null;
                let currentPosterBlob = null;
                let aiHistory = [];

                function escapeHtml(value) {
                    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function(char) {
                        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
                    });
                }

                async function loadDailyGoalUI() {
                    try {
                        const goalRes = await fetch('/api/daily-target');
                        const goal = await goalRes.json();
                        document.getElementById('daily-goal-title').value = goal.title || '';
                        document.getElementById('daily-goal-target').value = goal.targetContacts || 0;
                        document.getElementById('daily-goal-completed').value = goal.completedContacts || 0;
                        document.getElementById('daily-goal-instruction').value = goal.instruction || '';
                        const opsRes = await fetch('/api/operations-status');
                        const ops = await opsRes.json();
                        const connected = (ops.sessions || []).filter(function(s) { return s.status === 'CONNECTED'; }).length;
                        document.getElementById('ops-summary').textContent = connected + '/' + (ops.sessions || []).length + ' lines connected • ' + (ops.eventCount || 0) + ' runtime events';
                    } catch (e) {
                        document.getElementById('ops-summary').textContent = 'Status unavailable';
                    }
                }

                async function saveDailyGoalUI() {
                    const status = document.getElementById('daily-goal-status');
                    try {
                        const res = await fetch('/api/daily-target', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                title: document.getElementById('daily-goal-title').value.trim(),
                                instruction: document.getElementById('daily-goal-instruction').value.trim(),
                                targetContacts: Number(document.getElementById('daily-goal-target').value || 0),
                                completedContacts: Number(document.getElementById('daily-goal-completed').value || 0)
                            })
                        });
                        if (!res.ok) throw new Error('Save failed');
                        status.textContent = 'Saved';
                        loadDailyGoalUI();
                    } catch (e) {
                        status.textContent = e.message;
                    }
                }

                async function loadCampaignProfileUI() {
                    try {
                        const res = await fetch('/api/campaign-profile');
                        const profile = await res.json();
                        document.getElementById('campaign-verified-facts').value = (profile.verifiedFacts || []).join('\\n');
                        document.getElementById('campaign-talking-style').value = profile.talkingStyle || '';
                    } catch (e) {
                        document.getElementById('campaign-profile-status').textContent = 'Profile unavailable';
                    }
                }

                async function saveCampaignProfileUI() {
                    const status = document.getElementById('campaign-profile-status');
                    try {
                        const facts = document.getElementById('campaign-verified-facts').value.split(/\\r?\\n/).map(function(v) { return v.trim(); }).filter(Boolean);
                        const res = await fetch('/api/campaign-profile', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                verifiedFacts: facts,
                                talkingStyle: document.getElementById('campaign-talking-style').value.trim()
                            })
                        });
                        if (!res.ok) throw new Error('Save failed');
                        status.textContent = 'Saved and active';
                    } catch (e) {
                        status.textContent = e.message;
                    }
                }

                async function uploadCampaignFactsFile() {
                    const input = document.getElementById('campaign-facts-file');
                    const status = document.getElementById('campaign-profile-status');
                    const file = input.files && input.files[0];
                    if (!file) {
                        status.textContent = 'Choose a facts file first';
                        return;
                    }
                    try {
                        const content = await file.text();
                        const res = await fetch('/api/campaign-profile/import', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                content: content,
                                fileName: file.name,
                                mode: document.getElementById('campaign-facts-import-mode').value
                            })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Import failed');
                        status.textContent = data.factCount + ' verified facts active';
                        input.value = '';
                        loadCampaignProfileUI();
                    } catch (e) {
                        status.textContent = e.message;
                    }
                }
                loadDailyGoalUI();
                loadCampaignProfileUI();

                async function sendCustomPosterDirect() {
                    const phone = document.getElementById('p-voter-phone').value.trim();
                    const name = document.getElementById('p-name').value.trim();
                    const aspect = document.getElementById('p-aspect').value || '9:16';
                    const slogan = document.getElementById('p-slogan').value.trim();
                    const statusEl = document.getElementById('p-send-status');

                    if (!phone || phone.length < 10) {
                        alert('Please enter a correct 10-digit mobile number for the voter!');
                        return;
                    }

                    statusEl.style.color = '#2563eb';
                    statusEl.textContent = '⏳ Making a custom poster with the name and sending it on WhatsApp...';

                    try {
                        const res = await fetch('/api/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                phone: phone,
                                name: name,
                                mediaOption: 'custom_poster',
                                customText: 'राम राम ' + (name ? name + ' जी' : 'भाई जी') + '! 🙏\\nबाबा अभय सिंह टीम द्वारा आपके नाम का विशेष WhatsApp Status पोस्टर तैयार कर दिया गया है।\\nइसे अपने स्टेटस व प्रोफाइल पर ज़रूर लगाएं! 🚩'
                            })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            statusEl.style.color = '#16a34a';
                            statusEl.textContent = '✅ Poster sent to ' + phone + ' successfully!';
                        } else {
                            statusEl.style.color = '#dc2626';
                            statusEl.textContent = '❌ Error: ' + (data.error || 'Failed to send');
                        }
                    } catch (err) {
                        statusEl.style.color = '#dc2626';
                        statusEl.textContent = '❌ Network error: ' + err.message;
                    }
                }

                function switchTab(tabId, btn) {
                    if (!tabId) return;
                    document.querySelectorAll('.tab-content').forEach(function (el) { el.style.display = 'none'; });
                    document.querySelectorAll('.tab-btn').forEach(function (el) { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
                    const target = document.getElementById('tab-' + tabId);
                    if (target) target.style.display = 'block';
                    const activeBtn = btn || document.getElementById('tab-btn-' + tabId);
                    if (activeBtn) { activeBtn.classList.add('active'); activeBtn.setAttribute('aria-selected', 'true'); }
                    try { if (window.history && history.replaceState) history.replaceState(null, '', '#' + tabId); } catch (e) {}
                    try {
                        if (tabId === 'voters') loadVoters();
                        if (tabId === 'contacts') loadContacts();
                        if (tabId === 'media' && typeof window.hkLoadMedia === 'function') window.hkLoadMedia();
                        if (tabId === 'playground' && typeof loadCampaignAgendaUI === 'function') loadCampaignAgendaUI();
                    } catch (e) { console.warn('tab loader failed', tabId, e); }
                }
                // One delegated handler for every tab button (old onclick= and new data-tab=):
                // tabs keep working even if a feature module fails to initialise.
                document.addEventListener('click', function (e) {
                    var b = e.target && e.target.closest ? e.target.closest('.tab-btn') : null;
                    if (!b || b.hasAttribute('onclick')) return;
                    var id = b.getAttribute('data-tab') || String(b.id || '').replace('tab-btn-', '');
                    if (id && !b.classList.contains('active')) switchTab(id, b);
                }, true);

                function toggleCustomText(val) {
                    const grp = document.getElementById('custom-text-group');
                    if (grp) grp.style.display = val === 'custom' ? 'block' : 'none';
                }

                let searchDebounceTimer = null;
                function onVoterSearchInput(query) {
                    clearTimeout(searchDebounceTimer);
                    const dropdown = document.getElementById('voter-search-dropdown');
                    const q = (query || '').trim();
                    if (!q || q.length < 2) {
                        dropdown.style.display = 'none';
                        dropdown.innerHTML = '';
                        return;
                    }
                    searchDebounceTimer = setTimeout(async function() {
                        try {
                            const res = await fetch('/api/search-voters?q=' + encodeURIComponent(q));
                            const data = await res.json();
                            dropdown.innerHTML = '';
                            if (!data.results || data.results.length === 0) {
                                const emptyEl = document.createElement('div');
                                emptyEl.style.cssText = 'padding: 10px; font-size: 12px; color: #64748b; text-align: center;';
                                emptyEl.textContent = 'No voter found';
                                dropdown.appendChild(emptyEl);
                                dropdown.style.display = 'block';
                                return;
                            }
                            data.results.slice(0, 8).forEach(function(v) {
                                const rel = require('./relation_label').relLabel(v);
                                const item = document.createElement('div');
                                item.style.cssText = 'padding: 9px 12px; border-bottom: 1px solid #f1f5f9; cursor: pointer; text-align: left; background: white;';
                                item.onmouseenter = function() { this.style.background = '#f1f5f9'; };
                                item.onmouseleave = function() { this.style.background = 'white'; };
                                item.onclick = function() { selectVoterForField(v); };
                                
                                const title = document.createElement('div');
                                title.style.cssText = 'font-weight: 700; color: #0f172a; font-size: 13px;';
                                title.textContent = (v.name_hi || v.name || '') + ' (' + (v.name_en || '') + ')';
                                
                                const subtitle = document.createElement('div');
                                subtitle.style.cssText = 'font-size: 11px; color: #64748b;';
                                subtitle.textContent = rel + ': ' + (v.rel_name_hi || v.rel_name || '--') + ' | Ward: ' + (v.ward || '--') + ' | Serial #' + (v.sr_no || '--') + ' | EPIC: ' + (v.epic || '--');
                                
                                item.appendChild(title);
                                item.appendChild(subtitle);
                                dropdown.appendChild(item);
                            });
                            dropdown.style.display = 'block';
                        } catch (e) {
                            console.error('Voter search failed:', e);
                        }
                    }, 250);
                }

                function selectVoterForField(v) {
                    document.getElementById('v-voter-id').value = v.id || v.sr_no || '';
                    document.getElementById('v-name').value = v.name_hi || v.name || '';
                    document.getElementById('v-linked-ward').value = v.ward || '';
                    document.getElementById('v-linked-epic').value = v.epic || '';
                    document.getElementById('voter-search-dropdown').style.display = 'none';

                    const badge = document.getElementById('voter-linked-badge');
                    const rel = require('./relation_label').relLabel(v);
                    badge.innerHTML = '✅ <strong>' + (v.name_hi || v.name) + '</strong> (' + rel + ': ' + (v.rel_name_hi || '--') + ', Ward ' + v.ward + ', #' + v.sr_no + ', EPIC: ' + v.epic + ') <button type="button" onclick="clearLinkedVoter()" style="background: none; border: none; color: #dc2626; cursor: pointer; margin-left: 8px; font-weight: 700;">✕ Unlink</button>';
                    badge.style.display = 'block';

                    const slipRadio = document.getElementById('media-opt-slip');
                    if (slipRadio) slipRadio.checked = true;
                }

                function clearLinkedVoter() {
                    document.getElementById('v-voter-id').value = '';
                    document.getElementById('v-linked-ward').value = '';
                    document.getElementById('v-linked-epic').value = '';
                    const badge = document.getElementById('voter-linked-badge');
                    if (badge) {
                        badge.style.display = 'none';
                        badge.innerHTML = '';
                    }
                }

                function onTemplateChange(val) {
                    toggleCustomText(val);
                    if (val === 'offer_parchi') {
                        const slipRadio = document.getElementById('media-opt-slip');
                        if (slipRadio) slipRadio.checked = true;
                    }
                }

                document.addEventListener('click', function(e) {
                    const dropdown = document.getElementById('voter-search-dropdown');
                    const searchInput = document.getElementById('v-name');
                    if (dropdown && !dropdown.contains(e.target) && e.target !== searchInput) {
                        dropdown.style.display = 'none';
                    }
                });

                // Send Instant WhatsApp Message from Field Mode Form
                async function sendInstantMessage(e) {
                    e.preventDefault();
                    const phone = document.getElementById('v-phone').value.trim();
                    const name = document.getElementById('v-name').value.trim();
                    const lineId = document.getElementById('v-line').value;
                    const template = document.getElementById('v-template').value;
                    const customText = document.getElementById('v-custom-text').value;
                    const voterId = document.getElementById('v-voter-id').value;
                    const linkedWard = document.getElementById('v-linked-ward').value;
                    const linkedEpic = document.getElementById('v-linked-epic').value;

                    const mediaOptEl = document.querySelector('input[name="mediaOption"]:checked');
                    const mediaOption = mediaOptEl ? mediaOptEl.value : 'none';

                    const statusEl = document.getElementById('send-status');
                    const btn = document.getElementById('btn-submit');

                    btn.disabled = true;
                    btn.innerText = '⏳ Sending WhatsApp Message...';

                    try {
                        const res = await fetch('/api/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone, name, template, customText, lineId, voterId, linkedWard, linkedEpic, mediaOption })
                        });
                        const data = await res.json();

                        if (res.ok) {
                            statusEl.style.display = 'inline-block';
                            statusEl.style.background = '#dcfce7';
                            statusEl.style.color = '#15803d';
                            statusEl.innerText = '✅ Sent to +' + data.phone + ' via ' + data.line + (data.mediaSent ? ' (' + data.mediaSent + ')' : '');
                            document.getElementById('v-phone').value = '';
                            document.getElementById('v-name').value = '';
                            document.getElementById('v-custom-text').value = '';
                            clearLinkedVoter();
                            setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
                            updateLiveFeed();
                        } else {
                            alert('Failed to send: ' + (data.error || 'Unknown error'));
                        }
                    } catch (err) {
                        alert('Error communicating with server: ' + err.message);
                    } finally {
                        btn.disabled = false;
                        btn.innerText = '📲 Jod Lo & Send WhatsApp Instantly';
                    }
                }

                // Poster Studio Generator
                async function generatePosterPreview() {
                    const name = document.getElementById('p-name').value;
                    const aspect = document.getElementById('p-aspect').value;
                    const slogan = document.getElementById('p-slogan').value;

                    try {
                        const res = await fetch('/api/generate-poster', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, aspect, customSlogan: slogan })
                        });
                        const blob = await res.blob();
                        currentPosterBlob = blob;
                        const url = URL.createObjectURL(blob);
                        document.getElementById('poster-preview-img').src = url;
                        document.getElementById('btn-download').style.display = 'inline-block';
                    } catch (e) {
                        alert('Error generating poster: ' + e.message);
                    }
                }

                function downloadPoster() {
                    if (!currentPosterBlob) return;
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(currentPosterBlob);
                    a.download = 'Sihali_Khurd_Poster_' + Date.now() + '.jpg';
                    a.click();
                }

                // Upload Media from Device
                async function uploadMediaFile() {
                    const fileInput = document.getElementById('media-file-input');
                    const targetSelect = document.getElementById('media-target-select');
                    const statusEl = document.getElementById('upload-status');

                    if (!fileInput.files || fileInput.files.length === 0) {
                        alert('Please select a file to upload!');
                        return;
                    }

                    const file = fileInput.files[0];
                    statusEl.innerText = '⏳ Uploading ' + file.name + '... Please wait.';
                    statusEl.style.color = '#2563eb';

                    const reader = new FileReader();
                    reader.onload = async function() {
                        try {
                            const res = await fetch('/api/upload-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    target: targetSelect.value,
                                    base64Data: reader.result
                                })
                            });
                            const data = await res.json();
                            if (res.ok) {
                                statusEl.innerText = '✅ ' + data.message;
                                statusEl.style.color = '#16a34a';
                                if (targetSelect.value === 'poster.jpg') {
                                    document.getElementById('poster-asset-img').src = '/media/poster.jpg?t=' + Date.now();
                                }
                            } else {
                                statusEl.innerText = '❌ Error: ' + data.error;
                                statusEl.style.color = '#dc2626';
                            }
                        } catch (err) {
                            statusEl.innerText = '❌ Upload failed: ' + err.message;
                            statusEl.style.color = '#dc2626';
                        }
                    };
                    reader.readAsDataURL(file);
                }

                // AI Playground
                async function sendAITest() {
                    const input = document.getElementById('ai-test-input');
                    const text = input.value.trim();
                    if (!text) return;

                    input.value = '';
                    const chatUi = document.getElementById('ai-chat-ui');
                    chatUi.innerHTML += '<div class="bubble bubble-user">' + text + '</div>';
                    chatUi.scrollTop = chatUi.scrollHeight;

                    aiHistory.push({ role: 'user', content: text });

                    try {
                        const res = await fetch('/api/test-ai', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ message: text, history: aiHistory })
                        });
                        const data = await res.json();
                        aiHistory.push({ role: 'assistant', content: data.reply });

                        chatUi.innerHTML += '<div class="bubble bubble-bot">' + (data.reply || '').split(String.fromCharCode(10)).join('<br>') + '</div>';
                        chatUi.scrollTop = chatUi.scrollHeight;
                    } catch (e) {
                        chatUi.innerHTML += '<div class="bubble bubble-bot" style="color:red;">Error: ' + e.message + '</div>';
                    }
                }

                function quickTestQuery(q) {
                    document.getElementById('ai-test-input').value = q;
                    sendAITest();
                }

                // Update Live Voter Chat Feed (Voters Only)
                function openVoterInCRM(phone) {
                    const crmBtn = document.getElementById('tab-btn-voters');
                    switchTab('voters', crmBtn);
                    setTimeout(function() { selectVoter(phone); }, 150);
                }

                async function updateLiveFeed() {
                    try {
                        const res = await fetch('/api/messages');
                        const messages = await res.json();
                        const tbody = document.getElementById('live-table-body');
                        if (!messages || messages.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 35px;">💬 Waiting for voter messages... Real incoming chats will appear here in real time!</td></tr>';
                            return;
                        }

                        // Group by unique voter phone number (Single updated entry per voter)
                        const groupedByPhone = {};
                        messages.forEach(m => {
                            if (!m.phone) return;
                            if (!groupedByPhone[m.phone]) {
                                groupedByPhone[m.phone] = m;
                            }
                        });
                        const uniqueVoters = Object.values(groupedByPhone);

                        tbody.innerHTML = uniqueVoters.map(m => {
                            let badgeClass = 'badge-success';
                            if (m.status === 'HANDSHAKE_SENT') badgeClass = 'badge-info';
                            else if (m.status === 'TEST_SENT') badgeClass = 'badge-info';
                            else if (m.status === 'MEDIA_SENT') badgeClass = 'badge-info';

                            return '<tr style="cursor: pointer;" data-phone="' + (m.phone || '') + '" onclick="openVoterInCRM(this.dataset.phone)">' +
                                '<td style="color: #64748b; font-size: 12px;">' + (m.timestamp || '') + '</td>' +
                                '<td><span style="font-weight: 600; color: #334155; font-size: 12px;">' + (m.session || '') + '</span></td>' +
                                '<td><span style="color: #2563eb; font-weight: 700; font-size: 13px;">+' + (m.phone || '') + '</span></td>' +
                                '<td style="font-weight: 500; color: #0f172a;">' + (m.incoming || '') + '</td>' +
                                '<td style="color: #334155; font-size: 13px; white-space: pre-wrap;">' + (m.reply || '') + '</td>' +
                                '<td><span class="badge ' + badgeClass + '">● ' + (m.status || '') + '</span><br><button class="btn btn-sm" style="background:#2563eb; color:white; margin-top:4px; font-size:11px; padding:2px 8px; border-radius:4px; border:none;" data-phone="' + (m.phone || '') + '" onclick="event.stopPropagation(); openVoterInCRM(this.dataset.phone)">💬 Open Chat</button></td>' +
                                '</tr>';
                        }).join('');
                    } catch (e) {}
                }
                setInterval(updateLiveFeed, 4000);
                updateLiveFeed();

                // Update Diagnostics Feed
                async function updateDiagnostics() {
                    try {
                        const res = await fetch('/api/diagnostics');
                        const data = await res.json();
                        const tbody = document.getElementById('diag-table-body');
                        if (!data || !data.feed || data.feed.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 25px;">No system events or self-tests recorded yet.</td></tr>';
                            return;
                        }

                        tbody.innerHTML = data.feed.map(d => {
                            let badgeClass = 'badge-warning';
                            if (d.status === 'SELF_DEVICE') badgeClass = 'badge-info';
                            else if (d.status === 'BAD_MAC') badgeClass = 'badge-danger';

                            return '<tr>' +
                                '<td style="color: #64748b; font-size: 12px;">' + (d.timestamp || '') + '</td>' +
                                '<td><span style="font-weight: 600; color: #334155; font-size: 12px;">' + (d.session || '') + '</span></td>' +
                                '<td><span style="color: #475569; font-weight: 700; font-size: 12px;">' + (d.phone || '') + '</span></td>' +
                                '<td style="color: #334155; font-size: 12px;"><b>' + (d.incoming || '') + '</b><br><span style="color:#64748b;">' + (d.reply || '') + '</span></td>' +
                                '<td><span class="badge ' + badgeClass + '">● ' + (d.status || '') + '</span></td>' +
                                '</tr>';
                        }).join('');
                    } catch (e) {}
                }
                setInterval(updateDiagnostics, 4000);
                updateDiagnostics();

                // Clear All Logs
                async function clearAllLogs() {
                    if (!confirm('Are you sure you want to clear chat and diagnostic logs?')) return;
                    try {
                        await fetch('/api/clear-logs', { method: 'POST' });
                        updateLiveFeed();
                        updateDiagnostics();
                    } catch (e) {
                        alert('Failed to clear logs: ' + e.message);
                    }
                }

                // Send Diagnostic Test Message
                async function sendDiagnosticTest() {
                    const lineId = document.getElementById('diag-line').value;
                    const phone = document.getElementById('diag-phone').value.trim();
                    const message = document.getElementById('diag-msg').value.trim();
                    const statusEl = document.getElementById('diag-send-status');

                    if (!phone || !message) {
                        alert('Please enter recipient phone number and message.');
                        return;
                    }

                    statusEl.innerText = '⏳ Sending test WhatsApp...';
                    statusEl.style.color = '#2563eb';

                    try {
                        const res = await fetch('/api/test-send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: lineId, phone, message })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            statusEl.innerText = '✅ ' + data.message;
                            statusEl.style.color = '#16a34a';
                            updateLiveFeed();
                        } else {
                            statusEl.innerText = '❌ ' + (data.error || 'Failed');
                            statusEl.style.color = '#dc2626';
                        }
                    } catch (e) {
                        statusEl.innerText = '❌ Error: ' + e.message;
                        statusEl.style.color = '#dc2626';
                    }
                }

                // Load Voters and Memory - WhatsApp Web Replica JS Engine
                let currentFilterTag = 'ALL';
                let currentVoterData = null;

                function getTagStyle(t) {
                    if (t.indexOf('🔴') !== -1 || t.indexOf('🚨') !== -1) return 'background:#fee2e2; color:#991b1b; border-color:#fca5a5;';
                    if (t.indexOf('🟢') !== -1) return 'background:#dcfce7; color:#166534; border-color:#86efac;';
                    if (t.indexOf('🟡') !== -1) return 'background:#fef3c7; color:#92400e; border-color:#fcd34d;';
                    if (t.indexOf('📝') !== -1) return 'background:#ffedd5; color:#9a3412; border-color:#fdba74;';
                    if (t.indexOf('👨‍👩‍👧') !== -1 || t.indexOf('📢') !== -1) return 'background:#e0f2fe; color:#0369a1; border-color:#7dd3fc;';
                    if (t.indexOf('🚩') !== -1 || t.indexOf('📜') !== -1) return 'background:#f3e8ff; color:#6b21a8; border-color:#d8b4fe;';
                    if (t.indexOf('🌾') !== -1) return 'background:#d1fae5; color:#065f46; border-color:#6ee7b7;';
                    if (t.indexOf('🚆') !== -1) return 'background:#ccfbf1; color:#115e59; border-color:#5eead4;';
                    if (t.indexOf('👵') !== -1 || t.indexOf('👩‍🦰') !== -1) return 'background:#fce7f3; color:#9d174d; border-color:#f9a8d4;';
                    return 'background:#f1f5f9; color:#334155; border-color:#cbd5e1;';
                }

                async function toggleDemoPosterMode() {
                    try {
                        const statusRes = await fetch('/api/demo-poster-status');
                        const statusData = await statusRes.json();
                        const nextState = !statusData.demoMode;
                        const res = await fetch('/api/toggle-demo-posters', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled: nextState })
                        });
                        const data = await res.json();
                        const badge = document.getElementById('demo-mode-badge');
                        if (data.demoMode) {
                            badge.style.background = '#dcfce7';
                            badge.style.color = '#15803d';
                            badge.style.borderColor = '#16a34a';
                            badge.innerText = '📸 Demo poster mode: ON';
                        } else {
                            badge.style.background = '#e0f2fe';
                            badge.style.color = '#0284c7';
                            badge.style.borderColor = '#0284c7';
                            badge.innerText = '🖼️ Original poster mode';
                        }
                    } catch (e) {
                        alert('Error toggling demo poster mode: ' + e.message);
                    }
                }

                async function loadVoters() {
                    try {
                        const res = await fetch('/api/voters');
                        allVoters = await res.json();
                        document.getElementById('voter-count').innerText = allVoters.length;
                        document.getElementById('voter-count-badge').innerText = allVoters.length;
                        applyVoterFilters();
                    } catch (e) {
                        console.error('Error loading voters:', e);
                    }
                }

                function applyTagFilter(tag, el) {
                    currentFilterTag = tag;
                    if (el) {
                        document.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
                        el.classList.add('active');
                    }

                    applyVoterFilters();
                }

                function filterVoters(q) {
                    applyVoterFilters(q);
                }

                function applyVoterFilters(query) {
                    const searchInput = document.getElementById('voter-search');
                    const lower = String(query === undefined ? (searchInput ? searchInput.value : '') : query).toLowerCase();
                    const line = (document.getElementById('crm-line-filter') || {}).value || 'all';
                    const filtered = allVoters.filter(function(v) {
                        const lineMatch = line === 'all' || v.lastSessionId === line || v.assignedLine === line;
                        const stageSel = (document.getElementById('crm-stage-filter') || {}).value || 'all';
                        const stageMatch = stageSel === 'all' || (stageSel === 'needsAdmin' ? !!v.needsAdmin : (v.persuasionStage || 'unknown') === stageSel);
                        const nameMatch = v.name && v.name.toLowerCase().indexOf(lower) !== -1;
                        const phoneMatch = v.phone && v.phone.indexOf(lower) !== -1;
                        const tagMatch = v.tags && v.tags.some(function(t) { return t.toLowerCase().indexOf(lower) !== -1; });
                        const searchMatch = !lower || nameMatch || phoneMatch || tagMatch;
                        const tagFilterMatch = currentFilterTag === 'ALL'
                            || (currentFilterTag === 'MANUAL' && v.autoPilot === false)
                            || (v.tags && v.tags.indexOf(currentFilterTag) !== -1)
                            || v.voterSentiment === currentFilterTag;
                        return lineMatch && stageMatch && searchMatch && tagFilterMatch;
                    });
                    renderVoterList(filtered);
                }

                function renderVoterList(voters) {
                    const listUi = document.getElementById('voter-list-ui');
                    if (!voters || voters.length === 0) {
                        listUi.innerHTML = '<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 13px;">No voter found.</div>';
                        return;
                    }

                    listUi.innerHTML = voters.map(function(v) {
                        const isSelected = selectedVoterPhone === v.phone;
                        const initial = (v.name && v.name.trim()) ? v.name.trim().charAt(0).toUpperCase() : '👤';
                        const lastMsg = (v.history && v.history.length > 0) ? v.history[v.history.length - 1] : null;
                        const snippet = lastMsg ? ((lastMsg.role === 'user' ? '📩 ' : '🚩 ') + lastMsg.text) : 'New conversation...';
                        const time = lastMsg ? lastMsg.time : '';
                        const autoPilotBadge = v.autoPilot === false 
                            ? '<span style="background:#fed7aa; color:#9a3412; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700;">⏸️ Manual</span>'
                            : '<span style="background:#dcfce7; color:#15803d; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700;">🤖 Auto</span>';

                        const tagsHtml = (v.tags || []).slice(0, 3).map(function(t) {
                            return '<span class="wa-tag-pill" style="' + getTagStyle(t) + '">' + t + '</span>';
                        }).join('');

                        return '<div class="wa-contact-item ' + (isSelected ? 'selected' : '') + '" data-phone="' + v.phone + '" onclick="selectVoter(this.dataset.phone)">' +
                            '<div class="wa-avatar">' + initial + '</div>' +
                            '<div class="wa-contact-info">' +
                                '<div class="wa-contact-top">' +
                                    '<div class="wa-contact-name">' + (v.name || 'Villager') + '</div>' +
                                    '<div class="wa-contact-time">' + time + '</div>' +
                                '</div>' +
                                '<div class="wa-contact-sub">' +
                                    '<span>+' + v.phone + '</span>' +
                                    autoPilotBadge +
                                    ' <span style="padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700; background:#f1f5f9;">' + ({ unknown: '⚪', undecided: '🟡', leaning: '🟢', committed: '✅ Sure', opposed: '🔴' }[v.persuasionStage || 'unknown'] || '⚪') + '</span>' +
                                    (v.needsAdmin ? ' <span title="Needs admin" style="font-size:11px;">🚩</span>' : '') +
                                '</div>' +
                                '<div class="wa-contact-snippet">' + snippet + '</div>' +
                                '<div>' + tagsHtml + '</div>' +
                            '</div>' +
                        '</div>';
                    }).join('');
                }

                async function selectVoter(phone) {
                    selectedVoterPhone = phone;
                    renderVoterList(allVoters);

                    try {
                        const res = await fetch('/api/voter/' + phone);
                        currentVoterData = await res.json();
                        const v = currentVoterData;

                        document.getElementById('wa-chat-header').style.display = 'flex';
                        document.getElementById('wa-quick-actions').style.display = 'flex';
                        document.getElementById('wa-input-container').style.display = 'flex';

                        document.getElementById('header-name').innerText = v.name || 'Villager';
                        const details = '+' + v.phone + ' • Ward: ' + (v.ward || '--') + (v.fatherOrSpouse ? ' • Relation: ' + v.fatherOrSpouse : '');
                        document.getElementById('header-details').innerText = details;
                        document.getElementById('header-avatar').innerText = (v.name && v.name.trim()) ? v.name.trim().charAt(0).toUpperCase() : '👤';

                        // AutoPilot Button State
                        const apBtn = document.getElementById('btn-toggle-autopilot');
                        if (v.autoPilot === false) {
                            apBtn.style.background = '#f97316';
                            apBtn.innerText = '⏸️ Manual mode: active';
                            apBtn.title = 'Click to activate AI AutoPilot';
                        } else {
                            apBtn.style.background = '#16a34a';
                            apBtn.innerText = '🤖 AutoPilot AI: ON';
                            apBtn.title = 'Click to pause AI and takeover manually';
                        }

                        // Sentiment select
                        document.getElementById('voter-sentiment-select').value = v.voterSentiment || 'neutral';

                        // Populate Intelligence notes
                        document.getElementById('intel-family').value = v.familyNotes || '';
                        document.getElementById('intel-mahool').value = v.mahoolNotes || '';
                        document.getElementById('intel-baba').value = v.babaNotes || '';
                        document.getElementById('intel-goal').value = v.campaignGoal || '';
                        document.getElementById('wa-copilot-container').style.display = 'flex'; var _ic = document.getElementById('wa-instr-container'); if (_ic) _ic.style.display = 'flex';
                        renderActiveTags(v.tags || []);

                        // Render messages
                        const scrollUi = document.getElementById('wa-chat-scroll');
                        if (!v.history || v.history.length === 0) {
                            scrollUi.innerHTML = '<div style="text-align:center; color:#94a3b8; margin-top:150px;">No messages recorded with this voter yet. Send a direct message below!</div>';
                            return;
                        }

                        scrollUi.innerHTML = v.history.map(function(h) {
                            let bubbleClass = 'wa-bubble-user';
                            let senderLabel = '👤 ' + (v.name || 'Voter');

                            if (h.role === 'bot') {
                                if (h.session === 'Admin Direct' || h.session === 'Admin Manual' || h.session === 'Admin Quick Action') {
                                    bubbleClass = 'wa-bubble-admin';
                                    senderLabel = '👨‍💻 Admin direct message (' + h.session + ')';
                                } else {
                                    bubbleClass = 'wa-bubble-bot';
                                    senderLabel = '🚩 Baba Abhay Singh team (bot)';
                                }
                            }

                            let mediaHtml = '';
                            if (h.mediaUrl) {
                                mediaHtml = '<div style="margin-top:6px;"><img src="' + h.mediaUrl + '" style="max-width:220px; max-height:220px; border-radius:8px; border:1px solid #cbd5e1; display:block;"></div>';
                            } else if (h.mediaType === 'poster' || h.mediaType === 'demoPoster' || h.mediaType === 'customPoster') {
                                mediaHtml = '<div style="margin-top:6px;"><img src="/media/poster.jpg" style="max-width:220px; max-height:220px; border-radius:8px; border:1px solid #cbd5e1; display:block;"></div>';
                            } else if (h.mediaType === 'video') {
                                mediaHtml = '<div style="margin-top:6px;"><video src="/media/campaign_reel.mp4" controls style="max-width:220px; border-radius:8px; display:block;"></video></div>';
                            }

                            return '<div class="wa-bubble ' + bubbleClass + '">' +
                                '<div style="font-size: 10px; font-weight: 700; opacity: 0.8; margin-bottom: 3px;">' + senderLabel + '</div>' +
                                '<div style="white-space: pre-wrap;">' + h.text + '</div>' +
                                mediaHtml +
                                '<div class="wa-bubble-meta">' +
                                    '<span>' + (h.mediaType ? '📎 ' + h.mediaType : '') + '</span>' +
                                    '<span>' + h.time + ' ✓✓</span>' +
                                '</div>' +
                            '</div>';
                        }).join('');

                        scrollUi.scrollTop = scrollUi.scrollHeight;
                    } catch (e) {
                        console.error('Error selecting voter:', e);
                    }
                }

                function renderActiveTags(tags) {
                    const cont = document.getElementById('active-tags-container');
                    cont.innerHTML = tags.map(function(t) {
                        return '<span class="wa-tag-pill" style="' + getTagStyle(t) + ' padding:3px 8px; border-radius:12px; font-size:11px;">' +
                            t + ' <span data-tag="' + t + '" onclick="removeTagFromCurrentVoter(this.dataset.tag)" style="cursor:pointer; margin-left:4px; font-weight:bold; color:#ef4444;">×</span>' +
                        '</span>';
                    }).join('');
                }

                async function toggleCurrentAutoPilot() {
                    if (!selectedVoterPhone || !currentVoterData) return;
                    const nextState = currentVoterData.autoPilot === false ? true : false;
                    try {
                        const res = await fetch('/api/toggle-autopilot', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, autoPilot: nextState })
                        });
                        const data = await res.json();
                        currentVoterData.autoPilot = data.autoPilot;
                        selectVoter(selectedVoterPhone);
                        loadVoters();
                    } catch (e) {
                        alert('Failed to toggle AutoPilot: ' + e.message);
                    }
                }

                async function updateVoterSentiment(sentiment) {
                    if (!selectedVoterPhone) return;
                    try {
                        await fetch('/api/update-tags', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, sentiment: sentiment })
                        });
                        loadVoters();
                    } catch (e) {}
                }

                function toggleIntelDrawer() {
                    const drawer = document.getElementById('wa-intel-drawer');
                    drawer.style.display = (drawer.style.display === 'block') ? 'none' : 'block';
                }

                async function addTagToCurrentVoter(tag) {
                    if (!tag || !selectedVoterPhone || !currentVoterData) return;
                    document.getElementById('add-tag-select').value = '';
                    const tags = currentVoterData.tags || [];
                    if (tags.indexOf(tag) === -1) tags.push(tag);
                    try {
                        await fetch('/api/update-tags', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, tags: tags })
                        });
                        currentVoterData.tags = tags;
                        renderActiveTags(tags);
                        loadVoters();
                    } catch (e) {}
                }

                async function removeTagFromCurrentVoter(tag) {
                    if (!selectedVoterPhone || !currentVoterData) return;
                    let tags = currentVoterData.tags || [];
                    tags = tags.filter(function(t) { return t !== tag; });
                    try {
                        await fetch('/api/update-tags', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, tags: tags })
                        });
                        currentVoterData.tags = tags;
                        renderActiveTags(tags);
                        loadVoters();
                    } catch (e) {}
                }

                async function saveVoterIntelligence() {
                    if (!selectedVoterPhone) return;
                    const familyNotes = document.getElementById('intel-family').value;
                    const mahoolNotes = document.getElementById('intel-mahool').value;
                    const babaNotes = document.getElementById('intel-baba').value;
                    const campaignGoal = document.getElementById('intel-goal').value;
                    const statusEl = document.getElementById('intel-save-status');

                    try {
                        await fetch('/api/update-notes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, familyNotes: familyNotes, mahoolNotes: mahoolNotes, babaNotes: babaNotes, campaignGoal: campaignGoal })
                        });
                        statusEl.style.display = 'inline';
                        setTimeout(function() { statusEl.style.display = 'none'; }, 3000);
                        loadVoters();
                    } catch (e) {
                        alert('Failed to save notes: ' + e.message);
                    }
                }

                async function sendQuickAction(action) {
                    if (!selectedVoterPhone) return;
                    let customNote = '';
                    if (action === 'baba_register') {
                        customNote = prompt('What problem should be added to Baba Abhay Singh priority register?');
                        if (!customNote) return;
                    }

                    try {
                        const res = await fetch('/api/quick-action', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, action: action, customNote: customNote })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            setTimeout(function() { selectVoter(selectedVoterPhone); }, 600);
                        } else {
                            alert('Action failed: ' + (data.error || 'Unknown error'));
                        }
                    } catch (e) {
                        alert('Error executing action: ' + e.message);
                    }
                }

                async function sendManualWhatsAppReply() {
                    if (!selectedVoterPhone) return;
                    const input = document.getElementById('wa-direct-input');
                    const text = input.value.trim();
                    if (!text) return;

                    input.value = '';
                    try {
                        await fetch('/api/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, template: 'custom', customText: text })
                        });
                        setTimeout(function() { selectVoter(selectedVoterPhone); }, 600);
                    } catch (e) {
                        alert('Error sending message: ' + e.message);
                    }
                }
            
            
                async function loadPublicDashboardUrl() {
                    try {
                        const res = await fetch('/api/tunnel-status');
                        const data = await res.json();
                        const el = document.getElementById('public-url-badge');
                        if (data.success && data.url) {
                            const displayUrl = data.url.replace('https://', '').replace('http://', '');
                            el.innerHTML = '🔗 <a href="' + data.url + '" target="_blank" style="color:#0369a1; text-decoration:none;font-weight:bold;">' + displayUrl + '</a> <button data-url="' + data.url + '" onclick="navigator.clipboard.writeText(this.dataset.url)" style="background:none;border:none;cursor:pointer;" title="Copy dashboard URL">📋</button>';
                        } else {
                            el.innerHTML = '🔗 Dashboard active';
                        }
                    } catch (e) {}
                }
                loadPublicDashboardUrl();

                async function generateAIDraft() {
                    if (!selectedVoterPhone) return;
                    const inputEl = document.getElementById('wa-ai-instruction');
                    const instruction = inputEl.value.trim();
                    if (!instruction) {
                        alert('Please write an instruction for the AI (e.g. "tell them to come to the chaupal tomorrow morning")');
                        return;
                    }

                    const btn = document.getElementById('btn-ai-draft');
                    btn.disabled = true;
                    btn.innerText = '⏳ Thinking...';

                    try {
                        const res = await fetch('/api/ai-draft', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: selectedVoterPhone, instruction: instruction })
                        });
                        const data = await res.json();
                        if (data.success && data.draft) {
                            document.getElementById('wa-direct-input').value = data.draft;
                            document.getElementById('wa-direct-input').focus();
                            inputEl.value = '';
                        } else {
                            alert('Draft failed: ' + (data.error || 'Unknown error'));
                        }
                    } catch (e) {
                        alert('Draft error: ' + e.message);
                    } finally {
                        btn.disabled = false;
                        btn.innerText = '✨ Make draft';
                    }
                }

            
                let pgImageBase64 = null;
                let pgImageMime = null;
                let pgAiHistory = [];

                function hourToInput(value) {
                    const hour = Math.floor(Number(value) || 0);
                    const minute = Math.round(((Number(value) || 0) - hour) * 60);
                    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
                }

                function inputToHour(value) {
                    const parts = String(value || '00:00').split(':');
                    return Number(parts[0]) + (Number(parts[1]) / 60);
                }

                async function loadCampaignAgendaUI() {
                    try {
                        const res = await fetch('/api/campaign-agenda');
                        const data = await res.json();
                        if (data && data.topic) {
                            const topEl = document.getElementById('agenda-topic');
                            const ptEl = document.getElementById('agenda-points');
                            if (topEl) topEl.value = data.topic;
                            if (ptEl) ptEl.value = data.talkingPoints || '';
                            ['morning', 'dopahar', 'evening', 'night'].forEach(function(slot) {
                                const item = data.dailySchedule && data.dailySchedule[slot];
                                if (!item) return;
                                const start = document.getElementById('schedule-' + slot + '-start');
                                const end = document.getElementById('schedule-' + slot + '-end');
                                if (start) start.value = hourToInput(item.startHour);
                                if (end) end.value = hourToInput(item.endHour);
                            });
                        }
                    } catch (e) {}
                }
                loadCampaignAgendaUI();

                async function saveCampaignAgendaUI() {
                    const topic = document.getElementById('agenda-topic').value.trim();
                    const talkingPoints = document.getElementById('agenda-points').value.trim();
                    const dailySchedule = {};
                    ['morning', 'dopahar', 'evening', 'night'].forEach(function(slot) {
                        const start = document.getElementById('schedule-' + slot + '-start');
                        const end = document.getElementById('schedule-' + slot + '-end');
                        if (start && end && start.value && end.value) {
                            dailySchedule[slot] = {
                                startHour: inputToHour(start.value),
                                endHour: inputToHour(end.value),
                                timeWindow: start.value + ' - ' + end.value
                            };
                        }
                    });
                    try {
                        const res = await fetch('/api/campaign-agenda', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ topic: topic, talkingPoints: talkingPoints, dailySchedule: dailySchedule })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('✅ Campaign agenda saved!');
                        }
                    } catch (e) {
                        alert('Error saving agenda: ' + e.message);
                    }
                }

                function onPlaygroundFileSelected(event) {
                    const file = event.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        pgImageBase64 = e.target.result;
                        pgImageMime = file.type || 'image/jpeg';
                        document.getElementById('pg-image-preview-bar').style.display = 'flex';
                        document.getElementById('pg-image-filename').innerText = '📷 ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
                    };
                    reader.readAsDataURL(file);
                }

                function clearPlaygroundImage() {
                    pgImageBase64 = null;
                    pgImageMime = null;
                    document.getElementById('pg-file-input').value = '';
                    document.getElementById('pg-image-preview-bar').style.display = 'none';
                }

                function quickPlaygroundQuery(text) {
                    document.getElementById('ai-test-input').value = text;
                    sendPlaygroundChat();
                }

                async function testPlaygroundVoterSearch() {
                    const q = document.getElementById('pg-voter-search-input').value.trim();
                    if (!q) return;
                    const resEl = document.getElementById('pg-voter-search-result');
                    resEl.innerHTML = '⏳ Searching...';
                    try {
                        const res = await fetch('/api/search-voters?q=' + encodeURIComponent(q));
                        const data = await res.json();
                        if (data && data.results && data.results.length > 0) {
                            let html = '<b>' + data.results.length + ' results found:</b><br>';
                            data.results.slice(0, 3).forEach(v => {
                                html += '<div style="margin-top:4px; padding:4px; background:white; border-radius:4px; border:1px solid #cbd5e1;">'
                                    + '🏛️ <b>' + v.name + '</b> (W' + v.ward + ', #' + v.sr_no + ')<br>'
                                    + 'Relative: ' + v.rel_name + ' (' + v.rel_type + ') | EPIC: ' + v.epic + '<br>'
                                    + 'House: ' + v.house_no + ' | Booth: ' + v.booth
                                    + '</div>';
                            });
                            resEl.innerHTML = html;
                        } else {
                            resEl.innerHTML = '❌ No slip found. Check the spelling.';
                        }
                    } catch (e) {
                        resEl.innerHTML = 'Search error: ' + e.message;
                    }
                }

                async function sendPlaygroundChat() {
                    const inputEl = document.getElementById('ai-test-input');
                    const text = inputEl.value.trim();
                    if (!text && !pgImageBase64) return;

                    const voterName = document.getElementById('pg-voter-name').value.trim();
                    const voterPhone = document.getElementById('pg-voter-phone').value.trim();
                    const campaignGoal = document.getElementById('pg-campaign-goal').value.trim();
                    const provider = document.getElementById('pg-provider').value;

                    const chatUi = document.getElementById('ai-chat-ui');

                    // Display user bubble
                    let userBubbleHtml = '<div class="bubble bubble-user">';
                    if (pgImageBase64) {
                        userBubbleHtml += '<img src="' + pgImageBase64 + '" style="max-width: 140px; border-radius: 8px; display: block; margin-bottom: 4px;">';
                    }
                    if (text) userBubbleHtml += '<div>' + text + '</div>';
                    userBubbleHtml += '</div>';
                    chatUi.innerHTML += userBubbleHtml;
                    chatUi.scrollTop = chatUi.scrollHeight;

                    inputEl.value = '';
                    const tempImgBase64 = pgImageBase64;
                    const tempImgMime = pgImageMime;
                    clearPlaygroundImage();

                    const btn = document.getElementById('btn-pg-send');
                    btn.disabled = true;
                    btn.innerText = '⏳ Thinking...';

                    try {
                        const res = await fetch('/api/playground/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                message: text,
                                history: pgAiHistory,
                                phone: voterPhone,
                                voterName: voterName,
                                campaignGoal: campaignGoal,
                                provider: provider,
                                imageBase64: tempImgBase64,
                                mimeType: tempImgMime
                            })
                        });

                        const data = await res.json();
                        if (data.success) {
                            pgAiHistory.push({ role: 'user', content: text || '[फोटो]' });
                            pgAiHistory.push({ role: 'assistant', content: data.reply });

                            let botHtml = '<div class="bubble bubble-bot">' + data.reply.split(String.fromCharCode(10)).join('<br>') + '</div>';
                            chatUi.innerHTML += botHtml;
                            chatUi.scrollTop = chatUi.scrollHeight;

                            // Update live debug metrics
                            document.getElementById('pg-metric-provider').innerText = data.provider || provider;
                            document.getElementById('pg-metric-latency').innerText = data.timeMs + ' ms';
                            document.getElementById('pg-metric-tags').innerText = ((data.user && data.user.tags) || []).join(', ') || 'Normal';
                            document.getElementById('pg-metric-drip').innerText = data.nextDripMedia ? data.nextDripMedia.title : 'Done';
                        } else {
                            chatUi.innerHTML += '<div class="bubble bubble-bot" style="color:red;">Error: ' + (data.error || 'Unknown problem') + '</div>';
                        }
                    } catch (e) {
                        chatUi.innerHTML += '<div class="bubble bubble-bot" style="color:red;">Connection error: ' + e.message + '</div>';
                    } finally {
                        btn.disabled = false;
                        btn.innerText = 'Send 🚀';
                    }
                }

                // --- Contacts Manager Client Logic ---
                let cachedContacts = [];

                async function loadContacts() {
                    const line = (document.getElementById('contact-filter-line') || {}).value || 'all';
                    const ward = (document.getElementById('contact-filter-ward') || {}).value || 'all';
                    const tbody = document.getElementById('contacts-table-body');
                    const countEl = document.getElementById('contacts-count');
                    
                    try {
                        const res = await fetch('/api/contacts?line=' + encodeURIComponent(line) + '&ward=' + encodeURIComponent(ward));
                        const data = await res.json();
                        if (data.success) {
                            cachedContacts = data.contacts || [];
                            if (countEl) countEl.innerText = cachedContacts.length;
                            renderContactsTable(cachedContacts);
                        }
                    } catch (e) {
                        console.error('Error loading contacts:', e);
                        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Error: ' + e.message + '</td></tr>';
                    }
                }

                function renderContactsTable(list) {
                    const tbody = document.getElementById('contacts-table-body');
                    if (!tbody) return;
                    if (!list || list.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:30px;">No contacts found. Add one above or import from the voter list!</td></tr>';
                        return;
                    }

                    let rows = '';
                    for (let i = 0; i < list.length; i++) {
                        const c = list[i];
                        const lineBadge = c.line === 'sim_636' ? 'Primary (636)' : (c.line === 'canada' ? 'Canada (+1)' : 'Baba Line');
                        const lineBg = c.line === 'sim_636' ? '#dbeafe; color:#1e40af' : (c.line === 'canada' ? '#fef3c7; color:#92400e' : '#dcfce7; color:#166534');
                        const safeName = (c.name || '').replace(/'/g, "\\'");
                        rows += '<tr>' +
                            '<td><input type="checkbox" class="contact-checkbox" value="' + c.id + '"></td>' +
                            '<td style="font-weight:700; color:#0f172a;">' + escapeHtml(c.name) + (c.voterMatch && c.voterMatch.matched ? '<div style="font-size:10px;color:#15803d;margin-top:2px;">✓ Voter matched • ' + escapeHtml(c.voterMatch.epic || ('Serial ' + c.voterMatch.serial)) + '</div>' : '<div style="font-size:10px;color:#64748b;margin-top:2px;">Contact only • no unique voter match</div>') + '</td>' +
                            '<td style="font-family:monospace; font-weight:600; color:#2563eb;">' + escapeHtml(c.phone) + '</td>' +
                            '<td><span style="background:#f1f5f9; padding:2px 8px; border-radius:4px; font-weight:700;">Ward ' + (c.ward || '--') + '</span></td>' +
                            '<td><span style="background:' + lineBg + '; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">' + lineBadge + '</span></td>' +
                            '<td style="font-size:12px; color:#64748b;">' + escapeHtml(c.notes || '--') + '</td>' +
                            '<td>' +
                                '<button data-phone="' + (c.phone || '') + '" data-name="' + escapeHtml(c.name || '') + '" onclick="sendQuickWhatsAppToPhone(this.dataset.phone, this.dataset.name)" style="background:#16a34a; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:700; cursor:pointer; margin-right:4px;">📲 Chat</button>' +
                                '<button data-id="' + c.id + '" onclick="deleteContactRow(this.dataset.id)" style="background:#ef4444; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:700; cursor:pointer;">✕</button>' +
                            '</td>' +
                        '</tr>';
                    }
                    tbody.innerHTML = rows;
                }

                function filterContactsTable() {
                    const q = ((document.getElementById('contact-search-input') || {}).value || '').toLowerCase().trim();
                    if (!q) {
                        renderContactsTable(cachedContacts);
                        return;
                    }
                    const filtered = cachedContacts.filter(c => 
                        (c.name && c.name.toLowerCase().includes(q)) ||
                        (c.phone && c.phone.includes(q)) ||
                        (c.notes && c.notes.toLowerCase().includes(q))
                    );
                    renderContactsTable(filtered);
                }

                async function saveSingleContact() {
                    const name = document.getElementById('new-c-name').value.trim();
                    const phone = document.getElementById('new-c-phone').value.trim();
                    const ward = document.getElementById('new-c-ward').value;
                    const line = document.getElementById('new-c-line').value;
                    const notes = document.getElementById('new-c-notes').value.trim();

                    if (!phone) { alert('Mobile number is required!'); return; }
                    try {
                        const res = await fetch('/api/contacts/add', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, phone, ward, line, notes })
                        });
                        const data = await res.json();
                        if (data.success) {
                            document.getElementById('new-c-name').value = '';
                            document.getElementById('new-c-phone').value = '';
                            document.getElementById('new-c-notes').value = '';
                            loadContacts();
                            alert('✅ Contact saved!');
                        } else {
                            alert('Error: ' + data.error);
                        }
                    } catch (e) { alert('Error: ' + e.message); }
                }

                async function deleteContactRow(id) {
                    if (!confirm('Do you want to delete this contact?')) return;
                    try {
                        const res = await fetch('/api/contacts/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id })
                        });
                        const data = await res.json();
                        if (data.success) loadContacts();
                    } catch (e) { alert('Error: ' + e.message); }
                }

                async function importVotersToContacts() {
                    const ward = document.getElementById('import-ward-select').value;
                    const line = document.getElementById('import-line-select').value;
                    const confirmMsg = 'Import the voters of ' + (ward === 'all' ? 'all wards' : 'ward ' + ward) + ' into the contact list?';
                    if (!confirm(confirmMsg)) return;

                    try {
                        const res = await fetch('/api/contacts/import-voters', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ward, line, limit: 100 })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('✅ ' + data.added + ' voters imported into the contact list!');
                            loadContacts();
                        } else {
                            alert('Error: ' + data.error);
                        }
                    } catch (e) { alert('Error: ' + e.message); }
                }

                async function uploadContactsFile() {
                    const input = document.getElementById('vcf-upload-input');
                    const file = input.files[0];
                    if (!file) { alert('Please choose a VCF, CSV or Excel (.xlsx) file!'); return; }

                    const reader = new FileReader();
                    reader.onload = async function(e) {
                        const b64 = String(e.target.result || '').replace(/^data:[^,]*,/, '');
                        try {
                            const res = await fetch('/api/contacts/import-vcf', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ fileBase64: b64, fileName: file.name })
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert('✅ ' + data.count + ' contacts imported (tag ' + ((data.saved && data.saved.tag) || '') + ') • ' + data.matched + ' voter matches • ' + (data.invalid || 0) + ' invalid • ' + (data.duplicates || 0) + ' duplicates');
                                loadContacts();
                                input.value = '';
                            } else {
                                alert('Error: ' + data.error);
                            }
                        } catch (err) { alert('Upload error: ' + err.message); }
                    };
                    reader.readAsDataURL(file);
                }

                function toggleSelectAllContacts(master) {
                    document.querySelectorAll('.contact-checkbox').forEach(cb => cb.checked = master.checked);
                }

                function sendQuickWhatsAppToPhone(phone, name) {
                    document.getElementById('v-phone').value = phone;
                    document.getElementById('v-name').value = name;
                    switchTab('feed', document.querySelector('.tab-btn'));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }

                // Initial contacts load
                setTimeout(loadContacts, 1200);

            </script>
            <script>
            (function () {
                var bulkCsvText = '';
                var bulkMediaLoaded = false;
                var bulkPreviewTimer = null;
                var NL = String.fromCharCode(10);

                function el(id) { return document.getElementById(id); }
                window.renderOutboundSettings = function (d) {
                    if (!d || !document.getElementById('ob-proactive')) return;
                    document.getElementById('ob-proactive').checked = !!d.proactiveOutbound;
                    document.getElementById('ob-quiet').checked = d.quietHours === true;
                    document.getElementById('ob-proactive-state').textContent = d.proactiveOutbound ? 'ON' : 'OFF';
                    document.getElementById('ob-quiet-state').textContent = d.quietHours === true ? 'ON' : 'OFF';
                };
                window.saveOutboundSettings = function () {
                    var body = { proactiveOutbound: document.getElementById('ob-proactive').checked, quietHours: document.getElementById('ob-quiet').checked };
                    fetch('/api/settings/outbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (j) { window.renderOutboundSettings(j && j.settings); }).catch(function () {});
                };
                fetch('/api/settings/outbound').then(function (r) { return r.json(); }).then(function (j) { window.renderOutboundSettings(j && j.settings); }).catch(function () {});

                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                function setStatus(msg, ok) { var s = el('bulk-action-status'); if (!s) return; s.style.color = ok ? '#16a34a' : '#dc2626'; s.textContent = msg; }
                function fmtEta(sec) {
                    if (sec === null || sec === undefined) return 'waiting for a connected line';
                    if (!sec) return '—';
                    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
                    return (h ? h + 'h ' : '') + m + 'm';
                }
                function selectedLines() {
                    return Array.prototype.slice.call(document.querySelectorAll('.bulk-line-cb:checked')).map(function (c) { return c.value; });
                }
                function payload() {
                    return {
                        phones: el('bulk-phones').value,
                        csvText: bulkCsvText,
                        useContacts: el('bulk-use-contacts').checked,
                        contactWard: el('bulk-contact-ward').value.trim() || undefined,
                        contactVillage: el('bulk-contact-village').value.trim() || undefined,
                        saveToContacts: el('bulk-save-contacts').checked,
                        message: el('bulk-message').value,
                        mediaFile: el('bulk-media').value || null,
                        lines: selectedLines(),
                        caps: {
                            hourlyCap: el('bulk-hourly').value, dailyCap: el('bulk-daily').value,
                            minDelaySec: el('bulk-min-delay').value, maxDelaySec: el('bulk-max-delay').value,
                            quietStartHour: el('bulk-quiet-start').value, quietEndHour: el('bulk-quiet-end').value
                        }
                    };
                }
                function postJson(url, body) {
                    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
                        .then(function (r) { return r.json().then(function (d) { d._status = r.status; return d; }); });
                }

                function renderLines(lines, campaign) {
                    var box = el('bulk-lines');
                    if (!box) return;
                    var prev = selectedLines();
                    var chosen = campaign && (campaign.status === 'running' || campaign.status === 'paused') ? campaign.lines : null;
                    box.innerHTML = lines.map(function (l) {
                        var checked = chosen ? chosen.indexOf(l.id) !== -1 : (prev.length ? prev.indexOf(l.id) !== -1 : l.connected);
                        var badge = l.connected ? (l.paused ? '⏸️ ' + esc(l.pausedReason || 'paused') : '🟢 connected') : '🔴 ' + esc(l.status);
                        return '<label style="display:block; margin-bottom:4px;"><input type="checkbox" class="bulk-line-cb" value="' + esc(l.id) + '"' + (checked ? ' checked' : '') + '> <b>' + esc(l.name) + '</b> — ' + badge +
                            ' <span style="color:#64748b; font-size:11px;">(' + l.sentLastHour + '/h, ' + l.sentToday + ' today' + (l.nextSendInSec ? ', next in ' + l.nextSendInSec + 's' : '') + ')</span></label>';
                    }).join('') || 'No lines configured';
                }

                function renderStatus(d) {
                    renderLines(d.lines || [], d.campaign);
                    var sum = el('bulk-progress-summary');
                    var c = d.campaign;
                    if (!c) { sum.textContent = 'No broadcast yet. Connected lines: ' + d.connectedLines + ' • Opted-out numbers: ' + d.optOutCount; el('bulk-progress-bar').style.width = '0%'; el('bulk-recent-body').innerHTML = ''; return; }
                    var k = c.counts;
                    var done = k.total ? Math.round(((k.sent + k.failed + k.skipped) / k.total) * 100) : 0;
                    var state = c.status + (c.pauseReason ? ' (' + c.pauseReason + ')' : '') + (c.waitingReason ? ' — waiting: ' + c.waitingReason.replace('_', ' ') : '');
                    sum.innerHTML = '<b>' + esc(state) + '</b> • ✅ sent ' + k.sent + ' • ❌ failed ' + k.failed + ' • ⏭️ skipped ' + k.skipped + ' • ⏳ remaining ' + k.remaining + ' / ' + k.total +
                        ' • ETA ' + esc(fmtEta(c.etaSeconds)) + ' • opted-out total ' + d.optOutCount;
                    el('bulk-progress-bar').style.width = done + '%';
                    el('bulk-results-link').href = '/api/broadcast/results.csv?id=' + encodeURIComponent(c.id);
                    el('bulk-recent-body').innerHTML = (c.recent || []).map(function (r) {
                        var color = r.status === 'sent' ? '#16a34a' : (r.status === 'failed' ? '#dc2626' : '#64748b');
                        return '<tr><td>' + esc(r.phone) + '</td><td>' + esc(r.name) + '</td><td style="color:' + color + '; font-weight:700;">' + esc(r.status) + '</td><td>' + esc(r.reason) + '</td><td>' + esc(r.line) + '</td><td>' + esc(r.at ? new Date(r.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '') + '</td></tr>';
                    }).join('');
                }

                function loadBulkStatus() {
                    return fetch('/api/broadcast/status').then(function (r) { return r.json(); }).then(renderStatus).catch(function (e) { setStatus('Status error: ' + e.message, false); });
                }

                function loadBulkMedia() {
                    if (bulkMediaLoaded) return;
                    fetch('/api/broadcast/media').then(function (r) { return r.json(); }).then(function (d) {
                        var sel = el('bulk-media');
                        (d.media || []).forEach(function (m) {
                            var o = document.createElement('option');
                            o.value = m.file;
                            o.textContent = (m.type === 'video' ? '🎬 ' : '🖼️ ') + m.file + ' (' + Math.round(m.size / 1024) + ' KB)';
                            sel.appendChild(o);
                        });
                        bulkMediaLoaded = true;
                    }).catch(function () {});
                }

                function runPreview() {
                    postJson('/api/broadcast/preview', payload()).then(function (d) {
                        if (!d.success) { el('bulk-preview-counts').textContent = d.error || 'Preview failed'; return; }
                        var p = d.preview;
                        el('bulk-preview').textContent = p.samples && p.samples.length ? p.samples.map(function (s) { return s.text; }).join(NL + '— — —' + NL) : '';
                        el('bulk-preview-counts').textContent = '✅ ' + p.valid + ' ready • ❌ ' + p.invalid + ' invalid • 🔁 ' + p.duplicates + ' duplicates removed • 🚫 ' + p.optedOut + ' opted-out/declined' + (p.capErrors && p.capErrors.length ? ' • ⚠️ ' + p.capErrors.join('; ') : '');
                    }).catch(function (e) { el('bulk-preview-counts').textContent = 'Preview error: ' + e.message; });
                }
                function schedulePreview() { clearTimeout(bulkPreviewTimer); bulkPreviewTimer = setTimeout(runPreview, 600); }

                function doAction(action) {
                    if (action === 'preview') return runPreview();
                    if (action === 'csv-clear') { bulkCsvText = ''; el('bulk-csv-file').value = ''; el('bulk-csv-info').textContent = ''; el('bulk-csv-clear').style.display = 'none'; return schedulePreview(); }
                    if (action === 'save-contacts') {
                        return postJson('/api/contacts/bulk-add', { text: el('bulk-phones').value, csvText: bulkCsvText }).then(function (d) {
                            setStatus(d.success ? '💾 ' + d.added + ' contacts saved (' + d.invalid + ' invalid skipped)' : (d.error || 'Save failed'), !!d.success);
                            if (d.success && typeof loadContacts === 'function') loadContacts();
                        });
                    }
                    if (action === 'export') {
                        var src = el('export-source').value;
                        var q = ['source=' + encodeURIComponent(src)];
                        if (src === 'contacts') {
                            if (el('export-ward').value.trim()) q.push('ward=' + encodeURIComponent(el('export-ward').value.trim()));
                            if (el('export-village').value.trim()) q.push('village=' + encodeURIComponent(el('export-village').value.trim()));
                        } else {
                            var st = Array.prototype.slice.call(document.querySelectorAll('.export-status:checked')).map(function (c) { return c.value; });
                            if (st.length) q.push('status=' + encodeURIComponent(st.join(',')));
                            if (el('export-reason').value) q.push('reason=' + encodeURIComponent(el('export-reason').value));
                        }
                        if (el('export-include-optout').checked) q.push('includeOptedOut=1');
                        window.location.href = '/api/export/dialer.csv?' + q.join('&');
                        return;
                    }
                    if (action === 'start') {
                        var body = payload();
                        if (!body.lines.length) return setStatus('Select at least one line', false);
                        if (!window.confirm('Start bulk send? Messages will go out slowly with random gaps.')) return;
                        return postJson('/api/broadcast/create', body).then(function (d) {
                            setStatus(d.success ? '▶️ Started: ' + d.campaign.counts.pending + ' queued' + (d.savedContacts ? ' • ' + d.savedContacts + ' saved to contacts' : '') : '❌ ' + (d.error || 'Failed'), !!d.success);
                            loadBulkStatus();
                        });
                    }
                    if (action === 'pause' || action === 'resume' || action === 'cancel') {
                        if (action === 'cancel' && !window.confirm('Cancel this broadcast? Remaining numbers will not be sent.')) return;
                        return postJson('/api/broadcast/' + action, {}).then(function (d) {
                            setStatus(d.success ? 'OK: ' + d.campaign.status : '❌ ' + (d.error || 'Failed'), !!d.success);
                            loadBulkStatus();
                        });
                    }
                }

                function initBulkTab() {
                    var btn = el('tab-btn-bulk');
                    if (btn) btn.addEventListener('click', function () {
                        switchTab(this.dataset.tab, this);
                        loadBulkMedia();
                        loadBulkStatus();
                    });
                    var tab = el('tab-bulk');
                    if (!tab) return;
                    tab.addEventListener('click', function (e) {
                        var t = e.target.closest('[data-action]');
                        if (t && tab.contains(t)) { e.preventDefault(); doAction(t.dataset.action); }
                    });
                    el('bulk-message').addEventListener('input', schedulePreview);
                    el('bulk-phones').addEventListener('input', schedulePreview);
                    el('bulk-use-contacts').addEventListener('change', schedulePreview);
                    el('bulk-agenda-slot').addEventListener('change', function () {
                        var slot = this.value;
                        if (!slot) return;
                        fetch('/api/agenda/day').then(function (r) { return r.json(); }).then(function (d) {
                            var item = d.merged && d.merged.dailySchedule && d.merged.dailySchedule[slot];
                            if (!item) return;
                            if (item.hook) el('bulk-message').value = item.hook;
                            if (item.mediaFile) {
                                var sel = el('bulk-media');
                                if (!Array.prototype.some.call(sel.options, function (o) { return o.value === item.mediaFile; })) { var o = document.createElement('option'); o.value = item.mediaFile; o.textContent = item.mediaFile; sel.appendChild(o); }
                                sel.value = item.mediaFile;
                            }
                            schedulePreview();
                        });
                    });
                    el('export-source').addEventListener('change', function () {
                        var b = this.value === 'broadcast';
                        el('export-broadcast-filters').style.display = b ? 'inline' : 'none';
                        el('export-contact-filters').style.display = b ? 'none' : 'inline';
                    });
                    el('bulk-csv-file').addEventListener('change', function () {
                        var f = this.files && this.files[0];
                        if (!f) return;
                        var reader = new FileReader();
                        reader.onload = function (ev) {
                            bulkCsvText = String(ev.target.result || '');
                            var rows = bulkCsvText.split(NL).filter(function (l) { return l.trim(); }).length;
                            el('bulk-csv-info').textContent = '✅ ' + f.name + ' (' + rows + ' lines)';
                            el('bulk-csv-clear').style.display = 'inline-block';
                            schedulePreview();
                        };
                        reader.readAsText(f);
                    });
                    setInterval(function () { if (tab.style.display !== 'none') loadBulkStatus(); }, 5000);
                }

                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBulkTab); else initBulkTab();
            })();
            </script>
            <script>
            (function () {
                var SLOTS = [['morning', '🌅 Morning'], ['dopahar', '☀️ Afternoon'], ['evening', '🌇 Evening'], ['night', '🌙 Night']];
                var mediaCache = [];
                function el(id) { return document.getElementById(id); }
                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                function postJson(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }
                function todayIst() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }

                // ---------- Media Bank ----------
                function loadMedia() {
                    var box = el('hm-list');
                    if (box && !mediaCache.length) box.innerHTML = '<div style="color:#64748b; font-size:12px;">⏳ Loading media…</div>';
                    return fetch('/api/media/list', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    }).then(function (d) {
                        mediaCache = d.media || [];
                        renderMediaList();
                        refreshMediaSelects();
                    }).catch(function (e) {
                        if (box) box.innerHTML = '<div style="color:#b91c1c; font-size:12px;">⚠️ Media list failed to load (' + esc(e.message) + ') — <button type="button" onclick="window.hkLoadMedia()">retry</button></div>';
                    });
                }
                window.hkLoadMedia = loadMedia;
                function refreshMediaSelects() {
                    var bulk = el('bulk-media');
                    if (bulk) {
                        var cur = bulk.value;
                        bulk.innerHTML = '<option value="">— text only —</option>' + mediaCache.map(function (m) { return '<option value="' + esc(m.file) + '">' + (m.type === 'video' ? '🎬 ' : (m.type === 'document' ? '📄 ' : '🖼️ ')) + esc(m.file) + '</option>'; }).join('');
                        bulk.value = cur;
                    }
                    document.querySelectorAll('.ha-media').forEach(function (sel) {
                        var v = sel.value || sel.dataset.value || '';
                        sel.innerHTML = '<option value="">— none —</option>' + mediaCache.map(function (m) { return '<option value="' + esc(m.file) + '">' + esc(m.file) + '</option>'; }).join('');
                        sel.value = v;
                    });
                }
                window.hkRefreshMediaSelects = refreshMediaSelects;
                function renderMediaList() {
                    var box = el('hm-list');
                    if (!box) return;
                    box.innerHTML = mediaCache.map(function (m) {
                        var thumb = m.type === 'image' ? '<img src="' + esc(m.url) + '" style="width:100%; height:100px; object-fit:cover; border-radius:6px;">'
                            : '<div style="height:100px; display:flex; align-items:center; justify-content:center; background:#0f172a; color:white; border-radius:6px; font-size:30px;">' + (m.type === 'video' ? '🎬' : '📄') + '</div>';
                        return '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:6px; font-size:11px;">' + thumb +
                            '<div style="word-break:break-all; margin:4px 0;">' + esc(m.file) + ' (' + Math.round(m.size / 1024) + ' KB)</div>' +
                            '<button type="button" data-media-action="use" data-file="' + esc(m.file) + '" style="font-size:11px; padding:2px 6px; border:none; border-radius:4px; background:#16a34a; color:white; cursor:pointer;">📣 Bulk Send</button> ' +
                            '<a href="' + esc(m.url) + '" target="_blank" style="font-size:11px;">open</a> ' +
                            (m.protected ? '' : '<button type="button" data-media-action="delete" data-file="' + esc(m.file) + '" style="font-size:11px; padding:2px 6px; border:none; border-radius:4px; background:#ef4444; color:white; cursor:pointer;">✕</button>') +
                            '</div>';
                    }).join('') || '<div style="color:#64748b; font-size:12px;">No media yet</div>';
                }
                function uploadFiles(files) {
                    var list = Array.prototype.slice.call(files || []);
                    if (!list.length) return;
                    var status = el('hm-status');
                    var done = 0;
                    function next() {
                        if (!list.length) { status.style.color = '#16a34a'; status.textContent = '✅ ' + done + ' file(s) uploaded'; loadMedia(); return; }
                        var f = list.shift();
                        if (f.size > 45 * 1024 * 1024) { status.style.color = '#dc2626'; status.textContent = '❌ ' + f.name + ' is larger than 45 MB'; return next(); }
                        status.style.color = '#0369a1'; status.textContent = '⏳ Uploading ' + f.name + '…';
                        var reader = new FileReader();
                        reader.onload = function (ev) {
                            postJson('/api/media/upload', { fileName: f.name, base64Data: ev.target.result }).then(function (d) {
                                if (d.success) done++; else { status.style.color = '#dc2626'; status.textContent = '❌ ' + (d.error || 'Upload failed'); }
                                next();
                            }).catch(function (e) { status.textContent = '❌ ' + e.message; next(); });
                        };
                        reader.readAsDataURL(f);
                    }
                    next();
                }

                // ---------- Goal & progress ----------
                function bar(v, t) { var p = t ? Math.min(100, Math.round(v / t * 100)) : 0; return '<div style="background:#e2e8f0; border-radius:5px; height:8px;"><div style="background:#16a34a; width:' + p + '%; height:8px; border-radius:5px;"></div></div>'; }
                function table(map, keyLabel) {
                    var keys = Object.keys(map || {});
                    if (!keys.length) return '<span style="color:#64748b;">No activity yet today</span>';
                    return '<table class="table"><thead><tr><th>' + keyLabel + '</th><th>Reached</th><th>Replies</th><th>Leaning</th><th>Sure</th><th>Opposed</th></tr></thead><tbody>' +
                        keys.map(function (k) { var v = map[k]; return '<tr><td>' + esc(k) + '</td><td>' + v.reached + '</td><td>' + v.replies + '</td><td>' + (v.leaning || 0) + '</td><td><b>' + v.committed + '</b></td><td>' + (v.opposed || 0) + '</td></tr>'; }).join('') + '</tbody></table>';
                }
                function loadGoal() {
                    fetch('/api/daily-goal/progress').then(function (r) { return r.json(); }).then(function (d) {
                        var p = d.progress, g = p.goal || {}, t = d.totals || {};
                        if (document.activeElement && document.activeElement.id && document.activeElement.id.indexOf('hg-') === 0) { /* user typing */ } else {
                            el('hg-title').value = g.title || ''; el('hg-instruction').value = g.instruction || '';
                            el('hg-target').value = g.targetContacts || 0; el('hg-target-committed').value = g.targetCommitted || 0;
                            el('hg-ward').value = g.targetWard || ''; el('hg-task').value = g.task || '';
                        }
                        el('hg-progress').innerHTML = '👥 Reached: <b>' + p.reached + '</b> / ' + p.targetContacts + bar(p.reached, p.targetContacts) +
                            '<div style="margin-top:6px;">✅ Sure votes today: <b>' + p.committedToday + '</b> / ' + p.targetCommitted + '</div>' + bar(p.committedToday, p.targetCommitted) +
                            '<div style="margin-top:6px; font-size:12px;">💬 ' + p.replies + ' replies from ' + p.repliedPeople + ' people • 🔴 ' + p.opposedToday + ' opposed today</div>' +
                            '<div style="margin-top:6px; font-size:12px;">📋 Problems (samasya) logged today: <b>' + (p.samasyaToday || 0) + '</b> (open ' + (p.samasyaOpen || 0) + ') • 🤝 Meeting requests (mulaqat) / home visits: <b>' + (p.mulaqatToday || 0) + '</b> (pending ' + (p.mulaqatOpen || 0) + ')</div>';
                        var sc = Object.keys(p.stageChanges || {}).map(function (k) { return esc(k) + ': ' + p.stageChanges[k]; }).join(' • ');
                        el('hg-funnel').innerHTML = '<b>All contacts:</b> ⚪ unknown ' + (t.unknown || 0) + ' • 🟡 undecided ' + (t.undecided || 0) + ' • 🟢 leaning ' + (t.leaning || 0) + ' • ✅ committed ' + (t.committed || 0) + ' • 🔴 opposed ' + (t.opposed || 0) + ' • 🚩 needs admin ' + (t.needsAdmin || 0) +
                            (sc ? '<div style="margin-top:4px;"><b>Stage changes today:</b> ' + sc + '</div>' : '');
                        el('hg-by-line').innerHTML = table(p.byLine, 'Line');
                        el('hg-by-ward').innerHTML = table(p.byWard, 'Ward');
                        var hist = (d.history || []).filter(function (h) { return h.summary; }).map(function (h) { return h.summary.text; });
                        el('hg-summary').textContent = (p.summary ? p.summary.text : '') + (hist.length ? String.fromCharCode(10, 10) + 'Earlier: ' + String.fromCharCode(10) + hist.slice(0, 5).join(String.fromCharCode(10)) : '');
                    }).catch(function () {});
                }

                // ---------- Agenda per day ----------
                function renderSlots(merged, day) {
                    el('ha-slots').innerHTML = SLOTS.map(function (s) {
                        var base = (merged && merged.dailySchedule && merged.dailySchedule[s[0]]) || {};
                        var d = (day && day.slots && day.slots[s[0]]) || {};
                        return '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:8px; font-size:12px;"><b>' + s[1] + '</b> <span style="color:#64748b;">' + esc(base.timeWindow || '') + '</span>' +
                            '<div style="margin-top:4px;">Media: <select class="ha-media" data-slot="' + s[0] + '" data-value="' + esc(d.mediaFile || base.mediaFile || '') + '" style="max-width:170px; font-size:12px;"></select></div>' +
                            '<textarea class="ha-hook" data-slot="' + s[0] + '" rows="3" style="width:100%; box-sizing:border-box; margin-top:4px; font-size:12px;">' + esc(d.hook || base.hook || '') + '</textarea></div>';
                    }).join('');
                    refreshMediaSelects();
                }
                function loadDay() {
                    var date = el('ha-date').value || todayIst();
                    fetch('/api/agenda/day?date=' + encodeURIComponent(date)).then(function (r) { return r.json(); }).then(function (d) {
                        el('ha-topic').value = (d.day && d.day.topic) || (d.merged && d.merged.topic) || '';
                        el('ha-points').value = (d.day && d.day.talkingPoints) || (d.merged && d.merged.talkingPoints) || '';
                        el('ha-days').textContent = (d.days || []).length ? 'Saved days: ' + d.days.map(function (x) { return x.date; }).join(', ') : '';
                        renderSlots(d.merged, d.day);
                    });
                }

                function onGoalAction(a) {
                    if (a === 'save-goal') {
                        postJson('/api/daily-target', { title: el('hg-title').value, instruction: el('hg-instruction').value, targetContacts: el('hg-target').value, targetCommitted: el('hg-target-committed').value, targetWard: el('hg-ward').value.trim(), task: el('hg-task').value })
                            .then(function (d) { el('hg-goal-status').textContent = d.error ? '❌ ' + d.error : '✅ Saved'; loadGoal(); });
                    } else if (a === 'summary') {
                        postJson('/api/daily-goal/summary', {}).then(function (d) { el('hg-summary').textContent = d.summary || ''; });
                    } else if (a === 'load-day') {
                        loadDay();
                    } else if (a === 'save-day') {
                        var slots = {};
                        document.querySelectorAll('.ha-media').forEach(function (sel) { slots[sel.dataset.slot] = slots[sel.dataset.slot] || {}; slots[sel.dataset.slot].mediaFile = sel.value; });
                        document.querySelectorAll('.ha-hook').forEach(function (ta) { slots[ta.dataset.slot] = slots[ta.dataset.slot] || {}; slots[ta.dataset.slot].hook = ta.value; });
                        postJson('/api/agenda/day', { date: el('ha-date').value || todayIst(), topic: el('ha-topic').value, talkingPoints: el('ha-points').value, slots: slots })
                            .then(function (d) { el('ha-status').textContent = d.success ? '✅ Saved' : '❌ ' + (d.error || 'Failed'); loadDay(); });
                    }
                }

                function init() {
                    var gb = el('tab-btn-goal');
                    if (gb) gb.addEventListener('click', function () { switchTab(this.dataset.tab, this); loadMedia().then(loadDay); loadGoal(); });
                    var gt = el('tab-goal');
                    if (gt) {
                        el('ha-date').value = todayIst();
                        gt.addEventListener('click', function (e) { var t = e.target.closest('[data-goal-action]'); if (t) { e.preventDefault(); onGoalAction(t.dataset.goalAction); } });
                        setInterval(function () { if (gt.style.display !== 'none') loadGoal(); }, 10000);
                    }
                    var drop = el('hm-drop'), file = el('hm-file');
                    if (drop && file) {
                        drop.addEventListener('click', function (e) { if (e.target !== file) file.click(); });
                        file.addEventListener('change', function () { uploadFiles(this.files); this.value = ''; });
                        drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.background = '#e0f2fe'; });
                        drop.addEventListener('dragleave', function () { drop.style.background = '#f8fafc'; });
                        drop.addEventListener('drop', function (e) { e.preventDefault(); drop.style.background = '#f8fafc'; uploadFiles(e.dataTransfer.files); });
                    }
                    var ml = el('hm-list');
                    if (ml) ml.addEventListener('click', function (e) {
                        var t = e.target.closest('[data-media-action]');
                        if (!t) return;
                        if (t.dataset.mediaAction === 'use') {
                            refreshMediaSelects();
                            var bulk = el('bulk-media'); if (bulk) bulk.value = t.dataset.file;
                            var bb = el('tab-btn-bulk'); if (bb) bb.click();
                        } else if (t.dataset.mediaAction === 'delete') {
                            if (!window.confirm('Delete ' + t.dataset.file + '?')) return;
                            postJson('/api/media/delete', { file: t.dataset.file }).then(loadMedia);
                        }
                    });
                    var mb = el('tab-btn-media');
                    if (mb) mb.addEventListener('click', function () { loadMedia(); });
                    var sf = el('crm-stage-filter');
                    if (sf) sf.addEventListener('change', function () { if (typeof applyVoterFilters === 'function') applyVoterFilters(); });
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
            })();
            </script>
            <script>
            (function () {
                function el(id) { return document.getElementById(id); }
                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                var defaultScript = [];
                function fillLines(lines) {
                    ['st-tester', 'st-target'].forEach(function (id, idx) {
                        var sel = el(id); if (!sel) return;
                        var keep = sel.value;
                        sel.innerHTML = (lines || []).map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + ' — ' + esc(l.status) + '</option>'; }).join('');
                        if (keep) sel.value = keep; else if (lines && lines[idx]) sel.value = lines[idx === 0 ? (lines.length > 2 ? 2 : 1) : 0].id;
                    });
                }
                function render(d) {
                    if (!d) return;
                    var st = el('st-status');
                    if (st) st.textContent = d.status === 'idle' ? 'Idle' : (String(d.status || '').toUpperCase() + (d.total ? ' — turn ' + d.turn + '/' + d.total : '') + (d.error ? ' — ' + d.error : ''));
                    var sum = el('st-summary');
                    if (sum) sum.innerHTML = d.id ? ('Run <b>' + esc(d.id) + '</b>: ' + esc(d.testerLine) + ' → ' + esc(d.targetLine) + ' · ✅ ' + (d.passed || 0) + ' · ❌ ' + (d.failed || 0) + ' · <a href="/api/self-test/result/' + esc(d.id) + '.json">JSON</a> · <a href="/api/self-test/result/' + esc(d.id) + '.md">Markdown</a>') : '';
                    var tr = el('st-transcript');
                    if (tr) tr.innerHTML = (d.turns || []).map(function (t) {
                        var checks = Object.keys(t.checks || {}).map(function (k) { return (t.checks[k] ? '✅ ' : '❌ ') + esc(k); }).join(' · ');
                        return '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:8px; margin-bottom:6px; background:' + (t.pass ? '#f0fdf4' : '#fef2f2') + ';">' +
                            '<div><b>' + t.n + '. Voter:</b> ' + esc(t.voter) + '</div>' +
                            (t.replies && t.replies.length ? t.replies.map(function (r) { return '<div style="margin-top:4px;"><b>Bot:</b> ' + esc(r) + '</div>'; }).join('') : '<div style="margin-top:4px; color:#dc2626;"><b>Bot:</b> (no reply)</div>') +
                            '<div style="font-size:11px; color:#475569; margin-top:4px;">' + (t.latencyMs === null || t.latencyMs === undefined ? 'no reply' : (t.latencyMs / 1000).toFixed(1) + 's') + ' · ' + checks + '</div></div>';
                    }).join('');
                }
                function loadRuns() {
                    return fetch('/api/self-test/runs').then(function (r) { return r.json(); }).then(function (d) {
                        var box = el('st-runs'); if (!box) return;
                        var runs = (d && d.runs) || [];
                        box.innerHTML = runs.length ? runs.map(function (r) { return '<div>' + esc(r.startedAt) + ' · ' + esc(r.testerLine) + ' → ' + esc(r.targetLine) + ' · <b>' + esc(r.status) + '</b> (' + (r.passed || 0) + '/' + ((r.passed || 0) + (r.failed || 0)) + ') · <a href="/api/self-test/result/' + esc(r.id) + '.json">JSON</a> · <a href="/api/self-test/result/' + esc(r.id) + '.md">MD</a></div>'; }).join('') : 'No runs yet.';
                    }).catch(function () {});
                }
                function loadStatus() {
                    return fetch('/api/self-test/status').then(function (r) { return r.json(); }).then(function (d) {
                        if (!d) return;
                        fillLines(d.lines);
                        if (d.defaultScript) defaultScript = d.defaultScript;
                        var ta = el('st-script');
                        if (ta && !ta.value && defaultScript && defaultScript.length) ta.placeholder = defaultScript.map(function (x) { return x.text + (x.expectRef ? ' || ' + x.expectRef.join(', ') : ''); }).join(String.fromCharCode(10));
                        render(d);
                    }).catch(function () {});
                }
                function start() {
                    var body = { testerLine: el('st-tester') ? el('st-tester').value : '', targetLine: el('st-target') ? el('st-target').value : '', script: el('st-script') ? el('st-script').value : '' };
                    if (body.testerLine === body.targetLine) { if (el('st-status')) el('st-status').textContent = 'Pick two different lines'; return; }
                    fetch('/api/self-test/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                        .then(function (r) { return r.json(); }).then(function (d) { if (d && d.error && el('st-status')) el('st-status').textContent = '❌ ' + d.error; else render(d); });
                }
                function init() {
                    var tb = el('tab-btn-selftest');
                    if (tb) tb.addEventListener('click', function () { if (typeof switchTab === 'function') switchTab(this.dataset.tab, this); loadStatus(); loadRuns(); });
                    var sb = el('st-start'); if (sb) sb.addEventListener('click', start);
                    var xb = el('st-stop'); if (xb) xb.addEventListener('click', function () { fetch('/api/self-test/stop', { method: 'POST' }).then(function (r) { return r.json(); }).then(render); });
                    var tab = el('tab-selftest');
                    if (tab) setInterval(function () { if (tab.style.display !== 'none') { loadStatus(); } }, 3000);
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
            })();
            </script>
            <script>
            (function () {
                function el(id) { return document.getElementById(id); }
                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                function val(id) { var e = el(id); return e ? (e.type === 'checkbox' ? (e.checked ? '1' : '') : e.value) : ''; }
                function qs(pairs) { return pairs.filter(function (p) { return p[1]; }).map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'); }
                function postJson(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }
                var VILL = { sihali_khurd: 'Sihali Khurd', sihali_kalan: 'Sihali Kalan', hadahedi: 'Hadahedi' };
                var CATS = {};
                function statusSelect(kind, id, cur, list) {
                    return '<select data-kind="' + kind + '" data-id="' + esc(id) + '" class="v3-status">' + list.map(function (s) { return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>';
                }
                function th(cols) { return '<tr style="background:#f1f5f9; text-align:left;">' + cols.map(function (c) { return '<th style="padding:5px; border-bottom:1px solid #e2e8f0;">' + c + '</th>'; }).join('') + '</tr>'; }
                function td(v) { return '<td style="padding:5px; border-bottom:1px solid #f1f5f9; vertical-align:top;">' + v + '</td>'; }
                function loadSamasya() {
                    var q = qs([['village', val('sm-village')], ['ward', val('sm-ward')], ['status', val('sm-status')], ['category', val('sm-category')], ['q', val('sm-q')], ['includeTest', val('sm-test')]]);
                    var a = el('sm-csv'); if (a) a.href = '/api/samasya.csv' + (q ? '?' + q : '');
                    return fetch('/api/samasya' + (q ? '?' + q : '')).then(function (r) { return r.json(); }).then(function (d) {
                        if (!d) return;
                        CATS = d.categories || {};
                        var cs = el('sm-category');
                        if (cs && cs.options && cs.options.length <= 1) { cs.innerHTML = '<option value="">All categories</option>' + Object.keys(CATS).map(function (k) { return '<option value="' + k + '">' + esc(CATS[k]) + '</option>'; }).join(''); }
                        var c = d.counts || {}; var bs = c.byStatus || {};
                        if (el('sm-counts')) el('sm-counts').textContent = 'Total ' + (c.total || 0) + ' • today ' + (c.today || 0) + ' • new ' + (bs['new'] || 0) + ' • in-progress ' + (bs['in-progress'] || 0) + ' • resolved ' + (bs.resolved || 0);
                        var rows = (d.records || []).map(function (r) {
                            return '<tr' + (r.test ? ' style="background:#fef9c3;"' : '') + '>' + td('<b>' + esc(r.id) + '</b><br>' + esc(r.createdAtIST)) + td(esc(r.name || '') + '<br>' + esc(r.phone || '')) +
                                td(esc(VILL[r.village] || r.village || '') + (r.ward ? '<br>Ward ' + esc(r.ward) : '')) + td(esc(CATS[r.category] || r.category)) +
                                td(esc(r.description)) + td(esc(r.location || '')) + td(esc(r.since || '')) + td(esc(r.sankalp || '')) +
                                td(statusSelect('samasya', r.id, r.status, ['new', 'in-progress', 'resolved'])) +
                                td('<input class="v3-notes" data-kind="samasya" data-id="' + esc(r.id) + '" value="' + esc(r.notes || '') + '" placeholder="notes" style="width:120px;">') + '</tr>';
                        }).join('');
                        el('sm-list').innerHTML = '<table style="width:100%; border-collapse:collapse;">' + th(['ID / date', 'Voter', 'Village / ward', 'Category', 'Problem (voter words)', 'Where', 'Since', 'Linked sankalp', 'Status', 'Notes']) + (rows || '<tr><td colspan="10" style="padding:10px;">No records.</td></tr>') + '</table>';
                    }).catch(function () {});
                }
                function loadMulaqat() {
                    var q = qs([['village', val('mq-village')], ['ward', val('mq-ward')], ['status', val('mq-status')], ['q', val('mq-q')], ['includeTest', val('mq-test')]]);
                    var a = el('mq-csv'); if (a) a.href = '/api/mulaqat.csv' + (q ? '?' + q : '');
                    return fetch('/api/mulaqat' + (q ? '?' + q : '')).then(function (r) { return r.json(); }).then(function (d) {
                        if (!d) return;
                        var c = d.counts || {}; var bs = c.byStatus || {};
                        if (el('mq-counts')) el('mq-counts').textContent = 'Total ' + (c.total || 0) + ' • today ' + (c.today || 0) + ' • requested ' + (bs.requested || 0) + ' • confirmed ' + (bs.confirmed || 0) + ' • done ' + (bs.done || 0);
                        var rows = (d.records || []).map(function (r) {
                            return '<tr' + (r.test ? ' style="background:#fef9c3;"' : '') + '>' + td('<b>' + esc(r.id) + '</b><br>' + esc(r.createdAtIST)) + td(esc(r.type || 'visit')) + td(esc(r.name || '') + '<br>' + esc(r.phone || '')) +
                                td(esc(VILL[r.village] || r.village || '') + (r.ward ? '<br>Ward ' + esc(r.ward) : '')) + td(esc(r.preferredWhen || '') + (r.preferredDate ? '<br>(' + esc(r.preferredDate) + ')' : '')) +
                                td(esc(r.place || '')) + td(esc(r.familyMembers || '')) + td(esc(r.purpose || '')) +
                                td(statusSelect('mulaqat', r.id, r.status, ['requested', 'confirmed', 'done', 'cancelled'])) +
                                td('<input class="v3-notes" data-kind="mulaqat" data-id="' + esc(r.id) + '" value="' + esc(r.notes || '') + '" placeholder="notes / confirmed time" style="width:140px;">') + '</tr>';
                        }).join('');
                        el('mq-list').innerHTML = '<table style="width:100%; border-collapse:collapse;">' + th(['ID / date', 'Type', 'Voter', 'Village / ward', 'Preferred day+time', 'Place / landmark', 'Family', 'Purpose', 'Status', 'Notes']) + (rows || '<tr><td colspan="10" style="padding:10px;">No requests.</td></tr>') + '</table>';
                    }).catch(function () {});
                }
                function loadPlan() {
                    var q = qs([['stage', val('vp-stage')], ['q', val('vp-q')], ['includeTest', val('vp-test')]]);
                    return fetch('/api/voter-plan' + (q ? '?' + q : '')).then(function (r) { return r.json(); }).then(function (d) {
                        if (!d) return;
                        if (el('vp-total')) el('vp-total').textContent = (d.rows || []).length + ' shown of ' + (d.total || 0);
                        var rows = (d.rows || []).map(function (r) {
                            var c = r.card || {};
                            var card = [c.village ? esc(c.village) : '', c.ward ? 'ward ' + esc(c.ward) : '', c.age ? 'age ' + esc(c.age) : '', c.gender ? esc(c.gender) : '', c.familyVotes ? esc(c.familyVotes) + ' family votes' : ''].filter(Boolean).join(' • ') +
                                (c.concerns ? '<br>concerns: ' + esc([].concat(c.concerns).join('; ')) : '') + (c.objections ? '<br>objections: ' + esc([].concat(c.objections).join('; ')) : '');
                            var sm = (r.samasya || []).map(function (s) { return esc(s.id) + ' ' + esc(CATS[s.category] || s.category) + ' (' + esc(s.status) + ')'; }).join('<br>');
                            var mq = r.mulaqat ? esc(r.mulaqat.id) + ' ' + esc(r.mulaqat.status) + (r.mulaqat.preferredWhen ? '<br>' + esc(r.mulaqat.preferredWhen) : '') : '';
                            var nx = r.next || {};
                            var next = (nx.kind ? '<b>' + esc(nx.kind) + '</b> — ' : '') + esc(nx.whenLabel || '') + (nx.text ? '<div style="color:#475569; margin-top:3px;">' + esc(nx.text) + '</div>' : '');
                            return '<tr' + (r.test ? ' style="background:#fef9c3;"' : '') + '>' + td('<b>' + esc(r.name || '—') + '</b><br>' + esc(r.phone) + '<br>' + esc(r.line)) + td(esc(r.stage) + (r.optedOut ? '<br>🚫 STOP' : '') + (r.flow ? '<br>flow: ' + esc(r.flow) : '')) + td(card) + td(sm) + td(mq) + td(next) + '</tr>';
                        }).join('');
                        el('vp-list').innerHTML = '<table style="width:100%; border-collapse:collapse;">' + th(['Voter', 'Stage', 'Memory card', 'Open samasya', 'Mulaqat', 'Next planned action']) + (rows || '<tr><td colspan="6" style="padding:10px;">No voters.</td></tr>') + '</table>';
                    }).catch(function () {});
                }
                function onChange(e) {
                    var t = e.target;
                    if (!t || !t.dataset || !t.dataset.kind) return;
                    var url = '/api/' + t.dataset.kind + '/update';
                    var body = { id: t.dataset.id };
                    if (t.className === 'v3-status') body.status = t.value; else body.notes = t.value;
                    postJson(url, body).then(function () { if (t.dataset.kind === 'samasya') loadSamasya(); else loadMulaqat(); });
                }
                function bindTab(btnId, tabId, loader, refreshId, filterIds) {
                    var b = el(btnId);
                    if (b) b.addEventListener('click', function () { if (typeof switchTab === 'function') switchTab(this.dataset.tab, this); loader(); });
                    var r = el(refreshId); if (r) r.addEventListener('click', loader);
                    (filterIds || []).forEach(function (id) { var f = el(id); if (f) f.addEventListener('change', loader); });
                    var tab = el(tabId);
                    if (tab) tab.addEventListener('change', onChange);
                }
                function init() {
                    bindTab('tab-btn-samasya', 'tab-samasya', loadSamasya, 'sm-refresh', ['sm-village', 'sm-ward', 'sm-status', 'sm-category', 'sm-q', 'sm-test']);
                    bindTab('tab-btn-mulaqat', 'tab-mulaqat', loadMulaqat, 'mq-refresh', ['mq-village', 'mq-ward', 'mq-status', 'mq-q', 'mq-test']);
                    bindTab('tab-btn-plan', 'tab-plan', loadPlan, 'vp-refresh', ['vp-stage', 'vp-q', 'vp-test']);
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
            })();
            </script>${opsRoutes.ui.script()}${statusRoutes.ui.script()}${crmUi.script()}${ocRoutes.ui.script()}${dashAuth.ui.script()}
        </body>
        </html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    // Public: liveness only. The detailed view (sessions, queue, settings) needs a login or the PIN header.
    const base = { status: 'ok', mode: DASHBOARD_ONLY ? 'dashboard-only' : 'live', uptime: process.uptime(), brain: 'v3' };
    let authed = false;
    try { const hp = req.headers['x-campaign-pin']; authed = !!(req.dashUser || (hp && hp === CAMPAIGN_PIN)); } catch (e) {}
    if (!authed) return res.json({ ...base, linesConnected: SESSIONS.filter(s => s.status === 'CONNECTED').length, lines: SESSIONS.length });
    res.json({
        ...base,
        publicDashboardUrl: PUBLIC_DASHBOARD_URL || null,
        selfTest: liveSelfTest.isActive() ? 'running' : 'idle',
        silencePeriod: followupPlanner.inSilencePeriod(new Date()),
        outbound: require('./outbound_settings.js').get(),
        incomingQueue: incomingQueue.status(),
        sessions: SESSIONS.map(s => ({
            id: s.id,
            status: s.status,
            user: s.sock?.user
        }))
    });
});

// Deploy hold (5 Nov): a restart mid-conversation can leave half-written signal sessions ("Bad MAC") and
// "Waiting for this message" bubbles. So auto-update waits while: a scheduled bulk is running inside its window,
// the IST time is inside the bulk windows (09:00–11:30, 17:30–20:00), or a message moved in the last 45 s.
// Override: deploy_force.json (gitignored) with {"until": <epoch ms>} lets an urgent fix through.
let LAST_TRAFFIC_AT = 0;
function noteTraffic() { LAST_TRAFFIC_AT = Date.now(); }
function deployHoldReason(now = Date.now()) {
    try { const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy_force.json'), 'utf8')); if (f && Number(f.until) > now) return null; } catch (_) {}
    const ist = new Date(now + 5.5 * 3600e3); const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if ((mins >= 9 * 60 && mins < 11 * 60 + 30) || (mins >= 17 * 60 + 30 && mins < 20 * 60)) return 'bulk window (IST 09:00–11:30 / 17:30–20:00)';
    try {
        const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'scheduled_campaigns.json'), 'utf8'));
        const live = Object.values(st.campaigns || {}).find(c => c && !c.test && ['running', 'scheduled'].includes(c.status) && Number(c.windowStart) <= now + 10 * 60e3 && Number(c.windowEnd) + 60 * 60e3 >= now);
        if (live) return 'scheduled bulk running: ' + (live.name || live.id);
    } catch (_) {}
    if (now - LAST_TRAFFIC_AT < 45e3) return 'chat traffic in the last 45 s';
    return null;
}

// Graceful stop: save the retry store + let pending auth-key writes finish before pm2 kills us
let __stopping = false;
function gracefulStop(sig) {
    if (__stopping) return; __stopping = true;
    console.log(`[Shutdown] ${sig}: flushing message store and auth keys...`);
    try { const { BufferJSON: BJ } = require('@whiskeysockets/baileys'); fs.writeFileSync(MSG_STORE_FILE, JSON.stringify([...MSG_STORE.entries()], BJ.replacer)); } catch (e) { console.error('[Shutdown] store', e.message); }
    setTimeout(() => process.exit(0), 1200);
}
if (!DASHBOARD_ONLY) { process.on('SIGINT', () => gracefulStop('SIGINT')); process.on('SIGTERM', () => gracefulStop('SIGTERM')); }

// Background Auto-Sync Watchdog (Checks GitHub every 35s, resets cleanly, installs fonts, reloads PM2)
if (process.platform === 'linux') {
    console.log('[AutoSync] 🛡️ Continuous GitHub Auto-Update Watchdog Active (every 35s)');
    if (!DASHBOARD_ONLY) setInterval(() => {
        exec(`git fetch origin ${DEPLOY_BRANCH} > /dev/null 2>&1`, (err) => {
            if (err) return;
            exec(`git rev-parse HEAD && git rev-parse origin/${DEPLOY_BRANCH} && git rev-list --count HEAD..origin/${DEPLOY_BRANCH}`, (err2, stdout2) => {
                if (err2 || !stdout2) return;
                const hashes = stdout2.trim().split(/\s+/);
                const remoteAheadCount = Number(hashes[2] || 0);
                if (hashes.length >= 3 && remoteAheadCount > 0) {
                    const hold = deployHoldReason();
                    if (hold) { if (!global.__lastHoldLog || Date.now() - global.__lastHoldLog > 10 * 60e3) { console.log(`[AutoSync] ⏸ update waiting: ${hold}`); global.__lastHoldLog = Date.now(); } global.__deployHold = hold; return; }
                    global.__deployHold = null;
                    console.log(`[AutoSync] 🚀 New GitHub commit detected (${hashes[0].slice(0,7)} -> ${hashes[1].slice(0,7)})! Auto-updating...`);
                    const updateCmd = [
                        `git merge --ff-only origin/${DEPLOY_BRANCH}`,
                        'npm ci --omit=dev',
                        'mkdir -p ~/.fonts ~/.local/share/fonts',
                        'cp media/*.ttf ~/.fonts/ 2>/dev/null || true',
                        'cp media/*.ttf ~/.local/share/fonts/ 2>/dev/null || true',
                        'fc-cache -f ~/.fonts 2>/dev/null || true',
                        'pm2 restart whatsapp-bot --update-env',
                        'pm2 save'
                    ].join(' && ');

                    exec(updateCmd, (updateErr, updateOut) => {
                        if (updateErr) {
                            console.error('[AutoSync] Error during auto-deploy:', updateErr.message);
                        } else {
                            console.log('[AutoSync] ✅ Auto-update and PM2 restart completed successfully!');
                        }
                    });
                }
            });
        });
    }, 35000);
}


    // v6: operator-set per-voter follow-ups (the operator's setting is the trigger; not gated by the proactive toggle)
    if (!DASHBOARD_ONLY) setInterval(() => { runOperatorFollowups().catch(e => console.warn('[OpFollowup]', e.message)); }, 15 * 60 * 1000);

    // Start Proactive Daytime Nudge Interval (Every 15 mins)
    if (!DASHBOARD_ONLY) setInterval(() => {
        for (const line of SESSIONS) {
            if (line.sock && line.status === 'CONNECTED') runProactiveNudges(line.sock, line.id);
        }
    }, 15 * 60 * 1000);

    app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
});
