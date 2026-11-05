/**
 * CRM (WhatsApp Web Live) UI additions — 5 Nov 2026. Injected into the dashboard page by server.js.
 * Full scrollable chat (load older), Voter profile & memory panel (editable), AI co-pilot (suggest / try again /
 * one-click send), quick actions with clear feedback. ES5-safe, no optional chaining.
 */
function css() {
    return `
.wa-right { min-width: 0; overflow: hidden; }
.wa-wrapper { height: min(820px, calc(100vh - 40px)); min-height: 560px; }
.wa-chat-scroll { min-height: 0; overflow-x: hidden; overflow-y: auto; }
.wa-bubble { max-width: min(78%, 640px); overflow-wrap: anywhere; word-break: break-word; box-sizing: border-box; }
.wa-bubble img, .wa-bubble video { max-width: 100%; height: auto; }
.wa-header { min-width: 0; }
.wa-header > div { min-width: 0; }
#header-details { overflow-wrap: anywhere; }
.wa-quick-actions { flex-wrap: wrap; white-space: normal; overflow-x: visible; }
.wa-action-btn { white-space: nowrap; }
.crm-loadmore { align-self: center; background: #fff; border: 1px solid #cbd5e1; border-radius: 14px; padding: 5px 14px; font-size: 12px; font-weight: 700; color: #0369a1; cursor: pointer; }
.crm-count { align-self: center; font-size: 11px; color: #64748b; background: rgba(255,255,255,.7); padding: 2px 10px; border-radius: 10px; }
.crm-profile { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 10px 14px; max-height: 42vh; overflow-y: auto; }
.crm-profile h4 { margin: 0 0 6px 0; font-size: 13px; color: #0f172a; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.crm-pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 10px; }
.crm-pgrid label { font-size: 10.5px; font-weight: 700; color: #475569; display: block; }
.crm-pgrid input, .crm-pgrid select, .crm-profile textarea { width: 100%; box-sizing: border-box; padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; color: #0f172a; }
.crm-brief { background:#faf5ff; border:1px solid #e9d5ff; border-radius:8px; padding:8px; margin-top:8px; }
.crm-brief-h { font-size:11.5px; font-weight:800; color:#6b21a8; margin-bottom:4px; }
.crm-brief label { font-size:10.5px; font-weight:700; color:#475569; display:block; margin-top:4px; }
.crm-mode-badge { display:inline-block; margin-left:6px; font-size:11px; padding:1px 7px; border-radius:9px; background:#ede9fe; color:#5b21b6; font-weight:700; }
.crm-ro { font-size: 11.5px; color: #334155; background: #f1f5f9; border-radius: 6px; padding: 5px 8px; margin-top: 6px; overflow-wrap: anywhere; }
.crm-copilot { background: #f5f3ff; border-top: 1px solid #ddd6fe; padding: 8px 12px; display: none; flex-direction: column; gap: 6px; }
.crm-copilot-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.crm-copilot-row input { flex: 1 1 200px; min-width: 0; padding: 7px 10px; border-radius: 10px; border: 1px solid #c4b5fd; font-size: 12px; background: #fff; color: #0f172a; }
.crm-btn { border: none; border-radius: 10px; padding: 7px 12px; font-size: 12px; font-weight: 700; cursor: pointer; color: #fff; background: #6366f1; white-space: nowrap; }
.crm-btn.alt { background: #fff; color: #4338ca; border: 1px solid #c4b5fd; }
.crm-btn.go { background: #16a34a; }
.crm-btn:disabled { opacity: .6; cursor: wait; }
#crm-suggestion { width: 100%; box-sizing: border-box; min-height: 58px; padding: 8px 10px; border-radius: 10px; border: 1px solid #c4b5fd; font-size: 13px; background: #fff; color: #0f172a; resize: vertical; }
.crm-toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 9999; padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 700; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.2); max-width: 92vw; }
.crm-modal-bg { position: fixed; inset: 0; background: rgba(15,23,42,.45); z-index: 9998; display: flex; align-items: center; justify-content: center; padding: 12px; }
.crm-modal { background: #fff; border-radius: 12px; padding: 14px; width: min(440px, 100%); box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.crm-modal h4 { margin: 0 0 8px 0; font-size: 14px; }
.crm-modal input, .crm-modal textarea { width: 100%; box-sizing: border-box; margin: 4px 0 8px 0; padding: 8px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; }
@media (max-width: 700px) {
  .wa-wrapper { height: auto; min-height: 0; }
  .wa-right { width: 100%; }
  .wa-chat-scroll { height: 62vh; max-height: 62vh; flex: none; padding: 12px; }
  .wa-bubble { max-width: 88%; }
  .wa-quick-actions { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px; }
  .wa-quick-actions .wa-action-btn { white-space: normal; min-height: 44px; }
  .crm-pgrid { grid-template-columns: 1fr 1fr !important; }
}`;
}

