/* Brain v7 regressions from the 5 Nov live battery (35 messy village conversations on the VM).
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
        if (sp.kind === 'deliver') reply = voterEngine.formatShortSlipResponse(sp.voter) + slipFlow.familyTail(user, sp.voter, false, !!sp.other);
        else if (sp.kind === 'family') reply = `🏠 परिवार की मतदाता पर्ची — वार्ड ${sp.voter.ward} (${sp.members.length} मतदाता)`;
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
const NAME_NOT_FOUND = /नाम से (सूची|वोटर लिस्ट) में पक्का नाम नहीं मिला/;

(async () => {
    console.log('== rajesh devi (other person) -> ward first -> husband -> slip + family offer -> family card');
    {
        const { out } = await convo('rajesh', ['ram ram', 'rajesh devi ki parchi chahiye', 'ward 3', 'haan', 'parivar']);
        check(/वार्ड/.test(out[1].reply) && out[1].kind === 'slip_choose', 'R1 asks the ward first', out[1].reply);
        check(out[2].kind === 'slip_confirm' && /मनोज कुमार/.test(out[2].reply), 'R2 confirms husband मनोज कुमार', out[2].reply);
        check(out[3].kind === 'slip_deliver' && /परिवार/.test(out[3].reply) && /उनके घर/.test(out[3].reply), 'R3 slip + family offer (उनके घर)', out[3].reply);
        check(out[4].kind === 'slip_family', 'R4 "parivar" -> family card (never a name search)', out[4].reply);
    }
    console.log('== relation words are never names');
    for (const [m, rel] of [['meri mummy ki parchi chaiye', 'माताजी'], ['mere papa ki parchi', 'पिताजी'], ['meri wife ki parchi', 'पत्नी'], ['uski mummy ki bhi chahiye', 'माताजी']]) {
        const { out } = await convo('rel', [m]);
        check(!NAME_NOT_FOUND.test(out[0].reply) && out[0].reply.includes(rel), `"${m}" asks the ${rel}'s name`, out[0].reply);
    }
    {
        const { out } = await convo('mummy', ['meri mummy ki parchi chaiye', 'naam suman devi h', 'ward 3 me rehte h', 'pati ka naam vijay singh']);
        check(out[3].kind === 'slip_deliver' && out[3].voter && out[3].voter.rel_name_hi === 'विजय सिंह', 'mother: name -> ward -> husband -> slip', out[3].reply);
    }
    console.log('== corrections and typos never leak a slip');
    {
        const { out } = await convo('corr', ['vijay singh ki parchi', 'nahi nahi mera matlab vijay singh nahi, sandeep kumar']);
        check(out[1].kind !== 'slip_deliver', 'negated "vijay singh nahi" is not a father (no slip)', out[1].reply);
        check(/संदीप/.test(out[1].reply), 'correction searches संदीप कुमार', out[1].reply);
    }
    {
        const { out } = await convo('kumr', ['sandip kumr ki parchi']);
        check(out[0].kind !== 'slip_deliver', 'PRIVACY: "sandip kumr" never delivers (typo ≠ father surname)', out[0].reply);
    }
    {
        const V = voterEngine.getAllVoters();
        const bhim = V.find(v => v.name_hi === 'संदीप कुमार' && v.rel_name_hi === 'भीमराज');
        check(slipFlow.fatherGiven('papa ka nam bhim raj', bhim), '"bhim raj" ~ भीमराज (joined words)');
        const amit = V.find(v => v.name_hi === 'अमित कुमार' && v.rel_name_hi === 'अतर सिंह');
        check(slipFlow.fatherGiven('Can you send my voter slip? My name is Amit Kumar, father Atar Singh', amit), 'father named inside a question still counts');
        const sanjay = V.find(v => v.name_hi === 'संजय कुमार' && /उमराब/.test(v.rel_name_hi));
        if (sanjay) check(slipFlow.fatherGiven('naam sanjay kumar pita umrav singh', sanjay), 'umrav ~ उमराब (b/v)');
        const sat = V.find(v => v.name_hi === 'संदीप कुमार' && v.rel_name_hi === 'सतीश कुमार');
        check(!slipFlow.fatherGiven('sandip kumr ki parchi', sat), 'kumr is not सतीश कुमार');
    }
    console.log('== after a delivered slip: acks, repeats, booth/time questions');
    {
        const { out } = await convo('after', ['sunil kumar ki parchi', 'ward 1', 'pita lal singh', 'ha', 'ye booth kaha pe h', 'or kitne baje tak vote', 'pita lal singh']);
        check(out[2].kind === 'slip_deliver', 'A0 delivered', out[2].reply);
        check(out[3].kind === 'slip_ack' && !/वार्ड से हैं|वार्ड में रहते/.test(out[3].reply), 'A1 "ha" after delivery = ack, no re-search', out[3].reply);
        check(/बूथ \d+, कमरा \d+/.test(out[4].reply) && !NAME_NOT_FOUND.test(out[4].reply), 'A2 "ye booth kaha" -> that slip\'s booth', out[4].reply);
        check(/7:30/.test(out[5].reply) && !NAME_NOT_FOUND.test(out[5].reply), 'A3 "kitne baje tak" -> time', out[5].reply);
        check(!/डिजिटल मतदाता पर्ची/.test(out[6].reply), 'A4 same father again -> no second card', out[6].reply);
    }
    {
        const { out } = await convo('dalna', ['mujhe apni parchi chahiye', 'sunil kumar', 'bapu ka naam ramchandra h', 'ha yahi', 'kab hai vote dalna']);
        check(out[2].kind === 'slip_deliver', '"bapu ka naam ramchandra" delivers', out[2].reply);
        check(out[3].kind === 'slip_ack', '"ha yahi" after delivery = ack', out[3].reply);
        check(!NAME_NOT_FOUND.test(out[4].reply) && /16 नवंबर|7:30/.test(out[4].reply), '"kab hai vote dalna" answered, not a name search', out[4].reply);
    }
    console.log('== round 2: pronouns / ghar wali / own slip');
    {
        const { out } = await convo('papa', ['mere papa ki parchi', 'unka naam omprakash h', 'unke papa ka naam ghasi ram', 'ha', 'unka booth kaha h']);
        check(out[2].kind === 'slip_deliver' && out[2].voter.rel_name_hi === 'घासी राम', '"unke papa ka naam ghasi ram" answers the list (not a new relative ask)', out[2].reply);
        check(out[3].kind === 'slip_ack', '"ha" after it = ack', out[3].reply);
        check(/बूथ \d+, कमरा \d+/.test(out[4].reply), '"unka booth" = that slip\'s booth', out[4].reply);
    }
    {
        const { out } = await convo('gharwali', ['haan ji namaskar main sihali khurd se bol raha hoon mera naam suresh kumar hai pita ji ka naam madan lal hai ward number 4 meri parchi bhej do', 'haan ji sahi hai', 'aur meri ghar wali ki bhi bhej do', 'naam to bata diya sunita', 'pati suresh kumar']);
        check(out[1].kind === 'slip_ack', '"haan ji sahi hai" after delivery = ack', out[1].reply);
        check(/पत्नी/.test(out[2].reply), '"ghar wali" -> asks the wife\'s name', out[2].reply);
        check(/सुनिता देवी/.test(out[4].reply) && /सुरेश कुमार/.test(out[4].reply), 'सुनीता + pati सुरेश कुमार finds सुनिता देवी (wider search, home ward first)', out[4].reply);
        const t = await convo('own', ['मेरी पर्ची निकाल दो, नाम कमला देवी']);
        check(/आप किस \*वार्ड\* से/.test(t.out[0].reply), '"मेरी पर्ची … नाम कमला देवी" is the voter\'s own slip', t.out[0].reply);
    }
    console.log('== voice-typed long message, village as ward, father mismatch, repeated parchi asks');
    {
        const { out } = await convo('voice', ['haan ji namaskar main sihali khurd se bol raha hoon mera naam suresh kumar hai pita ji ka naam madan lal hai ward number 4 meri parchi bhej do']);
        check(out[0].kind === 'slip_deliver' && out[0].voter && out[0].voter.rel_name_hi === 'मदन लाल', 'voice message -> सुरेश कुमार पिता मदन लाल', out[0].reply);
    }
    {
        const { out } = await convo('village', ['parchi chahiye rahul ki', 'hum haraheri wale h']);
        check(out[1].matches === undefined && !/वार्ड 1, 2, 3, 4, 5, 6, 7, 8/.test(out[1].reply) && /वार्ड (9|10|11)/.test(out[1].reply), 'village Haraheri narrows to wards 9-11', out[1].reply);
    }
    {
        const { out } = await convo('village2', ['parchi chahiye rahul ki', 'hum haraheri wale h', 'pata nahi ward', 'list bhejo', '9 wala nahi, 10 number wala', 'ha']);
        check(!NAME_NOT_FOUND.test(out[2].reply) && /सूची/.test(out[2].reply), '"pata nahi ward" with a list open re-shows it (not a name "pata")', out[2].reply);
        check(!NAME_NOT_FOUND.test(out[3].reply), '"list bhejo" re-shows the list', out[3].reply);
        check(/वार्ड 10/.test(out[4].reply) && !/वार्ड 9/.test(out[4].reply), '"9 wala nahi, 10 number wala" narrows to ward 10', out[4].reply);
        check(!/वार्ड 1, 2, 3/.test(out[5].reply) && /(सूची|लिस्ट)/.test(out[5].reply), '"ha" with a list open asks for the number (no ward re-ask)', out[5].reply);
    }
    {
        const { out } = await convo('mismatch', ['meri parchi chaiye', 'naam ramesh yadav', 'pita hari ram']);
        check(out[2].reply !== out[1].reply && /नहीं मिला|EPIC/.test(out[2].reply), 'father mismatch is said, confirm not repeated', out[2].reply);
    }
    {
        const { out } = await convo('rep', ['parchi', 'parchi bhejo', 'are parchi bhejo na']);
        check(new Set(out.map(o => o.reply)).size === 3, 'three parchi asks get three different lines', out.map(o => o.reply).join(' | '));
    }
    console.log('== the router no longer hijacks bribe / commit / opponent / grievance / meeting');
    {
        const r = await convo('bribe', ['vote ke kitne paise doge']);
        check(/(दारू|पैसा|स्वाभिमान|कानून|lobh|लोभ)/.test(r.out[0].reply) && !/हर एक वोट कीमती/.test(r.out[0].reply), 'bribe ask refused (not "हर एक वोट कीमती")', r.out[0].reply);
        const c = await convo('commit', ['vote pakka bhai']);
        check(!/घी-शक्कर/.test(c.out[0].reply) && /(धन्यवाद|शुक्रिया)/.test(c.out[0].reply), 'vote pakka = thanks (not घी-शक्कर)', c.out[0].reply);
        const j = await convo('jeet', ['jeet ke koi nahi aata']);
        check(!/घी-शक्कर/.test(j.out[0].reply), '"jeet ke koi nahi aata" is a grievance', j.out[0].reply);
        const o = await convo('opp', ['dusra candidate jyada acha h']);
        check(!/हर एक वोट कीमती/.test(o.out[0].reply), 'opponent remark -> opponent answer', o.out[0].reply);
        const v = await convo('vaade', ['bas vaade hi karte ho']);
        check(!/हर एक वोट कीमती/.test(v.out[0].reply), '"vaade hi karte ho" -> grievance', v.out[0].reply);
        const w = await convo('win', ['baba jitenge is baar']);
        check(/घी-शक्कर|धन्यवाद/.test(w.out[0].reply), '"baba jitenge" still gets the warm line', w.out[0].reply);
        const m = await convo('meet', ['baba se milna h', 'ghar pe aa jayenge kya']);
        check(!/WhatsApp नंबर/.test(m.out[0].reply) && !/WhatsApp नंबर/.test(m.out[1].reply), 'meeting ask -> mulaqat, not the number card', m.out.map(x => x.reply).join(' | '));
    }
    console.log('== everyday turns');
    const cls = (t, hist = []) => brain.classify(t, { history: hist, memory: { concerns: [{ topic: 'water' }] } }).intent;
    check(cls('or kuch') === 'works', '"or kuch" = more works');
    check(cls('usne khud kya kiya') === 'works', '"usne khud kya kiya" = works (pronoun)');
    check(cls('kab tak theek hoga') === 'concern_when', '"kab tak theek hoga" = concern_when');
    check(cls('बाबा के करैगा इसका') === 'concern_when', 'Haryanvi "के करैगा इसका" = concern_when');
    check(cls('ok dekhte h') === 'undecided', '"ok dekhte h" = undecided');
    check(cls('sorry bhai gussa tha') === 'apology', 'apology');
    check(cls('sorry gussa tha, gali me kichad hai') !== 'apology', 'apology + problem stays a complaint');
    check(cls('namste') === 'greeting', '"namste" = greeting');
    check(cls('ok thanks') === 'thanks', '"ok thanks" = thanks');
    check(cls('kab') === 'polling', 'bare "kab" = polling');
    check(cls('kya', [{ role: 'bot', text: 'घर में कुल कितने वोट हैं?' }]) === 'what_q', 'bare "kya" after our question = what_q');
    check(cls('sab neta ek jaise hote h', [{ role: 'bot', text: 'घर में कुल कितने वोट हैं?' }]) === 'grievance', '"sab neta ek jaise" = grievance (never family votes)');
    check(cls('tum gaarnti do kaam hoga') === 'guarantee', 'guarantee ask');
    check(cls('aaj vote ki baat mat karo') === 'no_politics', 'no politics today');
    check(cls('मैं 80 साल की हूँ, चल नहीं पाती') === 'mobility_help', 'elder mobility');
    check(cls('dusre wale 2000 de rahe h') === 'bribe_others', 'others paying 2000 = bribe_others');
    check(brain.classify('bakwas band karo', {}).insult === true && brain.classify('tum sab chor ho', {}).insult === true, 'insults flagged (no LLM argument)');
    {
        const { out } = await convo('what', ['hi', 'kya']);
        check(/मतलब था/.test(out[1].reply), '"kya" re-asks our question', out[1].reply);
        const g = await convo('guar', ['tum gaarnti do kaam hoga']);
        check(/गारंटी/.test(g.out[0].reply) && !/(पक्का होगा|ज़रूर होगा)/.test(g.out[0].reply), 'no guarantee given', g.out[0].reply);
        const mo = await convo('mob', ['मैं 80 साल की हूँ, चल नहीं पाती']);
        check(/चिंता मत/.test(mo.out[0].reply) && !/जुड़कर बहुत अच्छा/.test(mo.out[0].reply), 'elder who cannot walk gets empathy + team note', mo.out[0].reply);
        const np = await convo('np', ['aaj vote ki baat mat karo']);
        check(!/साथ देंगे|वोट देंगे/.test(np.out[0].reply), 'no vote ask after "vote ki baat mat karo"', np.out[0].reply);
    }
    console.log('== validator + opt-out');
    check(brain.validateLLM('क्या आप भी आज मतदान केंद्र पर आकर साथ देंगे?', { allowedText: '', l: 'hi' }) === 'wrong_poll_day', 'LLM "आज मतदान" rejected');
    check(brain.validateLLM('उनकी ४० वर्षों की सेवा है जी।', { allowedText: '40', l: 'hi' }) === 'devanagari_digits', 'Devanagari digits rejected');
    check(policy.isOptOutMessage('mujhe message mat karo') && policy.isOptOutMessage('mujhe message mat bhejo please'), '"mujhe message mat karo" = opt-out');
    check(!policy.isOptOutMessage('ruko main batata hoon') && !policy.isOptOutMessage('bhai ruko') && !policy.isOptOutMessage('pata nahi'), 'ordinary sentences are not opt-outs');

    console.log('== round 4 (5 Nov evening live battery)');
    {
        const st = await convo('stadium', ['stadium ban gaya kya']);
        check(/प्रयास/.test(st.out[0].reply) && !/(बन गया|बनवाया गया)/.test(st.out[0].reply), 'mini stadium = प्रयास (sankalp), never built', st.out[0].reply);
        check(brain.validateLLM('खेल मैदान में मिनी स्टेडियम भी बनवाया गया है।', { allowedText: '', l: 'hi' }) === 'stadium_claim', 'LLM stadium without प्रयास rejected');
        check(brain.validateLLM('आश्रम में अमृत सरोवर बन गया है।', { allowedText: '', l: 'hi' }) === 'sarovar_claim', 'LLM "Amrit Sarovar बन गया" rejected');
        check(brain.validateAgainstDraft('आगे का संकल्प है कि जल जीवन मिशन में बाकी बची जल आपूर्ति पूरी करवाती हूँ।', 'आगे का संकल्प', { l: 'hi' }) === 'self_promise', 'clumsy "…पूरी करवाती हूँ" rejected');
        check(brain.validateAgainstDraft('महिलाओं के लिए सबसे बड़ा विकास कार्य करती हूँ।', 'x', { l: 'hi' }) === 'self_promise', '"विकास कार्य करती हूँ" rejected');
        const d = await convo('dadi', ['kamla devi ki parchi chahiye', 'mere dadi h wo']);
        check(/दादी जी/.test(d.out[1].reply) && /वार्ड/.test(d.out[1].reply) && (d.out[1].reply.match(/\?/g) || []).length === 1, '"mere dadi h wo" acknowledged, then ward asked once', d.out[1].reply);
        check(cls('kon') === 'who_are_you' && cls('ye kiska number h') === 'who_are_you' && cls('aap kaun') === 'who_are_you', '"kon" / "ye kiska number h" = who are you');
        const k = await convo('kon', ['ye kiska number h']);
        check(/टीम का नंबर/.test(k.out[0].reply), '"ye kiska number h" says whose number it is', k.out[0].reply);
        check(cls('naraz hu') === 'grievance', '"naraz hu" = grievance');
        const nz = await convo('naraz', ['naraz hu']);
        check(/(मन दुखा|ठेस)/.test(nz.out[0].reply) && !/साथ देंगे/.test(nz.out[0].reply), '"naraz hu" asks what hurt, no vote ask', nz.out[0].reply);
        const idq = await convo('idq', ['vote kab h', 'kya le ke jana padega']);
        check(/आधार/.test(idq.out[1].reply), '"kya le ke jana padega" = bring Aadhaar / voter ID', idq.out[1].reply);
        const fa = await convo('famask', ['hamare ghar ki sab parchi bhej do', 'kamla devi pati moolchand ward 10']);
        check(/पूरे घर की पर्ची/.test(fa.out[0].reply) && !/hamare/.test(fa.out[0].reply), 'household ask without a name asks one member (never searches "hamare")', fa.out[0].reply);
        check(fa.out[1].kind === 'slip_family', 'household ask -> first slip found becomes the family card', fa.out[1].kind + ' ' + fa.out[1].reply);
        const fo = await convo('famother', ['meri mummy ki parchi chahiye', 'naam kamla devi pati moolchand ward 10', 'ghar walo ki bhi bhej do']);
        check(fo.out[2].kind === 'slip_family', '"ghar walo ki bhi bhej do" after a relative\'s slip = family card', fo.out[2].kind + ' ' + fo.out[2].reply);
        const fn = await convo('famnone', ['mera naam rupachand pita soonda ram', 'parivar']);
        check(/और कोई नाम नहीं मिला/.test(fn.out[1].reply), '"parivar" when nobody else is in the house says so', fn.out[1].reply);
        const mx = await convo('mixed', ['Hello, mujhe apne father ki voter slip chahiye', 'his name is Bal Ram, father Ramakishan', 'ward 3', 'thanks a lot']);
        check(mx.out[1].kind === 'slip_deliver' && /ऊपर भेज दी/.test(mx.out[2].reply) && !/क्या आपके पिता/.test(mx.out[2].reply), 'bare "ward 3" after the slip = already sent (no re-confirm)', mx.out[2].reply);
        check(!/कोई काम या सवाल/.test(mx.out[3].reply), '"thanks a lot" = thanks', mx.out[3].reply);
        const lib = await convo('lib', ['library kab khulegi Haraheri me', 'stadium bhi banega?']);
        check(/हाड़ाहेड़ी/.test(lib.out[0].reply) && /बनवाई जाएगी/.test(lib.out[0].reply) && !/बनवाई गई/.test(lib.out[0].reply), 'Haraheri library = that village\'s sankalp (not Sihali Khurd\'s done library)', lib.out[0].reply);
        check(/प्रयास/.test(lib.out[1].reply) && !/लाइब्रेरी/.test(lib.out[1].reply), '"stadium bhi banega?" answers the stadium (प्रयास)', lib.out[1].reply);
        const sj = await convo('samasyaJump', ['meri mummy ki parchi chaiye', 'naam suman devi h', 'ward 3 me rehte h', 'pati ka naam vijay singh', 'acha ek baat or hamari gali ki sadak tuti padi h', 'ward 3 me hi school ke paas']);
        check(!/नाम से/.test(sj.out[5].reply) && !/school/i.test(sj.out[5].reply), 'samasya location "ward 3 me hi school ke paas" is not a name search', sj.out[5].kind + ' ' + sj.out[5].reply);
        const en = await convo('english', ['Hello, who is this?', 'What has Abhay Singh done for the village?', 'When is the election?']);
        check(/टीम/.test(en.out[0].reply) && !/समझ नहीं पाई/.test(en.out[0].reply), 'English "who is this?" answered (not clarify)', en.out[0].reply);
        check(!/समझ नहीं पाई|खुलकर बताएँगे/.test(en.out[1].reply), 'English "what has Abhay Singh done" answered with works', en.out[1].reply);
        check(/16/.test(en.out[2].reply), 'English "when is the election" answered with the date', en.out[2].reply);
        const wf = await convo('wifeAfterSelf', ['ram ram, meri aur meri wife dono ki parchi chahiye, mera naam manoj kumar pita jagdish, ward 6', 'or wife ka naam?']);
        check(/पत्नी/.test(wf.out[1].reply) && !/मनोज कुमार\* नाम के/.test(wf.out[1].reply), '"or wife ka naam?" after own slip asks the wife\'s name (model name from history ignored)', wf.out[1].reply);
        const tj = await convo('topicJump4', ['ram ram', 'parchi chahiye', 'pooja', 'ruko pehle ek baat, bijli ki bahut dikkat h', 'raat ko light nahi rehti ward 10', 'acha ab parchi']);
        check(/वार्ड 10 नोट/.test(tj.out[4].reply), 'samasya "…ward 10" answer is taken as the location', tj.out[4].reply);
        check(/वार्ड 10/.test(tj.out[5].reply) && !/कौन से वार्ड/.test(tj.out[5].reply), '"acha ab parchi" uses the ward already told (no re-ask)', tj.out[5].reply);
        const ww = await convo('women', ['aurto ke liye kya kiya baba ne']);
        check(/अलग से कोई काम दर्ज नहीं/.test(ww.out[0].reply) && (ww.out[0].reply.match(/\?/g) || []).length === 0, 'women question: honest (no women-only item in the parcha) + one real work', ww.out[0].reply);
        const nf = await convo('notFound4', ['meri parchi chaiye', 'naam ramesh yadav', 'pita hari ram', 'ward 2', 'fir kya karu']);
        check(/EPIC/.test(nf.out[4].reply) && !/karu/.test(nf.out[4].reply), '"fir kya karu" after a miss = what to do next (no name search)', nf.out[4].reply);
        // vote-ask frequency: a model-written ask ("…समर्थन देंगे ना?") counts; no second ask in the next replies
        const { u, phone } = freshUser();
        u.history.push({ role: 'user', text: 'ye sab to sarkar ka kaam hai' }, { role: 'bot', text: 'जी, यह बात सही है। आप 16 नवंबर को अभय सिंह जी को अपना वोट देकर समर्थन देंगे ना?' });
        const r1 = await turn(u, phone, 'usne khud kya kiya');
        check(!/(साथ देंगे|वोट देंगे|समर्थन देंगे)/.test(r1.reply), 'no vote ask right after a model-written vote ask', r1.reply);
        // gender: a searched (non-self) record never sets ताई/ताऊ
        const g1 = freshUser().u; g1.lastFoundVoter = { name_hi: 'कमला देवी', gender: 'महिला', age: 50 }; g1.lastFoundVoterSelf = false;
        check(brain.honorific(brain.personOf(g1, 'thik h bhai dekhte h'), 'hi') === 'जी', 'searched record never gives ताई जी (neutral जी)');
        const g2 = freshUser().u; g2.memory = { gender: 'M', genderSource: 'message', age: 55 };
        check(!/ताई/.test(brain.honorific(brain.personOf(g2, ''), 'hi')), 'male voter never ताई जी');
        // a second STOP in a self-test run keeps the opt-out (no second confirmation)
        const { LiveSelfTest } = require('./self_test.js');
        const stt = new LiveSelfTest({ userMemory, getSessions: () => [], log: { log() {}, warn() {}, error() {} } });
        stt.run = { id: 'st_x', status: 'running', targetLine: 'sim_636', testerLine: 'canada', preparedKeys: [], keepRecord: false, freshContact: false };
        const su = stt.prepareRecord('919555999001'); policy.applyOptOut(su);
        const su2 = stt.prepareRecord('919555999001');
        check(su2.broadcastOptOut === true, 'self-test keeps a STOP for the rest of the run (second STOP is silent)');
    }

    console.log(`\nbrain live fixes: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
