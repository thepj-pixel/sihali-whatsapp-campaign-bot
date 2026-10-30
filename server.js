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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/media', express.static(path.join(__dirname, 'media')));

const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';

// Configured WhatsApp Sessions
const SESSIONS = [
    { id: 'sim_636', name: 'Primary Line (6367810227)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'baba_aux', name: 'Baba Aux Line (Secondary)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'canada', name: 'Canada Line (+1 Rented)', status: 'DISCONNECTED', qr: null, sock: null }
];

const CAMPAIGN_PIN = process.env.CAMPAIGN_PIN || '2026';

// Persistent Live Message Feed (survives restarts)
const FEED_FILE = path.join(__dirname, 'messages_feed.json');
let LIVE_FEED = [];
try {
    if (fs.existsSync(FEED_FILE)) {
        LIVE_FEED = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8'));
    }
} catch (e) {
    LIVE_FEED = [];
}

function logMessage(event) {
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

// PIN Security Gate Middleware
app.use((req, res, next) => {
    // Whitelist static media, health, and debug
    if (req.path.startsWith('/media') || req.path === '/health' || req.path === '/api/debug') {
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

const sessionsDir = path.join(__dirname, 'sessions_auth');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Start a WhatsApp Session
async function startSession(sessionObj) {
    const sessionAuthPath = path.join(sessionsDir, sessionObj.id);
    const { state, saveCreds } = await useMultiFileAuthState(sessionAuthPath);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    console.log(`[${sessionObj.id}] Starting WhatsApp Session...`);

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Sihali Campaign Assistant', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: false
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
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${sessionObj.id}] Closed. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => startSession(sessionObj), 5000);
            }
        } else if (connection === 'open') {
            sessionObj.status = 'CONNECTED';
            sessionObj.qr = null;
            console.log(`[${sessionObj.id}] ✅ WhatsApp Connected!`);
        }
    });

    // Handle Incoming Messages
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                // If message is from me, handle or ignore
                if (msg.key && msg.key.fromMe) {
                    const selfBody = (
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        ''
                    ).trim();
                    if (selfBody && !selfBody.includes('ग्राम पंचायत') && !selfBody.includes('बाबा अभय सिंह')) {
                        logMessage({
                            session: sessionObj.name,
                            phone: 'Self Device',
                            incoming: selfBody,
                            reply: '⚠️ Self-messages ignored to prevent loop. Please test from a DIFFERENT phone!',
                            status: 'SELF_IGNORED'
                        });
                    }
                    continue;
                }

                const remoteJid = msg.key?.remoteJid || '';
                if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
                    continue; // Skip group chats & status
                }

                const senderPhone = remoteJid.split('@')[0];

                // Extract message body from all possible structures
                const body = (
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.ephemeralMessage?.message?.conversation ||
                    msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                    msg.message?.viewOnceMessage?.message?.conversation ||
                    msg.message?.viewOnceMessage?.message?.extendedTextMessage?.text ||
                    ''
                ).trim();

                if (!body) continue;

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

                    const posterPath = path.join(__dirname, 'media', 'poster.jpg');
                    const videoPath = path.join(__dirname, 'media', 'campaign_reel.mp4');

                    const matches = voterEngine.searchVoters(body);

                    if (isVideoQuery && fs.existsSync(videoPath)) {
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
            // Custom text
            messageText = customText || 'राम राम भाई जी! 🙏';
            await sock.sendMessage(jid, { text: messageText });
        }

        // Record in user memory
        userMemory.getUser(cleanedPhone, name);
        userMemory.recordMessage(cleanedPhone, 'bot', messageText, mediaType, sessionName);

        // Record in live feed
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

// API: Get Live Messages Feed
app.get('/api/messages', (req, res) => {
    res.json(LIVE_FEED);
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

// API: 1-Click Auto-Deploy / Git Pull & PM2 Reload
app.get('/update', (req, res) => {
    console.log('[AutoDeploy] Pulling latest code from GitHub...');
    exec('git pull && pm2 restart whatsapp-bot', (err, stdout, stderr) => {
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
                <a href="/" style="background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Return to Live Control Tower</a>
                <script>setTimeout(() => window.location.href = '/', 3000);</script>
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
                .tabs { display: flex; gap: 10px; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; overflow-x: auto; }
                .tab-btn { background: none; border: none; padding: 10px 18px; font-size: 14px; font-weight: 700; color: #64748b; cursor: pointer; border-radius: 8px; white-space: nowrap; }
                .tab-btn.active { background: white; color: #2563eb; box-shadow: 0 2px 4px rgba(0,0,0,0.06); }

                /* Table Styling */
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

                /* Voter Chat Inspector */
                .chat-view-container { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
                @media (max-width: 768px) {
                    .chat-view-container { grid-template-columns: 1fr; }
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
                        <p>24/7 Multi-Session WhatsApp Campaign & Field Connect Tower</p>
                    </div>
                    <div class="top-actions">
                        <span style="background: #dcfce7; color: #15803d; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700;">🟢 Iowa Cloud 24/7</span>
                        <a href="/update" onclick="return confirm('Pull latest code from GitHub and reload PM2?')" style="background: #0f172a; color: white; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 700;">🔄 Pull GitHub & Reload</a>
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
                    <button class="tab-btn active" onclick="switchTab('feed')">💬 Live Chat Stream</button>
                    <button class="tab-btn" onclick="switchTab('voters')">👤 Voter Memory & History (<span id="voter-count">0</span>)</button>
                    <button class="tab-btn" onclick="switchTab('media')">📸 Media Assets & Links</button>
                </div>

                <!-- TAB 1: Live Chat Stream -->
                <div id="tab-feed" class="card tab-content">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <h3 style="margin: 0; font-size: 16px;">Real-Time Incoming & Outgoing Chats</h3>
                        <span style="color: #64748b; font-size: 12px;">Auto-refreshing every 4s</span>
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
                                    <th style="width: 95px;">Status</th>
                                </tr>
                            </thead>
                            <tbody id="live-table-body">
                                <tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 30px;">Listening for new messages... Send a text to 6367810227!</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- TAB 2: Voter Memory & Chat History Inspector -->
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

                <!-- TAB 3: Media Bank -->
                <div id="tab-media" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📸 Campaign Media Assets Bank</h3>
                    <p style="color: #64748b; font-size: 14px;">These files are loaded in memory and sent automatically when voters request them on WhatsApp:</p>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-top: 20px;">
                        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; text-align: center;">
                            <img src="/media/poster.jpg" style="max-height: 200px; border-radius: 8px; margin-bottom: 10px;" />
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

                // Update Live Chat Feed
                async function updateLiveFeed() {
                    try {
                        const res = await fetch('/api/messages');
                        const messages = await res.json();
                        const tbody = document.getElementById('live-table-body');
                        if (!messages || messages.length === 0) return;

                        tbody.innerHTML = messages.map(m => {
                            let badgeClass = 'badge-success';
                            if (m.status === 'SELF_IGNORED') badgeClass = 'badge-warning';
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
