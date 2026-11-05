/* NLU v5 regression: the owner's live transcript (5 Nov 2026 morning) + variants, LLM stubbed and LLM off.
 * Mirrors server.js routing: nlu.understand -> nlu_router.plan -> direct reply | slip_flow.decide | brain (getAIResponse). */
process.env.DEFAULT_SCRIPT = process.env.DEFAULT_SCRIPT || 'hindi';
process.env.SCRIPT_ASK = 'off';
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const nlu = require('./nlu.js');
const router = require('./nlu_router.js');
const slipFlow = require('./slip_flow.js');
const voterEngine = require('./voter_engine.js');
const ai = require('./ai_assistant_service.js');

let pass = 0, fail = 0;
const failures = [];
function check(cond, label) { if (cond) pass++; else { fail++; failures.push(label); console.log('  ✗ ' + label); } }

// realistic stub LLM output keyed by message
const STUB = {
    'acha koin hu m aur mera voter id abhi tak nahi aaya': { intent: 'voter_card_issue', target_person: 'self', refers_to: 'self name', wants_slip: false, wants_contact: false, sentiment: 'concerned', script: 'roman' },
    'baba ke 100 vote kam h sihali me ..': { intent: 'political_talk', target_person: null, person_name_hi: 'कृष्ण', wants_slip: false, sentiment: 'concerned', script: 'roman' },
    'babal yadav kie': { intent: 'slip_request', target_person: 'other', person_name_hi: 'बबल यादव', person_name_roman: 'babal yadav kie', wants_slip: true, script: 'roman' },
    'babal yadav kie bhi parchi de do': { intent: 'slip_request', target_person: 'other', person_name_hi: 'बबल यादव', person_name_roman: 'babal yadav', wants_slip: true, script: 'roman' },
    'parveen kumar': { intent: 'slip_answer', target_person: 'other', person_name_hi: 'प्रवीण कुमार', person_name_roman: 'parveen kumar', wants_slip: true, script: 'roman' },
    'are bhai bataya naa naam voter id me': { intent: 'slip_answer', target_person: 'other', person_name_hi: 'प्रवीण कुमार', person_name_roman: 'parveen kumar', refers_to: 'pending slip for Parveen Kumar', wants_slip: true, script: 'roman' },
    'are parveen kumar kie voter list chaiye thi': { intent: 'slip_request', target_person: 'other', person_name_hi: 'प्रवीण कुमार', person_name_roman: 'parveen kumar', wants_slip: true, script: 'roman' },
    'nahi uski voter list id de doo': { intent: 'slip_request', target_person: 'other', person_name_hi: null, refers_to: 'Parveen Kumar', wants_slip: true, script: 'roman' },
    'are pareven kumar h naam h uska': { intent: 'slip_answer', target_person: 'other', person_name_hi: 'प्रवीण कुमार', person_name_roman: 'pareven kumar', wants_slip: true, script: 'roman' },
    'tumhar contact details do': { intent: 'contact_request', wants_contact: true, script: 'roman' },
    'राम राम अभय सिंह जी, हम आपके साथ nhai हैं': { intent: 'opposition', sentiment: 'concerned', script: 'hindi' }
};
const stubLLM = async (sys, prompt) => {
    const m = prompt.match(/NEW VOTER MESSAGE: ([\s\S]*?)\n\nJSON:/);
    const k = m ? m[1].trim() : '';
    if (STUB[k]) return '<think>reasoning</think>\n```json\n' + JSON.stringify(STUB[k]) + '\n```';
    return null; // unknown -> rules
};

