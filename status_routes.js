/**
 * 📢 Status posts — API + dashboard tab (installed from server.js with one call).
 * Every route sits behind the dashboard login (admin and members).
 */
const path = require('path');
const { StatusPoster } = require('./status_posts.js');

const KNOWN = { sim_636: '916367810227', baba_aux: '919509352067', canada: '14502790497' };

function install(app, d) {
    const { SESSIONS, contactsManager, isOptedOut, lineContacts = {} } = d;
    const numberOf = (lineId) => {
        const s = SESSIONS.find(x => x.id === lineId);
        const u = s && s.sock && s.sock.user;
        const fromSock = u && u.id ? String(u.id).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        return fromSock || (lineContacts[lineId] && lineContacts[lineId].waid) || KNOWN[lineId] || null;
    };
    const poster = new StatusPoster({
        stateFile: process.env.STATUS_POSTS_PATH || path.join(__dirname, 'status_posts.json'),
        mediaDir: path.join(__dirname, 'media'),
        getSessions: () => SESSIONS,
        ownNumbers: () => SESSIONS.map(s => numberOf(s.id)).filter(Boolean),
        ownNumberOf: numberOf,
        testLines: (process.env.STATUS_TEST_LINES || 'canada').split(',').map(s => s.trim()).filter(Boolean),
        audienceFor: (lineId, { tag }) => {
            const own = new Set(SESSIONS.map(s => numberOf(s.id)).filter(Boolean));
            const list = contactsManager.contacts.filter(c => {
                if (!c || !c.phone || own.has(c.phone)) return false;
                if (tag) return Array.isArray(c.tags) && c.tags.includes(tag);
                return c.line === lineId || (Array.isArray(c.tags) && c.tags.some(t => String(t).startsWith('📥')));
            }).map(c => c.phone);
            return list.filter(p => { try { return !isOptedOut(p); } catch (e) { return true; } });
        }
    });
    poster.start(30000);

    const send = (res, r) => res.status(r.status || (r.ok ? 200 : 400)).json({ success: !!r.ok, ...r });
    app.get('/api/status-posts', (req, res) => {
        const lines = SESSIONS.map(s => ({ id: s.id, name: s.name, connected: s.status === 'CONNECTED' && !!s.sock, test: poster.isTestLine(s.id), audience: s.status === 'CONNECTED' ? poster.audience(s.id).length : null }));
        res.json({ success: true, lines, ...poster.view() });
    });
    app.post('/api/status-posts/audience', (req, res) => { const b = req.body || {}; res.json({ success: true, lineId: b.lineId, count: poster.audience(b.lineId, { tag: b.tag || '', testOnly: b.testOnly === true }).length }); });
    app.post('/api/status-posts/post', async (req, res) => { try { send(res, await poster.post(req.body || {})); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
    app.post('/api/status-posts/schedule', (req, res) => send(res, poster.addSchedule({ ...(req.body || {}), by: req.dashUser && req.dashUser.username })));
    app.post('/api/status-posts/schedule/:id/delete', (req, res) => send(res, poster.removeSchedule(req.params.id)));
    app.post('/api/status-posts/schedule/:id/:onoff(enable|disable)', (req, res) => send(res, poster.setEnabled(req.params.id, req.params.onoff === 'enable')));
    app.post('/api/status-posts/:id/delete', async (req, res) => send(res, await poster.remove(req.params.id)));
    return { poster };
}

const BTN = 'padding:6px 12px; border:1px solid #cbd5e1; border-radius:6px; background:white; cursor:pointer;';
const tabButtons = () => `
                    <button id="tab-btn-status" class="tab-btn" type="button" data-tab="status">📢 Status posts</button>`;
const tabPanes = () => `
                <div id="tab-status" class="card tab-content" style="display: none;">
                    <h3 style="margin-top:0;">📢 WhatsApp Status posts (3–4 a day)</h3>
                    <p style="font-size:12px; color:#64748b; margin-top:0;">The status is shown to the line's saved contacts + imported contacts (STOP excluded). WhatsApp only shows it to people who also saved our number — the line's contact card goes with the first bulk message. Only real posters / photos from the Media Bank; retired posters can't be used. The Canada line is a test line: its status only goes to our own numbers.</p>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; font-size:12px;">
                        <div>
                            <b>1. Line</b> <select id="stp-line"></select> <span id="stp-aud" style="color:#475569;"></span><br>
                            <b>Only contacts with tag</b> <select id="stp-tag"><option value="">all saved + imported</option></select><br>
                            <b>2. Poster / photo / video</b>
                            <div id="stp-media" style="max-height:150px; overflow:auto; border:1px solid #e2e8f0; padding:4px; margin-top:4px;"></div>
                        </div>
                        <div>
                            <b>3. Caption (Hindi)</b> — or a text-only status if no poster is chosen
                            <textarea id="stp-caption" rows="4" style="width:100%;" placeholder="राम राम जी 🙏 ..."></textarea>
                            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">
                                <button type="button" id="stp-now" style="${BTN} background:#16a34a; color:white; font-weight:700;">📤 Post now</button>
                                <span>or daily at</span> <input id="stp-time" type="time" value="09:30">
                                <span>on</span> <input id="stp-date" type="date" title="empty = every day">
                                <button type="button" id="stp-sched" style="${BTN}">⏰ Schedule</button>
                            </div>
                            <div style="font-size:11px; color:#64748b; margin-top:4px;">Suggested: 09:30, 13:00, 17:30, 20:00 IST (max 4 a day per line). Empty date = every day.</div>
                        </div>
                    </div>
                    <pre id="stp-out" style="white-space:pre-wrap; font-size:12px; background:#f8fafc; padding:8px; border-radius:6px; margin-top:8px;"></pre>
                    <h4 style="margin:12px 0 6px 0;">⏰ Scheduled <button type="button" id="stp-refresh" style="${BTN}">↻</button></h4>
                    <div id="stp-schedules" style="font-size:12px;"></div>
                    <h4 style="margin:12px 0 6px 0;">🧾 Posted (latest first)</h4>
                    <div id="stp-history" style="font-size:12px; max-height:300px; overflow:auto;"></div>
                </div>`;
const script = () => `
            <script>
            (function () {
                function el(id) { return document.getElementById(id); }
                function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
                function postJson(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
                function chosen() { var c = document.querySelector('input[name="stp-mf"]:checked'); return c ? c.value : ''; }
                function payload() { return { lineId: el('stp-line').value, tag: el('stp-tag').value, mediaFile: chosen(), caption: chosen() ? el('stp-caption').value : '', text: chosen() ? '' : el('stp-caption').value }; }
                function aud() { postJson('/api/status-posts/audience', { lineId: el('stp-line').value, tag: el('stp-tag').value }).then(function (d) { el('stp-aud').textContent = d && d.success ? ('👥 ' + d.count + ' can see it') : ''; }).catch(function () {}); }
                function load() {
                    fetch('/api/media/list').then(function (r) { return r.json(); }).then(function (d) {
                        var list = (d.media || []).filter(function (m) { return !m.retired && (m.type === 'image' || m.type === 'video'); });
                        el('stp-media').innerHTML = '<label style="display:block;"><input type="radio" name="stp-mf" value="" checked> ✍️ text only</label>' + list.map(function (m) { return '<label style="display:block;"><input type="radio" name="stp-mf" value="' + esc(m.file) + '"> ' + (m.type === 'video' ? '🎬 ' : '🖼️ ') + esc(m.file) + ' <a href="' + esc(m.url) + '" target="_blank">view</a></label>'; }).join('');
                    }).catch(function () {});
                    fetch('/api/contacts/tags').then(function (r) { return r.json(); }).then(function (d) {
                        var cur = el('stp-tag').value;
                        el('stp-tag').innerHTML = '<option value="">all saved + imported</option>' + (d.tags || []).map(function (t) { return '<option value="' + esc(t.tag) + '">' + esc(t.tag) + ' (' + t.count + ')</option>'; }).join('');
                        el('stp-tag').value = cur;
                    }).catch(function () {});
                    return fetch('/api/status-posts').then(function (r) { return r.json(); }).then(function (d) {
                        var cur = el('stp-line').value;
                        el('stp-line').innerHTML = (d.lines || []).map(function (l) { return '<option value="' + esc(l.id) + '"' + (l.connected ? '' : ' disabled') + '>' + esc(l.name) + (l.test ? ' — TEST (own numbers only)' : '') + (l.connected ? '' : ' 🔴') + '</option>'; }).join('');
                        if (cur) el('stp-line').value = cur;
                        el('stp-schedules').innerHTML = (d.schedules || []).map(function (s) { return '<div style="padding:5px; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:4px;">' + (s.enabled ? '🟢' : '⏸️') + ' <b>' + esc(s.time) + ' IST</b> ' + (s.repeatDaily ? 'every day' : esc(s.date)) + ' • ' + esc(s.lineId) + ' • ' + esc(s.mediaFile || 'text') + ' • ' + esc((s.caption || s.text || '').slice(0, 60)) + (s.tag ? ' • tag ' + esc(s.tag) : '') + '<br><i style="color:#64748b;">' + esc(s.lastResult || 'not run yet') + '</i> <button type="button" class="stp-act" data-u="/api/status-posts/schedule/' + esc(s.id) + '/' + (s.enabled ? 'disable' : 'enable') + '">' + (s.enabled ? 'pause' : 'enable') + '</button> <button type="button" class="stp-act" data-u="/api/status-posts/schedule/' + esc(s.id) + '/delete">delete</button></div>'; }).join('') || '<i>No scheduled status posts.</i>';
                        el('stp-history').innerHTML = (d.history || []).map(function (h) { return '<div>' + (h.ok ? '✅' : '❌') + ' ' + esc(h.atIST) + ' • ' + esc(h.lineId) + (h.test ? ' (test)' : '') + ' • ' + esc(h.mediaFile || h.kind) + ' • 👥 ' + h.recipients + ' • ' + esc((h.caption || '').slice(0, 50)) + (h.error ? ' • ' + esc(h.error) : '') + (h.deletedAt ? ' • deleted' : (h.ok ? ' <button type="button" class="stp-act" data-c="1" data-u="/api/status-posts/' + esc(h.id) + '/delete">delete</button>' : '')) + '</div>'; }).join('') || '<i>Nothing posted yet.</i>';
                        aud();
                    }).catch(function () {});
                }
                function out(d) { el('stp-out').textContent = d.success ? ('✅ ' + JSON.stringify(d.post || d.schedule || d, null, 1)) : ('❌ ' + (d.error || 'failed')); load(); }
                function init() {
                    var b = el('tab-btn-status'); if (!b) return;
                    b.addEventListener('click', function () { if (typeof switchTab === 'function') switchTab('status', this); load(); });
                    el('stp-refresh').addEventListener('click', load);
                    el('stp-line').addEventListener('change', aud);
                    el('stp-tag').addEventListener('change', aud);
                    el('stp-now').addEventListener('click', function () { var p = payload(); if (!confirm('Post this status now from ' + p.lineId + '?')) return; el('stp-out').textContent = 'posting…'; postJson('/api/status-posts/post', p).then(out); });
                    el('stp-sched').addEventListener('click', function () { var p = payload(); p.time = el('stp-time').value; p.date = el('stp-date').value; postJson('/api/status-posts/schedule', p).then(out); });
                    document.addEventListener('click', function (e) { var t = e.target; if (!t || t.className !== 'stp-act') return; if (t.dataset.c && !confirm('Delete this status for everyone?')) return; postJson(t.dataset.u, {}).then(out); });
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
            })();
            </script>`;

module.exports = { install, ui: { tabButtons, tabPanes, script } };
