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

const app = express();
app.use(cors());
app.use(express.json());
app.use('/media', express.static(path.join(__dirname, 'media')));

const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';

// Configured WhatsApp Sessions
const SESSIONS = [
    { id: 'canada', name: 'Canada Line (+1 Rented)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'sim_636', name: 'Primary Line (6367810227)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'baba_aux', name: 'Baba Aux Line (Secondary)', status: 'DISCONNECTED', qr: null, sock: null }
];

// Live Message Feed Store (Last 100 messages)
const LIVE_FEED = [];
function logMessage(event) {
    LIVE_FEED.unshift({
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        ...event
    });
    if (LIVE_FEED.length > 100) LIVE_FEED.pop();
}

const sessionsDir = path.join(__dirname, 'sessions_auth');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Memory cache for user conversations (last 4 turns)
const userHistory = new Map();

async function startSession(sessionObj) {
    const sessionPath = path.join(sessionsDir, sessionObj.id);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Sihali Campaign Assistant', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
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
                // Check if message is from myself (self-testing or bot's own outgoing message)
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
                // Skip group chats (@g.us), broadcast status, or invalid IDs
                if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
                    continue;
                }

                // Clean phone number from JID
                const senderPhone = remoteJid.split('@')[0];

                // Extract message body from all possible WhatsApp structures
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

                const history = userHistory.get(remoteJid) || [];
                let replyText = '';

                try {
                    const lower = body.toLowerCase();
                    const isParchiQuery = lower.includes('parchi') || lower.includes('voter') || lower.includes('पर्ची') || lower.includes('नाम') || lower.includes('epic') || lower.includes('ward') || lower.includes('वार्ड');
                    const isPhotoQuery = lower.includes('photo') || lower.includes('poster') || lower.includes('फोटो') || lower.includes('पोस्टर') || lower.includes('तस्वीर') || lower.includes('banner') || lower.includes('image');
                    const isVideoQuery = lower.includes('video') || lower.includes('reel') || lower.includes('वीडियो') || lower.includes('रील') || lower.includes('clip');

                    const posterPath = path.join(__dirname, 'media', 'poster.jpg');
                    const videoPath = path.join(__dirname, 'media', 'campaign_reel.mp4');

                    const matches = voterEngine.searchVoters(body);

                    if (isVideoQuery && fs.existsSync(videoPath)) {
                        replyText = "सिहाली खुर्द के विकास का संकल्प - बाबा अभय सिंह (मोटी आंगली वाले बाबा) 🚩📹\n16 नवम्बर 2026 को भारी मतों से विजयी बनाएं!";
                        await sock.sendMessage(remoteJid, {
                            video: fs.readFileSync(videoPath),
                            caption: replyText
                        }, { quoted: msg });
                        console.log(`[${sessionObj.id}] ✅ Successfully sent video reel to ${senderPhone}`);
                    } else if (isPhotoQuery && fs.existsSync(posterPath)) {
                        replyText = "बाबा अभय सिंह (मोटी आंगली वाले बाबा) - ग्राम पंचायत सिहाली खुर्द 🚩\nसच्चा विकास, ईमानदार नेतृत्व।\nवोटर पर्ची देखने के लिए अपना नाम लिखकर भेजें!";
                        await sock.sendMessage(remoteJid, {
                            image: fs.readFileSync(posterPath),
                            caption: replyText
                        }, { quoted: msg });
                        console.log(`[${sessionObj.id}] ✅ Successfully sent poster image to ${senderPhone}`);
                    } else if (matches && matches.length > 0 && isParchiQuery) {
                        replyText = voterEngine.formatSlipResponse(matches[0]);
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                        console.log(`[${sessionObj.id}] ✅ Successfully sent voter slip to ${senderPhone}`);
                    } else {
                        // Query AI Assistant
                        replyText = await aiService.getAIResponse(body, NVIDIA_API_KEY, history);
                        if (!replyText || replyText.trim() === '') {
                            replyText = aiService.getFastLocalAnswer(body);
                        }
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                        console.log(`[${sessionObj.id}] ✅ Successfully replied via AI/local to ${senderPhone}`);
                    }
                } catch (err) {
                    console.error(`[${sessionObj.id}] Error resolving reply:`, err);
                    replyText = aiService.getFastLocalAnswer(body);
                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg }).catch(e => console.error('Fallback send failed:', e));
                }

                // Update conversation history
                history.push({ role: 'user', content: body });
                history.push({ role: 'assistant', content: replyText });
                if (history.length > 6) history.splice(0, 2);
                userHistory.set(remoteJid, history);

                // Log to live dashboard feed
                logMessage({
                    session: sessionObj.name,
                    phone: senderPhone,
                    incoming: body,
                    reply: replyText,
                    status: 'DELIVERED'
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

// UI: Dashboard
app.get('/', (req, res) => {
    let cardsHtml = SESSIONS.map(s => {
        let statusColor = s.status === 'CONNECTED' ? '#16a34a' : (s.status === 'QR_READY' ? '#eab308' : '#dc2626');
        let button = s.status === 'CONNECTED' 
            ? `<div style="color: #16a34a; font-weight: 700; margin-top: 10px;">🟢 Online & Listening 24/7</div>`
            : `<a href="/scan/${s.id}" style="display:inline-block; margin-top:12px; padding:10px 18px; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:600;">📲 Scan QR Code</a>`;

        return `
            <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; width: 300px; text-align: center;">
                <h3 style="margin: 0 0 10px 0; color: #1e293b;">${s.name}</h3>
                <div style="display: inline-block; padding: 4px 12px; border-radius: 20px; background: ${statusColor}15; color: ${statusColor}; font-weight: 700; font-size: 13px;">
                    ● ${s.status}
                </div>
                ${button}
            </div>
        `;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Sihali Khurd Campaign Assistant Control Tower</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; margin: 0; padding: 25px; }
                .container { max-width: 1100px; margin: 0 auto; }
                .header { text-align: center; margin-bottom: 25px; }
                .grid { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; margin-bottom: 35px; }
                .card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.07); border: 1px solid #e2e8f0; }
                .table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
                .table th { background: #f1f5f9; padding: 10px 12px; text-align: left; color: #475569; border-bottom: 2px solid #e2e8f0; }
                .table td { padding: 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
                .badge { padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; display: inline-block; }
                .badge-success { background: #dcfce7; color: #15803d; }
                .badge-warning { background: #fef3c7; color: #b45309; }
                .badge-info { background: #e0f2fe; color: #0369a1; }
                .sync-btn { background: #0f172a; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; font-size: 13px; }
                .sync-btn:hover { background: #1e293b; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="color: #0f172a; margin-bottom: 6px;">🏛️ ग्राम पंचायत सिहाली खुर्द 2026</h1>
                    <p style="color: #64748b; font-size: 15px; margin-top: 0;">बाबा अभय सिंह डिजिटल सेवा केंद्र — Live Control Tower</p>
                    <div style="display: flex; gap: 10px; justify-content: center; align-items: center; margin-top: 15px;">
                        <span style="background: #dcfce7; color: #15803d; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 700;">🟢 24/7 Cloud Active (Iowa)</span>
                        <a href="/update" class="sync-btn" onclick="return confirm('Sync latest updates from GitHub?')">🔄 Pull GitHub & Reload</a>
                    </div>
                </div>

                <div class="grid">
                    ${cardsHtml}
                </div>

                <div style="background: white; border-radius: 12px; padding: 15px 20px; margin-bottom: 25px; border: 1px solid #e2e8f0; display: flex; justify-content: space-around; align-items: center; flex-wrap: wrap; gap: 15px; font-size: 14px;">
                    <div>
                        <strong>📸 Official Poster:</strong> <a href="/media/poster.jpg" target="_blank" style="color: #2563eb; font-weight: 600;">poster.jpg</a> <span style="color:#64748b;">(Triggered by: "photo", "poster")</span>
                    </div>
                    <div>
                        <strong>📹 3D Campaign Reel:</strong> <a href="/media/campaign_reel.mp4" target="_blank" style="color: #2563eb; font-weight: 600;">campaign_reel.mp4</a> <span style="color:#64748b;">(Triggered by: "video", "reel")</span>
                    </div>
                </div>

                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h2 style="margin: 0; font-size: 18px; color: #0f172a;">💬 Live Incoming WhatsApp Chats</h2>
                        <span style="color: #64748b; font-size: 13px;">Auto-refreshes every 4s</span>
                    </div>

                    <div id="feed-container">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 90px;">Time</th>
                                    <th style="width: 140px;">Line</th>
                                    <th style="width: 130px;">Sender</th>
                                    <th>Incoming Message</th>
                                    <th>Bot Reply Sent</th>
                                    <th style="width: 100px;">Status</th>
                                </tr>
                            </thead>
                            <tbody id="feed-body">
                                <tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 30px;">Listening for new messages... Send a WhatsApp text to 6367810227!</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <script>
                async function updateFeed() {
                    try {
                        const res = await fetch('/api/messages');
                        const messages = await res.json();
                        const tbody = document.getElementById('feed-body');
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
                setInterval(updateFeed, 4000);
                updateFeed();
            </script>
        </body>
        </html>
    `);
});

// UI: QR Scan Page
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
                <script>setTimeout(() => window.location.reload(), 3000);</script>
            </div>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Scan WhatsApp QR: ${session.name}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: sans-serif; background: #f1f5f9; display: flex; align-items:center; justify-content:center; min-height: 100vh; margin:0;">
            <div style="background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align:center; max-width: 400px;">
                <h2 style="margin-top:0; color:#0f172a;">📲 ${session.name}</h2>
                <p style="color: #64748b; font-size: 14px;">WhatsApp -> <b>Linked Devices</b> -> <b>Link a Device</b>:</p>
                <img src="${session.qr}" style="width: 260px; height: 260px; border: 1px solid #e2e8f0; border-radius: 8px;" />
                <br>
                <a href="/" style="display:inline-block; margin-top: 15px; color: #2563eb; text-decoration:none; font-size: 14px; font-weight: bold;">← Back to Dashboard</a>
                <script>setTimeout(() => window.location.reload(), 20000);</script>
            </div>
        </body>
        </html>
    `);
});

// Live Messages API for dashboard
app.get('/api/messages', (req, res) => {
    res.json(LIVE_FEED);
});

// Auto-Update Endpoint: Pulls latest code from GitHub and reloads PM2
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
                <script>setTimeout(() => window.location.href = '/', 4000);</script>
            </body>
        `);
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        sessions: SESSIONS.map(s => ({ id: s.id, status: s.status }))
    });
});

app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
});