async function turn(user, phone, msg, llm) {
    user.history = user.history || [];
    user.history.push({ role: 'user', text: msg, at: new Date().toISOString() });
    const n = await nlu.understand(msg, user, { callLLM: llm });
    const p = router.plan(n, user, { text: msg, lineDisplay: '+91 63678 10227' });
    let reply = '', kind = 'brain', voter = null;
    if (p.reply) { reply = p.reply.text; kind = 'nlu_' + p.reply.intent + (p.reply.contactCard ? '+card' : ''); }
    else {
        const opts = p.slipOpts ? { ...p.slipOpts, blocked: false } : { slipIntent: voterEngine.isLikelyNameOrVoterQuery(msg) && !p.noSlip, searchText: msg, blocked: false, noSlip: !!p.noSlip };
        const sp = slipFlow.decide(msg, user, opts);
        if (sp) {
            kind = 'slip_' + sp.kind; voter = sp.voter || null;
            reply = sp.kind === 'deliver' ? voterEngine.formatShortSlipResponse(sp.voter) + slipFlow.FAMILY_TAIL : sp.text;
        } else {
            const clar = n.intent === 'unclear' ? router.clarify(user) : null;
            reply = clar || await ai.getAIResponse(msg, null, [], phone, { nlu: n, noSlip: !!(p.noSlip || p.slipOpts) });
        }
    }
    user.history.push({ role: 'bot', text: reply, at: new Date().toISOString() });
    return { n, reply, kind, voter };
}

const BAD = /(घर-गाँव में सब ठीक|ghar-gaon me sab theek|समझ नहीं पाई|samajh nahi paayi|याद नहीं आ रहा|सिर्फ़ सिहाली खुर्द की जानकारी)/;

