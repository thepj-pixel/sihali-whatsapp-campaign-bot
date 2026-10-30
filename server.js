const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
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

const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';

// Configured WhatsApp Sessions
const SESSIONS = [
    { id: 'canada', name: 'Canada Line (+1 Rented)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'sim_636', name: 'Primary Line (6367810227)', status: 'DISCONNECTED', qr: null, sock: null },
    { id: 'baba_aux', name: 'Baba Aux Line (Secondary)', status: 'DISCONNECTED', qr: null, sock: null }
];

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
        printQRInTerminal: true,
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
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                if (msg.key.fromMe) continue;
                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
                    continue; // Skip group chats & status
                }

                const body = (
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    ''
                ).trim();

                if (!body) continue;

                console.log(`[${sessionObj.id}] Message from ${remoteJid}: "${body}"`);

                // Maintain conversation history per user
                const history = userHistory.get(remoteJid) || [];

                let replyText = '';
                const lower = body.toLowerCase();
                const isParchiQuery = lower.includes('parchi') || lower.includes('voter') || lower.includes('पर्ची') || lower.includes('नाम') || lower.includes('epic');

                // Check voter database
                const matches = voterEngine.searchVoters(body);

                if (matches && matches.length > 0 && isParchiQuery) {
                    // Send 100% accurate voter slip
                    replyText = voterEngine.formatSlipResponse(matches[0]);
                } else {
                    // Route to NVIDIA Llama-3.3 70B AI Assistant with Grounded Knowledge
                    replyText = await aiService.getAIResponse(body, NVIDIA_API_KEY, history);
                }

                // Update history
                history.push({ role: 'user', content: body });
                history.push({ role: 'assistant', content: replyText });
                if (history.length > 6) history.splice(0, 2);
                userHistory.set(remoteJid, history);

                // Send reply with human-like brief typing latency (1-2s)
                await new Promise(r => setTimeout(r, 1200));
                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                console.log(`[${sessionObj.id}] ✅ Replied to ${remoteJid}`);
            }
        } catch (err) {
            console.error(`[${sessionObj.id}] Error in message upsert:`, err);
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

    const aiStatusBadge = NVIDIA_API_KEY 
        ? `<span style="background: #dcfce7; color: #15803d; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 700;">🟢 NVIDIA Llama-3.3 70B Active</span>`
        : `<span style="background: #fef3c7; color: #b45309; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 700;">🟡 Standalone Voter DB Active (Add NVIDIA_API_KEY for AI Conversation)</span>`;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Sihali Khurd Campaign Assistant Control Tower</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; margin: 0; padding: 30px; }
                .container { max-width: 1050px; margin: 0 auto; }
                .header { text-align: center; margin-bottom: 30px; }
                .grid { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="color: #0f172a; margin-bottom: 8px;">🏛️ ग्राम पंचायत सिहाली खुर्द 2026</h1>
                    <p style="color: #64748b; font-size: 16px;">बाबा अभय सिंह डिजिटल सेवा केंद्र — WhatsApp Control Tower</p>
                    <div style="margin-top: 10px;">${aiStatusBadge}</div>
                </div>
                <div class="grid">
                    ${cardsHtml}
                </div>
                <div style="text-align: center; margin-top: 40px; color: #94a3b8; font-size: 13px;">
                    Render Keep-Alive: Ping <code>/health</code> every 5-10 minutes.
                </div>
            </div>
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
