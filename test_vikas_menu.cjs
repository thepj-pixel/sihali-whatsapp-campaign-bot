/* Vikas menu (6 Nov 2026 live fix): "Gram Vikas karya batao" was answered as a NAME lookup.
 * Routing mirrors server.js (same as test_brain_live_fixes): slip_flow.preempt -> nlu.understand (rules) -> nlu_router.plan
 * -> direct reply | slip_flow.decide | reply brain (LLM off). */
process.env.DEFAULT_SCRIPT = 'hindi';
process.env.SCRIPT_ASK = 'off';
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const nlu = require('./nlu.js');
const router = require('./nlu_router.js');
const slipFlow = require('./slip_flow.js');
const voterEngine = require('./voter_engine.js');
const ai = require('./ai_assistant_service.js');
const brain = require('./reply_brain.js');
const vm = require('./vikas_menu.js');

let pass = 0, fail = 0;
function check(cond, label, extra) { if (cond) pass++; else { fail++; console.log('  ✗ ' + label + (extra ? '  -> ' + String(extra).replace(/\n/g, ' / ').slice(0, 260) : '')); } }

let phoneN = 0;
function freshUser() {
    const phone = '919556' + String(100000 + (++phoneN));
    const u = userMemory.getUser(phone);
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', history: [] });
    return { u, phone };
}
// a live model that would have said "slip_answer, name gram vikas karya" — the rules must win before it is asked
const stubLLM = async () => JSON.stringify({ intent: 'slip_answer', wants_slip: true, target_person: 'self', person_name_roman: 'gram vikas karya', person_name_hi: 'ग्राम विकास कार्य', script: 'roman' });

async function turn(user, phone, msg) {
    user.history.push({ role: 'user', text: msg, at: new Date().toISOString() });
    let reply = '', kind = 'brain';
    const pre = slipFlow.preempt(msg, user);
    let sp = pre, p = null, n = null;
    if (!pre) {
        n = await nlu.understand(msg, user, { callLLM: stubLLM });
        p = router.plan(n, user, { text: msg, lineDisplay: '+91 63678 10227' });
        if (p.reply) { reply = p.reply.text; kind = 'nlu_' + p.reply.intent; }
        else {
            const opts = p.slipOpts ? { ...p.slipOpts, blocked: false } : { slipIntent: voterEngine.isLikelyNameOrVoterQuery(msg) && !p.noSlip, searchText: msg, blocked: brain.inFlow(user), noSlip: !!p.noSlip };
            sp = slipFlow.decide(msg, user, opts);
        }
    }
    if (!reply && sp) {
        kind = 'slip_' + sp.kind;
        reply = sp.kind === 'deliver' ? slipFlow.deliverCaption(user, sp.voter, false, !!sp.other) : sp.text;
    } else if (!reply) {
        reply = await ai.getAIResponse(msg, null, [], phone, { nlu: n, noSlip: !!(p && (p.noSlip || p.slipOpts)) });
    }
    user.history.push({ role: 'bot', text: reply, at: new Date().toISOString() });
    return { reply, kind, n, voter: sp && sp.voter };
}
async function convo(msgs) {
    const { u, phone } = freshUser();
    const out = [];
    for (const m of msgs) out.push(await turn(u, phone, m));
    return { u, out };
}
const NAME_NOT_FOUND = /नाम से (सूची|वोटर लिस्ट) में पक्का नाम नहीं मिला|पूरा नाम/;
const isMenu = r => r.kind === 'nlu_vikas_menu' && r.reply.includes(vm.MENU_HEAD) && /1\. स्वास्थ्य/.test(r.reply) && /8\. आगे का संकल्प/.test(r.reply);
const HARD = r => {
    const t = r.reply;
    return !/(₹|रुपये|रुपए|लाख|करोड़|बजट|%)/.test(t) && !/पिछले कार्यकाल/.test(t) && !/सरपंच/.test(t) && !/(वोट|मुहर|क्रम\s*सं)/.test(t)
        && !/\d+\s*(काम|कार्य|सड़कें)/.test(t) && !/(करता|करती|रहता|रहती|चाहता|चाहती)\b/.test(t) && vm.guard(t) === null;
};