async function ownerTranscript(label, llm) {
    console.log(`\n== owner transcript (${label}) ==`);
    const phone = '919000000' + (llm ? '501' : '502');
    const user = userMemory.getUser(phone);
    Object.assign(user, { consented: true, consentStatus: 'ACCEPTED', history: [] });
    const vm = require('./voter_memory.js').ensure(user);
    vm.name = 'कृष्ण कुमार'; vm.nameSource = 'message';
    // earlier: a list of 2 कृष्ण was shown and the voter never picked one
    const two = voterEngine.searchVoters('कृष्ण अभय', 8).filter(v => /कृष्ण/.test(v.name_hi)).slice(0, 2);
    user.disambiguationMatches = two; user.slipPendingAt = new Date().toISOString(); user.slipPendingWho = 'self'; user.lastSlipQuery = 'कृष्ण';
    user.history.push({ role: 'bot', text: slipFlow.listText(two, 'कृष्ण', false) });

    let r = await turn(user, phone, 'acha koin hu m aur mera voter id abhi tak nahi aaya', llm);
    console.log(' B1:', r.reply);
    check(/कृष्ण कुमार जी/.test(r.reply) && /आपने बताया था/.test(r.reply), `${label} T1 recalls own name`);
    check(/वोटर कार्ड/.test(r.reply) && /टीम से पता करके/.test(r.reply) && !/acha koin/.test(r.reply), `${label} T1 handles card-not-received, no name search`);
    check(!r.voter && !/EPIC/.test(r.reply), `${label} T1 no roll details`);

    r = await turn(user, phone, 'baba ke 100 vote kam h sihali me ..', llm);
    console.log(' B2:', r.reply);
    check(!/^slip_/.test(r.kind) && !/EPIC|मकान|पिता:|अभय सिंह\*/.test(r.reply), `${label} T2 NO slip / no privacy leak (kind=${r.kind})`);
    check(/वोट/.test(r.reply) && /(परिवार|दोस्त)/.test(r.reply) && !/100/.test(r.reply), `${label} T2 political talk: every vote counts, family/friends, no figure`);

    r = await turn(user, phone, 'babal yadav kie', llm);
    console.log(' B3:', r.reply);
    check(/बबल यादव/.test(r.reply) && !/kie/.test(r.reply) && !BAD.test(r.reply), `${label} T3 searches बबल यादव (filler stripped)`);
    check(!r.voter || r.kind !== 'slip_deliver', `${label} T3 nothing delivered`);

    r = await turn(user, phone, 'babal yadav kie bhi parchi de do', llm);
    console.log(' B4:', r.reply);
    check(/बबल यादव/.test(r.reply) && !/kie|parchi de do/.test(r.reply), `${label} T4 searches बबल यादव`);
    check(r.kind !== 'slip_deliver', `${label} T4 no delivery without confirmation`);

    r = await turn(user, phone, 'parveen kumar', llm);
    console.log(' B5:', r.reply);
    check(/प्रवीण कुमार/.test(r.reply) && /r.kind/ && /^slip_(choose|confirm)/.test(r.kind), `${label} T5 roll search for प्रवीण कुमार (kind=${r.kind})`);
    check(!/कृष्ण/.test(r.reply) && !/EPIC|मकान/.test(r.reply), `${label} T5 no other person's data`);

    r = await turn(user, phone, 'are bhai bataya naa naam voter id me', llm);
    console.log(' B6:', r.reply);
    check(r.kind !== 'slip_deliver' && !/कृष्ण/.test(r.reply), `${label} T6 never resends कृष्ण's slip`);
    check(/प्रवीण/.test(r.reply), `${label} T6 refers to प्रवीण`);

    r = await turn(user, phone, 'are parveen kumar kie voter list chaiye thi', llm);
    console.log(' B7:', r.reply);
    check(/प्रवीण कुमार/.test(r.reply) && !BAD.test(r.reply), `${label} T7 परवीन/प्रवीण context kept`);

    r = await turn(user, phone, 'nahi uski voter list id de doo', llm);
    console.log(' B8:', r.reply);
    check(/प्रवीण/.test(r.reply) && !BAD.test(r.reply) && r.kind !== 'slip_deliver', `${label} T8 'uski' = प्रवीण`);

    r = await turn(user, phone, 'are pareven kumar h naam h uska', llm);
    console.log(' B9:', r.reply);
    check(/प्रवीण कुमार/.test(r.reply) && !BAD.test(r.reply), `${label} T9 pareven -> प्रवीण कुमार`);

    // the voter picks number 2 from the प्रवीण list -> that slip (another person's) goes out
    const list = user.disambiguationMatches || [];
    if (list.length >= 2) {
        r = await turn(user, phone, '2', llm);
        console.log(' B9b:', r.reply.split('\n').slice(0, 4).join(' | '));
        check(r.kind === 'slip_deliver' && r.voter && r.voter.name_hi === list[1].name_hi && r.voter.rel_name_hi === list[1].rel_name_hi, `${label} T9b picks entry 2 of प्रवीण list`);
        check(user.memory.name === 'कृष्ण कुमार', `${label} T9b own memory name untouched by family slip`);
    } else check(false, `${label} T9b list expected`);

    r = await turn(user, phone, 'tumhar contact details do', llm);
    console.log(' B10:', r.reply);
    check(/\+91 63678 10227/.test(r.reply) && /card|कार्ड/i.test(r.reply) && /\+card/.test(r.kind), `${label} T10 contact number + card`);

    r = await turn(user, phone, 'राम राम अभय सिंह जी, हम आपके साथ nhai हैं', llm);
    console.log(' B11:', r.reply);
    check(/(सम्मान|सिर आँखों)/.test(r.reply) && /(नाराज़गी|दिक्कत|मन खट्टा)/.test(r.reply) && r.kind.indexOf('slip') < 0, `${label} T11 respectful + asks the concern`);

    for (const h of user.history.filter(x => x.role === 'bot')) check(!BAD.test(h.text), `${label} no dumb fallback: ${h.text.slice(0, 50)}`);
}

