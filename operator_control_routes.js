/**
 * v6 operator control — API + dashboard tab "🔒 Today's goal" (daily lock: main goal, talking points, bot line, media;
 * global default mode; history). Per-voter brief/mode is edited in the CRM profile panel (crm_routes/crm_ui).
 * All routes sit behind the dashboard PIN middleware. ES5-safe UI (no optional chaining).
 */
const oc = require('./operator_control.js');

function install(app, deps = {}) {
    const { userMemory, runFollowups } = deps;
    app.get('/api/control/day', (req, res) => {
        const date = String(req.query.date || oc.istDate());
        const d = oc.load().days[date] || null;
        res.json({ success: true, date, today: oc.istDate(), day: d, locked: !!oc.lockedToday(), defaultMode: oc.getDefaultMode(), modes: oc.MODES, history: oc.dayHistory(14) });
    });
    app.post('/api/control/day', (req, res) => {
        try {
            const b = req.body || {};
            const d = oc.setDay(b.date || oc.istDate(), b);
            res.json({ success: true, day: d, locked: !!oc.lockedToday() });
        } catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });
    app.get('/api/control/history', (req, res) => res.json({ success: true, history: oc.dayHistory(Number(req.query.days) || 14) }));
    app.post('/api/control/default-mode', (req, res) => {
        try { res.json({ success: true, defaultMode: oc.setDefaultMode(String((req.body || {}).mode || '')) }); }
        catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });
    app.get('/api/control/voter/:phone', (req, res) => {
        const u = userMemory && userMemory.getUser(req.params.phone);
        if (!u) return res.status(404).json({ success: false, error: 'not found' });
        res.json({ success: true, control: oc.getVoterControl(u) });
    });
    app.post('/api/control/voter/:phone', (req, res) => {
        const u = userMemory && userMemory.getUser(req.params.phone);
        if (!u) return res.status(404).json({ success: false, error: 'not found' });
        const c = oc.setVoterControl(u, req.body || {});
        userMemory.save();
        res.json({ success: true, control: c });
    });
    app.get('/api/control/followups', (req, res) => {
        const all = (userMemory ? userMemory.getAllUsers() : []).filter(u => u.memory && u.memory.op && u.memory.op.followup && u.memory.op.followup !== 'off');
        res.json({ success: true, voters: all.map(u => ({ phone: u.phone, name: u.name || (u.memory && u.memory.name) || '', followup: u.memory.op.followup, last: u.memory.op.lastFollowupAt || null, due: oc.followupDue(u) })) });
    });
    app.post('/api/control/followups/run', async (req, res) => {
        if (typeof runFollowups !== 'function') return res.status(503).json({ success: false, error: 'not available' });
        try { res.json({ success: true, result: await runFollowups() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
}

const tabButtons = () => `
                    <button id="tab-btn-lock" class="tab-btn" type="button" data-tab="lock">🔒 Today's goal</button>`;

const tabPanes = () => `
                <div id="tab-lock" class="tab-content" style="display:none;">
                  <div class="oc-wrap">
                    <h3 style="margin:0 0 4px 0;">🔒 Today's main goal & agenda <span id="oc-lock-badge" class="oc-badge">—</span></h3>
                    <div class="oc-sub">When locked, the bot steers every chat today toward this goal, uses today's talking points, and sends today's media to each voter once a day at the right time. A new date (IST) starts a new day — older days appear in the history below.</div>
                    <div class="oc-grid">
                      <div><label>Date (IST)</label><input id="oc-date" type="date"></div>
                      <div><label>Default mode (all voters)</label><select id="oc-default-mode"><option value="normal">⚖️ Normal</option><option value="aggressive">🔥 Assertive (asks for the vote promise often)</option><option value="chill">😌 Relaxed (relationship first)</option><option value="gentle">🕊️ Gentle / virodhi (no vote talk)</option></select></div>
                    </div>
                    <label>🎯 Today's main goal</label>
                    <input id="oc-goal" placeholder="e.g. deliver voter slips + get a vote promise for 16 Nov">
                    <label>🗒️ Today's talking points (one point per line)</label>
                    <textarea id="oc-points" rows="4" placeholder="e.g. Abhay Singh ji will be at the chaupal this evening&#10;If you did not get your slip, send your name and father name"></textarea>
                    <label>💬 Bot line (optional — sent to each voter once a day; write it in Hindi)</label>
                    <input id="oc-steer" placeholder="e.g. आपकी वोटर पर्ची पहुँच गई? न मिली हो तो अपना नाम लिख दीजिए 🙏">
                    <label>📎 Today's media (photo / poster / mp4 — max 3)</label>
                    <div class="oc-upload"><input id="oc-file" type="file" accept="image/*,video/mp4,video/3gpp,video/quicktime"><span id="oc-up-status"></span></div>
                    <div id="oc-media" class="oc-media">Loading…</div>
                    <label class="oc-check"><input id="oc-locked" type="checkbox"> 🔒 Lock for today</label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"><button id="oc-save" class="oc-btn" type="button">💾 Save</button><button id="oc-run-fu" class="oc-btn alt" type="button">🔁 Run follow-ups now</button></div>
                    <div id="oc-fu" class="oc-sub" style="margin-top:6px;"></div>
                    <h4 style="margin:16px 0 6px 0;">📜 Previous days</h4>
                    <div id="oc-history" class="oc-sub">—</div>
                  </div>
                </div>`;

const css = () => `
.oc-wrap { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; max-width:860px; }
.oc-wrap label { display:block; font-size:12px; font-weight:700; color:#475569; margin:10px 0 3px 0; }
.oc-wrap input:not([type=checkbox]), .oc-wrap select, .oc-wrap textarea { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; background:#f8fafc; color:#0f172a; }
.oc-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.oc-sub { font-size:12px; color:#64748b; }
.oc-badge { font-size:12px; padding:2px 8px; border-radius:10px; background:#e2e8f0; color:#334155; vertical-align:middle; }
.oc-badge.on { background:#dcfce7; color:#166534; }
.oc-media { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; max-height:340px; overflow-y:auto; }
.oc-item { border:1px solid #e2e8f0; border-radius:8px; padding:6px; font-size:11px; background:#f8fafc; }
.oc-item.sel { border-color:#16a34a; background:#f0fdf4; }
.oc-item img, .oc-item video { width:100%; height:90px; object-fit:cover; border-radius:6px; display:block; }
.oc-item input[type=text] { font-size:11px !important; padding:4px 6px !important; margin-top:4px; }
.oc-check { display:flex !important; align-items:center; gap:6px; font-size:14px !important; color:#0f172a !important; margin-top:12px !important; }
.oc-btn { border:none; border-radius:10px; padding:10px 16px; font-size:14px; font-weight:700; cursor:pointer; color:#fff; background:#16a34a; }
.oc-btn.alt { background:#fff; color:#4338ca; border:1px solid #c4b5fd; }
.oc-upload { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px; }
.crm-mode-badge { display:inline-block; margin-left:6px; font-size:11px; padding:1px 7px; border-radius:9px; background:#ede9fe; color:#5b21b6; font-weight:700; }
@media (max-width:700px) { .oc-grid { grid-template-columns:1fr; } .oc-media { grid-template-columns:1fr 1fr; } }`;

const script = () => `
<script>
(function () {
    var OC = { media: [], sel: {}, day: null };
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function api(url, body) { var o = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}; return fetch(url, o).then(function (r) { return r.json(); }); }
    function toast(m, ok) { if (window.crmToast) window.crmToast(m, ok); else alert(m); }
    var RETIRED = /^(poster_sankalp|poster_vikas_infra|poster_statesman|poster_demo_test)/i;
    function renderMedia() {
        var el = document.getElementById('oc-media'); if (!el) return;
        var list = OC.media.filter(function (m) { return (m.type === 'image' || m.type === 'video') && !RETIRED.test(m.file) && !/^(baba_face|baba_33_transparent)/.test(m.file); });
        if (!list.length) { el.innerHTML = 'Media bank is empty — choose a file above.'; return; }
        el.innerHTML = list.map(function (m) {
            var s = OC.sel[m.file]; var url = '/media/' + encodeURIComponent(m.file);
            return '<div class="oc-item' + (s ? ' sel' : '') + '" data-f="' + esc(m.file) + '">' + (m.type === 'video' ? '<video src="' + url + '" muted preload="metadata"></video>' : '<img loading="lazy" src="' + url + '">') +
                '<label style="display:flex;gap:4px;align-items:center;margin:4px 0 0 0;font-size:11px;"><input type="checkbox" data-pick="1"' + (s ? ' checked' : '') + '> ' + esc(m.file.slice(0, 22)) + '</label>' +
                '<input type="text" data-cap="1" placeholder="Caption (optional)" value="' + esc(s ? s.caption : '') + '"></div>';
        }).join('');
    }
    function collect() {
        var out = []; var items = document.querySelectorAll('#oc-media .oc-item');
        for (var i = 0; i < items.length; i++) { var it = items[i]; var cb = it.querySelector('[data-pick]'); if (cb && cb.checked) out.push({ file: it.getAttribute('data-f'), caption: it.querySelector('[data-cap]').value }); }
        return out;
    }
    function load() {
        var date = document.getElementById('oc-date').value || '';
        return api('/api/control/day' + (date ? '?date=' + date : '')).then(function (d) {
            if (!d.success) return;
            var day = d.day || {}; OC.day = day;
            if (!document.getElementById('oc-date').value) document.getElementById('oc-date').value = d.today;
            document.getElementById('oc-default-mode').value = d.defaultMode;
            document.getElementById('oc-goal').value = day.goal || '';
            document.getElementById('oc-points').value = (day.points || []).join('\\n');
            document.getElementById('oc-steer').value = day.steerLine || '';
            document.getElementById('oc-locked').checked = !!day.locked;
            OC.sel = {}; (day.media || []).forEach(function (m) { OC.sel[m.file] = m; });
            var b = document.getElementById('oc-lock-badge'); b.textContent = d.locked ? '🔒 Locked today' : 'Not locked'; b.className = 'oc-badge' + (d.locked ? ' on' : '');
            document.getElementById('oc-history').innerHTML = (d.history || []).map(function (h) { return '<div style="padding:4px 0;border-bottom:1px solid #f1f5f9;"><b>' + esc(h.date) + '</b> ' + (h.locked ? '🔒' : '') + ' ' + esc(h.goal || '—') + (h.points && h.points.length ? ' • ' + h.points.length + ' points' : '') + (h.media && h.media.length ? ' • 📎' + h.media.length : '') + '</div>'; }).join('') || '—';
            return api('/api/media/list').then(function (m) { OC.media = (m && m.media) || []; renderMedia(); });
        }).catch(function (e) { toast('❌ ' + e.message, false); });
    }
    function save() {
        var body = { date: document.getElementById('oc-date').value, goal: document.getElementById('oc-goal').value, points: document.getElementById('oc-points').value, steerLine: document.getElementById('oc-steer').value, media: collect(), locked: document.getElementById('oc-locked').checked };
        api('/api/control/day', body).then(function (d) { if (d.success) { toast('✅ Saved — ' + (d.locked ? 'goal locked for today' : 'not locked'), true); load(); } else toast('❌ ' + (d.error || 'error'), false); });
        api('/api/control/default-mode', { mode: document.getElementById('oc-default-mode').value });
    }
    function upload(f) {
        var st = document.getElementById('oc-up-status');
        if (f.size > 45 * 1024 * 1024) { st.textContent = '❌ File is bigger than 45 MB'; return; }
        st.textContent = '⏳ Uploading…';
        var r = new FileReader();
        r.onload = function (ev) {
            api('/api/media/upload', { fileName: f.name, base64Data: ev.target.result }).then(function (d) {
                if (d.success) { st.textContent = '✅ ' + d.file; OC.sel[d.file] = { file: d.file, caption: '' }; return api('/api/media/list').then(function (m) { OC.media = (m && m.media) || []; renderMedia(); }); }
                st.textContent = '❌ ' + (d.error || 'upload failed');
            }).catch(function (e) { st.textContent = '❌ ' + e.message; });
        };
        r.readAsDataURL(f);
    }
    function fu() { api('/api/control/followups').then(function (d) { var el = document.getElementById('oc-fu'); if (el && d.success) el.textContent = 'Follow-ups on: ' + d.voters.length + ' voters' + (d.voters.length ? ' (' + d.voters.slice(0, 5).map(function (v) { return (v.name || v.phone) + ': ' + v.followup; }).join(', ') + ')' : ''); }); }
    function safeInit() { try { init(); } catch (e) { if (window.console) console.warn('lock tab init failed', e); } }
    document.addEventListener('DOMContentLoaded', safeInit); if (document.readyState !== 'loading') safeInit();
    var inited = false;
    function init() {
        if (inited || !document.getElementById('tab-lock')) return; inited = true;
        document.getElementById('oc-save').onclick = save;
        document.getElementById('oc-date').onchange = load;
        document.getElementById('oc-file').onchange = function () { if (this.files[0]) upload(this.files[0]); this.value = ''; };
        document.getElementById('oc-media').addEventListener('change', function (e) {
            var it = e.target.closest ? e.target.closest('.oc-item') : null; if (!it) return;
            if (e.target.getAttribute('data-pick')) { if (e.target.checked) { OC.sel[it.getAttribute('data-f')] = { file: it.getAttribute('data-f'), caption: '' }; it.classList.add('sel'); } else { delete OC.sel[it.getAttribute('data-f')]; it.classList.remove('sel'); } }
        });
        document.getElementById('oc-run-fu').onclick = function () { api('/api/control/followups/run', {}).then(function (d) { toast(d.success ? '✅ Follow-ups: ' + ((d.result && d.result.sent) || 0) + ' sent' : '❌ ' + (d.error || ''), !!d.success); fu(); }); };
        var b = document.getElementById('tab-btn-lock'); if (b) b.addEventListener('click', function () { load(); fu(); });
        if (typeof location !== 'undefined' && location.hash === '#lock') { load(); fu(); }
    }
})();
</script>`;

module.exports = { install, ui: { tabButtons, tabPanes, script, css } };
