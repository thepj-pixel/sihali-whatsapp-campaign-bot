
// Proactive Daytime Nudge Engine (Sends sweet, respectful follow-ups 2-4 hours after inactivity)
function runProactiveNudges(sock) {
    try {
        const now = new Date();
        const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
        // Only run between 10:00 AM and 7:45 PM IST
        if (istHours < 10 || istHours >= 20) return;

        const allUsers = userMemory.getAllUsers();
        for (const u of allUsers) {
            if (!u.phone || u.phone.includes('Self Device') || u.phone.length < 10) continue;
            if (engagementPolicy.canSendConsentReminder(u)) {
                const reminder = engagementPolicy.buildConsentReminder(u.name);
                const reminderJid = `${u.phone}@s.whatsapp.net`;
                sendSafeMessage(sock, reminderJid, { text: reminder }).then(() => {
                    u.consentReminderCount = (u.consentReminderCount || 0) + 1;
                    u.consentReminderAt = new Date().toISOString();
                    userMemory.recordMessage(u.phone, 'bot', reminder, 'consentReminder');
                    userMemory.save();
                    operationsTracker.record('consent_reminder', 'sent', { lineId: 'sim_636' });
                }).catch(e => operationsTracker.record('consent_reminder', 'failed', { lineId: 'sim_636', reason: e.message }));
                break;
            }
            if (!engagementPolicy.canSendProactive(u)) continue;
            if (u.proactivePingCount >= 2) continue;

            const lastSeenDate = new Date(u.lastSeen);
            const hoursSinceLastChat = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60);

            const lastPingDate = u.lastPingTime ? new Date(u.lastPingTime) : null;
            const hoursSinceLastPing = lastPingDate ? (Date.now() - lastPingDate.getTime()) / (1000 * 60 * 60) : 999;

            if (hoursSinceLastChat >= 2.5 && hoursSinceLastChat <= 8 && hoursSinceLastPing >= 20) {
                const pickedNudge = conversationContext.buildProactiveMessage(u);
                if (!pickedNudge) continue;
                const replyJid = `${u.phone}@s.whatsapp.net`;

                sendSafeMessage(sock, replyJid, { text: pickedNudge }).then(() => {
                    u.proactivePingCount = (u.proactivePingCount || 0) + 1;
                    u.lastPingTime = new Date().toISOString();
                    userMemory.recordMessage(u.phone, 'bot', pickedNudge, 'proactiveNudge');
                    userMemory.save();
                    console.log(`[ProactiveNudge] Sent sweet follow-up to ${u.phone}`);
                }).catch(e => console.error('[ProactiveNudge Error]:', e.message));
                break; // 1 ping per cycle to prevent batch flood
            }
        }
    } catch (err) {
        console.error('[ProactiveNudge Runner Error]:', err.message);
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
const voterCardGen = require('./voter_card_generator.js');
const aiService = require('./ai_assistant_service.js');
const userMemory = require('./user_memory.js');
const posterEngine = require('./poster_engine.js');
const mediaCatalog = require('./media_catalog.js');
const campaignAgenda = require('./campaign_agenda.js');
const visionService = require('./vision_service.js');
const contactsManager = require('./contacts_manager.js');
const engagementPolicy = require('./engagement_policy.js');
const operationsTracker = require('./operations_tracker.js');
const dailyGoal = require('./daily_goal.js');
const conversationContext = require('./conversation_context.js');
const campaignProfile = require('./campaign_profile.js');

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
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));
app.use('/media', express.static(path.join(__dirname, 'media')));

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


const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
const CAMPAIGN_PIN = process.env.CAMPAIGN_PIN || '2026';

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

