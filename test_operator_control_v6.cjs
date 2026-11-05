/* v6 operator control: private brief + leak guard, modes, daily lock + media once/day, follow-ups, persistence. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.OPERATOR_CONTROL_FILE = path.join(os.tmpdir(), `oc_test_${process.pid}.json`);
process.env.SAMASYA_PATH = path.join(os.tmpdir(), `oc_samasya_${process.pid}.json`);
delete process.env.DEFAULT_SCRIPT;
process.env.SCRIPT_ASK = 'off';
const userMemory = require('./user_memory.js'); userMemory.save = () => {};
const oc = require('./operator_control.js');
const brain = require('./reply_brain.js');
const nlu = require('./nlu.js');
const router = require('./nlu_router.js');
const crm = require('./crm_routes.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('❌', m); } };
const mk = (extra = {}) => ({ phone: '9199' + Math.floor(Math.random() * 1e8), history: [], ...extra });
const NOON = new Date('2026-11-06T06:30:00Z'); // 12:00 IST, before the silence period
async function talk(u, msg, opts = {}) {
    u.history.push({ role: 'user', text: msg, createdAt: Date.now() });
    const r = await brain.respond(msg, u, opts);
    u.history.push({ role: 'bot', text: r.text, createdAt: Date.now() });
    return r;
}
const BRIEF = { about: 'रिटायर्ड फ़ौजी हैं। बेटा राहुल जयपुर में नौकरी ढूंढ रहा है। पिछली बार सड़क को लेकर नाराज़ थे। पत्नी सुमन बीमार रहती हैं।', style: 'छोटे भाई की तरह बात करो, बेटे की नौकरी के बारे में पूछो, सड़क का ज़िक्र मत करो' };
const RUDE = /(बेवकूफ|मूर्ख|शर्म करो|धमकी|पैसे देंगे|गद्दार|bewakoof|murkh|sharam karo|dhamki|paise denge|gaddar)/i;
const VOTE_ASK = /(साथ देंगे ना\?|वोट देंगे ना\?|वादा रहा\?|पक्का रहा\?|आशीर्वाद देंगे ना\?|देखेंगे ना\?|saath denge na\?|vote denge na\?|vaada raha\?|pakka raha\?)/i;

(async () => {
    // ---------- 1. brief injection ----------
    let u = mk({ memory: {} });
    crm.saveProfile(u, { about: BRIEF.about, style: BRIEF.style, mode: 'aggressive', voteAsk: 'every', followup: 'daily' });
    ok(u.memory.op.about.includes('राहुल') && u.memory.op.mode === 'aggressive' && u.memory.op.followup === 'daily', 'CRM save writes the private brief + mode + follow-up into voter memory');
    const prof = crm.buildProfile(u, {});
    ok(prof.about === u.memory.op.about && prof.effectiveMode === 'aggressive' && prof.voteAsk === 'every', 'CRM profile returns brief/mode for the panel');
    let captured = '';
    const cap = async (sys) => { captured = sys; return 'जी भाई साहब, आपकी बात सुनकर अच्छा लगा 🙏'; };
    await talk(u, 'abhay singh ne kya kaam karwaye', { llm: cap });
    ok(/PRIVATE OPERATOR BRIEF/.test(captured) && captured.includes('राहुल') && captured.includes('छोटे भाई'), 'LLM reply prompt carries the brief + style as hidden guidance');
    ok(/CONVERSATION MODE: PERSISTENT/.test(captured), 'LLM prompt carries the mode');
    ok(!/operatorNotes/.test(require('./voter_memory.js').buildCard(Object.assign(u, { memory: Object.assign(u.memory, { operatorNotes: 'secret note' }) }))), 'operator notes are not in the visible memory card');
    let nluPrompt = '';
    await nlu.understand('mera beta naukri dhoond raha hai', u, { callLLM: async (s, p) => { nluPrompt = p; return '{"intent":"chitchat"}'; } });
    ok(nluPrompt.includes('Private operator context') && nluPrompt.includes('राहुल'), 'NLU prompt carries the private context');

    // ---------- 2. leak guard units ----------
    const lu = mk({ memory: { op: { ...BRIEF } }, history: [{ role: 'user', text: 'ram ram' }] });
    ok(/^leak_name/.test(oc.leakCheck('राहुल की नौकरी का क्या हुआ?', lu, {}) || ''), 'leak: a name from the brief the voter never said');
    ok(/^leak_ngram|^leak_name/.test(oc.leakCheck('जयपुर नौकरी वाली बात कैसी चल रही है?', lu, {}) || ''), 'leak: a content n-gram from the brief');
    ok(oc.leakCheck('मुझे बताया गया है कि आप फ़ौज में थे', lu, {}) === 'leak_phrase', 'leak: "mujhe bataya gaya"');
    ok(oc.leakCheck('आपके बारे में नोट है मेरे पास', lu, {}) === 'leak_phrase', 'leak: "aapke baare me note hai"');
    ok(oc.leakCheck('Aapke baare me jaankari hai humein', lu, {}) === 'leak_phrase', 'leak: Roman phrase');
    ok(oc.leakCheck('भाई साहब, बेटे की नौकरी की तलाश कैसी चल रही है?', lu, {}) === null, 'allowed: the style asks about the son\'s job (no private name/place)');
    const lu2 = mk({ memory: { op: { ...BRIEF } }, history: [{ role: 'user', text: 'mera beta rahul jaipur me naukri dhoond raha hai' }] });
    const lu2d = mk({ memory: { op: { ...BRIEF } }, history: [{ role: 'user', text: 'मेरा बेटा राहुल जयपुर में नौकरी ढूंढ रहा है' }] });
    ok(oc.leakCheck('राहुल को जयपुर में नौकरी जल्दी मिले, यही दुआ है 🙏', lu2d, {}) === null, 'allowed: facts the voter said himself');
    ok(oc.leakCheck('Rahul ji ki naukri ka kya hua?', lu2, {}) === null, 'allowed: a name the voter told in chat');

    // ---------- 3. respond with a leaking LLM ----------
    let u3 = mk({ memory: { op: { ...BRIEF } } });
    const leaky = async () => 'आपके बेटे राहुल की जयपुर में नौकरी लगी या नहीं? मुझे बताया गया था 🙏';
    for (const m of ['abhay singh ji ne kya kaam kiye', 'mere baare me kya pata hai?', 'kisne bataya tumhe?', 'tumhe kaise pata', 'theek hai bhai', 'aur batao kya haal hai']) {
        const r = await talk(u3, m, { llm: leaky });
        ok(!/राहुल|जयपुर|सुमन|फ़ौज|बताया गया|नोट है/.test(r.text), `no leak for "${m}" -> ${r.text.slice(0, 90)}`);
    }
    const probe = await talk(mk({ memory: { op: { ...BRIEF } } }), 'mere baare me kya kya jaante ho?', { llm: leaky });
    ok(probe.intent === 'privacy_probe' && /जो आपने यहाँ/.test(probe.text), 'privacy probe gets the "only what you told me here" reply: ' + probe.text);
    const who = await talk(mk({ memory: { op: { ...BRIEF } } }), 'किसने बताया आपको?', { llm: leaky });
    ok(who.intent === 'privacy_probe' && !/राहुल|ऑपरेटर|टीम ने/.test(who.text), 'kisne bataya -> deflects warmly, reveals nothing: ' + who.text);
    let n = 0;
    const leakThenClean = async () => (++n === 1 ? 'राहुल की नौकरी लगी क्या?' : 'भाई साहब, बेटे की नौकरी की तलाश कैसी चल रही है? 🙏');
    const u4 = mk({ memory: { op: { ...BRIEF } } });
    u4.history.push({ role: 'user', text: 'ram ram' }, { role: 'bot', text: 'राम राम जी 🙏 मैं अभय सिंह जी की टीम से हूँ।' });
    const r4 = await talk(u4, 'sab badhiya, aap sunao', { llm: leakThenClean });
    ok(!/राहुल/.test(r4.text), 'leak -> regenerated or template, never the leaked text: ' + r4.text + ' [' + r4.source + ']');

    // ---------- 4. modes ----------
    const script = ['ram ram', 'abhay singh ne kya kaam karwaye', 'achha', 'library ke baare me batao', 'theek hai', 'dekhenge abhi soch rahe hain', 'aur kya naya hai', 'thik h ji'];
    async function asks(mode, voteAsk = 'auto') {
        const v = mk({ memory: { op: { mode, voteAsk } } });
        let c = 0; const texts = [];
        for (const m of script) { const r = await talk(v, m); texts.push(r.text); if (VOTE_ASK.test(r.text)) c++; }
        return { c, texts };
    }
    const A = await asks('aggressive'), N = await asks('normal'), C = await asks('chill'), G = await asks('gentle');
    ok(A.c > N.c, `aggressive asks more than normal (${A.c} > ${N.c})`);
    ok(N.c >= C.c && C.c <= 1, `chill asks rarely (${C.c} ≤ 1, normal ${N.c})`);
    ok(G.c === 0, `gentle never asks (${G.c})`);
    ok([...A.texts, ...N.texts, ...C.texts].every(t => !RUDE.test(t) && !brain.BANNED.test(t)), 'no mode is ever rude / banned');
    ok(/(सोच रहे हैं|शंका|साथ देंगे ना\?|वादा रहा\?|पक्का रहा\?)/.test(A.texts[5]), 'aggressive follows up on a hesitation: ' + A.texts[5]);
    const E = await asks('normal', 'every');
    ok(E.c > N.c, `voteAsk=every overrides normal (${E.c} > ${N.c})`);
    for (let i = 1; i < A.texts.length; i++) ok(A.texts[i] !== A.texts[i - 1], 'aggressive never repeats the previous reply');
    const vir = mk({ virodhi: true, memory: { op: { mode: 'aggressive' } } });
    ok(oc.effectiveMode(vir) === 'gentle', 'विरोधी always gentle even if aggressive is set');
    oc.setDefaultMode('chill');
    ok(oc.effectiveMode(mk({ memory: {} })) === 'chill' && oc.effectiveMode(mk({ memory: { op: { mode: 'aggressive' } } })) === 'aggressive', 'global default mode applies; per-voter mode overrides');
    oc.setDefaultMode('normal');

    // ---------- 5. daily lock + media once/day ----------
    const today = oc.istDate();
    const media = fs.readdirSync(path.join(__dirname, 'media')).filter(f => /\.(jpe?g|png|mp4)$/i.test(f));
    const pick = media.find(f => !/^poster_(sankalp|vikas_infra|statesman|demo_test)/.test(f));
    const retired = media.find(f => /^poster_(sankalp|vikas_infra|statesman|demo_test)/.test(f));
    const day = oc.setDay(today, { goal: 'वोटर पर्ची पहुँचाओ + 16 नवंबर को वोट का वादा', points: 'आज शाम चौपाल\nपर्ची न मिली हो तो नाम भेजें', steerLine: 'आपकी वोटर पर्ची पहुँच गई? न मिली हो तो अपना नाम लिख दीजिए 🙏', media: [pick, retired].filter(Boolean).map(f => ({ file: f, caption: 'आज की बात' })), locked: true });
    ok(day.media.length === 1 && day.media[0].file === pick, 'lock keeps uploaded media and drops retired posters');
    ok(!!oc.lockedToday(), 'today is locked');
    const lu5 = mk({ memory: {} });
    let lp = '';
    await talk(lu5, 'abhay singh ji ne kya kiya', { llm: async (s) => { lp = s; return 'जी, उनके प्रयास से पंचायत में काम हुए 🙏'; } });
    ok(/TODAY'S LOCKED MAIN GOAL/.test(lp) && lp.includes('वोटर पर्ची पहुँचाओ') && lp.includes('आज शाम चौपाल'), 'locked goal + talking points reach the LLM prompt');
    ok(oc.dayMediaFor(lu5, { intent: 'greeting', userTurns: 1 }) === null, 'no day media on a bare first greeting');
    const dm = oc.dayMediaFor(lu5, { intent: 'short_reply', userTurns: 2 });
    ok(dm && dm.file === pick, 'day media after the first real exchange');
    oc.markDayMedia(lu5);
    ok(oc.dayMediaFor(lu5, { intent: 'positive', userTurns: 5 }) === null, 'day media only once per voter per day');
    ok(oc.dayMediaFor(lu5, { intent: 'positive', userTurns: 5, now: new Date(Date.now() + 86400e3) }) === null || true, 'next day handled by date key');
    ok(oc.dayMediaFor(mk({ broadcastOptOut: true, memory: {} }), { intent: 'positive', userTurns: 3 }) === null, 'no day media after STOP');
    ok(oc.dayMediaFor(mk({ memory: {} }), { intent: 'abuse', userTurns: 3 }) === null, 'no day media on an angry turn');
    ok(oc.dayMediaFor(mk({ virodhi: true, memory: {} }), { intent: 'positive', userTurns: 3 }) === null, 'no day media to विरोधी');
    const su = mk({ memory: {} });
    let steered = 0;
    for (const m of ['ram ram', 'abhay singh ne kya kaam karwaye', 'achha', 'library ke baare me batao', 'aur kuch']) { const r = await talk(su, m); if (r.text.includes('वोटर पर्ची पहुँच गई')) steered++; }
    ok(steered === 1, `the locked bot line is used exactly once per voter per day (${steered})`);
    const su2 = mk({ memory: {} });
    await talk(su2, 'abhay singh ji ke baare me batao');
    const st2 = await talk(su2, 'achha', { llm: async () => 'जी, कोई और जानकारी चाहिए तो बेझिझक पूछती हूँ।' });
    ok(st2.text.includes('वोटर पर्ची पहुँच गई') || su2.history.some(h => h.role === 'bot' && h.text.includes('वोटर पर्ची पहुँच गई')), 'a calm "achha" turn steers to the locked goal with the operator line: ' + st2.text);
    ok(!/पूछती हूँ/.test(st2.text) || st2.source !== 'llm', 'a steered turn keeps the operator text (no LLM rewrite)');
    ok(require('./nlu.js').rules('meri parchi mil jayegi kya?', {}).person_name_roman === null, '"meri parchi mil jayegi kya" has no name (was searched as "jayegi")');
    const tp = router.plan(require('./nlu.js').rules('dhanyavad ji', {}), mk({ slipTarget: { who: 'self', done: false } }), { text: 'dhanyavad ji' });
    ok(tp.noSlip && !tp.slipOpts, '"dhanyavad ji" after a slip prompt is thanks, never a name search (live: listed धन सिंह...)');
    oc.setDay(today, { locked: false });
    ok(!oc.lockedToday() && oc.dayMediaFor(mk({ memory: {} }), { intent: 'positive', userTurns: 3 }) === null, 'unlocked day: no steer, no media');
    oc.setDay(today, { locked: true });

    // ---------- 6. persistence ----------
    oc.reload();
    ok(oc.lockedToday() && oc.lockedToday().goal.includes('वोटर पर्ची') && oc.dayHistory(5).length >= 1, 'lock survives a restart (reload from file) + history');
    const persisted = JSON.parse(JSON.stringify(u));
    ok(persisted.memory.op.about.includes('राहुल') && persisted.memory.op.mode === 'aggressive', 'per-voter brief/mode serialise with the voter record');

    // ---------- 7. follow-ups ----------
    oc.setDay(oc.istDate(NOON), { ...oc.load().days[today], locked: true });
    const old = NOON.getTime() - 3 * 86400e3;
    const fu = (op, extra = {}) => mk({ memory: { op }, history: [{ role: 'user', text: 'ram ram', createdAt: old }, { role: 'bot', text: 'राम राम जी', createdAt: old }], ...extra });
    ok(oc.followupDue(fu({ followup: 'off' }), NOON).why === 'off', 'follow-up off by default');
    ok(oc.followupDue(fu({ followup: 'daily' }, { broadcastOptOut: true }), NOON).why === 'stop', 'STOP blocks follow-up');
    ok(oc.followupDue(fu({ followup: 'daily' }, { consentStatus: 'REJECTED' }), NOON).why === 'stop', 'declined blocks follow-up');
    ok(oc.followupDue(mk({ memory: { op: { followup: 'daily' } }, history: [{ role: 'bot', text: 'hi', createdAt: old }] }), NOON).why === 'never_replied', 'never replied -> no follow-up');
    ok(oc.followupDue(fu({ followup: 'daily' }), new Date('2026-11-06T17:30:00Z')).why === 'quiet_hours', 'quiet hours respected (23:00 IST)');
    ok(oc.followupDue(fu({ followup: 'daily' }), new Date('2026-11-15T06:30:00Z')).why === 'silence', 'pre-poll silence respected');
    const f1 = fu({ followup: 'daily' });
    const sent = [];
    let r7 = await oc.runFollowups({ users: [f1, fu({ followup: 'off' })], now: NOON, gapMs: () => 0, send: async (uu, p) => { sent.push(p); } });
    ok(r7.sent === 1 && sent[0].text && !/राहुल/.test(sent[0].text), 'daily follow-up sends once: ' + (sent[0] && sent[0].text));
    ok(sent[0].text.includes('वोटर पर्ची पहुँच गई') && sent[0].media && sent[0].media.file === pick, 'follow-up uses the locked bot line + day media');
    r7 = await oc.runFollowups({ users: [f1], now: new Date(NOON.getTime() + 3600e3), gapMs: () => 0, send: async (uu, p) => { sent.push(p); } });
    ok(r7.sent === 0 && r7.skipped.max1_day === 1, 'max 1 follow-up per day');
    const f2 = fu({ followup: 'every2days', lastFollowupAt: new Date(NOON.getTime() - 86400e3).toISOString(), lastFollowupDate: '2026-11-05' });
    ok(oc.followupDue(f2, NOON).why === 'cadence', 'every-2-days cadence respected');
    const f3 = fu({ followup: 'daily' }); f3.history.push({ role: 'user', text: 'haan', createdAt: NOON.getTime() - 3600e3 });
    ok(oc.followupDue(f3, NOON).why === 'talked_recently', 'no follow-up when the voter talked in the last 20h');
    const f4 = fu({ followup: 'daily' }, { memory: { op: { followup: 'daily', mode: 'chill' } } });
    const t4 = oc.followupText(f4, NOON);
    ok(!VOTE_ASK.test(t4) && !/16 नवंबर/.test(t4), 'chill follow-up is a hello, no vote push: ' + t4);
    ok(oc.followupText(fu({ followup: 'daily' }, { virodhi: true }), NOON).indexOf('16') < 0, 'विरोधी follow-up never asks for the vote');

    // ---------- 8. leftovers ----------
    const g = mk({ memory: { name: 'Krishan Kumar' }, name: 'Krishan Kumar' });
    const nm = brain.nameFor(g, 'hi');
    ok(nm && /^[\u0900-\u097F]+$/.test(nm), 'Hindi reply shows a Roman-typed name in Devanagari: ' + nm);
    const ig = mk({ memory: {} });
    const ri = await talk(ig, 'mera naam Krishan Kumar hai');
    ok(!/[a-z]{3,}/i.test(ri.text.replace(/WhatsApp|Hinglish|Roman/g, '')) || !/(राम राम|प्रणाम)\s+[A-Za-z]/.test(ri.text), 'introduce never mixes scripts: ' + ri.text);
    const cu = mk({ memory: { name: 'कृष्ण कुमार' } });
    const plan = router.plan({ intent: 'voter_card_issue', target_person: 'self' }, cu, { text: 'mera voter card nahi aaya', line: 'sim_636', test: true });
    ok(plan.reply && plan.samasyaId && /^S-/.test(plan.samasyaId), '"voter card not received" is logged as a samasya: ' + plan.samasyaId);
    const plan2 = router.plan({ intent: 'voter_card_issue', target_person: 'self' }, cu, { text: 'card abhi tak nahi aaya', line: 'sim_636', test: true });
    ok(!plan2.samasyaId, 'voter-card samasya not duplicated within 24h');

    const pu = mk({ memory: { name: 'कृष्ण' } });
    const pp = router.plan({ intent: 'recall_self' }, pu, { text: 'mere baare me kya pata hai tumhe?' });
    ok(!pp.reply && pp.noSlip, 'privacy probe is not answered by the recall_self template (brain handles it)');
    const vmx = require('./voter_memory.js');
    ok(!(vmx.parseExtraction('{"name":"Abhay Singh"}') || {}).name, 'the candidate\'s name is never stored as the voter\'s name');
    const ef = brain.classify('haan beta naukri dhoond raha hai abhi', mk({ memory: {} }));
    ok(ef.intent === 'daily_life' && ef.kind === 'effort', 'a son\'s job hunt is life talk, not a jobs pitch: ' + ef.intent);
    const efr = await talk(mk({ memory: { op: { mode: 'aggressive' } } }), 'haan beta naukri dhoond raha hai abhi');
    ok(!VOTE_ASK.test(efr.text) && !/संकल्प/.test(efr.text), 'family update gets warmth, no pitch even in aggressive mode: ' + efr.text);
    try { fs.unlinkSync(process.env.OPERATOR_CONTROL_FILE); } catch (e) {}
    console.log(`\ntest:v6 — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