(async () => {
    console.log('== the live bug: "Gram Vikas karya batao" -> menu, never a name lookup');
    {
        const { u, out } = await convo(['Gram Vikas karya batao']);
        check(isMenu(out[0]), 'V1 menu', out[0].reply);
        check(!NAME_NOT_FOUND.test(out[0].reply) && !/gram|विकास karya/i.test(out[0].reply), 'V1 no name-lookup text', out[0].reply);
        check(u.vikasMenu && u.vikasMenu.state === 'awaiting_vikas_category', 'V1 state awaiting_vikas_category');
        check(HARD(out[0]), 'V1 hard rules', out[0].reply);
        check(out[0].reply.split('\n').length <= 11, 'V1 short (<= 11 lines)', out[0].reply);
    }
    console.log('== triggers');
    for (const m of ['gram vikas', 'Gram Vikas', 'vikas karya', 'vikas kaam batao', 'kya kaam kiye', 'kya kya kaam karwaye', 'kaam batao', 'विकास कार्य', 'ग्राम विकास', 'क्या काम करवाए', 'कौन से काम हुए', 'work done', 'What work has been done?', 'gaon ka vikas kya hua']) {
        const { out } = await convo([m]);
        check(isMenu(out[0]), `"${m}" -> menu`, out[0].kind + ' ' + out[0].reply);
    }
    console.log('== not the menu');
    for (const m of ['kuch kaam nahi kiya', 'naali kab banegi', 'gram vikas adhikari se baat karni h', 'vikas kumar ki parchi']) {
        const { out } = await convo([m]);
        check(!/^nlu_vikas/.test(out[0].kind), `"${m}" is not the menu`, out[0].kind + ' ' + out[0].reply);
    }
    console.log('== menu -> number / word -> category works');
    {
        const { out } = await convo(['gram vikas', '3', 'khel', 'sankalp', '1', 'paani', 'sewer', 'moksh']);
        check(isMenu(out[0]), 'C0 menu', out[0].reply);
        check(out[1].kind === 'nlu_vikas_category' && /स्कूल/.test(out[1].reply) && /लाइब्रेरी/.test(out[1].reply) && /मीटिंग हॉल/.test(out[1].reply), 'C1 "3" -> school (library, meeting hall)', out[1].reply);
        check(out[2].kind === 'nlu_vikas_category' && /खेल मैदान/.test(out[2].reply) && /ओपन जिम/.test(out[2].reply) && /रनिंग ट्रैक/.test(out[2].reply), 'C2 "khel" -> playground', out[2].reply);
        check(out[3].kind === 'nlu_vikas_category' && /आगे का संकल्प/.test(out[3].reply) && /जाएगा|जाएगी|जाएँगे/.test(out[3].reply) && /स्टेडियम[^\n]*प्रयास/.test(out[3].reply), 'C3 "sankalp" -> future items labelled आगे का संकल्प, stadium = प्रयास', out[3].reply);
        check(!/बनवाया गया|बनवाई गई/.test(out[3].reply), 'C3 sankalp never shown as done', out[3].reply);
        check(/उप-स्वास्थ्य केंद्र/.test(out[4].reply), 'C4 "1" -> health', out[4].reply);
        check(/जल जीवन मिशन/.test(out[5].reply) && /बोरवेल/.test(out[5].reply), 'C5 "paani" -> water + borewell', out[5].reply);
        check(/सीवरेज/.test(out[6].reply), 'C6 "sewer" -> sewerage', out[6].reply);
        check(/मोक्षधाम/.test(out[7].reply) && /जोहड़/.test(out[7].reply) && /अमृत सरोवर[^\n]*चालू/.test(out[7].reply), 'C7 "moksh" -> mokshdham/johad/ashram, Amrit Sarovar चालू', out[7].reply);
        for (let i = 1; i < out.length; i++) {
            const body = out[i].reply.split('\n').slice(1, -1);
            check(body.length >= 2 && body.length <= 5, `C${i} 2-5 work lines`, out[i].reply);
            check(out[i].reply.trim().endsWith(vm.END_LINE), `C${i} ends with the "नंबर लिखिए" line`, out[i].reply);
            check(HARD(out[i]), `C${i} hard rules`, out[i].reply);
        }
    }
    console.log('== every category passes the guard and uses parcha wording only');
    {
        const pf = require('./rag_vault/parcha_facts.json');
        const all = new Set([].concat(pf.major, pf.sankalp, pf.details).map(x => x.hi));
        for (const c of vm.CATS) {
            const t = vm.categoryText(c.key);
            check(t && vm.guard(t) === null, `guard ok: ${c.key}`, t);
            const lines = t.split('\n').slice(1, -1).map(l => l.replace(/^\S+\s/, ''));
            check(lines.every(l => all.has(l)), `parcha wording only: ${c.key}`, lines.find(l => !all.has(l)));
            check(!/\d/.test(lines.join(' ')), `no figures: ${c.key}`, t);
        }
        check(vm.guard(vm.menuText({})) === null, 'menu passes the guard');
    }
    console.log('== direct category question without the menu');
    {
        const { out } = await convo(['school me kya kaam hua']);
        check(out[0].kind === 'nlu_vikas_category' && /लाइब्रेरी/.test(out[0].reply), '"school me kya kaam hua" -> school directly', out[0].reply);
        const r2 = await convo(['sadak ka kya kaam karwaya']);
        check(r2.out[0].kind === 'nlu_vikas_category' && /डामर|इंटरलॉकिंग/.test(r2.out[0].reply), '"sadak ka kya kaam karwaya" -> roads', r2.out[0].reply);
        const r3 = await convo(['sadak tooti padi hai']);
        check(!/^nlu_vikas/.test(r3.out[0].kind), '"sadak tooti padi hai" stays a complaint', r3.out[0].kind);
    }
    console.log('== greeting then works');
    {
        const { out } = await convo(['ram ram', 'kaam batao', '2']);
        check(!/^nlu_vikas/.test(out[0].kind), 'G0 greeting is a greeting', out[0].kind);
        check(isMenu(out[1]), 'G1 "kaam batao" -> menu', out[1].reply);
        check(out[2].kind === 'nlu_vikas_category' && /सड़क/.test(out[2].reply), 'G2 "2" -> roads', out[2].reply);
    }
    console.log('== the menu closes once the voter moves on');
    {
        const { u, out } = await convo(['gram vikas', 'achha theek hai', '3']);
        check(!/^nlu_vikas/.test(out[2].kind), 'a bare "3" two turns later is not a menu pick', out[2].kind + ' ' + out[2].reply);
        check(!u.vikasMenu, 'state cleared');
    }
    console.log('== "vikas kumar" in a slip is still a name lookup');
    {
        const { out } = await convo(['meri parchi chahiye', 'vikas kumar']);
        check(/^slip_/.test(out[1].kind) && /विकास कुमार/.test(out[1].reply), '"vikas kumar" during a slip -> name lookup', out[1].kind + ' ' + out[1].reply);
        check(!/^nlu_vikas/.test(out[1].kind), '"vikas kumar" is not the menu');
    }
    console.log('== menu mid-slip keeps the slip; the ward answer completes it');
    {
        const { u, out } = await convo(['sunil kumar ki parchi', 'Gram Vikas karya batao', 'ward 1', 'pita lal singh']);
        check(out[0].kind === 'slip_choose' && /वार्ड/.test(out[0].reply), 'S0 slip asks the ward', out[0].reply);
        check(isMenu(out[1]) && /पर्ची वाली बात भी चालू है/.test(out[1].reply), 'S1 menu mid-slip (+ slip reminder)', out[1].reply);
        check(Array.isArray(u.disambiguationMatches) && u.disambiguationMatches.length > 0 || u.slipTarget, 'S1 slip state kept');
        check(/^slip_/.test(out[2].kind) && !/^nlu_vikas/.test(out[2].kind), 'S2 "ward 1" goes back to the slip', out[2].kind + ' ' + out[2].reply);
        check(out[3].kind === 'slip_deliver' || out[2].kind === 'slip_deliver' || out[2].kind === 'slip_confirm', 'S3 slip completes', out[2].kind + ' / ' + out[3].kind + ' ' + out[3].reply);
    }
    {
        // menu pick in the middle of a slip, then the slip continues
        const { out } = await convo(['sunil kumar ki parchi', 'kya kaam kiye', '4', 'ward 1', 'pita lal singh']);
        check(out[2].kind === 'nlu_vikas_category' && /खेल/.test(out[2].reply), 'S4 "4" mid-slip -> playground', out[2].reply);
        check(/^slip_/.test(out[3].kind), 'S5 "ward 1" -> slip', out[3].kind + ' ' + out[3].reply);
        check(out[4].kind === 'slip_deliver' || out[3].kind === 'slip_deliver', 'S6 slip delivered', out[4].kind + ' ' + out[4].reply);
    }
    console.log('== nameWords never keeps "gram vikas karya"');
    check(nlu.nameWords('Gram Vikas karya batao').length === 0, 'nameWords("Gram Vikas karya batao") = []', nlu.nameWords('Gram Vikas karya batao').join(' '));
    check(nlu.nameWords('vikas kumar').map(w => w.toLowerCase()).join(' ') === 'vikas kumar', 'nameWords("vikas kumar") keeps the name');
    const r = nlu.rules('Gram Vikas karya batao', { history: [] });
    check(r.intent === 'vikas_menu' && !r.wants_slip, 'rules: vikas_menu, no slip', JSON.stringify(r));

    console.log(`\nvikas menu: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