async function familyScript(label, llm) {
    console.log(`\n== family slip (${label}) ==`);
    const phone = '919000000' + (llm ? '601' : '602');
    const user = userMemory.getUser(phone);
    Object.assign(user, { consented: true, consentStatus: 'ACCEPTED', history: [] });
    let r = await turn(user, phone, 'mere bhai praveen kumar ki parchi chahiye', llm);
    console.log(' B1:', r.reply.slice(0, 160));
    check(/प्रवीण कुमार/.test(r.reply) && /^slip_(choose|confirm)/.test(r.kind) && !/EPIC|मकान/.test(r.reply), `${label} F1 list for brother, no EPIC/house before pick`);
    const pick = (user.disambiguationMatches || [])[0];
    r = await turn(user, phone, pick ? `pita ${pick.rel_name_hi}` : 'pita xyz', llm);
    console.log(' B2:', r.reply.split('\n').slice(0, 3).join(' | '));
    check(r.kind === 'slip_deliver' && pick && r.voter.rel_name_hi === pick.rel_name_hi, `${label} F2 father name picks the right प्रवीण`);
    r = await turn(user, phone, 'krishan kumar ki bhi parchi', llm);
    console.log(' B3:', r.reply.slice(0, 160));
    check(/कृष्ण कुमार/.test(r.reply) && r.kind !== 'slip_deliver', `${label} F3 next family member searched, asks to confirm`);
    r = await turn(user, phone, 'baba jitenge is baar', llm);
    console.log(' B4:', r.reply.slice(0, 160));
    check(!/^slip_/.test(r.kind), `${label} F4 campaign talk mid-list is not a slip`);
    r = await turn(user, phone, 'bhawani ram', llm);
    console.log(' B5:', r.reply.split('\n').slice(0, 3).join(' | '));
    check(r.kind === 'slip_deliver' && /भवानी/.test(r.voter.rel_name_hi), `${label} F5 father name -> कृष्ण कुमार (भवानी राम)`);
}

function units() {
    console.log('\n== units ==');
    const nw = t => nlu.nameWords(t).join(' ');
    check(nw('babal yadav kie bhi parchi de do') === 'babal yadav', 'filler strip 1');
    check(nw('are pareven kumar h naam h uska') === 'pareven kumar', 'filler strip 2');
    check(nw('are parveen kumar kie voter list chaiye thi') === 'parveen kumar', 'filler strip 3');
    check(nlu.toDevanagari(['parveen', 'kumar']) === 'प्रवीण कुमार', 'translit parveen');
    check(nlu.toDevanagari(['babal', 'yadav']) === 'बबल यादव', 'translit babal');
    check(nlu.toDevanagari(['krishan']) === 'कृष्ण', 'translit krishan');
    check(voterEngine.searchVoters('pareven kumar', 5).every(v => /प्रवीण/.test(v.name_hi)), 'roll search pareven');
    const j = nlu.parseJson('<think>x</think> ```json {"intent":"slip_request","wants_slip":true,} ```');
    check(j && j.intent === 'slip_request', 'robust JSON parse');
    check(nlu.parseJson('no json here') === null, 'parse null');
    const c = nlu.clean({ intent: 'weird', person_name_hi: 'बबल यादव की', ward: 44 });
    check(c.intent === 'unclear' && c.person_name_hi === 'बबल यादव' && c.ward === null, 'clean whitelists');
    const m = nlu.merge(nlu.rules('baba ke 100 vote kam h', {}), nlu.clean({ intent: 'slip_answer', wants_slip: true, person_name_hi: 'कृष्ण' }), 'baba ke 100 vote kam h');
    check(m.intent !== 'slip_answer' && !m.wants_slip, 'guard: candidate talk never a slip even if LLM says so');
    // fatherGiven never from "baba"
    const v = { name_hi: 'कृष्ण', rel_name_hi: 'अभय सिंह', ward: 3, rel_type: 'पिता' };
    const u = { history: [{ role: 'bot', text: 'क्या आपके पिता का नाम अभय सिंह है? पर्ची' }], pendingParchiCandidate: v, slipPendingAt: new Date().toISOString() };
    check(slipFlow.decide('baba ke 100 vote kam h sihali me', u, { slipIntent: false }) === null || slipFlow.decide('baba ke 100 vote kam h sihali me', u, { slipIntent: false }).kind !== 'deliver', 'baba != father name');
    check(router.plan(nlu.rules('tumhar contact details do', {}), {}, { lineDisplay: 'X' }).reply.contactCard === true, 'contact plan');
}

(async () => {
    units();
    await ownerTranscript('LLM stub', stubLLM);
    await ownerTranscript('LLM off', null);
    await familyScript('LLM stub', stubLLM);
    await familyScript('LLM off', null);
    console.log(`\nNLU v5: ${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.join('\n')); process.exit(1); }
    process.exit(0);
})();
