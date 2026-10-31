
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
            if (u.proactivePingCount >= 2) continue;

            const lastSeenDate = new Date(u.lastSeen);
            const hoursSinceLastChat = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60);

            const lastPingDate = u.lastPingTime ? new Date(u.lastPingTime) : null;
            const hoursSinceLastPing = lastPingDate ? (Date.now() - lastPingDate.getTime()) / (1000 * 60 * 60) : 999;

            if (hoursSinceLastChat >= 2.5 && hoursSinceLastChat <= 8 && hoursSinceLastPing >= 20) {
                const nudges = [
                    `अरे भैया, सुनिए ना... 🙏 आपने बताया नहीं, घर पर सब ठीक-ठाक हैं न? भाभी जी और बच्चे कैसे हैं? सोचा एक बार हाल-चाल पूछ लूं! 😊`,
                    `राम राम भैया! 🚩 आज बाबा अभय सिंह के चुनाव प्रचार का बहुत सुंदर WhatsApp स्टेटस बना है। अगर आप कहें तो आपके नाम का एक प्यारा सा पोस्टर बना कर भेज दूं? अपने स्टेटस पर जरूर लगाना भैया! 📲`,
                    `सुनिए भैया... इस बार अपने वार्ड में गांव के विकास का क्या माहौल लग रहा है? बाबा अभय सिंह (मोटी आंगली वाले बाबा) के काम तो सबने देखे ही हैं, आपकी क्या राय है भैया? 🙏`
                ];
                const pickedNudge = nudges[(u.proactivePingCount || 0) % nudges.length];
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
const aiService = require('./ai_assistant_service.js');
const userMemory = require('./user_memory.js');
const posterEngine = require('./poster_engine.js');
const mediaCatalog = require('./media_catalog.js');

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
    { id: 'baba_aux', name: 'Baba Aux Line (Secondary)', status: 'DISCONNECTED', qr: null, sock: null },
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
    '90959605924011': '918764870431' // Pre-mapped from verified chat
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
                        const handshakeText = "राम राम भाई जी! 🙏\nबाबा अभय सिंह सेवा केंद्र (ग्राम पंचायत सिहाली खुर्द) में आपका स्वागत है।\nवोटर लिस्ट में नाम व पर्ची देखने के लिए अपना नाम लिखकर भेजें! 🚩";
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
                    const lower = body.toLowerCase();
                    const isParchiQuery = lower.includes('parchi') || lower.includes('voter') || lower.includes('पर्ची') || lower.includes('नाम') || lower.includes('epic') || lower.includes('ward') || lower.includes('वार्ड');
                    const isPhotoQuery = lower.includes('photo') || lower.includes('poster') || lower.includes('फोटो') || lower.includes('पोस्टर') || lower.includes('तस्वीर') || lower.includes('banner') || lower.includes('image');
                    const isVideoQuery = lower.includes('video') || lower.includes('reel') || lower.includes('वीडियो') || lower.includes('रील') || lower.includes('clip');
                    const isPosterGenQuery = lower.includes('poster bana') || lower.includes('status bana') || lower.includes('फोटो बना') || lower.includes('पोस्टर बना');

                    const posterPath = path.join(__dirname, 'media', 'poster.jpg');
                    const videoPath = path.join(__dirname, 'media', 'campaign_reel.mp4');

                    // Extract Ward if mentioned
                    const user = userMemory.getUser(senderPhone);
                    const wardMatch = lower.match(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/i);
                    if (wardMatch) {
                        user.ward = parseInt(wardMatch[1]);
                        userMemory.save();
                    }

                    const isParchiConfirm = lower.includes('bhej do') || lower.includes('bhejo') || lower.includes('send') || lower.includes('nikalo') || lower.includes('निकालो') || lower.includes('भेज दो') || lower.includes('भेजो') || (lower.includes('haa') && lower.includes('parchi'));

                    const matches = voterEngine.searchVoters(body, 5, user.ward);

                    if (isPosterGenQuery) {
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

                        replyText = `राम राम ${voterName} जी! 🙏\nबाबा अभय सिंह सेवा केंद्र द्वारा आपके नाम का विशेष WhatsApp Status पोस्टर तैयार कर दिया गया है।\nइसे अपने स्टेटस व प्रोफाइल पर जरूर लगाएं! 🚩`;

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
                    } else if (matches && matches.length > 0) {
                        // High-precision voter match found! Send voter slip immediately!
                        replyText = voterEngine.formatSlipResponse(matches[0]);
                        if (matches.length > 1) {
                            replyText += `\n\n📌 *नोट:* इस नाम से ${matches.length} मतदाता मिले हैं। सही पर्ची के लिए अपना वार्ड नंबर (उदा: "वार्ड ${matches[1].ward}") लिखकर भेजें।`;
                        }
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        mediaTypeSent = 'voterSlip';
                        console.log(`[${sessionObj.id}] ✅ Sent voter slip to ${senderPhone} (${matches[0].name_hi})`);
                    } else if (body.toLowerCase().includes('prince')) {
                        replyText = `राम राम प्रिंस भाई जी! 🙏\nआप बाबा अभय सिंह (मोटी आंगली वाले बाबा) के मुख्य चुनाव प्रचारक व डिजिटल सेवा प्रभारी हैं।\nसिहाली खुर्द 2026 का डिजिटल अभियान 24/7 पूरे दम-खम के साथ लाइव है! 🚩\nबताइए भाई जी, आज के प्रचार या सिस्टम में क्या नया अपडेट करना है?`;
                        await sendSafeMessage(sock, replyJid, { text: replyText });
                        console.log(`[${sessionObj.id}] ✅ Recognized Campaign Lead Prince (${senderPhone})`);
                    } else {
                        // AI Assistant query
                        const history = userMemory.getUserHistory(senderPhone).map(h => ({
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

        if (template === 'welcome') {
            const greetingName = name ? ` ${name} जी` : ' भाई जी';
            messageText = `राम राम${greetingName}! 🙏\n\nबाबा अभय सिंह (मोटी आंगली वाले बाबा) डिजिटल सेवा केंद्र में आपको जोड़ लिया गया है।\nगांव के विकास और अपनी वोटर पर्ची की जानकारी के लिए यहाँ कभी भी मैसेज कर सकते हैं! 🚩`;
            await sock.sendMessage(jid, { text: messageText });
            mediaType = 'welcome';
        } else if (template === 'poster') {
            messageText = `राम राम${name ? ' ' + name + ' जी' : ' भाई जी'}! 🙏\n\nबाबा अभय सिंह (मोटी आंगली वाले बाबा) - ग्राम पंचायत सिहाली खुर्द 🚩\nसच्चा विकास, ईमानदार नेतृत्व।\n16 नवम्बर 2026 को भारी मतों से विजयी बनाएं!`;
            if (fs.existsSync(posterPath)) {
                await sock.sendMessage(jid, {
                    image: fs.readFileSync(posterPath),
                    caption: messageText
                });
                mediaType = 'poster';
            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        } else if (template === 'custom_poster') {
            // Generate on the fly poster with voter name
            const buf = await posterEngine.generatePoster({ name: name || 'ग्रामवासी', aspect: '9:16' });
            messageText = `राम राम${name ? ' ' + name + ' जी' : ' भाई जी'}! 🙏\nआपके नाम का सिहाली खुर्द 2026 स्टेटस पोस्टर तैयार है।\nबाबा अभय सिंह (मोटी आंगली वाले बाबा) 🚩`;
            await sock.sendMessage(jid, {
                image: buf,
                caption: messageText
            });
            mediaType = 'customPoster';
        } else if (template === 'video') {
            messageText = `सिहाली खुर्द के विकास का संकल्प - बाबा अभय सिंह 🚩📹\n16 नवम्बर 2026 को भारी मतों से विजयी बनाएं!`;
            if (fs.existsSync(videoPath)) {
                await sock.sendMessage(jid, {
                    video: (aiService.CONFIG?.media_urls?.campaign_reel_video || process.env.GITHUB_VIDEO_URL) ? { url: aiService.CONFIG?.media_urls?.campaign_reel_video || process.env.GITHUB_VIDEO_URL } : fs.readFileSync(videoPath),
                    caption: messageText
                });
                mediaType = 'video';
            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        } else if (template === 'slogan') {
            const slogan = userMemory.getNextSlogan(cleanedPhone);
            messageText = `राम राम भाई जी! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
            await sock.sendMessage(jid, { text: messageText });
        } else {
            messageText = customText || 'राम राम भाई जी! 🙏';
            await sock.sendMessage(jid, { text: messageText });
        }

        userMemory.getUser(cleanedPhone, name);
        userMemory.recordMessage(cleanedPhone, 'bot', messageText, mediaType, sessionName);

        logMessage({
            session: sessionName,
            phone: cleanedPhone,
            incoming: `[Quick Add: ${name || 'Voter'}]`,
            reply: messageText,
            status: mediaType ? 'MEDIA_SENT' : 'DELIVERED'
        });

        res.json({
            success: true,
            phone: cleanedPhone,
            line: sessionName,
            message: messageText
        });
    } catch (err) {
        console.error('Error in /api/send-message:', err);
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

        const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
        const targetPath = path.join(__dirname, 'media', target);
        fs.writeFileSync(targetPath, Buffer.from(cleanBase64, 'base64'));

        console.log(`[Upload] Uploaded new media: ${target} (${cleanBase64.length} chars)`);
        res.json({ success: true, message: `Successfully updated ${target}!` });
    } catch (e) {
        console.error('Error in /api/upload-media:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: Test AI Directly in Dashboard Playground
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

// API: Update voter intelligence notes (Family, Mahool, Baba)
app.post('/api/update-notes', (req, res) => {
    const { phone, familyNotes, mahoolNotes, babaNotes } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    const user = userMemory.updateNotes(phone, { familyNotes, mahoolNotes, babaNotes });
    res.json({ success: true, phone, user });
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

        if (action === 'demo_poster') {
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
                replyText = `राम राम जी! 🙏\nआपकी वोटर पर्ची निकालने के लिए कृपया अपना सही नाम या वोटर आईडी (EPIC) नंबर लिखकर भेजें।\nबाबा अभय सिंह डिजिटल सेवा केंद्र 🚩`;
            }
            await sock.sendMessage(jid, { text: replyText });
            mediaType = 'voterSlip';
        } else if (action === 'ramram') {
            const user = userMemory.getUser(cleanedPhone);
            replyText = `राम राम ${user.name ? user.name + ' जी' : 'भाई जी'}! 🙏🚩\nबाबा अभय सिंह (मोटी आंगली वाले बाबा) के सेवा केंद्र से आपका बहुत-बहुत स्वागत है। बताइए आज परिवार में सब कुशल मंगल?`;
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

        res.json({ success: true, action, message: replyText });
    } catch (e) {
        console.error('Error in /api/quick-action:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/voter/:phone', (req, res) => {
    const phone = req.params.phone;
    const user = userMemory.getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
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
app.get('/update', (req, res) => {
    console.log('[AutoDeploy] Pulling latest code from GitHub...');
    exec('git pull origin main && pm2 restart whatsapp-bot', (err, stdout, stderr) => {
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

// Background Auto-Sync Watchdog (checks GitHub every 60s for new commits)
setInterval(() => {
    exec('git fetch origin main > /dev/null 2>&1 && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && git pull origin main && pm2 restart whatsapp-bot', (err, stdout, stderr) => {
        if (!err && stdout && stdout.trim()) {
            console.log('[AutoSync] Pulled updates from GitHub & reloaded bot:', stdout.trim());
        }
    });
}, 60000);


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
