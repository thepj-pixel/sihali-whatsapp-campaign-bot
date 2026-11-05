/* (harness copied from test_brain_live_fixes.cjs)
 * Routing mirrors server.js: slip_flow.preempt -> nlu.understand (rules; LLM verdict stubbed where the live model
 * mattered) -> nlu_router.plan -> direct reply | slip_flow.decide | reply brain (getAIResponse, LLM off). */
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
const policy = require('./engagement_policy.js');

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra) { if (cond) pass++; else { fail++; failures.push(label); console.log('  ✗ ' + label + (extra ? '  -> ' + String(extra).replace(/\n/g, ' / ').slice(0, 220) : '')); } }

let phoneN = 0;
function freshUser() {
    const phone = '919555' + String(100000 + (++phoneN));
    const u = userMemory.getUser(phone);
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', history: [] });
    return { u, phone };
}
// STUB: the live model's verdicts that caused failures (keyed by message)
const STUB = {
    'kab hai vote dalna': { intent: 'other', wants_slip: false, script: 'roman' },
    'or kitne baje tak vote': { intent: 'other', wants_slip: false, script: 'roman' },
    'ye booth kaha pe h': { intent: 'other', wants_slip: false, script: 'roman' },
    'vote ke kitne paise doge': { intent: 'political_talk', sentiment: 'concerned', script: 'roman' },
    'jeet ke koi nahi aata': { intent: 'political_talk', sentiment: 'concerned', script: 'roman' },
    'vote pakka bhai': { intent: 'support', sentiment: 'positive', script: 'roman' },
    'dusra candidate jyada acha h': { intent: 'opposition', sentiment: 'neutral', script: 'roman' },
    'bas vaade hi karte ho': { intent: 'political_talk', sentiment: 'angry', script: 'roman' },
    'baba se milna h': { intent: 'contact_request', wants_contact: true, script: 'roman' },
    'ghar pe aa jayenge kya': { intent: 'contact_request', wants_contact: true, script: 'roman' },
    'baba jitenge is baar': { intent: 'support', sentiment: 'positive', script: 'roman' },
    'or wife ka naam?': { intent: 'slip_request', wants_slip: true, target_person: 'other', person_name_roman: 'manoj kumar', person_name_hi: 'मनोज कुमार', script: 'roman' },
    'Hello, who is this?': { intent: 'unclear', script: 'roman' },
    'What has Abhay Singh done for the village?': { intent: 'unclear', script: 'roman' },
    'When is the election?': { intent: 'unclear', script: 'roman' }
};
const stubLLM = async (sys, prompt) => {
    const m = prompt.match(/NEW VOTER MESSAGE: ([\s\S]*?)\n\nJSON:/);
    const k = m ? m[1].trim() : '';
    return STUB[k] ? JSON.stringify(STUB[k]) : null;
};

async function turn(user, phone, msg) {
    user.history.push({ role: 'user', text: msg, at: new Date().toISOString() });
    let reply = '', kind = 'brain', voter = null;
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
        kind = 'slip_' + sp.kind; voter = sp.voter || null;
        if (sp.kind === 'deliver') reply = slipFlow.deliverCaption(user, sp.voter, false, !!sp.other); // server: card + this caption
        else if (sp.kind === 'family') reply = slipFlow.familyCaption(sp, false);
        else reply = sp.text;
    } else if (!reply) {
        const clar = n && n.intent === 'unclear' && ['unclear', 'short_reply'].includes(brain.classify(msg, user).intent) ? router.clarify(user) : null;
        reply = clar || await ai.getAIResponse(msg, null, [], phone, { nlu: n, noSlip: !!(p && (p.noSlip || p.slipOpts)) });
    }
    user.history.push({ role: 'bot', text: reply, at: new Date().toISOString() });
    return { reply, kind, voter, n };
}
async function convo(label, msgs) {
    const { u, phone } = freshUser();
    const out = [];
    for (const m of msgs) out.push(await turn(u, phone, m));
    return { u, out };
}

/* v9 (6 Nov 02:45 live): messy third-party and Hindi/English mixed slip phrasings, typos, corrections, family after a
 * relative's slip. Rules only (LLM NLU stubbed off), same routing as server.js. */
const DEV = /[\u0900-\u097F]/;
const NO_EPIC = r => !/\b[A-Z]{3}\d{7}\b/.test(r);
const NOT_FOUND_ANY = /(पक्का नाम नहीं मिला|नहीं मिला 🙏 उनके पिता)/;
function voterRules(out, label) {
    out.forEach((o, i) => {
        check(DEV.test(o.reply), `${label} t${i + 1} reply in Devanagari`, o.reply);
        check(!/(क्रम\s*संख्या|ballot|बैलेट).{0,12}\d/i.test(o.reply), `${label} t${i + 1} no ballot serial`, o.reply);
        check(!/(पहले|पूर्व)\s*(भी)?\s*सरपंच\s*(रह|थे)/.test(o.reply), `${label} t${i + 1} never "was sarpanch before"`, o.reply);
        check(NO_EPIC(o.reply), `${label} t${i + 1} no EPIC`, o.reply);
    });
}

