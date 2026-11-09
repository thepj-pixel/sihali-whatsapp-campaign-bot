'use strict';
// Contact Studio (/send): pick contacts, edit names, make lists, write or AI-draft a message with {name}, add media,
// and schedule it through the safe scheduler (Primary only, ceilings enforced there). Prince, 9 Nov 2026.

module.exports = function register(app, { contactsManager, aiService }) {
    app.post('/api/studio/contact', (req, res) => {
        try {
            const b = req.body || {};
            const ph = contactsManager.cleanPhone(b.phone);
            const cur = ph && contactsManager.contacts.find(c => c.phone === ph);
            if (!cur) return res.status(404).json({ success: false, error: 'contact not found' });
            if (typeof b.name === 'string' && b.name.trim()) cur.name = b.name.trim().slice(0, 60);
            if (typeof b.addList === 'string' && b.addList.trim()) cur.tags = Array.from(new Set([...(cur.tags || []), b.addList.trim().slice(0, 40)]));
            if (typeof b.removeList === 'string') cur.tags = (cur.tags || []).filter(t => t !== b.removeList);
            cur.updatedAt = new Date().toISOString();
            contactsManager.save();
            res.json({ success: true, contact: { phone: cur.phone, name: cur.name, tags: cur.tags } });
        } catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });

    app.post('/api/studio/list', (req, res) => {
        try {
            const { phones = [], list } = req.body || {};
            const name = String(list || '').trim().slice(0, 40);
            if (!name) return res.status(400).json({ success: false, error: 'list name needed' });
            const set = new Set(phones.map(p => contactsManager.cleanPhone(p)).filter(Boolean));
            let n = 0;
            for (const c of contactsManager.contacts) if (set.has(c.phone)) { c.tags = Array.from(new Set([...(c.tags || []), name])); n++; }
            contactsManager.save();
            res.json({ success: true, tagged: n });
        } catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });

    app.post('/api/studio/ai-draft', async (req, res) => {
        try {
            const brief = String((req.body || {}).brief || '').slice(0, 400);
            if (!brief) return res.status(400).json({ success: false, error: 'brief needed' });
            const sys = 'You write short WhatsApp messages in Hindi (Devanagari) for अभय सिंह (मोटी आंगली वाले), sarpanch candidate of Gram Panchayat Sihali Khurd, speaking himself in first person (male). Never write "बाबा". Warm, village tone, 2-3 short lines, start with "राम राम {name} जी". No numbers, budgets, promises with dates, caste/religion, or attacks on anyone. Return exactly 3 variants separated by a line containing only ---';
            const out = await aiService.callLLMCascade(sys, [], brief, null, 15000);
            const text = typeof out === 'string' ? out : (out && (out.text || out.reply)) || '';
            const variants = text.split(/\n\s*-{3,}\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 3);
            res.json({ success: !!variants.length, variants });
        } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.get('/send', (req, res) => res.type('html').send(PAGE));
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contact Studio</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}header{background:#0f172a;color:#fff;padding:10px 14px;display:flex;gap:12px;align-items:center}header a{color:#93c5fd}
main{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;padding:12px}@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px}input,select,textarea,button{font:inherit;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px}button{background:#2563eb;color:#fff;border:0;cursor:pointer}button.g{background:#e2e8f0;color:#0f172a}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:4px 6px;border-bottom:1px solid #f1f5f9;text-align:left}td input.nm{width:95%;border:1px solid transparent}td input.nm:focus{border-color:#93c5fd}
.tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:10px;padding:0 6px;margin:1px;font-size:11px}#list{max-height:60vh;overflow:auto}textarea{width:100%;box-sizing:border-box}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}pre{white-space:pre-wrap;background:#f1f5f9;padding:8px;border-radius:6px;font-size:13px}</style></head><body>
<header><b>Contact Studio</b><a href="/">← Dashboard</a><span id="cnt"></span></header><main>
<section class="card"><div class="row"><input id="q" placeholder="Search name / number" style="flex:1"><select id="tag"><option value="all">All lists</option></select><button class="g" id="selall">Select shown</button><button class="g" id="clr">Clear</button></div>
<div class="row"><b>Small batch:</b> <input id="bs" type="number" value="5" min="1" max="10" style="width:50px"><button class="g" id="nextb">Pick next batch (not yet sent)</button><small>Choose a village list above, then pick 5. Sent people get list \"studio_sent\" and are skipped next time.</small></div>
<div class="row"><input id="newlist" placeholder="List name"><button class="g" id="mklist">Add selected to list</button><span id="selc">0 selected</span></div>
<div id="list"><table><thead><tr><th></th><th>Name (click to edit)</th><th>Number</th><th>Lists</th></tr></thead><tbody id="tb"></tbody></table></div></section>
<section class="card"><b>Message</b> <small>{name} is filled with each contact's name. Several messages = one per box, rotated.</small>
<div class="row"><input id="brief" placeholder="AI: what should it say? (e.g. Bhai Dooj wish + ask opinion)" style="flex:1"><button class="g" id="ai">AI draft</button></div>
<textarea id="m1" rows="4" placeholder="*मैं अभय सिंह बोल रहा हूँ* 🙏&#10;राम राम {name} जी, ..."></textarea><textarea id="m2" rows="3" placeholder="Variant 2 (optional)"></textarea><textarea id="m3" rows="3" placeholder="Variant 3 (optional)"></textarea>
<div class="row"><b>Media</b> <select id="media"><option value="">No media (text only)</option></select></div>
<div class="row">Start <input type="datetime-local" id="ws"> End <input type="datetime-local" id="we"></div>
<div class="row"><button class="g" id="prev">Preview</button><button id="go">Schedule send</button></div><small>Primary line only. Safe limits are enforced: max 20/hour, 40/day, 2.5–6 min gaps; people already messaged in 20 h are skipped.</small><pre id="out"></pre></section></main>
<script>
var C=[],SEL=new Set(),H={'content-type':'application/json'};
function j(u,b){return fetch(u,b?{method:'POST',headers:H,body:JSON.stringify(b),credentials:'same-origin'}:{credentials:'same-origin'}).then(function(r){return r.json()})}
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function shown(){var q=document.getElementById('q').value.toLowerCase(),t=document.getElementById('tag').value;return C.filter(function(c){return(t==='all'||(c.tags||[]).indexOf(t)>=0)&&(!q||(c.name||'').toLowerCase().indexOf(q)>=0||c.phone.indexOf(q)>=0)})}
function draw(){var s=shown(),h='';s.slice(0,600).forEach(function(c){h+='<tr><td><input type="checkbox" data-p="'+c.phone+'"'+(SEL.has(c.phone)?' checked':'')+'></td><td><input class="nm" data-p="'+c.phone+'" value="'+esc(c.name)+'"></td><td>'+c.phone+'</td><td>'+(c.tags||[]).map(function(t){return'<span class="tag">'+esc(t)+'</span>'}).join('')+'</td></tr>'});
document.getElementById('tb').innerHTML=h;document.getElementById('cnt').textContent=s.length+' shown of '+C.length+(s.length>600?' (first 600 listed, search to narrow)':'');document.getElementById('selc').textContent=SEL.size+' selected'}
function load(){j('/api/contacts').then(function(d){C=d.contacts||[];var ts={};C.forEach(function(c){(c.tags||[]).forEach(function(t){ts[t]=(ts[t]||0)+1})});var o='<option value="all">All lists</option>';Object.keys(ts).sort().forEach(function(t){o+='<option>'+esc(t)+'</option>'});var el=document.getElementById('tag'),v=el.value;el.innerHTML=o;el.value=v||'all';draw()})}
document.getElementById('tb').addEventListener('change',function(e){var p=e.target.getAttribute('data-p');if(!p)return;if(e.target.type==='checkbox'){e.target.checked?SEL.add(p):SEL.delete(p);draw()}else{j('/api/studio/contact',{phone:p,name:e.target.value}).then(function(d){var c=C.find(function(x){return x.phone===p});if(c&&d.contact)c.name=d.contact.name})}});
['q','tag'].forEach(function(i){document.getElementById(i).addEventListener('input',draw)});
document.getElementById('selall').onclick=function(){shown().forEach(function(c){SEL.add(c.phone)});draw()};document.getElementById('clr').onclick=function(){SEL.clear();draw()};document.getElementById('nextb').onclick=function(){var n=Math.max(1,Math.min(10,+document.getElementById('bs').value||5));SEL.clear();shown().filter(function(c){return(c.tags||[]).indexOf('studio_sent')<0}).slice(0,n).forEach(function(c){SEL.add(c.phone)});var st=new Date(Date.now()+2*60000);document.getElementById('ws').value=local(st);document.getElementById('we').value=local(new Date(st.getTime()+(n*6+5)*60000));draw();if(!SEL.size)alert('Is list mein sabko bhej diya gaya hai')};
document.getElementById('mklist').onclick=function(){var n=document.getElementById('newlist').value;if(!n||!SEL.size)return alert('Select contacts and type a list name');j('/api/studio/list',{phones:Array.from(SEL),list:n}).then(function(d){alert(d.tagged+' added to '+n);load()})};
document.getElementById('ai').onclick=function(){var b=document.getElementById('brief').value;if(!b)return;this.textContent='…';var self=this;j('/api/studio/ai-draft',{brief:b}).then(function(d){self.textContent='AI draft';(d.variants||[]).forEach(function(v,i){document.getElementById('m'+(i+1)).value=v});if(!d.success)alert('AI busy, write it yourself')})};
j('/api/media/list').then(function(d){var o='<option value="">No media (text only)</option>';(d.media||d.files||d||[]).forEach(function(m){if(!m.retired)o+='<option>'+esc(m.file)+'</option>'});document.getElementById('media').innerHTML=o});
function iso(v){return v?v+':00+05:30':''}
function local(d){var t=new Date(d.getTime()+330*60000);return t.toISOString().slice(0,16)}
var now=new Date(Date.now()+5*60000);document.getElementById('ws').value=local(now);document.getElementById('we').value=local(new Date(now.getTime()+3*3600000));
function payload(){var byP={};C.forEach(function(c){byP[c.phone]=c});var msgs=['m1','m2','m3'].map(function(i){return document.getElementById(i).value.trim()}).filter(Boolean);var m=document.getElementById('media').value;
return{name:'Studio '+new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),recipients:Array.from(SEL).map(function(p){var n=(byP[p]||{}).name||'';if(/^(ग्रामवासी|Contact \\d+|Voter \\d+)$/i.test(n))n='';return{phone:p,name:n}}),messages:msgs,mediaFiles:m?[m]:[],lines:['sim_636'],windowStart:iso(document.getElementById('ws').value),windowEnd:iso(document.getElementById('we').value),minGapSec:150,maxGapSec:360,contactCard:false}}
function show(d){var p=d.preview||d;var s=(d.success===false||p.ok===false)?'❌ '+((p.errors||[]).join('; ')||d.error):'';if(p.recipients!==undefined)s+='People: '+p.recipients+'  Skipped: '+(p.skipped||0)+' '+JSON.stringify(p.skippedByReason||{})+'\\n'+(p.warnings||[]).join('\\n')+'\\n\\n'+(p.samples||[]).slice(0,3).map(function(x){return x.at+' → '+x.text+(x.media?' ['+x.media+']':'')}).join('\\n\\n');if(d.campaign)s='✅ Scheduled '+d.campaign.id+' for '+(d.campaign.items||[]).length+' people';document.getElementById('out').textContent=s}
document.getElementById('prev').onclick=function(){if(!SEL.size)return alert('Select contacts');j('/api/scheduled/preview',payload()).then(show)};
document.getElementById('go').onclick=function(){if(!SEL.size)return alert('Select contacts');if(SEL.size>10&&!confirm(SEL.size+' is a big batch. Small batches of 5 are safer. Continue?'))return;if(!confirm('Schedule to '+SEL.size+' people?'))return;var ph=Array.from(SEL);j('/api/scheduled/create',payload()).then(function(d){show(d);if(d.campaign){j('/api/studio/list',{phones:ph,list:'studio_sent'}).then(function(){SEL.clear();load()})}})};
load();
</script></body></html>`;