function script() {
    return `
<script>
(function () {
    var CRM = { phone: null, start: 0, total: 0, attempt: 0, exclude: [], profile: null, actions: null, polling: false };
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function toast(msg, ok) {
        var t = document.createElement('div'); t.className = 'crm-toast'; t.style.background = ok ? '#16a34a' : '#dc2626'; t.textContent = msg;
        document.body.appendChild(t); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ok ? 3200 : 6000);
    }
    window.crmToast = toast;
    function api(url, body) {
        var o = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
        return fetch(url, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); });
    }
    function bubble(h) {
        var name = (typeof currentVoterData !== 'undefined' && currentVoterData && currentVoterData.name) || 'Voter';
        var cls = 'wa-bubble-user', who = '👤 ' + name;
        if (h.role === 'bot') {
            if (h.session === 'Admin Direct' || h.session === 'Admin Manual' || h.session === 'Admin Quick Action') { cls = 'wa-bubble-admin'; who = '👨‍💻 Admin (' + (h.session || '') + ')'; }
            else { cls = 'wa-bubble-bot'; who = '🚩 Abhay Singh team (bot)'; }
        }
        var media = '';
        if (h.mediaUrl) media = '<div style="margin-top:6px;"><img src="' + esc(h.mediaUrl) + '" style="max-width:220px;max-height:220px;border-radius:8px;border:1px solid #cbd5e1;display:block;"></div>';
        else if (h.mediaType === 'poster' || h.mediaType === 'customPoster') media = '<div style="margin-top:6px;"><img src="/media/poster.jpg" style="max-width:200px;border-radius:8px;border:1px solid #cbd5e1;display:block;"></div>';
        return '<div class="wa-bubble ' + cls + '"><div style="font-size:10px;font-weight:700;opacity:.8;margin-bottom:3px;">' + esc(who) + '</div>' +
            '<div style="white-space:pre-wrap;">' + esc(h.text) + '</div>' + media +
            '<div class="wa-bubble-meta"><span>' + (h.mediaType ? '📎 ' + esc(h.mediaType) : '') + '</span><span>' + esc(h.time || '') + '</span></div></div>';
    }
    function loadChat(phone, older) {
        var url = '/api/crm/chat/' + encodeURIComponent(phone) + '?limit=200' + (older ? '&before=' + CRM.start : '');
        return api(url).then(function (d) {
            if (!d.success || CRM.phone !== phone) return;
            var box = document.getElementById('wa-chat-scroll'); if (!box) return;
            var html = d.messages.map(bubble).join('');
            var head = (d.hasMore ? '<button class="crm-loadmore" id="crm-loadmore" type="button">⬆️ Older messages (' + d.start + ')</button>' : '<div class="crm-count">Full chat • ' + d.total + ' messages</div>');
            if (older) {
                var oldH = box.scrollHeight;
                var lm = document.getElementById('crm-loadmore'); if (lm) lm.parentNode.removeChild(lm);
                var cnt = box.querySelector('.crm-count'); if (cnt) cnt.parentNode.removeChild(cnt);
                box.insertAdjacentHTML('afterbegin', head + html);
                box.scrollTop = box.scrollHeight - oldH;
            } else {
                if (!d.total) { box.innerHTML = '<div style="text-align:center;color:#94a3b8;margin-top:120px;">No messages with this voter yet.</div>'; }
                else { box.innerHTML = head + html; box.scrollTop = box.scrollHeight; }
                CRM.total = d.total;
            }
            CRM.start = d.start;
            var b = document.getElementById('crm-loadmore'); if (b) b.onclick = function () { loadChat(phone, true); };
        }).catch(function (e) { toast('Chat did not load: ' + e.message, false); });
    }
    function pollChat() {
        if (!CRM.phone) return;
        var tab = document.getElementById('tab-voters'); if (!tab || tab.style.display === 'none') return;
        api('/api/crm/chat/' + encodeURIComponent(CRM.phone) + '?limit=1').then(function (d) {
            if (d.success && d.total !== CRM.total) {
                var box = document.getElementById('wa-chat-scroll');
                var nearBottom = box && (box.scrollHeight - box.scrollTop - box.clientHeight < 120);
                if (nearBottom) loadChat(CRM.phone, false); else CRM.total = d.total;
            }
        }).catch(function () {});
    }
    setInterval(pollChat, 8000);

    // ---------- profile & memory ----------
    var F = [['name', 'Name'], ['relName', 'Father / husband'], ['ward', 'Ward'], ['booth', 'Booth (auto)', 1], ['gender', 'Gender (M/F)'], ['age', 'Age'], ['stance', 'Stance'], ['familyVotes', 'Family votes'], ['interests', 'Interests / issues'], ['scriptPref', 'Reply script']];
    var MODEL = { normal: '⚖️ Normal', aggressive: '🔥 Assertive', chill: '😌 Relaxed', gentle: '🕊️ Gentle (virodhi)' };
    function sel(k, label, opts, v) { return '<div><label>' + label + '</label><select data-pf="' + k + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (v === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>'; }
    function modeBadge(p) {
        var hd = document.getElementById('header-details'); if (!hd || !p) return;
        var b = document.getElementById('crm-mode-badge');
        if (!b) { b = document.createElement('span'); b.id = 'crm-mode-badge'; b.className = 'crm-mode-badge'; hd.parentNode.insertBefore(b, hd.nextSibling); }
        b.textContent = (MODEL[p.effectiveMode] || p.effectiveMode || '') + (p.about || p.style ? ' • 🔐 Brief' : '') + (p.followup && p.followup !== 'off' ? ' • 🔁 ' + (p.followup === 'daily' ? 'daily' : 'every 2 days') : '');
    }
    window.crmModeBadge = modeBadge;
    function renderProfile(p) {
        modeBadge(p);
        var el = document.getElementById('crm-profile-panel'); if (!el) return;
        var g = F.map(function (f) {
            if (f[0] === 'scriptPref') {
                var so = [['', '— (default: Hindi)'], ['hindi', 'Hindi (Devanagari)'], ['hinglish', 'Hinglish (Roman)']];
                return '<div><label>' + f[1] + '</label><select data-pf="scriptPref">' + so.map(function (o) { return '<option value="' + o[0] + '"' + ((p.scriptPref || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
            }
            if (f[0] === 'stance') {
                var opts = [['unknown', '⚪ Unknown'], ['undecided', '🟡 Undecided'], ['leaning', '🟢 Leaning'], ['committed', '✅ Committed (sure)'], ['opposed', '🔴 Opposed']];
                return '<div><label>' + f[1] + '</label><select data-pf="stance">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (p.stance === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
            }
            return '<div><label>' + f[1] + '</label><input data-pf="' + f[0] + '" value="' + esc(p[f[0]]) + '"' + (f[2] ? ' readonly style="background:#eef2f7"' : '') + '></div>';
        }).join('');
        var sam = (p.samasya || []).map(function (s) { return '📝 ' + esc(s.id) + ' [' + esc(s.status) + '] ' + esc(s.category || '') + ': ' + esc((s.description || '').slice(0, 90)); }).join('<br>') || '—';
        var mul = (p.mulaqat || []).map(function (m) { return '🤝 ' + esc(m.id) + ' [' + esc(m.status) + '] ' + esc(m.when || '') + ' ' + esc(m.place || '') + ' ' + esc(m.purpose || ''); }).join('<br>') || '—';
        el.innerHTML = '<h4><span>🧾 Voter profile & memory' + (p.optedOut ? ' <span style="color:#dc2626">• STOP</span>' : '') + '</span>' +
            '<span><button class="crm-btn go" type="button" id="crm-profile-save">💾 Save</button> <button class="crm-btn alt" type="button" id="crm-profile-close">✕</button></span></h4>' +
            '<div class="crm-pgrid">' + g + '</div>' +
            '<div class="crm-brief"><div class="crm-brief-h">🔐 Private brief — the bot will never tell this to the voter, it only uses it to guide how it talks</div>' +
            '<label>About this person (who they are, relations, history, worries)</label><textarea data-pf="about" rows="3" placeholder="e.g. retired soldier, son is looking for a job in Jaipur, was upset about the road last time">' + esc(p.about) + '</textarea>' +
            '<label>How to talk to them</label><textarea data-pf="style" rows="2" placeholder="e.g. talk like a younger brother, ask about the son job hunt, do not mention the road">' + esc(p.style) + '</textarea>' +
            '<div class="crm-pgrid" style="margin-top:6px;">' +
            sel('mode', 'Mode', [['', '— Default (' + (MODEL[p.defaultMode] || p.defaultMode || 'Normal') + ')'], ['normal', MODEL.normal], ['aggressive', MODEL.aggressive], ['chill', MODEL.chill], ['gentle', MODEL.gentle]], p.mode || '') +
            sel('voteAsk', 'How often to ask for the vote', [['auto', 'Based on mode'], ['every', 'In every reply'], ['every2', 'Every 2-3 replies'], ['rarely', 'Rarely']], p.voteAsk || 'auto') +
            sel('followup', 'Follow-up', [['off', 'Off'], ['daily', 'Daily (once)'], ['every2days', 'Every 2 days']], p.followup || 'off') +
            '</div></div>' +
            '<label style="font-size:10.5px;font-weight:700;color:#475569;display:block;margin-top:6px;">Operator notes (private — the bot will never tell)</label><textarea data-pf="notes" rows="2">' + esc(p.notes) + '</textarea>' +
            '<div class="crm-ro"><b>Family:</b> ' + esc(p.family || '—') + ' • <b>Village:</b> ' + esc(p.village || '—') + ' • <b>Line:</b> ' + esc(p.line || '—') + '<br><b>Last promise / stance:</b> ' + esc(p.commitment || '—') + '<br><b>Summary:</b> ' + esc(p.summary || '—') + '</div>' +
            '<div class="crm-ro"><b>Problems (samasya):</b><br>' + sam + '</div><div class="crm-ro"><b>Meeting requests (mulaqat):</b><br>' + mul + '</div>' +
            '<div style="font-size:10.5px;color:#64748b;margin-top:4px;">' + (p.editedBy ? 'Last edited by: ' + esc(p.editedBy) : 'Filled automatically from chats & memory') + '</div>';
        document.getElementById('crm-profile-save').onclick = saveProfile;
        document.getElementById('crm-profile-close').onclick = function () { el.style.display = 'none'; };
    }
    function loadProfile(phone) {
        return api('/api/crm/profile/' + encodeURIComponent(phone)).then(function (d) { if (d.success && CRM.phone === phone) { CRM.profile = d.profile; renderProfile(d.profile); } });
    }
    function saveProfile() {
        if (!CRM.phone) return;
        var body = {}; var els = document.querySelectorAll('#crm-profile-panel [data-pf]');
        for (var i = 0; i < els.length; i++) { var k = els[i].getAttribute('data-pf'); if (k !== 'booth') body[k] = els[i].value; }
        api('/api/crm/profile/' + encodeURIComponent(CRM.phone), body).then(function (d) {
            if (d.success) { renderProfile(d.profile); toast('✅ Profile saved — bot memory updated', true); if (typeof loadVoters === 'function') loadVoters(); }
            else toast('❌ Not saved: ' + (d.error || d._status), false);
        }).catch(function (e) { toast('❌ ' + e.message, false); });
    }
    window.crmToggleProfile = function () {
        var el = document.getElementById('crm-profile-panel'); if (!el) return;
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
        if (el.style.display === 'block' && CRM.phone) loadProfile(CRM.phone);
    };

    // ---------- co-pilot ----------
    function suggest(again) {
        if (!CRM.phone) return;
        var btn = document.getElementById('crm-cp-suggest'), btn2 = document.getElementById('crm-cp-again');
        var box = document.getElementById('crm-suggestion'), info = document.getElementById('crm-cp-info');
        if (again && box.value.trim()) CRM.exclude.push(box.value.trim());
        CRM.attempt = again ? CRM.attempt + 1 : 0;
        if (!again) CRM.exclude = [];
        btn.disabled = true; btn2.disabled = true; info.textContent = '⏳ Reading the full chat & memory to make a suggestion...';
        var instr = document.getElementById('wa-ai-instruction');
        api('/api/crm/copilot', { phone: CRM.phone, attempt: CRM.attempt, exclude: CRM.exclude, instruction: instr ? instr.value.trim() : '' }).then(function (d) {
            if (d.success && d.text) { box.value = d.text; box.style.display = 'block'; document.getElementById('crm-cp-actions').style.display = 'flex'; info.textContent = '✔ Suggestion (' + (d.source || '') + ') • voter last message: "' + String(d.basedOn || '').slice(0, 60) + '"' + (d.note ? ' • ' + d.note : ''); }
            else { info.textContent = ''; toast('❌ Could not make a suggestion: ' + (d.error || d._status), false); }
        }).catch(function (e) { info.textContent = ''; toast('❌ ' + e.message, false); })
          .then(function () { btn.disabled = false; btn2.disabled = false; });
    }
    function sendSuggestion() {
        var box = document.getElementById('crm-suggestion'); var text = box.value.trim();
        if (!CRM.phone || !text) return;
        var b = document.getElementById('crm-cp-send'); b.disabled = true;
        api('/api/send-message', { phone: CRM.phone, template: 'custom', customText: text, lineId: (CRM.profile && CRM.profile.line) || undefined }).then(function (d) {
            if (d._ok && d.success !== false) { toast('✅ Sent', true); box.value = ''; box.style.display = 'none'; document.getElementById('crm-cp-actions').style.display = 'none'; document.getElementById('crm-cp-info').textContent = ''; CRM.exclude = []; setTimeout(function () { loadChat(CRM.phone, false); }, 700); }
            else toast('❌ Not sent: ' + (d.error || d._status), false);
        }).catch(function (e) { toast('❌ ' + e.message, false); }).then(function () { b.disabled = false; });
    }
    window.crmSuggest = suggest; window.crmSendSuggestion = sendSuggestion;
    window.generateAIDraft = function () { suggest(false); };

    // ---------- quick actions ----------
    function modal(title, fields, cb) {
        var bg = document.createElement('div'); bg.className = 'crm-modal-bg';
        bg.innerHTML = '<div class="crm-modal"><h4>' + esc(title) + '</h4>' + fields.map(function (f) {
            if (f.type === 'check') return '<label style="font-size:13px;display:block;margin:4px 0 10px 0;"><input type="checkbox" data-mf="' + f.k + '" ' + (f.v ? 'checked' : '') + ' style="width:auto;margin-right:6px;">' + esc(f.label) + '</label>';
            return '<label style="font-size:12px;font-weight:700;color:#475569;">' + esc(f.label) + '</label>' + (f.area ? '<textarea rows="3" data-mf="' + f.k + '">' + esc(f.v || '') + '</textarea>' : '<input data-mf="' + f.k + '" value="' + esc(f.v || '') + '">');
        }).join('') + '<div style="display:flex;gap:8px;justify-content:flex-end;"><button class="crm-btn alt" type="button" data-x="0">Cancel</button><button class="crm-btn go" type="button" data-x="1">✔ OK</button></div></div>';
        document.body.appendChild(bg);
        bg.addEventListener('click', function (e) {
            var x = e.target.getAttribute && e.target.getAttribute('data-x'); if (x === null || x === undefined) return;
            var out = {}; var els = bg.querySelectorAll('[data-mf]');
            for (var i = 0; i < els.length; i++) out[els[i].getAttribute('data-mf')] = els[i].type === 'checkbox' ? els[i].checked : els[i].value;
            document.body.removeChild(bg); if (x === '1') cb(out);
        });
    }
    var LABEL = { contact_card: '📇 Contact card', ramram: '🙏 Ram Ram', poster: '📸 Poster', demo_poster: '📸 Poster', video: '📹 Video', slip: '🎫 Slip (parchi)', baba_register: '📝 Register', meeting: '🤝 Meeting (mulaqat)' };
    function run(action, extra) {
        var body = { phone: CRM.phone, action: action, lineId: (CRM.profile && CRM.profile.line) || undefined };
        for (var k in (extra || {})) body[k] = extra[k];
        var btns = document.querySelectorAll('#wa-quick-actions .wa-action-btn'); for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
        return api('/api/quick-action', body).then(function (d) {
            if (d._ok && d.success) {
                var msg = '✅ ' + (LABEL[action] || action) + ': ' + (d.sent ? 'sent' : 'recorded') + (d.record && d.record.id ? ' (' + d.record.id + ')' : '') + (d.record && d.record.slipStep && d.record.slipStep !== 'deliver' ? ' — asked the voter to confirm (' + d.record.slipStep + ')' : '');
                toast(msg, true); setTimeout(function () { loadChat(CRM.phone, false); if (document.getElementById('crm-profile-panel').style.display !== 'none') loadProfile(CRM.phone); }, 600);
            } else toast('❌ ' + (LABEL[action] || action) + ': ' + (d.error || ('HTTP ' + d._status)), false);
        }).catch(function (e) { toast('❌ ' + e.message, false); })
          .then(function () { for (var i = 0; i < btns.length; i++) btns[i].disabled = false; });
    }
    window.sendQuickAction = function (action) {
        if (!CRM.phone) { toast('First open a chat from the left side', false); return; }
        if (action === 'demo_poster') action = 'poster';
        if (action === 'baba_register') return modal('📝 Add a problem to Baba register', [{ k: 'note', label: 'Problem (what, where)', area: true, v: '' }, { k: 'place', label: 'Place / street (optional)' }, { k: 'send', type: 'check', label: 'Also send the voter a "we have noted it" message', v: true }], function (o) { if (!o.note.trim()) return toast('Write the problem', false); run('baba_register', o); });
        if (action === 'meeting') return modal('🤝 Record a chaupal meeting', [{ k: 'when', label: 'When (e.g. tomorrow 5 pm)' }, { k: 'place', label: 'Where (home / chaupal / street)' }, { k: 'purpose', label: 'Purpose' }, { k: 'send', type: 'check', label: 'Also send the voter a confirmation message', v: true }], function (o) { run('meeting', o); });
        if (action === 'slip') return modal('🎫 Voter slip (parchi)', [{ k: 'name', label: 'Name (leave empty to use the name from the chat)', v: (CRM.profile && CRM.profile.name) || '' }], function (o) { run('slip', o.name ? { name: o.name } : {}); });
        if (action === 'poster' || action === 'video') {
            var c = window.confirm('Send the approved ' + (action === 'poster' ? 'poster' : 'video') + ' to this voter?'); if (!c) return;
        }
        run(action, {});
    };
    function refreshActions() {
        return api('/api/crm/actions').then(function (d) {
            if (!d.success) return; CRM.actions = d;
            var v = document.getElementById('qa-video'); if (v) v.style.display = d.actions.video ? '' : 'none';
            var p = document.getElementById('qa-poster'); if (p) p.style.display = d.actions.poster ? '' : 'none';
        }).catch(function () {});
    }

    // ---------- open a chat ----------
    var orig = window.selectVoter;
    window.selectVoter = function (phone) {
        var first = CRM.phone !== phone;
        CRM.phone = phone;
        if (first) {
            CRM.attempt = 0; CRM.exclude = []; CRM.profile = null;
            var sb = document.getElementById('crm-suggestion'); if (sb) { sb.value = ''; sb.style.display = 'none'; }
            var ca = document.getElementById('crm-cp-actions'); if (ca) ca.style.display = 'none';
            var ci = document.getElementById('crm-cp-info'); if (ci) ci.textContent = '';
        }
        var p = typeof orig === 'function' ? orig(phone) : null;
        return Promise.resolve(p).then(function () {
            var cp = document.getElementById('wa-copilot-container'); if (cp) cp.style.display = 'flex';
            loadChat(phone, false);
            loadProfile(phone);
            if (!CRM.actions) refreshActions();
        });
    };
    // demo poster badge shows the real state (it can only be ON when the VM env allows it)
    api('/api/demo-poster-status').then(function (d) {
        var b = document.getElementById('demo-mode-badge'); if (!b) return;
        b.textContent = d.demoMode ? '📸 Demo poster mode: ON' : '🖼️ Approved poster mode (demo off)';
        if (!d.demoMode) { b.style.background = '#e0f2fe'; b.style.color = '#0284c7'; b.style.borderColor = '#0284c7'; }
    }).catch(function () {});
    refreshActions();
})();
</script>`;
}

module.exports = { css, script };