(async () => {
    console.log('== owner live 02:45: vooterr slip rajeshh devi kie -> manoj -> parivaar');
    {
        const { out } = await convo('own', ['vooterr slip rajeshh devi kie', 'manoj', 'parivaar']);
        check(out[0].kind === 'slip_choose' && /राजेश देवी/.test(out[0].reply) && /रहती हैं/.test(out[0].reply) && !/रहते हैं/.test(out[0].reply), 'O1 typo ask -> ward question, female "रहती हैं"', out[0].reply);
        check(out[1].kind === 'slip_deliver' && out[1].voter && out[1].voter.rel_name_hi === 'मनोज कुमार', 'O2 husband manoj -> her slip', out[1].kind + ' ' + out[1].reply);
        check(out[2].kind === 'slip_family' && out[2].voter && Number(out[2].voter.ward) === 3, 'O3 "parivaar" -> HER family card (ward 3, house 80)', out[2].kind + ' ' + out[2].reply);
        check(/उनके परिवार/.test(out[2].reply), 'O3 family caption says उनके परिवार for a relative', out[2].reply);
        voterRules(out, 'own');
    }
    for (const fam of ['parivar', 'परिवार', 'family', 'ghar walo ki', 'uske ghar walo ki bhi', 'send family slips', 'family ki slip bhej do', 'pariwar ki parchi', 'ghar walo ki bhi parchi bhejo', 'unke parivar ki bhi']) {
        const { out } = await convo('fam', ['voter slip rajesh devi ki', 'manoj', fam]);
        check(out[2].kind === 'slip_family' && out[2].voter && Number(out[2].voter.ward) === 3, `"${fam}" after a relative's slip -> that family card`, out[2].kind + ' ' + out[2].reply);
    }
    console.log('== third-party asks without a name (relation words, mixed language)');
    for (const [msg, rel] of [['mere papa ki slip chahiye', 'पिताजी'], ['meri mummy ki parchi', 'माताजी'], ['bhai ki voter slip', 'भाई'], ['meri mummy ki parchii', 'माताजी'], ['papa ki slipp bhejo', 'पिताजी'], ['mere bhai ki parchi chahiye', 'भाई'], ['wife ki voter slip', 'पत्नी']]) {
        const { out } = await convo('rel', [msg]);
        check(out[0].kind === 'slip_ask_name' && out[0].reply.includes(rel) && !NOT_FOUND_ANY.test(out[0].reply), `"${msg}" -> asks the ${rel}'s name (never a search)`, out[0].kind + ' ' + out[0].reply);
        voterRules(out, msg);
    }
    {
        const { out } = await convo('papa2', ['mere papa ki slip chahiye', 'sunil kumar pita lal singh']);
        check(out[1].kind === 'slip_deliver' && out[1].voter && out[1].voter.rel_name_hi === 'लाल सिंह' && /सुनील कुमार/.test(out[1].reply) && /जी की डिजिटल/.test(out[1].reply), 'papa ask then "sunil kumar pita lal singh" -> his slip (third person caption)', out[1].kind + ' ' + out[1].reply);
    }
    console.log('== named third party, English / mixed');
    {
        const { out } = await convo('en1', ['voter slip for rajesh devi']);
        check(out[0].kind === 'slip_choose' && /राजेश देवी/.test(out[0].reply) && /रहती/.test(out[0].reply), '"voter slip for rajesh devi" -> ward question (रहती)', out[0].kind + ' ' + out[0].reply);
        voterRules(out, 'en1');
    }
    {
        const { out } = await convo('w3', ['rajesh devi ki parchi bhejo ward 3']);
        check(['slip_confirm', 'slip_deliver'].includes(out[0].kind) && out[0].voter && Number(out[0].voter.ward) === 3, '"rajesh devi ki parchi bhejo ward 3" -> the ward-3 Rajesh Devi', out[0].kind + ' ' + out[0].reply);
    }
    {
        const { out } = await convo('pati', ['rajesh devi ki parchi', 'uske pati manoj h']);
        check(out[1].kind === 'slip_deliver' && out[1].voter && out[1].voter.rel_name_hi === 'मनोज कुमार', '"uske pati manoj h" -> her slip', out[1].kind + ' ' + out[1].reply);
    }
    {
        const { out } = await convo('pati2', ['voter slip for rajesh devi', 'husband manoj kumar']);
        check(out[1].kind === 'slip_deliver' && out[1].voter && out[1].voter.rel_name_hi === 'मनोज कुमार', '"husband manoj kumar" (English) -> her slip', out[1].kind + ' ' + out[1].reply);
    }
    console.log('== ward corrections');
    for (const corr of ['ward 3 nahi ward 6', 'ward 3 ni ward 6', 'ward 3 nhi 6', '3 nahi 6']) {
        const { out } = await convo('corr', ['rajesh devi ki parchi', corr]);
        check(out[1].voter && Number(out[1].voter.ward) === 6, `"${corr}" picks ward 6`, out[1].kind + ' ' + out[1].reply);
    }
    {
        const { out } = await convo('corr2', ['rajesh devi ki parchi ward 3 nahi ward 6']);
        check(out[0].voter && Number(out[0].voter.ward) === 6, 'one-message "…ward 3 nahi ward 6" picks ward 6', out[0].kind + ' ' + out[0].reply);
    }
    console.log('== self slip still works + family');
    {
        const { out } = await convo('self', ['meri parchii bhejo', 'sunil kumar pita lal singh', 'parivaar']);
        check(out[1].kind === 'slip_deliver' && /आपकी डिजिटल/.test(out[1].reply), 'self slip delivered', out[1].kind + ' ' + out[1].reply);
        check(out[2].kind === 'slip_family' || /और कोई नाम नहीं मिला/.test(out[2].reply), 'self "parivaar" -> family card or "no other names"', out[2].kind + ' ' + out[2].reply);
    }
    {
        // a male namesake list keeps "रहते"
        const { out } = await convo('male', ['sunil kumar ki parchi']);
        check(out[0].kind === 'slip_choose' && !/रहती/.test(out[0].reply), 'male namesakes keep "रहते"', out[0].reply);
    }

    console.log(`\nslip mixed: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