// PIN Security Gate Middleware
app.use((req, res, next) => {
    // Whitelist static media, health, debug, and Meta Ads Webhook
    if (req.path.startsWith('/media') || req.path === '/health' || req.path === '/api/debug' || req.path.startsWith('/webhook')) {
        return next();
    }

    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(c => {
        const parts = c.trim().split('=');
        if (parts[0]) cookies[parts[0]] = parts[1] ? decodeURIComponent(parts[1]) : '';
    });

    const queryPin = req.query.pin;
    const headerPin = req.headers['x-campaign-pin'];
    const activePin = cookies['campaign_pin'] || queryPin || headerPin;

    if (activePin === CAMPAIGN_PIN) {
        if (queryPin === CAMPAIGN_PIN) {
            res.setHeader('Set-Cookie', `campaign_pin=${CAMPAIGN_PIN}; Path=/; Max-Age=2592000; SameSite=Lax`);
        }
        return next();
    }

    if (req.path.startsWith('/api')) {
        return res.status(401).json({ error: 'Unauthorized. Enter PIN 2026 on dashboard.' });
    }

    // Render Lock Screen
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>🔒 Security Gate - Sihali Khurd 2026</title>
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
            <style>
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
                .card { background: #1e293b; padding: 35px 25px; border-radius: 18px; width: 100%; max-width: 380px; text-align: center; box-shadow: 0 20px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
                .pin-input { width: 100%; padding: 15px; font-size: 26px; text-align: center; letter-spacing: 10px; border-radius: 10px; border: 2px solid #475569; background: #0f172a; color: #38bdf8; margin: 22px 0; outline: none; font-weight: 700; }
                .pin-input:focus { border-color: #38bdf8; }
                .btn { width: 100%; padding: 15px; background: #2563eb; color: white; font-size: 16px; font-weight: 700; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; }
                .btn:active { transform: scale(0.98); }
            </style>
        </head>
        <body>
            <div class="card">
                <div style="font-size: 42px; margin-bottom: 12px;">🔒</div>
                <h2 style="margin: 0; font-size: 20px; color: #f8fafc;">ग्राम पंचायत सिहाली खुर्द</h2>
                <p style="color: #94a3b8; font-size: 13px; margin: 6px 0 0 0;">बाबा अभय सिंह चुनाव 2026 — निजी कंट्रोल रूम</p>
                
                <form method="GET" action="/">
                    <input type="password" name="pin" class="pin-input" placeholder="••••" maxlength="8" autofocus required inputmode="numeric">
                    <button type="submit" class="btn">🚀 Unlock Dashboard</button>
                </form>
                <p style="color: #64748b; font-size: 11px; margin-top: 18px;">Private & Confidential • Campaign Team Access Only</p>
            </div>
        </body>
        </html>
    `);
});

// Configured WhatsApp Sessions
const SESSIONS = [
    { id: 'sim_636', name: 'Primary Line (6367810227)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'baba_aux', name: 'Baba Aux Line (9509352067)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'canada', name: 'Canada Line (+1 Rented)', status: 'DISCONNECTED', qr: null, sock: null }
];

const sessionsDir = path.join(__dirname, 'sessions_auth');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// In-memory message store for Baileys retry requests & decrypt healing
const MSG_STORE = new Map();

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
            if (MSG_STORE.size > 1000) {
                const firstKey = MSG_STORE.keys().next().value;
                MSG_STORE.delete(firstKey);
            }
        }
        if (jid && jid.includes('@s.whatsapp.net')) {
            const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
            const trackedUser = userMemory.getUser(phone);
            if (trackedUser?.consentStatus === 'ACCEPTED') dailyGoal.markContact(phone);
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
        getMessage: async (key) => {
            if (key?.id && MSG_STORE.has(key.id)) {
                return MSG_STORE.get(key.id);
            }
            return undefined;
        }
    });

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
        }
    });

    // Handle Incoming Messages
    sock.ev.on('messages.upsert', async (m) => {
        try {
            console.log(`[${sessionObj.id}] Incoming messages.upsert: type=${m.type}, count=${m.messages?.length}`);
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                if (msg.key?.id && msg.message) {
                    MSG_STORE.set(msg.key.id, msg.message);
                    if (MSG_STORE.size > 1000) {
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

                if (!body && hasImage) {
                    body = (imageAnalysis && imageAnalysis.summaryHindi)
                        ? `[फोटो: ${imageAnalysis.summaryHindi}]`
                        : '[फोटो प्राप्त हुई]';
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

                // Record user message in memory
                userMemory.recordMessage(senderPhone, 'user', body, null, sessionObj.name);

                // Anti-Rogue Protection: Check if AutoPilot is PAUSED for this specific contact
                const user = userMemory.getUser(senderPhone);

                // Consent is a real state transition, not just message copy.
                // New contacts receive the permission prompt before campaign automation starts.
                const consentDecision = engagementPolicy.parseConsentResponse(body);
                if (user.consentStatus === 'PENDING') {
                    engagementPolicy.markConsentPrompted(user);
                    userMemory.save();
                    const consentPrompt = engagementPolicy.buildConsentPrompt(user.name);
                    await sendSafeMessage(sock, replyJid, { text: consentPrompt });
                    userMemory.recordMessage(senderPhone, 'bot', consentPrompt, 'consent_prompt', sessionObj.name);
                    operationsTracker.record('consent_prompt', 'sent', { lineId: sessionObj.id });
                    continue;
                }

                if (user.consentStatus === 'PROMPTED' && consentDecision) {
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
                    const retryPrompt = engagementPolicy.buildConsentPrompt(user.name);
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
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'consent_ack', sessionObj.name);
                        logMessage({ session: sessionObj.name, phone: senderPhone, incoming: body, reply: replyText, status: 'CONSENT_ACCEPTED' });
                        continue;
                    }

                    // Dynamic Language Preference Choice
                    if (user && user.conversationStage === 'ASKED_LANGUAGE') {
                        if (lower === '1' || lower === '1.' || lower.includes('hinglish') || lower.includes('english')) {
                            user.languagePreference = 'hinglish';
                            user.conversationStage = 'ASKED_OCCUPATION';
                            userMemory.save();
                            replyText = `Bahut badhiya ${user.name || 'bhai ji'}! Ab se aapse Hinglish (ABC format) me hi baat hogi. 😊\nAap kya karte ho — student, kisan, army, police ya apna koi kaam? 🚩`;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_choice', sessionObj.name);
                            continue;
                        } else if (lower === '2' || lower === '2.' || lower.includes('hindi') || lower.includes('हिंदी')) {
                            user.languagePreference = 'hi';
                            user.conversationStage = 'ASKED_OCCUPATION';
                            userMemory.save();
                            replyText = `बहुत बढ़िया ${user.name || 'भैया'}! अब से आपसे हिंदी (देवनागरी) में बातचीत होगी। 😊\nआप क्या करते हैं — पढ़ाई, किसानी, फौज, पुलिस या अपना कोई काम? 🚩`;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_choice', sessionObj.name);
                            continue;
                        }
                    }

                    // On-the-fly Language Switch
                    if (lower.includes('hinglish me') || lower.includes('english me')) {
                        user.languagePreference = 'hinglish';
                        userMemory.save();
                        replyText = `Theek hai bhaiya! Ab se aapse Hinglish (ABC format) me hi baat karenge. 😊 Bataiye, aaj gaon me kya mahol hai? 🚩`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        userMemory.recordMessage(senderPhone, 'bot', replyText, 'lang_switch', sessionObj.name);
                        continue;
                    }
                    if (lower.includes('hindi me') || lower.includes('हिंदी में')) {
                        user.languagePreference = 'hi';
                        userMemory.save();
                        replyText = `जी बिल्कुल भैया! अब से आपसे हिंदी (देवनागरी) में बातचीत होगी। 😊 बताइए, आज गाँव में क्या माहौल है? 🚩`;
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

                    // Extract Ward if mentioned
                    const user = userMemory.getUser(senderPhone);
                    const wardMatch = lower.match(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/i);
                    if (wardMatch) {
                        user.ward = parseInt(wardMatch[1]);
                        userMemory.save();
                    }

                    const isPhotoQuery = lower.includes('photo') || lower.includes('poster') || lower.includes('फोटो') || lower.includes('पोस्टर') || lower.includes('तस्वीर') || lower.includes('banner') || lower.includes('image');
                    const isVideoQuery = lower.includes('video') || lower.includes('reel') || lower.includes('वीडियो') || lower.includes('रील') || lower.includes('clip');
                    const isPosterGenQuery = lower.includes('poster bana') || lower.includes('status bana') || lower.includes('फोटो बना') || lower.includes('पोस्टर बना');

                    // Check if user is confirming previous query ("ye hie details h", "yahi h", "itna hi pata h", etc.)
                    const isFollowUpDetails = lower.includes('ye hie') || lower.includes('yahi') || lower.includes('yehi') || lower.includes('itna hi') || lower.includes('yahi h') || lower.includes('yahi he') || lower.includes('nahi pata');
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

                    const isVoterSlipIntent = !isConversational && !isGreetingMsg && !isPhotoQuery && !isVideoQuery && !isPosterGenQuery && (
                        hasEpicPattern ||
                        hasExplicitParchiKeyword ||
                        (hasParchiPhrase && !lower.includes('photo') && !lower.includes('video') && !lower.includes('poster')) ||
                        voterEngine.isLikelyNameOrVoterQuery(effectiveSearchText) ||
                        isFollowUpDetails
                    );

                    if (imageAnalysis) {
                        const voterName = user.name || 'भैया';
                        if (imageAnalysis.suggestedTag) {
                            userMemory.updateTags(senderPhone, [imageAnalysis.suggestedTag]);
                        }
                        if (imageAnalysis.category === 'civic_issue') {
                            const newMahool = ((user.mahoolNotes || '') + ' | शिकायत: ' + imageAnalysis.summaryHindi).trim();
                            userMemory.updateNotes(senderPhone, { mahoolNotes: newMahool });
                            replyText = visionService.getConversationalReply(imageAnalysis, voterName);
                        } else if (imageAnalysis.category === 'voter_id') {
                            const searchQ = imageAnalysis.details?.epic || imageAnalysis.details?.name || '';
                            const parchiMatches = searchQ ? voterEngine.searchVoters(searchQ) : [];
                            if (parchiMatches && parchiMatches.length > 0) {
                                replyText = `राम राम ${voterName}! 🙏 आपकी वोटर आईडी / पर्ची की पहचान हो गई है:\n\n` + voterEngine.formatVoterSlip(parchiMatches[0]);
                            } else {
                                replyText = visionService.getConversationalReply(imageAnalysis, voterName);
                            }
                        } else {
                            replyText = visionService.getConversationalReply(imageAnalysis, voterName);
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
                    } else if (isVoterSlipIntent) {
                        let targetVoter = null;

                        // Check if voter is actively confirming a pending single-voter father check
                        const isYesConfirmation = lower === 'ha' || lower === 'haan' || lower === 'हाँ' || lower === 'yes' || lower === 'sahi h' || lower === 'sahi hai' || lower === 'yahi h' || lower === 'yahi he' || lower === 'shi h' || lower === 'ji' || lower === 'theek h' || lower === 'thik h';

                        if (user && user.pendingParchiCandidate && isYesConfirmation) {
                            targetVoter = user.pendingParchiCandidate;
                            delete user.pendingParchiCandidate;
                            user.ward = targetVoter.ward;
                            user.lastFoundVoter = targetVoter;
                            userMemory.save();

                            replyText = voterEngine.formatShortSlipResponse(targetVoter) +
                                `\n\n👨‍👩‍👧 *क्या आपको अपने परिवार के अन्य सदस्यों (माताजी, पिताजी, भाई, भाभी) की भी वोटर पर्ची चाहिए भैया? बस उनका नाम लिखकर भेज दीजिए!* 🚩\n\n*(अगर किसी बात में थोड़ी बहुत गलती हो जाए तो छोटा मानकर माफ करना भैया... बाकी हमारी नीयत में कोई खोट नहीं है, हम तो बस पूरे गाँव की सेवा में हाजिर हैं! 🙏)*`;

                            let cardBuffer = null;
                            try {
                                cardBuffer = await voterCardGen.generateVoterCard(targetVoter);
                            } catch (e) {
                                console.error(`[${sessionObj.id}] Error generating voter card:`, e.message);
                            }

                            if (cardBuffer) {
                                await sendSafeMessage(sock, replyJid, {
                                    image: cardBuffer,
                                    caption: replyText
                                });
                                mediaTypeSent = 'voterSlipCard';
                                console.log(`[${sessionObj.id}] ✅ Delivered confirmed voter slip JPG card to ${senderPhone} (${targetVoter.name_hi})`);
                            } else {
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'voterSlip';
                            }
                            userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);
                            logMessage({
                                session: sessionObj.name,
                                phone: senderPhone,
                                incoming: body,
                                reply: replyText,
                                status: 'CONFIRMED_PARCHI_DELIVERED'
                            });
                            continue;
                        }

                        // Check if voter asked for parchi without any name or EPIC
                        const cleanParchiQuery = effectiveSearchText.replace(/parchi|voter|slip|card|id|bhej|do|bhejo|nikalo|mera|meri|mujhe|पर्ची|कार्ड|आईडी|भेज|दो|भेजो|निकालो|मेरी|मेरा|मुझे/gi, '').trim();
                        if (!cleanParchiQuery && (hasExplicitParchiKeyword || hasParchiPhrase)) {
                            replyText = `राम राम भाई जी! 🙏\nअधिकृत डिजिटल मतदाता पर्ची देखने के लिए कृपया अपना *शुभ नाम* (या पहचान पत्र / EPIC नंबर) लिखकर भेजें! 🚩\n\n*(उदा: 'प्रिंस यादव' या 'IED1610633')*`;
                            await sendSafeMessage(sock, replyJid, { text: replyText });
                            mediaTypeSent = 'parchiNamePrompt';
                            userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);
                            logMessage({
                                session: sessionObj.name,
                                phone: senderPhone,
                                incoming: body,
                                reply: replyText,
                                status: 'ASKED_VOTER_NAME'
                            });
                            continue;
                        }

                        // Check if voter is answering an active disambiguation prompt (e.g. typing "1", "2", or father's name)
                        if (user && user.disambiguationMatches && user.disambiguationMatches.length > 0) {
                            const choiceNum = parseInt(body.trim());
                            if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= user.disambiguationMatches.length) {
                                targetVoter = user.disambiguationMatches[choiceNum - 1];
                            } else {
                                for (const cand of user.disambiguationMatches) {
                                    const candRel = ((cand.rel_name_hi || '') + ' ' + (cand.rel_name_en || '')).toLowerCase();
                                    const candWard = String(cand.ward);
                                    if (candRel.includes(lower) || lower.includes(candWard) || candWard === body.trim()) {
                                        targetVoter = cand;
                                        break;
                                    }
                                }
                            }
                            if (targetVoter) {
                                delete user.disambiguationMatches;
                                user.ward = targetVoter.ward;
                                user.lastFoundVoter = targetVoter;
                                userMemory.save();
                            }
                        }

                        let matches = targetVoter ? [targetVoter] : voterEngine.searchVoters(effectiveSearchText, 5, user.ward);

                        // If multiple distinct people share the same name and user hasn't specified father's name or ward:
                        if (!targetVoter && matches && matches.length > 1) {
                            const sameNameList = matches.filter(m => (m.name_hi === matches[0].name_hi || (m.name_en && m.name_en.toLowerCase() === matches[0].name_en.toLowerCase())));
                            if (sameNameList.length > 1 && !user.ward) {
                                user.disambiguationMatches = sameNameList;
                                userMemory.save();
                                replyText = voterEngine.formatDisambiguationPrompt(sameNameList, matches[0].name_hi);
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'disambiguation';
                                console.log(`[${sessionObj.id}] ⚠️ Disambiguation requested for ${matches[0].name_hi} (${sameNameList.length} matches)`);
                                userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);
                                logMessage({
                                    session: sessionObj.name,
                                    phone: senderPhone,
                                    incoming: body,
                                    reply: replyText,
                                    status: 'DISAMBIGUATION_SENT'
                                });
                                continue;
                            }
                        }

                        // If single candidate found: ask father confirmation first (and pre-generate card in background)
                        if (!targetVoter && matches && matches.length === 1) {
                            targetVoter = matches[0];
                            const relNameLow = (targetVoter.rel_name_hi || '').toLowerCase();
                            const alreadySpecifiedFather = lower.includes(relNameLow) || (targetVoter.rel_name_en && lower.includes(targetVoter.rel_name_en.toLowerCase()));

                            if (!alreadySpecifiedFather) {
                                user.lastSearchedQuery = effectiveSearchText;
                                user.lastSearchedName = targetVoter.name;
                                user.pendingParchiCandidate = targetVoter;
                                userMemory.save();

                                // Pre-generate card in background so it is ready instantaneously
                                voterCardGen.generateVoterCard(targetVoter).catch(() => {});

                                const relLabel = targetVoter.rel_type === 'H' ? 'पति' : 'पिताजी';
                                replyText = `राम राम भाई जी! 🙏 वोटर लिस्ट में *${targetVoter.name_hi}* नाम मिल गया है: 📋\n\nक्या आपके ${relLabel} का नाम *${targetVoter.rel_name_hi}* (वार्ड नं. ${targetVoter.ward}, मकान नं. ${targetVoter.house_no}) है?\n\nकृपया *'हाँ'* या *'सही है'* लिखकर बताएं, ताकि मैं आपकी अधिकृत डिजिटल पर्ची तुरंत भेज सकूँ! 😊🚩\n*(अगर कोई अन्य नाम है तो सही नाम लिखकर भेजें)*`;

                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'parchiConfirmation';
                                userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);
                                logMessage({
                                    session: sessionObj.name,
                                    phone: senderPhone,
                                    incoming: body,
                                    reply: replyText,
                                    status: 'FATHER_CONFIRMATION_ASKED'
                                });
                                continue;
                            }
                        }

                        if (matches && matches.length > 0) {
                            targetVoter = targetVoter || matches[0];
                            user.lastSearchedQuery = effectiveSearchText;
                            user.lastSearchedName = targetVoter.name;
                            user.lastFoundVoter = targetVoter;
                            if (!user.ward && targetVoter.ward) user.ward = targetVoter.ward;
                            if (!user.name) user.name = targetVoter.name;
                            userMemory.save();

                            replyText = voterEngine.formatShortSlipResponse(targetVoter) +
                                `\n\n👨‍👩‍👧 *क्या आपको अपने परिवार के अन्य सदस्यों की भी वोटर पर्ची चाहिए भैया? बस उनका नाम लिखकर भेज दीजिए!* 🚩\n\n*(अगर किसी बात में थोड़ी बहुत गलती हो जाए तो छोटा मानकर माफ करना भैया... बाकी हमारी नीयत में कोई खोट नहीं है! 🙏)*`;

                            // Generate Official JPG Voter Card with Baba's Photo
                            let cardBuffer = null;
                            try {
                                cardBuffer = await voterCardGen.generateVoterCard(targetVoter);
                            } catch (cardErr) {
                                console.error(`[${sessionObj.id}] Error generating voter card:`, cardErr.message);
                            }

                            if (cardBuffer) {
                                const cardFileName = `parchi_${targetVoter.id || targetVoter.sr_no}.jpg`;
                                const cardFilePath = path.join(__dirname, 'media', 'uploads', cardFileName);
                                try { fs.writeFileSync(cardFilePath, cardBuffer); } catch(e) {}
                                await sendSafeMessage(sock, replyJid, {
                                    image: cardBuffer,
                                    caption: replyText
                                });
                                mediaTypeSent = 'voterSlipCard';
                                console.log(`[${sessionObj.id}] ✅ Sent voter slip JPG card + details to ${senderPhone} (${targetVoter.name_hi})`);
                            } else {
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'voterSlip';
                                console.log(`[${sessionObj.id}] ✅ Sent text voter slip to ${senderPhone} (${targetVoter.name_hi})`);
                            }
                        } else if (isFollowUpDetails && user && user.lastFoundVoter) {
                            targetVoter = user.lastFoundVoter;
                            replyText = voterEngine.formatShortSlipResponse(targetVoter);

                            let cardBuffer = null;
                            try {
                                cardBuffer = await voterCardGen.generateVoterCard(targetVoter);
                            } catch (cardErr) {
                                console.error(`[${sessionObj.id}] Error generating follow-up voter card:`, cardErr.message);
                            }

                            if (cardBuffer) {
                                await sendSafeMessage(sock, replyJid, {
                                    image: cardBuffer,
                                    caption: replyText
                                });
                                mediaTypeSent = 'voterSlipCard';
                                console.log(`[${sessionObj.id}] ✅ Delivered stored voter slip JPG card upon follow-up to ${senderPhone}`);
                            } else {
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                mediaTypeSent = 'voterSlip';
                                console.log(`[${sessionObj.id}] ✅ Delivered stored voter slip text upon follow-up to ${senderPhone}`);
                            }
                        } else {
                            if (hasExplicitParchiKeyword || hasEpicPattern || hasParchiPhrase || lower.includes("mera naam") || lower.includes("parchi")) {
                                replyText = voterEngine.formatFallbackResponse();
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                                console.log(`[${sessionObj.id}] ⚠️ Parchi requested but voter not found: "${effectiveSearchText}"`);
                            } else {
                                // Casual chat / AI query! Fall through to conversational AI & Fast Local Engine
                                console.log(`[${sessionObj.id}] 💬 Message "${effectiveSearchText}" had no parchi match and no explicit parchi keyword. Falling through to conversational AI.`);
                                const history = userMemory.getUserHistory(senderPhone).slice(0, -1).map(h => ({
                                    role: h.role === "bot" ? "assistant" : "user",
                                    content: h.text
                                }));

                                replyText = await aiService.getAIResponse(body, NVIDIA_API_KEY, history, senderPhone);
                                if (!replyText || replyText.trim() === "") {
                                    replyText = aiService.getFastLocalAnswer(body, senderPhone);
                                }
                                await sendSafeMessage(sock, replyJid, { text: replyText });
                            }
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

                        replyText = await aiService.getAIResponse(body, NVIDIA_API_KEY, history, senderPhone);
                        if (!replyText || replyText.trim() === '') {
                            replyText = aiService.getFastLocalAnswer(body, senderPhone);
                        }
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        console.log(`[${sessionObj.id}] ✅ Replied via AI/local to ${senderPhone}`);
                    }
                } catch (err) {
                    console.error(`[${sessionObj.id}] Error resolving reply:`, err);
                    replyText = aiService.getFastLocalAnswer(body, senderPhone);
                    await sendSafeMessage(sock, replyJid, { text: replyText }).catch(e => console.error('Fallback send failed:', e));
                }

                // Record bot reply in memory
                userMemory.recordMessage(senderPhone, 'bot', replyText, mediaTypeSent, sessionObj.name);

                // Anti-Ban Shield: Auto-send 3-in-1 Campaign Contact Card during early interactions (turns 1 to 3)
                try {
                    const u = userMemory.getUser(senderPhone);
                    const userMsgCount = (u.history || []).filter(h => h.role === 'user').length;

                    // Send on interaction 1, 2, or 3 if not already sent
                    if (engagementPolicy.shouldSendContactCard(u, userMsgCount)) {
                        u.contactCardSent = true;
                        u.contactCardSentAt = new Date().toISOString();
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
    });
}

// Start all sessions
SESSIONS.forEach(sess => {
    startSession(sess).catch(e => console.error(`Failed to start ${sess.id}:`, e));
});

// Helper to get connected socket
function getActiveSocket(preferredId = 'sim_636') {
    const pref = SESSIONS.find(s => s.id === preferredId && s.status === 'CONNECTED' && s.sock);
    if (pref) return { session: pref, sock: pref.sock };
    const anyConnected = SESSIONS.find(s => s.status === 'CONNECTED' && s.sock);
    if (anyConnected) return { session: anyConnected, sock: anyConnected.sock };
    return null;
}

// ==================== REST APIS ====================

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

        const active = getActiveSocket(lineId || 'sim_636');
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
            messageText = `राम राम ${voterDisplayName}! 🙏🚩\n\nग्राम पंचायत सिहाली खुर्द के सर्वांगीण विकास हेतु 16 नवम्बर 2026 को अभय सिंह (मोटी आंगली वाले) के पक्ष में स्वस्तिक (卐) पर मुहर लगाकर भारी मतों से विजयी बनाएं!\n\nकाम बोला है, काम बोलेगा! ✨`;
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
            status: mediaType ? 'MEDIA_SENT' : 'DELIVERED'
        });
        operationsTracker.record('dashboard_send', 'ok', {
            lineId: active.session.id,
            mediaType: mediaType || 'text',
            template: template || 'custom'
        });

        res.json({
            success: true,
            phone: cleanedPhone,
            line: sessionName,
            message: messageText
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

// API: Get Cloudflare Tunnel Status
app.get('/api/tunnel-status', (req, res) => {
    exec('pm2 logs tunnel --lines 60 --nostream 2>/dev/null', (err, stdout, stderr) => {
        const text = stdout || stderr || '';
        const matches = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g);
        if (matches && matches.length > 0) {
            const url = matches[matches.length - 1];
            return res.json({ success: true, url: url, provider: 'Cloudflare' });
        }
        res.json({ success: false, message: 'Tunnel URL not found in recent logs', hint: 'Run: pm2 logs tunnel --lines 50' });
    });
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
app.post('/api/quick-action', async (req, res) => {
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

app.post('/api/contacts/import-vcf', (req, res) => {
    try {
        const { vcfText } = req.body;
        const imported = contactsManager.parseVCF(vcfText || '');
        res.json({ success: true, count: imported.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
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

// API: Request Pairing Code (for Canada + Baba accounts)
app.post('/api/request-pairing-code', async (req, res) => {
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

// API: PM2 Debug Logs (Tunnel + Bot)
app.get('/api/debug', (req, res) => {
    exec('pm2 logs tunnel --lines 25 --nostream 2>/dev/null; pm2 logs whatsapp-bot --lines 60 --nostream', (err, stdout, stderr) => {
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

app.get('/update', (req, res) => {
    console.log('[AutoDeploy] Pulling latest code from GitHub...');
    exec('git pull origin main && mkdir -p ~/.fonts && cp media/*.ttf ~/.fonts/ 2>/dev/null || true && fc-cache -f ~/.fonts 2>/dev/null || true && rm -rf parchi_cache/* && pm2 restart all', (err, stdout, stderr) => {
        if (err) {
            console.error('[AutoDeploy Error]:', stderr);
            return res.status(500).send(`
                <body style="font-family: sans-serif; padding: 30px;">
                    <h2 style="color: #dc2626;">❌ Auto-Update Failed</h2>
                    <pre style="background: #f1f5f9; padding: 15px; border-radius: 8px;">${stderr || err.message}</pre>
                    <a href="/?pin=${CAMPAIGN_PIN}">← Return to Dashboard</a>
                </body>
            `);
        }
        res.send(`
            <body style="font-family: sans-serif; padding: 30px; text-align: center;">
                <h2 style="color: #16a34a;">✅ Successfully Updated & Reloaded from GitHub!</h2>
                <p>Google Cloud VM has pulled all latest changes and restarted the bot.</p>
                <pre style="background: #f1f5f9; padding: 15px; border-radius: 8px; text-align: left; display: inline-block;">${stdout}</pre>
                <br><br>
                <a href="/?pin=${CAMPAIGN_PIN}" style="background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Return to Dashboard</a>
                <script>setTimeout(() => window.location.href = '/?pin=${CAMPAIGN_PIN}', 3000);</script>
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
            <a href="/?pin=${CAMPAIGN_PIN}" style="display:inline-block; padding:12px 24px; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:bold;">← Return to Dashboard</a>
            <script>setTimeout(() => window.location.href = '/?pin=${CAMPAIGN_PIN}', 3500);</script>
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
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
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
                .tabs { display: flex; gap: 8px; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; overflow-x: auto; }
                .tab-btn { background: none; border: none; padding: 10px 16px; font-size: 13px; font-weight: 700; color: #64748b; cursor: pointer; border-radius: 8px; white-space: nowrap; }
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

            </style>
        </head>
        <body>
            <div class="container">
                <!-- Top Header -->
                <div class="header-bar">
                    <div class="brand">
                        <h1>🏛️ सिहाली खुर्द चुनाव 2026 — बाबा अभय सिंह</h1>
                        <p>24/7 Multi-Session Campaign Tower • Mobile Field & AI Studio</p>
                    </div>
                    <div class="top-actions">
                        <span id="tunnel-badge" style="background: #e0f2fe; color: #0369a1; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; border: 1px solid #bae6fd;">🔗 टनल जांच रहे हैं...</span>
                        <span style="background: #dcfce7; color: #15803d; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700;">🟢 Iowa Cloud 24/7</span>
                        <a href="/update" onclick="return confirm('Sync latest code from GitHub?')" style="background: #0f172a; color: white; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 700;">🔄 Pull GitHub</a>
                    </div>
                </div>

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
                                <input type="tel" id="v-phone" class="input-field" placeholder="उदा: 9829xxxxxx या 6367810227" required autocomplete="off">
                            </div>
                            <div class="form-group" style="position: relative;">
                                <label>🔍 Search & Link Voter (List में नाम)</label>
                                <input type="text" id="v-name" class="input-field" placeholder="नाम या EPIC टाइप करें..." autocomplete="off" oninput="onVoterSearchInput(this.value)">
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
                                    <option value="consent_check">🛡️ 0. एंटी-स्पैम सहमति (1. हाँ / 2. नहीं Consent Check)</option>
                                    <option value="permission_casual">🤝 1. सहमति व हाल-चाल (Soft Permission - Non-spam)</option>
                                    <option value="offer_parchi">🎫 2. वोटर पर्ची की पेशकश (Voter Slip Offer)</option>
                                    <option value="ground_feedback">📢 3. वार्ड समस्या व चर्चा (Ward Feedback)</option>
                                    <option value="direct_appeal">🗳️ 4. स्वस्तिक मुहर सीधा संदेश (Direct 16 Nov Appeal)</option>
                                    <option value="welcome">👋 5. त्वरित स्वागत ("Aapko jod liya h...")</option>
                                    <option value="custom">✍️ 6. कस्टम संदेश (Custom message...)</option>
                                </select>
                            </div>
                            <div class="form-group" style="grid-column: 1 / -1; display: none;" id="custom-text-group">
                                <label>कस्टम संदेश लिखें (Custom Message)</label>
                                <input type="text" id="v-custom-text" class="input-field" placeholder="संदेश टाइप करें...">
                            </div>

                            <!-- Media Attachment Radios -->
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label style="margin-bottom: 6px; display: block; font-size: 12px; font-weight: 700; color: #cbd5e1;">📎 मीडिया अटैचमेंट (Media Option):</label>
                                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="none" checked> 💬 केवल टेक्स्ट (Text Only)
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="slip" id="media-opt-slip"> 🎫 वोटर पर्ची JPG कार्ड
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="poster"> 📸 चुनाव प्रचार पोस्टर
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px 12px; border-radius: 8px; border: 1px solid #334155; color: #e2e8f0; font-size: 13px; cursor: pointer;">
                                        <input type="radio" name="mediaOption" value="video"> 📹 3D वीडियो रील
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
                                    <h3 style="margin: 0; font-size: 18px; color: #0f172a;">🎮 AI प्लेग्राउंड (लाइव टेस्टिंग लैब)</h3>
                                    <p style="color: #64748b; font-size: 13px; margin: 4px 0 0 0;">मतदाता के साथ रीयल-टाइम चैट, विज़न विश्लेषण और चुनावी लक्ष्य का लाइव परीक्षण करें।</p>
                                </div>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <span style="font-size: 12px; font-weight: 700; color: #475569;">मॉडल:</span>
                                    <select id="pg-provider" style="padding: 6px 10px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 12px; background: white; color: #0f172a; font-weight: 600;">
                                        <option value="cascade">⚡ ऑटो कैस्केड (NVIDIA ➡️ Groq ➡️ Gemini)</option>
                                        <option value="groq">🟠 Groq Qwen (27B Ultra-Fast)</option>
                                        <option value="gemini">🔵 Gemini 3.8 Flash (Vision & Text)</option>
                                        <option value="nvidia">🟢 NVIDIA Nemotron</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Voter Simulation Context Bar -->
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; background: #f8fafc; padding: 12px; border-radius: 10px; border: 1px solid #e2e8f0; margin-bottom: 15px;">
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">👤 मतदाता का नाम:</label>
                                    <input type="text" id="pg-voter-name" placeholder="उदा: विक्रम यादव" value="विक्रम यादव" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">📱 फोन नंबर:</label>
                                    <input type="text" id="pg-voter-phone" placeholder="919876543210" value="919876543210" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">🎯 इस चैट का विशेष लक्ष्य (Campaign Goal):</label>
                                    <input type="text" id="pg-campaign-goal" placeholder="उदा: कल सुबह चौपाल पर बुलाना" value="कल सुबह चौपाल पर चाय पर बुलाना और बिजली सबस्टेशन की बात छेड़ना" style="width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: white; color: #0f172a;">
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
                                    <span id="pg-image-filename">📷 फोटो चयनित</span>
                                    <button onclick="clearPlaygroundImage()" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer;">✕ हटाएं</button>
                                </div>

                                <!-- Input Bar -->
                                <div style="padding: 10px 14px; background: #f0f2f5; border-top: 1px solid #cbd5e1; display: flex; gap: 8px; align-items: center;">
                                    <input type="file" id="pg-file-input" accept="image/*" style="display: none;" onchange="onPlaygroundFileSelected(event)">
                                    <button onclick="document.getElementById('pg-file-input').click()" style="background: white; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 20px; font-size: 14px; cursor: pointer;" title="फोटो अपलोड करें (वोटर कार्ड, टूटी सड़क, पोस्टर)">
                                        📷
                                    </button>
                                    <input type="text" id="ai-test-input" placeholder="संदेश लिखें (उदा: 'बिजली का क्या माहौल है', 'वोटर पर्ची चाहिए', 'दारू बांटेगा क्या')..." class="input-field" style="flex: 1; background: white; color: #0f172a; border: 1px solid #cbd5e1; border-radius: 20px; padding: 8px 16px; font-size: 13px;" onkeydown="if(event.key==='Enter') sendPlaygroundChat()">
                                    <button onclick="sendPlaygroundChat()" id="btn-pg-send" style="background: #2563eb; color: white; border: none; padding: 8px 18px; border-radius: 20px; font-weight: 700; font-size: 13px; cursor: pointer;">
                                        भेजें 🚀
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Right Panel: Daily Campaign Agenda, Voter Search & Diagnostics -->
                        <div style="display: flex; flex-direction: column; gap: 14px;">
                            <!-- 1. Daily Campaign Agenda & Multi-Media Drip Box -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <span style="font-weight: 700; color: #0f172a; font-size: 13px;">📢 आज का चुनावी एजेंडा (Daily Agenda)</span>
                                    <span style="font-size: 11px; background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 10px; font-weight: 700;">Active RAG</span>
                                </div>
                                <div style="margin-bottom: 8px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">विषय (Topic):</label>
                                    <input type="text" id="agenda-topic" style="width: 100%; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 2px; color:#0f172a;">
                                </div>
                                <div style="margin-bottom: 8px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">मुख्य बातचीत बिंदु (Talking Points):</label>
                                    <textarea id="agenda-points" rows="2" style="width: 100%; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 2px; color:#0f172a; resize: vertical;"></textarea>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-size: 11px; color: #64748b;">3-4 मीडिया ड्रिप अनुक्रम एक्टिव</span>
                                    <button onclick="saveCampaignAgendaUI()" style="background: #15803d; color: white; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer;">
                                        💾 एजेंडा सेव करें
                                    </button>
                                </div>
                            </div>

                            <!-- 2. Fuzzy Voter Search Engine -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <div style="font-weight: 700; color: #0f172a; font-size: 13px; margin-bottom: 6px;">🔍 3,636 वोटर स्मार्ट सर्च (Typo-Tolerant)</div>
                                <div style="display: flex; gap: 6px; margin-bottom: 8px;">
                                    <input type="text" id="pg-voter-search-input" placeholder="उदा: rina, pirnce, w1 45..." style="flex: 1; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; color:#0f172a;" onkeydown="if(event.key==='Enter') testPlaygroundVoterSearch()">
                                    <button onclick="testPlaygroundVoterSearch()" style="background: #2563eb; color: white; border: none; padding: 5px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer;">खोजें</button>
                                </div>
                                <div id="pg-voter-search-result" style="max-height: 110px; overflow-y: auto; font-size: 11px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px; color: #334155;">
                                    सर्च रिजल्ट यहाँ दिखेगा...
                                </div>
                            </div>

                            <!-- 3. Live AI Inspection Metrics -->
                            <div style="border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; background: #f8fafc; font-size: 12px;">
                                <div style="font-weight: 700; color: #0f172a; margin-bottom: 6px;">⚡ लाइव AI डिबग व विश्लेषण:</div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">प्रदाता / मॉडल:</span>
                                    <span id="pg-metric-provider" style="font-weight: 700; color: #2563eb;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">विलंबता (Latency):</span>
                                    <span id="pg-metric-latency" style="font-weight: 700; color: #16a34a;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                    <span style="color: #64748b;">पहचाने गए टैग:</span>
                                    <span id="pg-metric-tags" style="font-weight: 700; color: #d97706;">-</span>
                                </div>
                                <div style="display: flex; justify-content: space-between;">
                                    <span style="color: #64748b;">अगला मीडिया ड्रिप:</span>
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
                                    <h3 style="margin: 0; font-size: 14px; color: #0f172a; font-weight: 700;">💬 मतदाता संवाद कक्ष</h3>
                                    <span style="font-size: 11px; color: #64748b;">WhatsApp Web Replica • Ground CRM</span>
                                </div>
                                <button onclick="toggleDemoPosterMode()" id="demo-mode-badge" style="font-size: 11px; padding: 3px 8px; border-radius: 12px; border: 1px solid #16a34a; background: #dcfce7; color: #15803d; font-weight: 700; cursor: pointer;">
                                    📸 डेमो पोस्टर मोड: चालू
                                </button>
                            </div>
                            <div class="wa-search-bar">
                                <input type="text" id="voter-search" placeholder="🔍 नाम, फोन नंबर या टैग से खोजें..." style="width: 100%; padding: 8px 12px; border-radius: 16px; border: 1px solid #cbd5e1; font-size: 13px; outline: none; background: #f8fafc; color: #0f172a;" oninput="filterVoters(this.value)">
                            </div>
                            <!-- 17 Smart Filter Chips -->
                            <div class="wa-filter-chips">
                                <span class="filter-chip active" onclick="applyTagFilter('ALL', this)">सभी (<span id="voter-count-badge">0</span>)</span>
                                <span class="filter-chip" onclick="applyTagFilter('🟢 पक्का समर्थक', this)">🟢 समर्थक</span>
                                <span class="filter-chip" onclick="applyTagFilter('🟡 सोच विचार', this)">🟡 असमंजस</span>
                                <span class="filter-chip" onclick="applyTagFilter('🔴 विरोधी / नाराज', this)">🔴 विरोधी</span>
                                <span class="filter-chip" onclick="applyTagFilter('📝 काम की शिकायत', this)">📝 शिकायतें</span>
                                <span class="filter-chip" onclick="applyTagFilter('📢 चुनावी माहौल', this)">📢 माहौल</span>
                                <span class="filter-chip" onclick="applyTagFilter('👨‍👩‍👧 परिवार विवरण', this)">👨‍👩‍👧 परिवार</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚩 युवा टीम', this)">🚩 युवा टीम</span>
                                <span class="filter-chip" onclick="applyTagFilter('🌾 किसान व पशुपालक', this)">🌾 किसान</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚆 प्रवासी मतदाता', this)">🚆 प्रवासी</span>
                                <span class="filter-chip" onclick="applyTagFilter('🚨 धांधली अलर्ट', this)">🚨 धांधली अलर्ट</span>
                                <span class="filter-chip" onclick="applyTagFilter('👵 बुजुर्ग व पेंशन', this)">👵 बुजुर्ग</span>
                                <span class="filter-chip" onclick="applyTagFilter('👩‍🦰 महिला शक्ति', this)">👩‍🦰 महिला</span>
                                <span class="filter-chip" onclick="applyTagFilter('📜 संकल्प पत्र', this)">📜 संकल्प</span>
                                <span class="filter-chip" onclick="applyTagFilter('🤝 सीधी मुलाकात', this)">🤝 मुलाकात</span>
                                <span class="filter-chip" onclick="applyTagFilter('🎫 वोटर पर्ची', this)">🎫 पर्ची</span>
                                <span class="filter-chip" onclick="applyTagFilter('MANUAL', this)">⏸️ Manual</span>
                            </div>
                            <div class="wa-contacts-list" id="voter-list-ui">
                                <div style="padding: 30px; text-align: center; color: #94a3b8;">लोड हो रहा है...</div>
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
                                        <div style="font-size: 12px; color: #64748b;" id="header-details">+91 00000 00000 • वार्ड: --</div>
                                    </div>
                                </div>

                                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                    <!-- AutoPilot AI Toggle Button -->
                                    <button id="btn-toggle-autopilot" onclick="toggleCurrentAutoPilot()" style="padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 700; border: none; cursor: pointer; background: #16a34a; color: white;">
                                        🤖 AutoPilot AI: चालू
                                    </button>

                                    <!-- Sentiment Dropdown -->
                                    <select id="voter-sentiment-select" onchange="updateVoterSentiment(this.value)" style="padding: 5px 8px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 600; background: white; color: #0f172a;">
                                        <option value="positive">🟢 पक्का समर्थक</option>
                                        <option value="swing">🟡 असमंजस / सोच-विचार</option>
                                        <option value="critical">🔴 विरोधी / नाराज</option>
                                        <option value="neutral">⚪ सामान्य संपर्क</option>
                                    </select>

                                    <!-- Toggle Intelligence Notes Drawer -->
                                    <button onclick="toggleIntelDrawer()" style="padding: 6px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 12px; font-weight: 600; cursor: pointer; color: #0f172a;">
                                        📋 वोटर नोट्स व टैग्स
                                    </button>
                                </div>
                            </div>

                            <!-- Collapsible Voter Intelligence & Memory Drawer -->
                            <div class="wa-intel-bar" id="wa-intel-drawer">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <h4 style="margin: 0; font-size: 13px; color: #0f172a;">🧠 वोटर मेमरी, टैग्स व ज़मीनी खुफिया जानकारी</h4>
                                    <button onclick="toggleIntelDrawer()" style="background: none; border: none; font-size: 14px; cursor: pointer; color: #64748b;">✕</button>
                                </div>

                                <!-- Active Tags -->
                                <div style="margin-bottom: 10px;">
                                    <span style="font-size: 11px; font-weight: 700; color: #64748b; margin-right: 6px;">सक्रिय टैग्स:</span>
                                    <span id="active-tags-container"></span>
                                    <select id="add-tag-select" onchange="addTagToCurrentVoter(this.value)" style="padding: 2px 6px; font-size: 11px; border-radius: 6px; border: 1px solid #cbd5e1; margin-left: 6px; background:white; color:#0f172a;">
                                        <option value="">+ नया टैग जोड़ें...</option>
                                        <option value="🟢 पक्का समर्थक">🟢 पक्का समर्थक</option>
                                        <option value="🟡 सोच विचार">🟡 सोच विचार</option>
                                        <option value="🔴 विरोधी / नाराज">🔴 विरोधी / नाराज</option>
                                        <option value="👨‍👩‍👧 परिवार विवरण">👨‍👩‍👧 परिवार विवरण</option>
                                        <option value="📢 चुनावी माहौल">📢 चुनावी माहौल</option>
                                        <option value="📝 काम की शिकायत">📝 काम की शिकायत</option>
                                        <option value="🎫 वोटर पर्ची जारी">🎫 वोटर पर्ची</option>
                                        <option value="🤝 सीधी मुलाकात">🤝 सीधी मुलाकात</option>
                                        <option value="🚩 युवा टीम">🚩 युवा टीम</option>
                                        <option value="🌾 किसान व पशुपालक">🌾 किसान व पशुपालक</option>
                                        <option value="👵 बुजुर्ग व पेंशन">👵 बुजुर्ग व पेंशन</option>
                                        <option value="👩‍🦰 महिला शक्ति">👩‍🦰 महिला शक्ति</option>
                                        <option value="🚨 धांधली अलर्ट">🚨 धांधली अलर्ट</option>
                                        <option value="📜 संकल्प पत्र">📜 संकल्प पत्र</option>
                                        <option value="🚆 प्रवासी मतदाता">🚆 प्रवासी मतदाता</option>
                                    </select>
                                </div>

                                <!-- Notes Form -->
                                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;">
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">👨‍👩‍👧 परिवार विवरण (Family Info)</label>
                                        <input type="text" id="intel-family" placeholder="उदा: 5 वोट, चाचा जी साथ हैं..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">📢 चुनावी माहौल व चर्चा (Ground Mahool)</label>
                                        <input type="text" id="intel-mahool" placeholder="उदा: वार्ड में अच्छी हवा, विरोधियों की चर्चा..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                    <div>
                                        <label style="font-size: 11px; font-weight: 600; color: #475569;">📝 बाबा अभय सिंह प्राथमिकता रजिस्टर</label>
                                        <input type="text" id="intel-baba" placeholder="उदा: रास्ते की नाली ठीक करवाने का वादा..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                    </div>
                                </div>
                                <div style="margin-top: 10px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #475569;">🎯 इस मतदाता से बातचीत का विशेष लक्ष्य (Campaign Goal)</label>
                                    <input type="text" id="intel-goal" placeholder="उदा: कल सुबह चौपाल पर बुलाना, पानी का समाधान बताना, वार्ड 3 की नाराजगी दूर करना..." style="width: 100%; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background:#f8fafc; color:#0f172a;">
                                </div>
                                <div style="text-align: right; margin-top: 8px;">
                                    <button onclick="saveVoterIntelligence()" style="background: #2563eb; color: white; border: none; padding: 5px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                        💾 Save Notes & Intelligence
                                    </button>
                                    <span id="intel-save-status" style="font-size: 11px; font-weight: 600; color: #16a34a; margin-left: 8px; display: none;">✅ सहेज लिया गया!</span>
                                </div>
                            </div>

                            <!-- Messages Stream -->
                            <div class="wa-chat-scroll" id="wa-chat-scroll">
                                <div style="text-align: center; color: #8696a0; margin-top: 180px;">
                                    <div style="font-size: 44px; margin-bottom: 10px;">💬</div>
                                    <div style="font-weight: 700; font-size: 16px; color: #334155;">मतदाता संवाद कक्ष में आपका स्वागत है</div>
                                    <p style="font-size: 13px; max-width: 420px; margin: 6px auto 0 auto; color: #64748b;">बाईं तरफ से किसी भी मतदाता पर क्लिक करें। आप उनकी पूरी चैट देख सकते हैं, सीधे बात कर सकते हैं, या ऑटोपायलट संभाल सकते हैं।</p>
                                </div>
                            </div>

                            <!-- Quick Action Bar -->
                            <div class="wa-quick-actions" id="wa-quick-actions" style="display: none;">
                                <button class="wa-action-btn" style="background: #0284c7; color: white; border-color: #0369a1; font-weight: 700;" onclick="sendQuickAction('contact_card')">📇 संपर्क कार्ड (Anti-Ban)</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('ramram')">🙏 राम राम</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('demo_poster')">📸 डेमो पोस्टर भेजें</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('video')">📹 3D वीडियो रील</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('slip')">🎫 वोटर पर्ची निकालें</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('baba_register')">📝 बाबा रजिस्टर में दर्ज</button>
                                <button class="wa-action-btn" onclick="sendQuickAction('meeting')">🤝 चौपाल मुलाकात</button>
                            </div>

                            <!-- AI Copilot / Assisted Message Drafting Bar -->
                            <div id="wa-copilot-container" style="background: #f8fafc; padding: 8px 16px; border-top: 1px solid #e2e8f0; display: none; gap: 8px; align-items: center;">
                                <span style="font-size: 12px; font-weight: 700; color: #6366f1; white-space: nowrap;">✨ AI सह-चालक:</span>
                                <input type="text" id="wa-ai-instruction" placeholder="AI को निर्देश दें (उदा: 'बोलो कि कल सुबह 9 बजे चौपाल पर आएं और साथ में चाय पीते हैं')..." style="flex: 1; padding: 7px 12px; border-radius: 12px; border: 1px solid #cbd5e1; font-size: 12px; background: white; color: #0f172a;" onkeydown="if(event.key==='Enter') generateAIDraft()">
                                <button onclick="generateAIDraft()" id="btn-ai-draft" style="background: #6366f1; color: white; border: none; padding: 7px 14px; border-radius: 12px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;">
                                    ✨ ड्राफ्ट बनाएं
                                </button>
                            </div>

                            <!-- Chat Direct Input Bar -->
                            <div class="wa-input-container" id="wa-input-container" style="display: none;">
                                <input type="text" id="wa-direct-input" class="wa-input-field" placeholder="सीधा WhatsApp संदेश लिखें (Enter दबाएं या Send पर क्लिक करें)..." onkeydown="if(event.key==='Enter') sendManualWhatsAppReply()">
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
                        </div>
                    </div>

                    <!-- Quick Action Toolbars -->
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
                        <!-- Import from Voter DB -->
                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                            <span style="font-size: 12px; font-weight: 700; color: #334155;">📥 3,636 वोटर लिस्ट से आयात:</span>
                            <select id="import-ward-select" style="padding: 5px 8px; font-size: 12px; border-radius: 6px; border: 1px solid #cbd5e1; background: white;">
                                <option value="all">सभी वार्ड (1-11)</option>
                                <option value="1">वार्ड नं. 1</option>
                                <option value="2">वार्ड नं. 2</option>
                                <option value="3">वार्ड नं. 3</option>
                                <option value="4">वार्ड नं. 4</option>
                                <option value="5">वार्ड नं. 5</option>
                                <option value="6">वार्ड नं. 6</option>
                                <option value="7">वार्ड नं. 7</option>
                                <option value="8">वार्ड नं. 8</option>
                                <option value="9">वार्ड नं. 9</option>
                                <option value="10">वार्ड नं. 10</option>
                                <option value="11">वार्ड नं. 11</option>
                            </select>
                            <select id="import-line-select" style="padding: 5px 8px; font-size: 12px; border-radius: 6px; border: 1px solid #cbd5e1; background: white;">
                                <option value="sim_636">Primary Line (6367810227)</option>
                                <option value="baba_aux">Baba Aux Line</option>
                                <option value="canada">Canada Line (+1)</option>
                            </select>
                            <button onclick="importVotersToContacts()" style="background: #ea580c; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                📥 आयात करें
                            </button>
                        </div>

                        <!-- Direct Upload CSV / VCF -->
                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                            <span style="font-size: 12px; font-weight: 700; color: #334155;">📂 VCF / CSV फाइल अपलोड:</span>
                            <input type="file" id="vcf-upload-input" accept=".vcf,.csv" style="font-size: 12px;">
                            <button onclick="uploadContactsFile()" style="background: #2563eb; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                ⬆️ अपलोड करें
                            </button>
                        </div>
                    </div>

                    <!-- Add Single Contact Form (Collapsible/Inline) -->
                    <div style="background: white; border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 16px;">
                        <h4 style="margin: 0 0 10px 0; font-size: 13px; color: #0f172a;">➕ नया संपर्क सीधे जोड़ें</h4>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
                            <input type="text" id="new-c-name" placeholder="मतदाता का नाम (उदा: राजेश यादव)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <input type="text" id="new-c-phone" placeholder="मोबाइल नंबर (10 अंक)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <select id="new-c-ward" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                                <option value="1">वार्ड नं. 1</option>
                                <option value="2">वार्ड नं. 2</option>
                                <option value="3" selected>वार्ड नं. 3</option>
                                <option value="4">वार्ड नं. 4</option>
                                <option value="5">वार्ड नं. 5</option>
                                <option value="6">वार्ड नं. 6</option>
                                <option value="7">वार्ड नं. 7</option>
                                <option value="8">वार्ड नं. 8</option>
                                <option value="9">वार्ड नं. 9</option>
                                <option value="10">वार्ड नं. 10</option>
                                <option value="11">वार्ड नं. 11</option>
                            </select>
                            <select id="new-c-line" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                                <option value="sim_636">Primary Line (6367810227)</option>
                                <option value="baba_aux">Baba Aux Line</option>
                                <option value="canada">Canada Line (+1)</option>
                            </select>
                            <input type="text" id="new-c-notes" placeholder="नोट्स (उदा: पक्का समर्थक, 4 वोट)" style="padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                            <button onclick="saveSingleContact()" style="background: #16a34a; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">
                                💾 सहेजें
                            </button>
                        </div>
                    </div>

                    <!-- Filter & Search Bar -->
                    <div style="display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap;">
                        <input type="text" id="contact-search-input" placeholder="🔍 नाम या फोन नंबर से खोजें..." onkeyup="filterContactsTable()" style="flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
                        <select id="contact-filter-line" onchange="loadContacts()" style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; background: white;">
                            <option value="all">सभी लाइन्स (All WhatsApp)</option>
                            <option value="sim_636">Primary (6367810227)</option>
                            <option value="baba_aux">Baba Aux Line</option>
                            <option value="canada">Canada Line (+1)</option>
                        </select>
                        <select id="contact-filter-ward" onchange="loadContacts()" style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; background: white;">
                            <option value="all">सभी वार्ड (1-11)</option>
                            <option value="1">वार्ड 1</option>
                            <option value="2">वार्ड 2</option>
                            <option value="3">वार्ड 3</option>
                            <option value="4">वार्ड 4</option>
                            <option value="5">वार्ड 5</option>
                            <option value="6">वार्ड 6</option>
                            <option value="7">वार्ड 7</option>
                            <option value="8">वार्ड 8</option>
                            <option value="9">वार्ड 9</option>
                            <option value="10">वार्ड 10</option>
                            <option value="11">वार्ड 11</option>
                        </select>
                    </div>

                    <!-- Contacts Table -->
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 40px;"><input type="checkbox" id="select-all-contacts" onclick="toggleSelectAllContacts(this)"></th>
                                    <th>मतदाता का नाम</th>
                                    <th>फोन नंबर</th>
                                    <th>वार्ड</th>
                                    <th>WhatsApp लाइन</th>
                                    <th>नोट्स / पहचान</th>
                                    <th style="width: 140px;">कार्य (Action)</th>
                                </tr>
                            </thead>
                            <tbody id="contacts-table-body">
                                <tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 30px;">⏳ संपर्क लोड हो रहे हैं...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- TAB 5: Media Bank & Direct Uploader -->
                <div id="tab-media" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📸 Campaign Media Bank & Mobile Uploader</h3>
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
                            <button onclick="saveCampaignProfileUI()" style="margin-top:8px;background:#7c3aed;color:white;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;">Save Facts & Style</button>
                            <span id="campaign-profile-status" style="margin-left:10px;font-size:12px;color:#475569;"></span>
                        </div>
                    </div>
                    <!-- Daily Media Drip Schedule (4 Active Slots) -->
                    <div style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px 0; color: #0f172a;">⏰ दैनिक 4-स्लॉट ऑटोमैटिक शेड्यूल (Daily Drip Slots)</h4>
                        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin-bottom:12px;">
                            <label style="font-size:12px;">Morning <input id="schedule-morning-start" type="time"> to <input id="schedule-morning-end" type="time"></label>
                            <label style="font-size:12px;">Afternoon <input id="schedule-dopahar-start" type="time"> to <input id="schedule-dopahar-end" type="time"></label>
                            <label style="font-size:12px;">Evening <input id="schedule-evening-start" type="time"> to <input id="schedule-evening-end" type="time"></label>
                            <label style="font-size:12px;">Night <input id="schedule-night-start" type="time"> to <input id="schedule-night-end" type="time"></label>
                        </div>
                        <button onclick="saveCampaignAgendaUI()" style="margin-bottom:12px;background:#15803d;color:white;border:0;border-radius:7px;padding:7px 12px;font-weight:700;cursor:pointer;">Save Media Times</button>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #ea580c; font-size: 13px;">🌅 सुबह का स्लॉट</div>
                                <div style="font-size: 11px; color: #64748b;">08:30 AM - 10:30 AM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">डेली एजेंडा पोस्टर + माहौल हुक</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #0284c7; font-size: 13px;">☀️ दोपहर का स्लॉट</div>
                                <div style="font-size: 11px; color: #64748b;">01:30 PM - 03:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">विकास कार्य फैक्ट रिपोर्ट कार्ड</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #16a34a; font-size: 13px;">🌇 शाम का स्लॉट</div>
                                <div style="font-size: 11px; color: #64748b;">05:30 PM - 07:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">संकल्प व स्टेटस पोस्टर</div>
                            </div>
                            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                                <div style="font-weight: 700; color: #7c3aed; font-size: 13px;">🌙 रात का स्लॉट</div>
                                <div style="font-size: 11px; color: #64748b;">08:00 PM - 09:30 PM</div>
                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">3D विकास संकल्प वीडियो रील</div>
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
            </div>

            <!-- Dashboard JavaScript -->
            <script>
                let allVoters = [];
                let selectedVoterPhone = null;
                let currentPosterBlob = null;
                let aiHistory = [];

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
                loadDailyGoalUI();
                loadCampaignProfileUI();

                async function sendCustomPosterDirect() {
                    const phone = document.getElementById('p-voter-phone').value.trim();
                    const name = document.getElementById('p-name').value.trim();
                    const aspect = document.getElementById('p-aspect').value || '9:16';
                    const slogan = document.getElementById('p-slogan').value.trim();
                    const statusEl = document.getElementById('p-send-status');

                    if (!phone || phone.length < 10) {
                        alert('कृपया मतदाता का सही 10 अंकों का मोबाइल नंबर दर्ज करें!');
                        return;
                    }

                    statusEl.style.color = '#2563eb';
                    statusEl.textContent = '⏳ नाम सहित कस्टम पोस्टर जनरेट करके WhatsApp पर भेजा जा रहा है...';

                    try {
                        const res = await fetch('/api/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                phone: phone,
                                name: name,
                                mediaOption: 'custom_poster',
                                customText: 'राम राम ' + (name ? name + ' जी' : 'भाई जी') + '! 🙏\nबाबा अभय सिंह टीम द्वारा आपके नाम का विशेष WhatsApp Status पोस्टर तैयार कर दिया गया है।\nइसे अपने स्टेटस व प्रोफाइल पर ज़रूर लगाएं! 🚩'
                            })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            statusEl.style.color = '#16a34a';
                            statusEl.textContent = '✅ पोस्टर सफलता पूर्वक ' + phone + ' को भेज दिया गया है!';
                        } else {
                            statusEl.style.color = '#dc2626';
                            statusEl.textContent = '❌ त्रुटि: ' + (data.error || 'भेजने में विफल');
                        }
                    } catch (err) {
                        statusEl.style.color = '#dc2626';
                        statusEl.textContent = '❌ नेटवर्क त्रुटि: ' + err.message;
                    }
                }

                function switchTab(tabId, btn) {
                    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
                    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                    const target = document.getElementById('tab-' + tabId);
                    if (target) target.style.display = 'block';
                    const activeBtn = btn || document.getElementById('tab-btn-' + tabId);
                    if (activeBtn) activeBtn.classList.add('active');
                    if (tabId === 'voters') loadVoters();
                    if (tabId === 'contacts') loadContacts();
                    if (tabId === 'playground' && typeof loadCampaignAgendaUI === 'function') loadCampaignAgendaUI();
                }

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
                                emptyEl.textContent = 'कोई मतदाता नहीं मिला';
                                dropdown.appendChild(emptyEl);
                                dropdown.style.display = 'block';
                                return;
                            }
                            data.results.slice(0, 8).forEach(function(v) {
                                const rel = v.rel_type === 'H' ? 'पति' : 'पिता';
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
                                subtitle.textContent = rel + ': ' + (v.rel_name_hi || v.rel_name || '--') + ' | वार्ड: ' + (v.ward || '--') + ' | क्रम #' + (v.sr_no || '--') + ' | EPIC: ' + (v.epic || '--');
                                
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
                    const rel = v.rel_type === 'H' ? 'पति' : 'पिता';
                    badge.innerHTML = '✅ <strong>' + (v.name_hi || v.name) + '</strong> (' + rel + ': ' + (v.rel_name_hi || '--') + ', वार्ड ' + v.ward + ', #' + v.sr_no + ', EPIC: ' + v.epic + ') <button type="button" onclick="clearLinkedVoter()" style="background: none; border: none; color: #dc2626; cursor: pointer; margin-left: 8px; font-weight: 700;">✕ Unlink</button>';
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
                    const crmBtn = document.querySelectorAll('.tab-btn')[4];
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
                            badge.innerText = '📸 डेमो पोस्टर मोड: चालू';
                        } else {
                            badge.style.background = '#e0f2fe';
                            badge.style.color = '#0284c7';
                            badge.style.borderColor = '#0284c7';
                            badge.innerText = '🖼️ ओरिजिनल पोस्टर मोड';
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
                        applyTagFilter(currentFilterTag);
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

                    if (tag === 'ALL') {
                        renderVoterList(allVoters);
                    } else if (tag === 'MANUAL') {
                        const filtered = allVoters.filter(function(v) { return v.autoPilot === false; });
                        renderVoterList(filtered);
                    } else {
                        const filtered = allVoters.filter(function(v) {
                            return (v.tags && v.tags.indexOf(tag) !== -1) || v.voterSentiment === tag;
                        });
                        renderVoterList(filtered);
                    }
                }

                function filterVoters(q) {
                    const lower = (q || '').toLowerCase();
                    const filtered = allVoters.filter(function(v) {
                        const nameMatch = v.name && v.name.toLowerCase().indexOf(lower) !== -1;
                        const phoneMatch = v.phone && v.phone.indexOf(lower) !== -1;
                        const tagMatch = v.tags && v.tags.some(function(t) { return t.toLowerCase().indexOf(lower) !== -1; });
                        return nameMatch || phoneMatch || tagMatch;
                    });
                    renderVoterList(filtered);
                }

                function renderVoterList(voters) {
                    const listUi = document.getElementById('voter-list-ui');
                    if (!voters || voters.length === 0) {
                        listUi.innerHTML = '<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 13px;">कोई मतदाता नहीं मिला।</div>';
                        return;
                    }

                    listUi.innerHTML = voters.map(function(v) {
                        const isSelected = selectedVoterPhone === v.phone;
                        const initial = (v.name && v.name.trim()) ? v.name.trim().charAt(0).toUpperCase() : '👤';
                        const lastMsg = (v.history && v.history.length > 0) ? v.history[v.history.length - 1] : null;
                        const snippet = lastMsg ? ((lastMsg.role === 'user' ? '📩 ' : '🚩 ') + lastMsg.text) : 'नई बातचीत...';
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
                                    '<div class="wa-contact-name">' + (v.name || 'ग्रामवासी') + '</div>' +
                                    '<div class="wa-contact-time">' + time + '</div>' +
                                '</div>' +
                                '<div class="wa-contact-sub">' +
                                    '<span>+' + v.phone + '</span>' +
                                    autoPilotBadge +
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

                        document.getElementById('header-name').innerText = v.name || 'ग्रामवासी';
                        const details = '+' + v.phone + ' • वार्ड: ' + (v.ward || '--') + (v.fatherOrSpouse ? ' • संबंध: ' + v.fatherOrSpouse : '');
                        document.getElementById('header-details').innerText = details;
                        document.getElementById('header-avatar').innerText = (v.name && v.name.trim()) ? v.name.trim().charAt(0).toUpperCase() : '👤';

                        // AutoPilot Button State
                        const apBtn = document.getElementById('btn-toggle-autopilot');
                        if (v.autoPilot === false) {
                            apBtn.style.background = '#f97316';
                            apBtn.innerText = '⏸️ मैन्युअल मोड: सक्रिय';
                            apBtn.title = 'Click to activate AI AutoPilot';
                        } else {
                            apBtn.style.background = '#16a34a';
                            apBtn.innerText = '🤖 AutoPilot AI: चालू';
                            apBtn.title = 'Click to pause AI and takeover manually';
                        }

                        // Sentiment select
                        document.getElementById('voter-sentiment-select').value = v.voterSentiment || 'neutral';

                        // Populate Intelligence notes
                        document.getElementById('intel-family').value = v.familyNotes || '';
                        document.getElementById('intel-mahool').value = v.mahoolNotes || '';
                        document.getElementById('intel-baba').value = v.babaNotes || '';
                        document.getElementById('intel-goal').value = v.campaignGoal || '';
                        document.getElementById('wa-copilot-container').style.display = 'flex';
                        renderActiveTags(v.tags || []);

                        // Render messages
                        const scrollUi = document.getElementById('wa-chat-scroll');
                        if (!v.history || v.history.length === 0) {
                            scrollUi.innerHTML = '<div style="text-align:center; color:#94a3b8; margin-top:150px;">इस मतदाता के साथ अभी कोई संदेश रिकॉर्ड नहीं हुआ है। नीचे से सीधा संदेश भेजें!</div>';
                            return;
                        }

                        scrollUi.innerHTML = v.history.map(function(h) {
                            let bubbleClass = 'wa-bubble-user';
                            let senderLabel = '👤 ' + (v.name || 'वोटर');

                            if (h.role === 'bot') {
                                if (h.session === 'Admin Direct' || h.session === 'Admin Manual' || h.session === 'Admin Quick Action') {
                                    bubbleClass = 'wa-bubble-admin';
                                    senderLabel = '👨‍💻 एडमिन सीधा संदेश (' + h.session + ')';
                                } else {
                                    bubbleClass = 'wa-bubble-bot';
                                    senderLabel = '🚩 बाबा अभय सिंह जनसंपर्क';
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
                        customNote = prompt('बाबा अभय सिंह के प्राथमिकता रजिस्टर में क्या समस्या दर्ज करनी है?');
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
            
            
                async function checkTunnelStatus() {
                    try {
                        const res = await fetch('/api/tunnel-status');
                        const data = await res.json();
                        const el = document.getElementById('tunnel-badge');
                        if (data.success && data.url) {
                            el.innerHTML = '🔗 <a href="' + data.url + '" target="_blank" style="color:#0369a1; text-decoration:none; font-weight:bold;">' + data.url.replace("https://", "") + '</a> <button data-url="' + data.url + '" onclick="navigator.clipboard.writeText(this.dataset.url); alert(&quot;Tunnel URL Copied!&quot;);" style="background:none; border:none; cursor:pointer; font-size:11px;" title="Copy Tunnel URL">📋</button>';
                        } else {
                            el.innerHTML = '🔗 Port 3000 Active';
                        }
                    } catch (e) {}
                }
                checkTunnelStatus();

                async function generateAIDraft() {
                    if (!selectedVoterPhone) return;
                    const inputEl = document.getElementById('wa-ai-instruction');
                    const instruction = inputEl.value.trim();
                    if (!instruction) {
                        alert('कृपया AI को निर्देश लिखें (उदा: "बोलो कि कल सुबह चौपाल पर आएं")');
                        return;
                    }

                    const btn = document.getElementById('btn-ai-draft');
                    btn.disabled = true;
                    btn.innerText = '⏳ सोच रहे हैं...';

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
                        btn.innerText = '✨ ड्राफ्ट बनाएं';
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
                            alert('✅ चुनावी एजेंडा सफलतापूर्वक सेव हो गया!');
                        }
                    } catch (e) {
                        alert('एजेंडा सेव करने में त्रुटि: ' + e.message);
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
                    resEl.innerHTML = '⏳ खोज रहे हैं...';
                    try {
                        const res = await fetch('/api/search-voters?q=' + encodeURIComponent(q));
                        const data = await res.json();
                        if (data && data.results && data.results.length > 0) {
                            let html = '<b>' + data.results.length + ' परिणाम मिले:</b><br>';
                            data.results.slice(0, 3).forEach(v => {
                                html += '<div style="margin-top:4px; padding:4px; background:white; border-radius:4px; border:1px solid #cbd5e1;">'
                                    + '🏛️ <b>' + v.name + '</b> (W' + v.ward + ', #' + v.sr_no + ')<br>'
                                    + 'संबंधी: ' + v.rel_name + ' (' + v.rel_type + ') | EPIC: ' + v.epic + '<br>'
                                    + 'मकान: ' + v.house_no + ' | बूथ: ' + v.booth
                                    + '</div>';
                            });
                            resEl.innerHTML = html;
                        } else {
                            resEl.innerHTML = '❌ कोई पर्ची नहीं मिली। स्पेलिंग जांचें।';
                        }
                    } catch (e) {
                        resEl.innerHTML = 'सर्च त्रुटि: ' + e.message;
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
                    btn.innerText = '⏳ सोच रहे हैं...';

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
                            document.getElementById('pg-metric-tags').innerText = (data.user?.tags || []).join(', ') || 'सामान्य';
                            document.getElementById('pg-metric-drip').innerText = data.nextDripMedia ? data.nextDripMedia.title : 'पूर्ण';
                        } else {
                            chatUi.innerHTML += '<div class="bubble bubble-bot" style="color:red;">त्रुटि: ' + (data.error || 'अज्ञात समस्या') + '</div>';
                        }
                    } catch (e) {
                        chatUi.innerHTML += '<div class="bubble bubble-bot" style="color:red;">कनेक्शन त्रुटि: ' + e.message + '</div>';
                    } finally {
                        btn.disabled = false;
                        btn.innerText = 'भेजें 🚀';
                    }
                }

                // --- Contacts Manager Client Logic ---
                let cachedContacts = [];

                async function loadContacts() {
                    const line = document.getElementById('contact-filter-line')?.value || 'all';
                    const ward = document.getElementById('contact-filter-ward')?.value || 'all';
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
                        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">त्रुटि: ' + e.message + '</td></tr>';
                    }
                }

                function renderContactsTable(list) {
                    const tbody = document.getElementById('contacts-table-body');
                    if (!tbody) return;
                    if (!list || list.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:30px;">कोई संपर्क नहीं मिला। ऊपर से नया जोड़ें या वोटर लिस्ट से आयात करें!</td></tr>';
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
                            '<td style="font-weight:700; color:#0f172a;">' + escapeHtml(c.name) + '</td>' +
                            '<td style="font-family:monospace; font-weight:600; color:#2563eb;">' + escapeHtml(c.phone) + '</td>' +
                            '<td><span style="background:#f1f5f9; padding:2px 8px; border-radius:4px; font-weight:700;">वार्ड ' + c.ward + '</span></td>' +
                            '<td><span style="background:' + lineBg + '; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">' + lineBadge + '</span></td>' +
                            '<td style="font-size:12px; color:#64748b;">' + escapeHtml(c.notes || '--') + '</td>' +
                            '<td>' +
                                '<button data-phone="' + (c.phone || '') + '" data-name="' + escapeHtml(c.name || '') + '" onclick="sendQuickWhatsAppToPhone(this.dataset.phone, this.dataset.name)" style="background:#16a34a; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:700; cursor:pointer; margin-right:4px;">📲 चैट</button>' +
                                '<button data-id="' + c.id + '" onclick="deleteContactRow(this.dataset.id)" style="background:#ef4444; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:700; cursor:pointer;">✕</button>' +
                            '</td>' +
                        '</tr>';
                    }
                    tbody.innerHTML = rows;
                }

                function filterContactsTable() {
                    const q = document.getElementById('contact-search-input')?.value.toLowerCase().trim() || '';
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

                    if (!phone) { alert('मोबाइल नंबर आवश्यक है!'); return; }
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
                            alert('✅ संपर्क सहेज लिया गया!');
                        } else {
                            alert('त्रुटि: ' + data.error);
                        }
                    } catch (e) { alert('Error: ' + e.message); }
                }

                async function deleteContactRow(id) {
                    if (!confirm('क्या आप इस संपर्क को हटाना चाहते हैं?')) return;
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
                    const confirmMsg = 'क्या आप ' + (ward === 'all' ? 'सभी वार्डों' : 'वार्ड ' + ward) + ' के मतदाताओं को संपर्क सूची में आयात करना चाहते हैं?';
                    if (!confirm(confirmMsg)) return;

                    try {
                        const res = await fetch('/api/contacts/import-voters', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ward, line, limit: 100 })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('✅ ' + data.added + ' मतदाता संपर्क सूची में आयात कर लिए गए!');
                            loadContacts();
                        } else {
                            alert('त्रुटि: ' + data.error);
                        }
                    } catch (e) { alert('Error: ' + e.message); }
                }

                async function uploadContactsFile() {
                    const input = document.getElementById('vcf-upload-input');
                    const file = input.files[0];
                    if (!file) { alert('कृपया VCF या CSV फाइल चुनें!'); return; }

                    const reader = new FileReader();
                    reader.onload = async function(e) {
                        const text = e.target.result;
                        try {
                            const res = await fetch('/api/contacts/import-vcf', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ vcfText: text })
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert('✅ ' + data.count + ' संपर्क सफलतापूर्वक आयात हुए!');
                                loadContacts();
                                input.value = '';
                            } else {
                                alert('त्रुटि: ' + data.error);
                            }
                        } catch (err) { alert('Upload error: ' + err.message); }
                    };
                    reader.readAsText(file);
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
        </body>
        </html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        sessions: SESSIONS.map(s => ({
            id: s.id,
            status: s.status,
            user: s.sock?.user
        }))
    });
});

