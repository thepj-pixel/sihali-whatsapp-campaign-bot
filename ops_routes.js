/**
 * OPS v4 — dashboard APIs + tabs for: 📊 Overview / निष्कर्ष, 🚫 विरोधी list, 🗓️ Scheduled bulk campaigns.
 * Installed from server.js with one call (install(app, deps)) so server.js stays a thin hook.
 * Every route sits behind the global PIN gate (registered after it).
 */
const path = require('path');
const overview = require('./overview.js');
const contactTags = require('./contact_tags.js');
const { ScheduledCampaigns, windowFromHours, PRESETS } = require('./scheduled_campaigns.js');

function install(app, d) {
    const { SESSIONS, broadcastEngine, userMemory, liveSelfTest, engagementPolicy, followupPlanner, contactsManager, samasyaStore, mulaqatStore, campaignAgenda, onBulkSent, logMessage, dailyIstDate, resolveAudience } = d;

    contactTags.installGentleMode(d.replyBrain);
    try { if (contactTags.syncToMemory(userMemory)) userMemory.save(); } catch (e) {}

    let lastSelfTestAt = 0; // a self-test pair needs 25 s of quiet before own-line test sends
    const scheduler = new ScheduledCampaigns({
        stateFile: process.env.SCHEDULED_STATE_PATH || path.join(__dirname, 'scheduled_campaigns.json'),
        mediaDir: path.join(__dirname, 'media'),
        getSessions: () => SESSIONS,
        engine: broadcastEngine,
        isBlocked: (phone) => (liveSelfTest.ownLineOf([phone]) ? 'own_line' : engagementPolicy.broadcastBlockReason(userMemory.users[phone])),
        isVirodhi: (phone) => contactTags.isVirodhi(phone) || !!(userMemory.users[phone] && userMemory.users[phone].virodhi === true),
        ownLineOf: (phone) => liveSelfTest.ownLineOf([phone]),
        isTestBusy: () => { try { if (liveSelfTest.isActive()) { lastSelfTestAt = Date.now(); return true; } return Date.now() - lastSelfTestAt < 25000; } catch (e) { return false; } },
        getAssignedLine: (phone) => (userMemory.users[phone] && userMemory.users[phone].assignedLine) || null,
        isSilenced: (ms) => { try { return followupPlanner.inSilencePeriod(new Date(ms)); } catch (e) { return false; } },
        onSent: (info) => {
            if (info.test) {
                // own-line verification send: record it (flagged opsTest) so Overview can show it, nothing else
                try {
                    const u = userMemory.getUser(info.phone, 'Test');
                    u.opsTest = info.campaignId; u.selfTest = u.selfTest || null;
                    userMemory.recordMessage(info.phone, 'bot', (info.media ? `[${info.media.type}: ${info.media.file}] ` : '') + info.text, info.media ? 'scheduled_' + info.media.type : 'scheduled', info.lineName);
                    userMemory.save();
                } catch (e) {}
                try { logMessage({ session: info.lineName, phone: info.phone, incoming: '[Scheduled campaign TEST]', reply: info.text, status: info.media ? 'MEDIA_SENT' : 'DELIVERED' }); } catch (e) {}
                return;
            }
            onBulkSent({ ...info, media: info.media });
        }
    });
    scheduler.start(3000);

    const pinOk = () => true; // global PIN gate already applies to /api/*
    const send = (res, r) => res.status(r.status || (r.ok ? 200 : 400)).json({ success: !!r.ok, ...r });

    // ---------- Overview ----------
    app.get('/api/overview', (req, res) => {
        try {
            const q = req.query || {};
            const includeTest = q.includeTest === '1' || q.includeTest === 'true';
            const out = overview.build({
                users: userMemory.getAllUsers(),
                samasya: samasyaStore.list({ includeTest }),
                mulaqat: mulaqatStore.list({ includeTest }),
                isVirodhi: p => contactTags.isVirodhi(p),
                contactOf: p => { try { return contactsManager.findByPhone(p); } catch (e) { return null; } },
                filter: { stance: q.stance || '', line: q.line || '', ward: q.ward || '', q: q.q || '', includeTest }
            });
            res.json({ success: true, ...out });
        } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // ---------- विरोधी list ----------
    app.get('/api/virodhi', (req, res) => res.json({ success: true, list: contactTags.list() }));
    app.post('/api/virodhi/add', (req, res) => {
        const b = req.body || {};
        const r = contactTags.addVirodhi(b.text || b.phones || '', { note: b.note || '', userMemory });
        res.json({ success: true, added: r.added.length, already: r.already.length, invalid: r.invalid, total: contactTags.list().length });
    });
    app.post('/api/virodhi/remove', (req, res) => res.json({ success: contactTags.removeVirodhi((req.body || {}).phone, { userMemory }) }));

    // ---------- Scheduled campaigns ----------
    const inputFrom = (b = {}) => ({ ...b, ...(b.test ? {} : resolveAudience(b)) });
    app.post('/api/scheduled/preview', (req, res) => { try { res.json({ success: true, preview: scheduler.preview(inputFrom(req.body)) }); } catch (e) { res.status(400).json({ success: false, error: e.message }); } });
    app.post('/api/scheduled/create', (req, res) => { try { send(res, scheduler.create(inputFrom(req.body))); } catch (e) { res.status(400).json({ success: false, error: e.message }); } });
    app.post('/api/scheduled/from-agenda', (req, res) => {
        try {
            const b = req.body || {};
            const date = b.date || dailyIstDate();
            const slot = b.slot;
            const ag = campaignAgenda.getAgenda(date);
            const s = ag && ag.dailySchedule && ag.dailySchedule[slot];
            if (!s) return res.status(400).json({ success: false, error: 'Unknown agenda slot: ' + slot });
            // 6 Nov: morning / evening use the agreed bulk windows (09:00–11:30, 17:30–20:00 IST); other slots their own hours
            const pr = PRESETS[slot];
            const w = pr ? windowFromHours(date, pr[0], pr[1]) : windowFromHours(date, Number(s.startHour), Number(s.endHour));
            // texts: the operator's variants, else the slot hook; posters: the operator's pick, else the slot poster,
            // else the 🔒 day-lock media for that date (retired posters never pass resolveMedia)
            const msgs = Array.isArray(b.messages) ? b.messages.filter(Boolean) : String(b.messages || '').split(/\n\s*-{3,}\s*\n/).map(x => x.trim()).filter(Boolean);
            let media = (b.mediaFiles && b.mediaFiles.length) ? b.mediaFiles : (s.mediaFile ? [s.mediaFile] : []);
            if (!media.length) { try { const day = require('./operator_control.js').load().days[date]; media = ((day && day.media) || []).map(m => m.file || m).filter(f => typeof f === 'string' && !require('./media_policy.js').isRetired(f)); } catch (e) {} }
            const useSlotWindow = !(b.windowStart && b.windowEnd) && !b.preset;
            const input = inputFrom({ ...b, name: b.name || `Agenda ${date} ${slot}`, source: 'agenda', ...(useSlotWindow ? { windowStart: w.start, windowEnd: w.end } : {}),
                messages: msgs.length ? msgs : [s.hook].filter(Boolean),
                mediaFiles: media });
            send(res, b.previewOnly ? { ok: true, preview: scheduler.preview(input), slot: { name: s.name, hook: s.hook, mediaFiles: input.mediaFiles } } : scheduler.create(input));
        } catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });
    app.get('/api/scheduled', (req, res) => res.json({ success: true, campaigns: scheduler.list(), lines: SESSIONS.map(s => ({ id: s.id, name: s.name, connected: s.status === 'CONNECTED' && !!s.sock })) }));
    app.get('/api/scheduled/:id/results.csv', (req, res) => {
        const csv = scheduler.resultsCsv(req.params.id);
        if (!csv) return res.status(404).json({ success: false, error: 'not found' });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="scheduled_results_${String(req.params.id).replace(/[^a-z0-9_]/gi, '')}.csv"`);
        res.send(csv);
    });
    app.get('/api/scheduled/:id', (req, res) => { const c = scheduler.get(req.params.id); if (!c) return res.status(404).json({ success: false, error: 'not found' }); res.json({ success: true, campaign: scheduler.summary(c, { items: true }) }); });
    app.post('/api/scheduled/:id/:action', (req, res) => send(res, scheduler.setStatus(req.params.id, req.params.action)));

    // test cleanup: also drop the own-number records our test campaigns created (runs before the existing handler)
    app.post('/api/test-records/cleanup', (req, res, next) => {
        let n = 0;
        try {
            for (const [k, u] of Object.entries(userMemory.users)) if (u && u.opsTest) { delete userMemory.users[k]; n++; }
            if (n) userMemory.save();
        } catch (e) {}
        res.setHeader('X-Ops-Test-Users-Removed', String(n));
        next();
    });

    return { scheduler, pinOk };
}

// ---------------- Dashboard UI (plain strings, injected into server.js page) ----------------
const BTN = 'padding:6px 12px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;';
const tabButtons = () => `
                    <button id="tab-btn-overview" class="tab-btn" type="button" data-tab="overview">📊 Overview / conclusions</button>
                    <button id="tab-btn-schedule" class="tab-btn" type="button" data-tab="schedule">🗓️ Scheduled Bulk</button>`;

const tabPanes = () => `
                <div id="tab-overview" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📊 Overview / conclusions — every conversation in one line</h3>
                    <div id="ov-totals" style="display:flex; gap:8px; flex-wrap:wrap; font-size:13px;"></div>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:10px; font-size:12px;">
                        <div><b>✅ Good</b><div id="ov-good"></div></div>
                        <div><b>⚠️ Needs care</b><div id="ov-bad"></div></div>
                    </div>
                    <div style="margin-top:10px; font-size:12px;"><b>🤝 Mulaqat</b><div id="ov-mulaqat"></div></div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:12px; margin-top:12px;">
                        <select id="ov-stance"><option value="">All stances</option><option value="commit">✅ Committed</option><option value="समर्थक">🟢 Supporter (samarthak)</option><option value="सोच रहे">🟡 Thinking (soch rahe)</option><option value="विरोधी">🔴 Opponent (virodhi)</option><option value="नाराज़">😠 Upset (naraz)</option></select>
                        <input id="ov-line" placeholder="Line id" style="width:80px;">
                        <input id="ov-ward" placeholder="Ward" style="width:56px;">
                        <input id="ov-q" placeholder="Search name / phone / topic" style="width:180px;">
                        <label><input type="checkbox" id="ov-test"> include test</label>
                        <button type="button" id="ov-refresh" style="${BTN}">↻ Refresh</button>
                        <span id="ov-count" style="color:#475569;"></span>
                    </div>
                    <div id="ov-list" style="font-size:12px; margin-top:10px; max-height:640px; overflow:auto;"></div>
                    <details style="margin-top:14px;">
                        <summary style="cursor:pointer; font-weight:700;">🚫 Opponent list (virodhi) — gentle mode: respect, listen, no vote asks</summary>
                        <p style="font-size:12px; color:#64748b;">Paste numbers, one per line (optionally "phone, name"). The bot stays very respectful with them, never asks for their vote, listens and logs any samasya. Scheduled Bulk skips them unless you tick "include opponents (virodhi)".</p>
                        <textarea id="vr-text" rows="4" style="width:100%;" placeholder="98XXXXXXXX, name"></textarea>
                        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; font-size:12px;">
                            <input id="vr-note" placeholder="note (optional)" style="width:200px;">
                            <button type="button" id="vr-add" style="${BTN}">➕ Add as opponent (virodhi)</button>
                            <span id="vr-status"></span>
                        </div>
                        <div id="vr-list" style="font-size:12px; margin-top:8px; max-height:260px; overflow:auto;"></div>
                    </details>
                </div>
                <div id="tab-schedule" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">🗓️ Scheduled Bulk — quiet sends spread over a time window</h3>
                    <div style="border:2px solid #16a34a; border-radius:10px; padding:10px; margin-bottom:12px; font-size:12px; background:#f0fdf4;">
                        <b style="font-size:14px;">🚀 Bulk in 3 steps: ① import → ② choose tag + window + texts/posters → ③ preview → start</b>
                        <div style="margin-top:8px;"><b>① Import contacts</b> — Excel (.xlsx), CSV (any headers: Name / Mobile / Phone / नाम / मोबाइल), phone export (.vcf), or paste "name number" lines. +91 / 0 / spaces / dashes are fine; duplicates and invalid numbers are dropped.</div>
                        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">
                            <input type="file" id="imp-file" accept=".csv,.xlsx,.vcf,.txt">
                            <span>tag</span> <input id="imp-tag" style="width:150px;" placeholder="📥 Bulk 6 Nov">
                            <button type="button" id="imp-check" style="${BTN}">👁 Check (nothing saved)</button>
                            <button type="button" id="imp-save" style="${BTN} background:#2563eb; color:white; font-weight:700;">📥 Import with this tag</button>
                        </div>
                        <textarea id="imp-text" rows="2" style="width:100%; margin-top:6px;" placeholder="or paste: Ramesh Kumar 98765 43210 (one per line)"></textarea>
                        <div id="imp-out" style="margin-top:6px; white-space:pre-wrap;"></div>
                        <div style="margin-top:6px;"><b>②</b> pick the tag under "1. Audience" below, a window, 3–4 text variants and posters. <b>③</b> 👁 Preview → 🗓️ Schedule.</div>
                    </div>
                    <p style="font-size:12px; color:#64748b; margin-top:0;">Each person gets a random time inside the window, at least 20–90 s apart per line, a rotating message + poster, spread across the lines you tick. STOP / declined people are skipped; opponents (virodhi) are skipped unless ticked. Safe to restart the server.</p>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; font-size:12px;">
                        <div>
                            <b>1. Audience</b><br>
                            <textarea id="sc-phones" rows="5" style="width:100%;" placeholder="phone, name, ward (one per line)"></textarea>
                            <b>Contacts with tag</b> <select id="sc-tag"><option value="">— none —</option></select> max people <input id="sc-max" type="number" min="0" style="width:56px;" placeholder="all"><br>
                            <label><input type="checkbox" id="sc-contacts"> + all saved contacts</label> ward <input id="sc-ward" style="width:46px;"> village <input id="sc-village" style="width:90px;">
                            <br><label><input type="checkbox" id="sc-virodhi"> include opponents (virodhi)</label>
                            <br><label><input type="checkbox" id="sc-card" checked> send the line's contact card after the first message (once per person — needed so they can see our Status)</label>
                        </div>
                        <div>
                            <b>2. Messages (variants separated by a line with ---)</b><br>
                            <textarea id="sc-msgs" rows="5" style="width:100%;" placeholder="{राम राम|नमस्ते} {name} जी 🙏 ...&#10;---&#10;second message ..."></textarea>
                            <b>Posters / media (rotate)</b><div id="sc-media" style="max-height:110px; overflow:auto; border:1px solid #e2e8f0; padding:4px;"></div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:12px; margin-top:8px;">
                        <b>3. Window (IST)</b>
                        <select id="sc-preset"><option value="morning">morning 09:00–11:30</option><option value="evening">evening 17:30–20:00</option><option value="dopahar">afternoon 13:00–16:00</option><option value="">custom</option></select>
                        date <input id="sc-date" type="date">
                        from <input id="sc-start" type="time" value="09:00"> to <input id="sc-end" type="time" value="11:30">
                        gap <input id="sc-min" type="number" value="20" style="width:52px;">–<input id="sc-max" type="number" value="90" style="width:52px;"> s
                        <label><input type="checkbox" id="sc-quiet"> quiet hours 21–08</label>
                    </div>
                    <div style="font-size:12px; margin-top:6px;"><b>4. Lines</b> <span id="sc-lines"></span></div>
                    <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; align-items:center; font-size:12px;">
                        <input id="sc-name" placeholder="campaign name" style="width:180px;">
                        <button type="button" id="sc-preview" style="${BTN}">👁 Preview</button>
                        <button type="button" id="sc-create" style="${BTN} background:#16a34a; color:white; font-weight:700;">🗓️ Schedule</button>
                        <span style="margin-left:12px;">or agenda slot:</span>
                        <select id="sc-slot"><option value="morning">morning</option><option value="dopahar">dopahar</option><option value="evening">evening</option><option value="night">night</option></select>
                        <button type="button" id="sc-agenda" style="${BTN}">📅 Schedule agenda slot (its hook + poster) to this audience</button>
                    </div>
                    <pre id="sc-out" style="white-space:pre-wrap; font-size:12px; background:#f8fafc; padding:8px; border-radius:6px; margin-top:8px;"></pre>
                    <h4 style="margin:12px 0 6px 0;">Campaigns <button type="button" id="sc-refresh" style="${BTN}">↻</button></h4>
                    <div id="sc-list" style="font-size:12px;"></div>
                    <div id="sc-detail" style="font-size:12px; margin-top:8px; max-height:380px; overflow:auto;"></div>
                </div>`;

const script = () => `
            <script>
            (function () {
                function el(id) { return document.getElementById(id); }
                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                function postJson(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
                function chip(label, n, color) { return '<span style="padding:6px 10px; border-radius:8px; background:' + color + '; font-weight:700;">' + esc(label) + ': ' + n + '</span>'; }
                var STC = { 'commit': '#bbf7d0', 'समर्थक': '#dcfce7', 'सोच रहे': '#fef9c3', 'विरोधी': '#fee2e2', 'नाराज़': '#fecaca' };
                var STL = { 'commit': 'Committed', 'समर्थक': 'Supporter', 'सोच रहे': 'Thinking', 'विरोधी': 'Opponent (virodhi)', 'नाराज़': 'Upset' };
                function loadOverview() {
                    var p = [['stance', el('ov-stance').value], ['line', el('ov-line').value], ['ward', el('ov-ward').value], ['q', el('ov-q').value], ['includeTest', el('ov-test').checked ? '1' : '']].filter(function (x) { return x[1]; }).map(function (x) { return x[0] + '=' + encodeURIComponent(x[1]); }).join('&');
                    return fetch('/api/overview' + (p ? '?' + p : '')).then(function (r) { return r.json(); }).then(function (d) {
                        if (!d || !d.success) return;
                        var t = d.totals || {};
                        var cats = Object.keys(t.samasyaByCategory || {}).map(function (k) { return esc(k) + ' ' + t.samasyaByCategory[k]; }).join(', ');
                        el('ov-totals').innerHTML = chip('Conversations', t.conversations || 0, '#e2e8f0') + chip('✅ Commit', t.commit || 0, STC.commit) + chip('🟢 Supporter', t['समर्थक'] || 0, STC['समर्थक']) + chip('🟡 Thinking', t['सोच रहे'] || 0, STC['सोच रहे']) + chip('🔴 Opponent (virodhi)', t['विरोधी'] || 0, STC['विरोधी']) + chip('😠 Upset', t['नाराज़'] || 0, STC['नाराज़']) + chip('📋 Samasya', (t.samasyaTotal || 0) + (cats ? ' (' + cats + ')' : ''), '#e0f2fe') + chip('🤝 Mulaqat', t.mulaqatTotal || 0, '#ede9fe');
                        el('ov-good').innerHTML = (d.good || []).map(function (g) { return '<div>• ' + esc(g.name || g.phone) + ' — ' + esc(g.why) + '</div>'; }).join('') || '<i>—</i>';
                        el('ov-bad').innerHTML = (d.bad || []).map(function (g) { return '<div>• ' + esc(g.name || g.phone) + ' — ' + esc(g.why) + '</div>'; }).join('') || '<i>—</i>';
                        el('ov-mulaqat').innerHTML = (d.mulaqatScheduled || []).map(function (m) { return '<div>• ' + esc(m.name || m.phone) + ' — ' + esc(m.status) + ' — ' + esc(m.when || m.date || 'time?') + ' — ' + esc(m.place || 'place?') + (m.ward ? ' (ward ' + esc(m.ward) + ')' : '') + '</div>'; }).join('') || '<i>none yet</i>';
                        el('ov-count').textContent = (d.rows || []).length + ' shown';
                        var rows = (d.rows || []).map(function (r) {
                            var when = r.lastAt ? new Date(r.lastAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
                            var sm = (r.samasya || []).map(function (s) { return esc(s.category) + ' (' + esc(s.status) + ')'; }).join('<br>');
                            var mq = (r.mulaqat || []).map(function (m) { return esc(m.status) + ' ' + esc(m.when) + ' ' + esc(m.place); }).join('<br>');
                            return '<tr style="border-bottom:1px solid #e2e8f0;' + (r.test ? ' background:#fef9c3;' : '') + '"><td style="padding:5px;"><b>' + esc(r.name || '—') + '</b><br>' + esc(r.phone) + '</td><td>' + esc(r.line) + '</td><td>' + esc(r.ward) + '</td><td><span style="padding:2px 6px; border-radius:6px; background:' + (STC[r.stance] || '#e2e8f0') + ';">' + esc(STL[r.stance] || r.stance) + '</span>' + (r.mode && r.mode !== 'normal' ? '<br><span style="font-size:11px;padding:1px 6px;border-radius:8px;background:#ede9fe;color:#5b21b6;">' + ({ aggressive: '🔥 Assertive', chill: '😌 Relaxed', gentle: '🕊️ Gentle (virodhi)' }[r.mode] || esc(r.mode)) + '</span>' : '') + (r.brief ? ' 🔐' : '') + (r.optedOut ? '<br>🚫 STOP' : '') + '</td><td>' + esc(when) + '</td><td>' + esc(r.summary) + '</td><td>' + sm + '</td><td>' + mq + '</td></tr>';
                        }).join('');
                        el('ov-list').innerHTML = '<table style="width:100%; border-collapse:collapse;"><tr style="text-align:left; background:#f1f5f9;"><th>Voter</th><th>Line</th><th>Ward</th><th>Stance</th><th>Last msg</th><th>What was talked about</th><th>Samasya</th><th>Mulaqat</th></tr>' + (rows || '<tr><td colspan="8" style="padding:10px;">No conversations.</td></tr>') + '</table>';
                    }).catch(function () {});
                }
                function loadVirodhi() {
                    return fetch('/api/virodhi').then(function (r) { return r.json(); }).then(function (d) {
                        el('vr-list').innerHTML = (d.list || []).map(function (v) { return '<div>• ' + esc(v.phone) + ' ' + esc(v.name || '') + ' <i style="color:#64748b;">' + esc(v.note || '') + '</i> <button type="button" class="vr-del" data-phone="' + esc(v.phone) + '" style="font-size:11px;">remove</button></div>'; }).join('') || '<i>empty</i>';
                    }).catch(function () {});
                }
                var mediaList = [];
                function loadSchedule() {
                    fetch('/api/media/list').then(function (r) { return r.json(); }).then(function (d) {
                        mediaList = (d.media || []).filter(function (m) { return !m.retired; }); // retired posters are never offered (server refuses them too)
                        el('sc-media').innerHTML = mediaList.map(function (m) { return '<label style="display:block;"><input type="checkbox" class="sc-mf" value="' + esc(m.file) + '"> ' + (m.type === 'video' ? '🎬 ' : m.type === 'document' ? '📄 ' : '🖼️ ') + esc(m.file) + '</label>'; }).join('') || '<i>Media Bank is empty</i>';
                    }).catch(function () {});
                    return fetch('/api/scheduled').then(function (r) { return r.json(); }).then(function (d) {
                        fetch('/api/contacts/tags').then(function (r) { return r.json(); }).then(function (t) {
                            var cur = el('sc-tag').value;
                            el('sc-tag').innerHTML = '<option value="">— none —</option>' + (t.tags || []).map(function (x) { return '<option value="' + esc(x.tag) + '">' + esc(x.tag) + ' (' + x.count + ')</option>'; }).join('');
                            if (cur) el('sc-tag').value = cur;
                        }).catch(function () {});
                        el('sc-lines').innerHTML = (d.lines || []).map(function (l) { return '<label style="margin-right:10px;"><input type="checkbox" class="sc-line" value="' + esc(l.id) + '"' + (l.connected ? ' checked' : ' disabled') + '> ' + esc(l.name || l.id) + (l.connected ? ' 🟢' : ' 🔴') + '</label>'; }).join('');
                        el('sc-list').innerHTML = (d.campaigns || []).map(function (c) {
                            var k = c.counts || {};
                            return '<div style="padding:6px; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:6px;"><b>' + esc(c.name) + '</b> ' + (c.test ? '🧪 ' : '') + '<code>' + esc(c.id) + '</code> — <b>' + esc(c.status) + '</b>' + (c.waitingReason ? ' (' + esc(c.waitingReason) + ')' : '') + (c.pauseReason ? ' <span style="color:#b91c1c; font-weight:700;">⏸ ' + esc(c.pauseReason) + '</span>' : '') + '<br>' + esc(c.window.startIST) + ' → ' + esc(c.window.endIST) + ' • lines ' + esc((c.lines || []).join(', ')) + ' • ' + c.messages + ' msg / ' + (c.media || []).length + ' media<br>sent ' + (k.sent || 0) + ' • pending ' + (k.pending || 0) + ' • skipped ' + (k.skipped || 0) + ' • failed ' + (k.failed || 0) + (c.nextDueIST ? ' • next ' + esc(c.nextDueIST) : '') +
                                ' <button type="button" class="sc-act" data-id="' + esc(c.id) + '" data-a="view">details</button> <button type="button" class="sc-act" data-id="' + esc(c.id) + '" data-a="pause">pause</button> <button type="button" class="sc-act" data-id="' + esc(c.id) + '" data-a="resume">resume</button> <button type="button" class="sc-act" data-id="' + esc(c.id) + '" data-a="cancel">cancel</button> <a href="/api/scheduled/' + encodeURIComponent(c.id) + '/results.csv">⬇️ results CSV</a></div>';
                        }).join('') || '<i>No scheduled campaigns yet.</i>';
                    }).catch(function () {});
                }
                function scPayload() {
                    var lines = Array.prototype.slice.call(document.querySelectorAll('.sc-line:checked')).map(function (c) { return c.value; });
                    var mf = Array.prototype.slice.call(document.querySelectorAll('.sc-mf:checked')).map(function (c) { return c.value; });
                    var date = el('sc-date').value || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
                    var b = { name: el('sc-name').value, phones: el('sc-phones').value, useContacts: el('sc-contacts').checked, contactTag: el('sc-tag').value, maxRecipients: el('sc-max').value, contactCard: el('sc-card').checked, contactWard: el('sc-ward').value, contactVillage: el('sc-village').value, includeVirodhi: el('sc-virodhi').checked, messages: el('sc-msgs').value, mediaFiles: mf, lines: lines, minGapSec: el('sc-min').value, maxGapSec: el('sc-max').value, quietHours: el('sc-quiet').checked, date: date };
                    if (el('sc-preset').value) b.preset = el('sc-preset').value; else { b.windowStart = date + 'T' + el('sc-start').value; b.windowEnd = date + 'T' + el('sc-end').value; }
                    return b;
                }
                function show(d) {
                    var p = d.preview || (d.campaign ? null : d);
                    var head = '';
                    if (d.success === false || (p && p.ok === false)) head = '❌ ' + ((p && p.errors && p.errors.join('; ')) || d.error || 'failed') + '\\n';
                    else if (p && p.recipients !== undefined) {
                        var sk = Object.keys(p.skippedByReason || {}).map(function (k) { return k + ' ' + p.skippedByReason[k]; }).join(', ');
                        head = '✅ ' + p.recipients + ' people will get it (' + Object.keys(p.perLine || {}).map(function (k) { return k + ': ' + p.perLine[k]; }).join(', ') + ')\\n' +
                            'skipped: ' + (sk || 'none') + ' • duplicates removed ' + (p.duplicates || 0) + ' • invalid ' + (p.invalid || 0) + (p.heldBack ? ' • held back for next window ' + p.heldBack : '') + '\\n' +
                            'window ' + p.window.join(' → ') + ' • gaps ' + (p.gapSec || []).join('–') + ' s • caps ' + (p.caps ? p.caps.hourlyCap + '/h, ' + p.caps.dailyCap + '/day' : '') + '\\n' +
                            'texts ' + JSON.stringify(p.textRotation || {}) + ' • posters ' + JSON.stringify(p.posterRotation || {}) + '\\n' +
                            ((p.warnings || []).length ? '⚠️ ' + p.warnings.join('\\n⚠️ ') + '\\n' : '');
                    } else if (d.campaign) head = '🗓️ Scheduled: ' + d.campaign.name + ' — ' + (d.campaign.counts || {}).total + ' people, ' + d.campaign.window.startIST + ' → ' + d.campaign.window.endIST + '\\n';
                    el('sc-out').textContent = head + '\\n' + JSON.stringify(d.preview || d.campaign || d, null, 2);
                }
                function readFile(f) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function (e) { ok(String(e.target.result || '').replace(/^data:[^,]*,/, '')); }; r.onerror = no; r.readAsDataURL(f); }); }
                function doImport(dry) {
                    var f = el('imp-file').files[0];
                    var body = { tag: el('imp-tag').value, text: el('imp-text').value, dryRun: dry };
                    if (!dry && !confirm('Import these contacts with tag "' + (body.tag || 'default') + '"?')) return;
                    el('imp-out').textContent = '⏳ reading…';
                    (f ? readFile(f) : Promise.resolve(null)).then(function (b64) {
                        if (b64) { body.fileBase64 = b64; body.fileName = f.name; }
                        return postJson('/api/contacts/import', body);
                    }).then(function (d) {
                        if (!d.success) { el('imp-out').textContent = '❌ ' + (d.error || 'failed'); return; }
                        var k = d.counts || {};
                        el('imp-out').innerHTML = (d.dryRun ? '👁 <b>Check only — nothing saved.</b> ' : '✅ <b>Imported</b> (' + esc((d.saved || {}).created) + ' new, ' + esc((d.saved || {}).tagged) + ' already saved got the tag). ') +
                            'Format ' + esc(d.format) + ' • rows ' + k.rows + ' • <b>valid ' + k.valid + '</b> • invalid ' + k.invalid + ' • duplicates ' + k.duplicatesInFile + ' • already saved ' + k.alreadySaved + ' • STOP ' + k.optedOut + ' • virodhi ' + k.virodhi + ' • voter-roll match ' + k.voterMatched + ' • tag <b>' + esc(d.tag) + '</b>' +
                            '<br>' + (d.sample || []).map(function (s) { return esc(s.name || '—') + ' ' + esc(s.phone) + (s.voter ? ' 🗳️' : '') + ' (' + esc(s.flags) + ')'; }).join(' • ') +
                            ((d.invalidSample || []).length ? '<br>❌ invalid: ' + d.invalidSample.map(function (x) { return esc(x.name) + ' ' + esc(x.raw) + ' (' + esc(x.reason) + ')'; }).join(' • ') : '');
                        if (!d.dryRun) { loadSchedule(); setTimeout(function () { el('sc-tag').value = d.tag; }, 800); }
                    }).catch(function (e) { el('imp-out').textContent = '❌ ' + e.message; });
                }
                function init() {
                    var ob = el('tab-btn-overview'); if (ob) ob.addEventListener('click', function () { switchTab('overview', this); loadOverview(); loadVirodhi(); });
                    var sb = el('tab-btn-schedule'); if (sb) sb.addEventListener('click', function () { switchTab('schedule', this); loadSchedule(); });
                    el('ov-refresh').addEventListener('click', loadOverview);
                    ['ov-stance', 'ov-test', 'ov-line', 'ov-ward', 'ov-q'].forEach(function (id) { el(id).addEventListener('change', loadOverview); });
                    el('vr-add').addEventListener('click', function () { postJson('/api/virodhi/add', { text: el('vr-text').value, note: el('vr-note').value }).then(function (d) { el('vr-status').textContent = d.success ? ('✅ added ' + d.added + ', already ' + d.already + (d.invalid && d.invalid.length ? ', invalid ' + d.invalid.length : '')) : '❌'; el('vr-text').value = ''; loadVirodhi(); loadOverview(); }); });
                    el('vr-list').addEventListener('click', function (e) { var b = e.target; if (b && b.className === 'vr-del') postJson('/api/virodhi/remove', { phone: b.dataset.phone }).then(loadVirodhi); });
                    el('imp-check').addEventListener('click', function () { doImport(true); });
                    el('imp-save').addEventListener('click', function () { doImport(false); });
                    el('sc-preview').addEventListener('click', function () { postJson('/api/scheduled/preview', scPayload()).then(show); });
                    el('sc-create').addEventListener('click', function () { if (!confirm('Schedule this campaign? Messages will go out inside the window.')) return; postJson('/api/scheduled/create', scPayload()).then(function (d) { show(d); loadSchedule(); }); });
                    el('sc-agenda').addEventListener('click', function () { var b = scPayload(); b.slot = el('sc-slot').value; if (!confirm('Schedule agenda slot "' + b.slot + '" for ' + b.date + ' to this audience?')) return; postJson('/api/scheduled/from-agenda', b).then(function (d) { show(d); loadSchedule(); }); });
                    el('sc-refresh').addEventListener('click', loadSchedule);
                    el('sc-list').addEventListener('click', function (e) {
                        var b = e.target; if (!b || b.className !== 'sc-act') return;
                        if (b.dataset.a === 'view') return fetch('/api/scheduled/' + b.dataset.id).then(function (r) { return r.json(); }).then(function (d) {
                            var c = d.campaign || {}; el('sc-detail').innerHTML = '<table style="width:100%; border-collapse:collapse;"><tr style="background:#f1f5f9; text-align:left;"><th>Phone</th><th>Name</th><th>Line</th><th>Due</th><th>Variant</th><th>Status</th><th>Sent</th></tr>' + (c.items || []).map(function (i) { return '<tr><td>' + esc(i.phone) + '</td><td>' + esc(i.name) + '</td><td>' + esc(i.line) + '</td><td>' + esc(i.dueIST) + '</td><td>' + esc(i.variant) + '</td><td>' + esc(i.status) + (i.reason ? ' (' + esc(i.reason) + ')' : '') + '</td><td>' + esc(i.sentIST) + '</td></tr>'; }).join('') + '</table>';
                        });
                        postJson('/api/scheduled/' + b.dataset.id + '/' + b.dataset.a, {}).then(function () { loadSchedule(); });
                    });
                    setInterval(function () { var t = el('tab-schedule'); if (t && t.style.display !== 'none') loadSchedule(); }, 15000);
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
            })();
            </script>`;

module.exports = { install, ui: { tabButtons, tabPanes, script } };
