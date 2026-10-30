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

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));
app.use('/media', express.static(path.join(__dirname, 'media')));

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

                const remoteJid = msg.key?.remoteJid || '';
                if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
                    continue; // Skip group chats & status
                }

                const senderPhone = remoteJid.split('@')[0];

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
                    console.log(`[${sessionObj.id}] Decryption empty or Bad MAC for ${remoteJid}`);
                    logDiagnostic({
                        session: sessionObj.name,
                        phone: senderPhone,
                        incoming: '[Encrypted Packet / Bad MAC Decryption Error]',
                        reply: 'Sent auto-handshake welcome to repair Signal ratchet.',
                        status: 'BAD_MAC'
                    });

                    // Send auto-handshake welcome message so voter gets an instant reply and Signal session re-synchronizes!
                    try {
                        const handshakeText = "राम राम भाई जी! 🙏\nबाबा अभय सिंह सेवा केंद्र (ग्राम पंचायत सिहाली खुर्द) में आपका स्वागत है।\nवोटर लिस्ट में नाम व पर्ची देखने के लिए अपना नाम लिखकर भेजें! 🚩";
                        await sock.sendMessage(remoteJid, { text: handshakeText });
                        console.log(`[${sessionObj.id}] ✅ Sent handshake reply to ${remoteJid} to restore Signal ratchet`);
                        userMemory.recordMessage(senderPhone, 'bot', handshakeText, null, sessionObj.name);
                        logMessage({
                            session: sessionObj.name,
                            phone: senderPhone,
                            incoming: '[New Contact / Welcome Handshake]',
                            reply: handshakeText,
                            status: 'HANDSHAKE_SENT'
                        });
                    } catch (handshakeErr) {
                        console.error(`[${sessionObj.id}] Handshake reply error:`, handshakeErr?.message);
                    }
                    continue;
                }

                console.log(`[${sessionObj.id}] Received from ${senderPhone}: "${body}"`);

                // Record user message in memory
                userMemory.recordMessage(senderPhone, 'user', body, null, sessionObj.name);

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

                    const matches = voterEngine.searchVoters(body);

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

                        await sock.sendMessage(remoteJid, {
                            image: statusPosterBuffer,
                            caption: replyText
                        }, { quoted: msg });

                        mediaTypeSent = 'customPoster';
                        console.log(`[${sessionObj.id}] ✅ Sent personalized poster to ${senderPhone} (${voterName})`);
                    } else if (isVideoQuery && fs.existsSync(videoPath)) {
                        const alreadySent = userMemory.hasSentMedia(senderPhone, 'video');
                        replyText = alreadySent
                            ? "भाई जी, ये 3D वीडियो पहले भी भेजी थी, एक बार फिर देख लो और आगे शेयर जरूर करना! 😊🚩\n16 नवम्बर 2026 — बाबा अभय सिंह"
                            : "सिहाली खुर्द के विकास का संकल्प - बाबा अभय सिंह (मोटी आंगली वाले बाबा) 🚩📹\n16 नवम्बर 2026 को भारी मतों से विजयी बनाएं!";

                        await sock.sendMessage(remoteJid, {
                            video: fs.readFileSync(videoPath),
                            caption: replyText
                        }, { quoted: msg });

                        mediaTypeSent = 'video';
                        console.log(`[${sessionObj.id}] ✅ Sent video reel to ${senderPhone}`);
                    } else if (isPhotoQuery && fs.existsSync(posterPath)) {
                        replyText = "बाबा अभय सिंह (मोटी आंगली वाले बाबा) - ग्राम पंचायत सिहाली खुर्द 🚩\nसच्चा विकास, ईमानदार नेतृत्व।\nवोटर पर्ची देखने के लिए अपना नाम लिखकर भेजें!";

                        await sock.sendMessage(remoteJid, {
                            image: fs.readFileSync(posterPath),
                            caption: replyText
                        }, { quoted: msg });

                        mediaTypeSent = 'poster';
                        console.log(`[${sessionObj.id}] ✅ Sent poster image to ${senderPhone}`);
                    } else if (matches && matches.length > 0 && isParchiQuery) {
                        replyText = voterEngine.formatSlipResponse(matches[0]);
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                        mediaTypeSent = 'voterSlip';
                        console.log(`[${sessionObj.id}] ✅ Sent voter slip to ${senderPhone}`);
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
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                        console.log(`[${sessionObj.id}] ✅ Replied via AI/local to ${senderPhone}`);
                    }
                } catch (err) {
                    console.error(`[${sessionObj.id}] Error resolving reply:`, err);
                    replyText = aiService.getFastLocalAnswer(body, senderPhone);
                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg }).catch(e => console.error('Fallback send failed:', e));
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
                    video: fs.readFileSync(videoPath),
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
app.get('/api/voter/:phone', (req, res) => {
    const phone = req.params.phone;
    const user = userMemory.getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// API: PM2 Debug Logs
app.get('/api/debug', (req, res) => {
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
            ? `<div style="text-align:right;"><span style="color:#16a34a; font-weight:700; font-size:12px;">🟢 ONLINE</span><br><a href="/reset/${s.id}" onclick="return confirm('Clean reset and re-link ${s.name}?')" style="color:#64748b; font-size:11px; text-decoration:underline;">Re-link</a></div>`
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
                                <label>Voter Mobile Number *</label>
                                <input type="tel" id="v-phone" class="input-field" placeholder="e.g. 9829xxxxxx or 6367810227" required autocomplete="off">
                            </div>
                            <div class="form-group">
                                <label>Voter Name (Optional)</label>
                                <input type="text" id="v-name" class="input-field" placeholder="e.g. Ramesh Sharma" autocomplete="off">
                            </div>
                            <div class="form-group">
                                <label>Sending WhatsApp Line</label>
                                <select id="v-line" class="input-field">
                                    <option value="sim_636">Primary Line (6367810227)</option>
                                    <option value="baba_aux">Baba Aux Line (Secondary)</option>
                                    <option value="canada">Canada Line (+1)</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Action Template</label>
                                <select id="v-template" class="input-field" onchange="toggleCustomText(this.value)">
                                    <option value="welcome">Instant Connect ("Aapko jod liya h...")</option>
                                    <option value="custom_poster">Personalized Name Poster 🎨</option>
                                    <option value="poster">Official Campaign Poster 📸</option>
                                    <option value="video">3D Campaign Video Reel 📹</option>
                                    <option value="slogan">Rotating Campaign Slogan 🚩</option>
                                    <option value="custom">Custom Message...</option>
                                </select>
                            </div>
                            <div class="form-group" style="grid-column: 1 / -1; display: none;" id="custom-text-group">
                                <label>Custom WhatsApp Message</label>
                                <input type="text" id="v-custom-text" class="input-field" placeholder="Type custom message to send...">
                            </div>
                        </div>

                        <button type="submit" class="btn-add" id="btn-submit">
                            📲 Jod Lo & Send WhatsApp Instantly
                        </button>
                    </form>
                </div>

                <!-- Tabbed Navigation -->
                <div class="tabs">
                    <button class="tab-btn active" onclick="switchTab('feed')">💬 Live Voter Chat</button>
                    <button class="tab-btn" onclick="switchTab('diagnostics')">🛠️ Diagnostics & Self-Test Log</button>
                    <button class="tab-btn" onclick="switchTab('studio')">🎨 Live Poster Studio</button>
                    <button class="tab-btn" onclick="switchTab('playground')">🤖 AI Playground & Lab</button>
                    <button class="tab-btn" onclick="switchTab('voters')">👤 Voter Memory (<span id="voter-count">0</span>)</button>
                    <button class="tab-btn" onclick="switchTab('media')">📸 Media Bank & Uploader</button>
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
                                <a href="/reset/sim_636" onclick="return confirm('Reset and generate fresh QR for Primary Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Reset & Re-pair</a>
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
                                <a href="/reset/baba_aux" onclick="return confirm('Reset Baba Aux Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Reset</a>
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
                                <a href="/reset/canada" onclick="return confirm('Reset Canada Line?')" style="flex: 1; text-align: center; background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 7px; border-radius: 6px; font-size: 12px; text-decoration: none; font-weight: 600;">🔄 Reset</a>
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
                            <input type="text" id="diag-msg" placeholder="Test message text..." class="input-field" style="flex: 1; min-width: 200px; background: white; color: #0f172a; border: 1px solid #cbd5e1;" value="राम राम भाई जी! यह बाबा अभय सिंह सेवा केंद्र का लाइव टेस्ट मैसेज है। 🚩">
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

                <!-- TAB 3: AI Playground & Testing Lab -->
                <div id="tab-playground" class="card tab-content" style="display: none;">
                    <div style="display: grid; grid-template-columns: 1fr 340px; gap: 20px;">
                        <div>
                            <h3 style="margin-top:0;">🤖 AI Assistant Testing Lab</h3>
                            <p style="color: #64748b; font-size: 14px;">Test conversations with Baba Abhay Singh's AI assistant in real-time before sending to voters.</p>
                            
                            <div style="border: 1px solid #e2e8f0; border-radius: 10px; height: 350px; display: flex; flex-direction: column; background: #fafafa; margin-top: 15px;">
                                <div id="ai-chat-ui" style="flex:1; overflow-y:auto; padding:15px; display:flex; flex-direction:column; gap:10px;">
                                    <div class="bubble bubble-bot">
                                        राम राम भाई जी! 🙏 मैं बाबा अभय सिंह सेवा केंद्र का डिजिटल सहायक हूँ। बताइए, कैसे सेवा करूँ?
                                    </div>
                                </div>
                                <div style="padding: 10px; background: white; border-top: 1px solid #e2e8f0; display:flex; gap:8px;">
                                    <input type="text" id="ai-test-input" placeholder="Type query e.g. 'kon ho bhai tum' or 'daaru baatega kya'..." class="input-field" style="background:#f8fafc; color:#0f172a; border:1px solid #cbd5e1;" onkeydown="if(event.key==='Enter') sendAITest()">
                                    <button onclick="sendAITest()" style="background:#2563eb; color:white; border:none; padding:10px 20px; border-radius:8px; font-weight:700; cursor:pointer;">Send</button>
                                </div>
                            </div>
                        </div>

                        <!-- Active Knowledge & Rules Fact Sheet -->
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; background: #f8fafc; font-size: 13px;">
                            <div style="font-weight: 700; color: #0f172a; margin-bottom: 8px;">🧠 Active Persona & Rules:</div>
                            <ul style="padding-left: 18px; margin: 0 0 15px 0; color: #334155; line-height: 1.5;">
                                <li><b>Identity:</b> Baba Abhay Singh Seva Kendra digital assistant.</li>
                                <li><b>Opposition Policy:</b> Never name opposite candidates directly. Slay bribing & liquor with sweet village satire.</li>
                                <li><b>Budget Rule:</b> Zero rupees / tender amounts mentioned.</li>
                                <li><b>Length:</b> 2-3 punchy, charming lines max.</li>
                            </ul>
                            <div style="font-weight: 700; color: #0f172a; margin-bottom: 6px;">💡 Quick Test Buttons:</div>
                            <div style="display:flex; flex-direction:column; gap:6px;">
                                <button onclick="quickTestQuery('kon ho bhai tum')" style="text-align:left; background:white; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:12px;">"kon ho bhai tum"</button>
                                <button onclick="quickTestQuery('virodhi bol raha h daaru aur paise baatega')" style="text-align:left; background:white; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px; font-size:12px;">"virodhi daaru baatega"</button>
                                <button onclick="quickTestQuery('baba ne pichle 5 saal me kya kaam kiya')" style="text-align:left; background:white; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px; font-size:12px;">"baba ne kya kaam kiya"</button>
                                <button onclick="quickTestQuery('ek badhiya slogan sunao')" style="text-align:left; background:white; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px; font-size:12px;">"ek slogan sunao"</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB 4: Voter Memory & Chat History Inspector -->
                <div id="tab-voters" class="card tab-content" style="display: none;">
                    <div class="chat-view-container">
                        <div>
                            <input type="text" id="voter-search" placeholder="🔍 Search voter by name or phone..." class="input-field" style="color: #0f172a; background: white; border: 1px solid #cbd5e1; margin-bottom: 10px;" oninput="filterVoters(this.value)">
                            <div class="voter-list" id="voter-list-ui">
                                <div style="padding: 20px; text-align: center; color: #94a3b8;">Loading voters...</div>
                            </div>
                        </div>
                        <div class="chat-box">
                            <div id="chat-header" style="padding: 12px 16px; background: white; border-bottom: 1px solid #e2e8f0; font-weight: 700; font-size: 14px; color: #1e293b;">
                                Select a voter to view their conversation
                            </div>
                            <div class="chat-messages" id="chat-messages-ui">
                                <div style="text-align: center; color: #94a3b8; margin-top: 150px;">Select a person from the left panel to see full chat history & media tracking.</div>
                            </div>
                            <div id="chat-input-bar" style="padding: 10px; background: white; border-top: 1px solid #e2e8f0; display: none;">
                                <div style="display: flex; gap: 8px;">
                                    <input type="text" id="chat-direct-text" placeholder="Type a message to reply directly..." class="input-field" style="color:#0f172a; background:#f8fafc; border:1px solid #cbd5e1;">
                                    <button onclick="sendDirectReply()" style="background:#2563eb; color:white; border:none; padding:10px 18px; border-radius:8px; font-weight:700; cursor:pointer;">Send</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB 5: Media Bank & Direct Uploader -->
                <div id="tab-media" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📸 Campaign Media Bank & Mobile Uploader</h3>
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

                function switchTab(tabId) {
                    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
                    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                    document.getElementById('tab-' + tabId).style.display = 'block';
                    event.target.classList.add('active');
                    if (tabId === 'voters') loadVoters();
                }

                function toggleCustomText(val) {
                    document.getElementById('custom-text-group').style.display = val === 'custom' ? 'block' : 'none';
                }

                // Send Instant WhatsApp Message from Field Mode Form
                async function sendInstantMessage(e) {
                    e.preventDefault();
                    const phone = document.getElementById('v-phone').value;
                    const name = document.getElementById('v-name').value;
                    const lineId = document.getElementById('v-line').value;
                    const template = document.getElementById('v-template').value;
                    const customText = document.getElementById('v-custom-text').value;
                    const statusEl = document.getElementById('send-status');
                    const btn = document.getElementById('btn-submit');

                    btn.disabled = true;
                    btn.innerText = '⏳ Sending WhatsApp Message...';

                    try {
                        const res = await fetch('/api/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone, name, template, customText, lineId })
                        });
                        const data = await res.json();

                        if (res.ok) {
                            statusEl.style.display = 'inline-block';
                            statusEl.style.background = '#dcfce7';
                            statusEl.style.color = '#15803d';
                            statusEl.innerText = '✅ Buzz! Sent to +' + data.phone + ' via ' + data.line;
                            document.getElementById('v-phone').value = '';
                            document.getElementById('v-name').value = '';
                            document.getElementById('v-custom-text').value = '';
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
                    chatUi.innerHTML += \`<div class="bubble bubble-user">\${text}</div>\`;
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

                        chatUi.innerHTML += \`
                            <div class="bubble bubble-bot">
                                \${data.reply}
                            </div>
                        \`;
                        chatUi.scrollTop = chatUi.scrollHeight;
                    } catch (e) {
                        chatUi.innerHTML += \`<div class="bubble bubble-bot" style="color:red;">Error: \${e.message}</div>\`;
                    }
                }

                function quickTestQuery(q) {
                    document.getElementById('ai-test-input').value = q;
                    sendAITest();
                }

                // Update Live Voter Chat Feed (Voters Only)
                async function updateLiveFeed() {
                    try {
                        const res = await fetch('/api/messages');
                        const messages = await res.json();
                        const tbody = document.getElementById('live-table-body');
                        if (!messages || messages.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 35px;">💬 Waiting for voter messages... Real incoming chats will appear here in real time!</td></tr>';
                            return;
                        }

                        tbody.innerHTML = messages.map(m => {
                            let badgeClass = 'badge-success';
                            if (m.status === 'HANDSHAKE_SENT') badgeClass = 'badge-info';
                            else if (m.status === 'TEST_SENT') badgeClass = 'badge-info';
                            else if (m.status === 'MEDIA_SENT') badgeClass = 'badge-info';

                            return \`
                                <tr>
                                    <td style="color: #64748b; font-size: 12px;">\${m.timestamp}</td>
                                    <td><span style="font-weight: 600; color: #334155; font-size: 12px;">\${m.session}</span></td>
                                    <td><span style="color: #2563eb; font-weight: 700; font-size: 13px;">+\${m.phone}</span></td>
                                    <td style="font-weight: 500; color: #0f172a;">\${m.incoming}</td>
                                    <td style="color: #334155; font-size: 13px; white-space: pre-wrap;">\${m.reply}</td>
                                    <td><span class="badge \${badgeClass}">● \${m.status}</span></td>
                                </tr>
                            \`;
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

                            return \`
                                <tr>
                                    <td style="color: #64748b; font-size: 12px;">\${d.timestamp}</td>
                                    <td><span style="font-weight: 600; color: #334155; font-size: 12px;">\${d.session}</span></td>
                                    <td><span style="color: #475569; font-weight: 700; font-size: 12px;">\${d.phone}</span></td>
                                    <td style="color: #334155; font-size: 12px;"><b>\${d.incoming}</b><br><span style="color:#64748b;">\${d.reply}</span></td>
                                    <td><span class="badge \${badgeClass}">● \${d.status}</span></td>
                                </tr>
                            \`;
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

                // Load Voters and Memory
                async function loadVoters() {
                    try {
                        const res = await fetch('/api/voters');
                        allVoters = await res.json();
                        document.getElementById('voter-count').innerText = allVoters.length;
                        renderVoterList(allVoters);
                    } catch (e) {}
                }

                function renderVoterList(voters) {
                    const listUi = document.getElementById('voter-list-ui');
                    if (voters.length === 0) {
                        listUi.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">No voters recorded yet.</div>';
                        return;
                    }
                    listUi.innerHTML = voters.map(v => \`
                        <div class="voter-item \${selectedVoterPhone === v.phone ? 'selected' : ''}" onclick="selectVoter('\${v.phone}')">
                            <div style="font-weight: 700; font-size: 14px; color: #0f172a;">\${v.name || 'Unnamed Voter'}</div>
                            <div style="font-size: 12px; color: #2563eb;">+\${v.phone}</div>
                            <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
                                \${v.sentMedia.poster ? '📸 Poster ' : ''}
                                \${v.sentMedia.video ? '📹 Video ' : ''}
                                \${v.sentMedia.voterSlip ? '🎫 Slip ' : ''}
                                • \${v.interactionCount} chats
                            </div>
                        </div>
                    \`).join('');
                }

                function filterVoters(q) {
                    const lower = q.toLowerCase();
                    const filtered = allVoters.filter(v => (v.name && v.name.toLowerCase().includes(lower)) || v.phone.includes(lower));
                    renderVoterList(filtered);
                }

                async function selectVoter(phone) {
                    selectedVoterPhone = phone;
                    renderVoterList(allVoters);
                    document.getElementById('chat-input-bar').style.display = 'block';

                    try {
                        const res = await fetch('/api/voter/' + phone);
                        const user = await res.json();
                        document.getElementById('chat-header').innerHTML = \`
                            <span>👤 \${user.name || 'Voter'} (+ \${user.phone})</span>
                            <span style="float: right; font-size: 12px; font-weight: normal; color: #64748b;">
                                \${user.sentMedia.poster ? '📸 Poster Sent | ' : ''}
                                \${user.sentMedia.video ? '📹 Video Sent | ' : ''}
                                \${user.sentMedia.voterSlip ? '🎫 Slip Sent' : ''}
                            </span>
                        \`;

                        const messagesUi = document.getElementById('chat-messages-ui');
                        if (!user.history || user.history.length === 0) {
                            messagesUi.innerHTML = '<div style="text-align:center; color:#94a3b8; margin-top:50px;">No message history recorded yet.</div>';
                            return;
                        }

                        messagesUi.innerHTML = user.history.map(h => \`
                            <div class="bubble \${h.role === 'user' ? 'bubble-user' : 'bubble-bot'}">
                                <div style="font-size: 10px; color: #64748b; margin-bottom: 2px;">\${h.role === 'user' ? 'Voter' : 'Baba Bot'} • \${h.time}</div>
                                \${h.text}
                            </div>
                        \`).join('');
                        messagesUi.scrollTop = messagesUi.scrollHeight;
                    } catch (e) {}
                }

                async function sendDirectReply() {
                    if (!selectedVoterPhone) return;
                    const input = document.getElementById('chat-direct-text');
                    const text = input.value.trim();
                    if (!text) return;

                    input.value = '';
                    await fetch('/api/send-message', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: selectedVoterPhone, template: 'custom', customText: text })
                    });
                    setTimeout(() => selectVoter(selectedVoterPhone), 800);
                }
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
        sessions: SESSIONS.map(s => ({ id: s.id, status: s.status }))
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

app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
});