// Background Auto-Sync Watchdog (Checks GitHub every 35s, resets cleanly, installs fonts, reloads PM2)
if (process.platform === 'linux') {
    console.log('[AutoSync] 🛡️ Continuous GitHub Auto-Update Watchdog Active (every 35s)');
    setInterval(() => {
        exec(`git fetch origin ${DEPLOY_BRANCH} > /dev/null 2>&1`, (err) => {
            if (err) return;
            exec(`git rev-parse HEAD && git rev-parse origin/${DEPLOY_BRANCH}`, (err2, stdout2) => {
                if (err2 || !stdout2) return;
                const hashes = stdout2.trim().split(/\s+/);
                if (hashes.length >= 2 && hashes[0] !== hashes[1]) {
                    console.log(`[AutoSync] 🚀 New GitHub commit detected (${hashes[0].slice(0,7)} -> ${hashes[1].slice(0,7)})! Auto-updating...`);
                    const updateCmd = [
                        `git merge --ff-only origin/${DEPLOY_BRANCH}`,
                        'mkdir -p ~/.fonts ~/.local/share/fonts',
                        'cp media/*.ttf ~/.fonts/ 2>/dev/null || true',
                        'cp media/*.ttf ~/.local/share/fonts/ 2>/dev/null || true',
                        'fc-cache -f ~/.fonts 2>/dev/null || true',
                        'rm -rf parchi_cache/*',
                        'pm2 restart all'
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


    // Start Proactive Daytime Nudge Interval (Every 15 mins)
    setInterval(() => {
        const prim = SESSIONS.find(s => s.id === 'sim_636');
        if (prim && prim.sock && prim.status === 'CONNECTED') {
            runProactiveNudges(prim.sock);
        }
    }, 15 * 60 * 1000);

    app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
});
