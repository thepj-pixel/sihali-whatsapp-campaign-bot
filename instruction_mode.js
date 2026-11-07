/**
 * Instruction mode (5 Nov 2026). The operator writes a short Hinglish instruction about ONE voter
 * ("isko paani ki tanki ke baare me bata do"); the bot turns it into a natural Hindi message.
 *
 *   safetyCheck(instruction, {llm})        -> {ok} | {ok:false, category, reason, options[]}   (rules first, then an LLM check)
 *   draft(user, instruction, {llm})        -> {ok, draft, facts[], missingFact?, note?, refused?, reason?}
 *   checkText(text, user, {allowedText})   -> reason | null   (hard rules + leak guard for anything voter-facing)
 *   setPending(user, instruction, {llm,by}) / clearPending(user) / pendingOf(user)
 *   weavePending(text, user, {llm, intent, message}) -> {text, used}    (called by reply_brain.respond)
 *   setMute(user, on, by) / isMuted(user)
 *
 * Facts come only from rag_vault/parcha_facts.json. The voter must never learn that anyone instructed this.
 */
const fs = require('fs');
const path = require('path');
const oc = require('./operator_control.js');

const PARCHA = path.join(__dirname, 'rag_vault', 'parcha_facts.json');
let FACTS = null;
function facts() {
    if (FACTS) return FACTS;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(PARCHA, 'utf8')); } catch (e) {}
    const items = [];
    for (const x of d.major || []) items.push({ ...x, kind: 'done' });
    for (const x of d.details || []) items.push({ ...x, kind: x.status === 'ongoing' ? 'ongoing' : (x.type === 'future' ? 'sankalp' : 'done') });
    for (const x of d.sankalp || []) items.push({ ...x, kind: 'sankalp' });
    FACTS = { items, candidate: d.candidate || {}, poll: d.poll || {} };
    return FACTS;
}

// ---------------- safety filter ----------------
const RULES = [
    ['harass', /(((isko|usko|inko|unko|ise|use|ese|tum|aap)\s*(bhi\s*)?(thoda\s*)?(pareshan|preshan|pershan|tang|tung)\s*kar)|((pareshan|preshan|pershan|tang|tung)\s*kar\s*(do|de|dena|daalo|dalo|ke\s*rakh))|harass|pester|peeche\s*pad|piche\s*pad|sabak\s*sikha|chain\s*se\s*(na|mat)|jeena\s*haram|((इसको|उसको|इसे|उसे|तुम)\s*(भी\s*)?(परेशान|तंग)\s*कर)|((परेशान|तंग)\s*कर\s*(दो|दे|देना|डालो))|पीछे\s*पड़|सबक\s*सिखा|जीना\s*हराम)/i],
    ['spam', /(spam|bar\s*bar|baar\s*baar|baar-baar|bar-bar|roz\s*roz|har\s*(ghante|minute|minat)|lagatar|lagaataar|\d{2,}\s*(message|msg|messages|मैसेज)|message\s*(pe|par)\s*message|बार\s*-?\s*बार|रोज़?\s*रोज़?|हर\s*(घंटे|मिनट)|लगातार)/i],
    ['threaten', /(dhamki|dhamka|darao|dara\s*do|dara\s*de|daraa|threat|dekh\s*lenge|dekh\s*lunga|anjaam|anjam|nateeja\s*bhugat|धमकी|धमका|डरा|अंजाम|देख\s*लेंगे|नतीजा\s*भुगत)/i],
    ['insult', /(gaali|gali\s*de|galiyan|bura\s*bhala|beizzat|bezzat|be-izzat|zaleel|jaleel|insult|abuse|bewakoof|bevkoof|pagal\s*bol|neecha\s*dikha|गाली|बेइज़्ज़त|बेइज्जत|बुरा\s*भला|ज़लील|जलील|बेवकूफ)/i],
    ['bribe', /(paisa|paise|paiso|rupay|rupaye|rupee|\brs\.?\s*\d|₹|\d+\s*(rs|rupay|rupaye|hazar|hazaar)|daaru|daru|sharab|botal|bottle|gift|tohfa|tohfe|inaam|inam|bribe|money|cash|lalach|laalach|kambal|saree|sadi\s*de|पैसा|पैसे|रुपय|रुपए|रुपये|दारू|शराब|तोहफ|गिफ्ट|इनाम|लालच|कंबल)/i],
    ['caste_religion', /(\bjat\b|\bjati\b|\bjaati\b|\bcaste\b|biradari|biraadari|((jaat|gurjar|gujjar|meena|meghwal|brahmin|brahman|rajput|yadav|dalit|bania|baniya)\s*(samaj|log|logo|vote|voter|biradari|hai|ho|wala|wale))|\bdalit\b|\bobc\b|\bsc\s*\/?\s*st\b|hindu|muslim|musalman|musalmaan|\bdharm\b|dharam|religion|mazhab|जाति|बिरादरी|((जाट|गुर्जर|मीणा|मेघवाल|ब्राह्मण|राजपूत|यादव|दलित)\s*(समाज|लोग|वोट|बिरादरी|है))|हिंदू|हिन्दू|मुसलमान|मुस्लिम|धर्म|मज़हब)/i],
    ['attack_opponent', /((virodhi|opponent|samne\s*wal[ae]|saamne\s*wal[ae]|dusr[ae]\s*(ummeedwar|umeedwar|candidate|party|wale)|doosr[ae]\s*(ummeedwar|candidate|party|wale)|विरोधी|सामने\s*वाले|दूसरे\s*(उम्मीदवार|प्रत्याशी))[^.!?।]{0,40}(burai|buraai|bura|chor|jhoot|jhooth|bhrasht|corrupt|kharab|nikamm|bikau|neecha|beizzat|badnam|बुराई|बुरा|चोर|झूठ|भ्रष्ट|खराब|निकम्म|बिकाऊ|बदनाम)|(burai|badnam|बुराई|बदनाम)\s*(kar|करो|कर))/i],
    ['lie_promise', /(jhooth|jhoot|jhuth|\blie\b|fake|galat\s*(bata|bol)|guarantee|garantee|gaurantee|pakka\s*(ho|ban|lag)\s*(jayega|jayegi|jaega|jaegi)|vaada\s*kar|wada\s*kar|waada\s*kar|promise|tareekh|tarikh|\bdate\s*(de|bata|bol)|kal\s*tak|is\s*mahine|agle\s*(hafte|mahine|saal)|\d+\s*(din|hafte|mahine)\s*(me|mein)|naukri\s*(dila|lagwa|pakki)|sarkari\s*naukri|झूठ|गारंटी|वादा\s*कर|पक्का\s*(हो|बन)\s*जाएग|तारीख|नौकरी\s*(दिला|लगवा))/i],
    ['private_data', /(((uska|uski|uske|dusre|doosre|kisi\s*aur|padosi|padosan|biwi|wife|beti|bete|bhai)\s*(ka|ki|ke)?\s*)(number|phone|mobile|epic|voter\s*id|aadhaar|aadhar|address|pata|ghar\s*ka\s*pata)[a-z\s]{0,14}(bata|de\b|do\b|share|bhej)|\bepic\b|aadhaar|aadhar|voter\s*list\s*(ka|ki|se)\s*(data|detail)|(उसका|उसकी|दूसरे|किसी\s*और|पड़ोसी)[^।]{0,15}(नंबर|फोन|पता|आधार)|आधार)/i],
    ['symbol', /(chunav\s*chinh|chinh\b|symbol|nishan\s*(bata|bol)|चुनाव\s*चिन्ह|चिह्न|निशान\s*बता)/i],
    ['sarpanch_claim', /((pehle|purv|pichhle\s*baar)\s*(bhi\s*)?sarpanch\s*(the|rahe|reh)|ex[- ]?sarpanch|former\s*sarpanch|पहले\s*(भी\s*)?सरपंच\s*(थे|रहे))/i],
    ['money_figures', /(budget|bajat|kitne\s*(crore|lakh|lakh)|crore|karod|\blakh\b|lakhon|kitne\s*kaam|bajat|बजट|करोड़|लाख|कितने\s*काम)/i],
    ['ballot_number', /(serial\s*(no|number)|kram\s*sankhya|ballot\s*(no|number)|kaunse\s*number\s*par|क्रम\s*संख्या|सीरियल)/i]
];
const REASON = {
    harass: "the bot won't pester or harass anyone",
    spam: "the bot won't spam or message anyone again and again",
    threaten: "the bot won't threaten anyone",
    insult: "the bot won't insult or abuse anyone",
    bribe: "the bot won't offer money, liquor or gifts, or talk money",
    caste_religion: "the bot won't use caste or religion",
    attack_opponent: "the bot won't attack or badmouth opponents",
    lie_promise: "the bot won't lie, promise dates or guarantee results",
    private_data: "the bot won't share anyone's private data (phone, EPIC, Aadhaar, address)",
    symbol: "the bot won't make election-symbol claims",
    sarpanch_claim: "the bot never says Abhay Singh ji was sarpanch before",
    money_figures: "the bot won't quote budgets, rupee figures or work counts",
    ballot_number: "the bot won't give a ballot serial number",
    unsafe: "that instruction is not safe for the campaign"
};
function optionsFor(cat) {
    if (['harass', 'spam', 'threaten', 'insult'].includes(cat)) return ['Switch this voter to Gentle mode', 'Mute the bot for this voter'];
    return ['Rephrase it as a polite message that uses only parcha facts'];
}
function refusal(cat) {
    const c = REASON[cat] ? cat : 'unsafe';
    const options = optionsFor(c);
    return { ok: false, refused: true, category: c, reason: `Can't do that: ${REASON[c]}. Options: ${options.join(', or ').replace(/^S/, 's').replace(/^R/, 'r')}.`, options };
}
function rulesCheck(instruction) {
    const t = String(instruction || '');
    for (const [cat, rx] of RULES) if (rx.test(t)) return cat;
    return null;
}
const LLM_SAFETY_SYS = 'You screen instructions that a campaign operator gives to a WhatsApp bot about ONE voter, for a village panchayat election in India. Refuse (allow=false) if the instruction asks the bot to harass, pester, spam or keep messaging, threaten, insult, bribe or offer money/liquor/gifts, use caste or religion, attack or badmouth opponents, lie, promise dates/jobs/guarantees, or reveal anyone\'s private data (phone, EPIC, Aadhaar, address). Asking the voter about THEMSELVES (their own name, work, family, ward, how they are, what they need) is fine and is NOT private data. Polite informing, greeting, asking how they are, reminding about the vote date, or telling a development work fact is fine. Reply ONLY JSON: {"allow":true|false,"category":"harass|spam|threaten|insult|bribe|caste_religion|attack_opponent|lie_promise|private_data|ok"}';
// 7 Nov (owner): asking the voter about THEMSELVES (name, work, family, ward, haal-chaal, needs) is conversation, not private data.
const ASK_SELF_RX = /((pooch|puch|poochh|puchh|pucho|poocho|ask|पूछ)[\s\S]{0,60}|^[\s\S]{0,60}(pooch|puch|pucho|poocho|ask|पूछ))/i;
const SELF_TOPIC_RX = /(\bname\b|naam|नाम|\bwork\b|kaam\s*(kya|kaun|karte|karta|karti|dhand)|kya\s*kaam|what\s*(he|she|they|it)?\s*do(es)?|occupation|job|dhandha|dhanda|naukri\s*kya|काम\s*क्या|क्या\s*काम|kya\s*karte|family|parivaar|parivar|ghar\s*(me|mein)\s*kaun|परिवार|ward|वार्ड|gaon|village|गाँव|haal|hal\s*chal|haalchaal|हालचाल|kaise\s*ho|kaise\s*hai|how\s*(he|she|they)\s*(is|are)|how\s*are|kya\s*chahiye|samasya|problem|dikkat|zaroorat|ज़रूरत|समस्या)/i;
function asksAboutSelf(t) { t = String(t || ''); return ASK_SELF_RX.test(t) && SELF_TOPIC_RX.test(t) && !/(uska|uski|uske|dusre|doosre|kisi\s*aur|padosi|उसका|उसकी|दूसरे|किसी\s*और)/i.test(t); }
function selfQuestion(instruction, user) {
    const t = String(instruction || '');
    const parts = [];
    if (/(\bname\b|naam|नाम)/i.test(t)) parts.push('आपका शुभ नाम क्या है');
    if (/(\bwork\b|kaam|what\s*(he|she|they|it)?\s*do(es)?|occupation|job|dhand|naukri|kya\s*karte|काम)/i.test(t)) parts.push('आप क्या काम करते हैं');
    if (/(family|parivaar|parivar|ghar\s*(me|mein)\s*kaun|परिवार)/i.test(t)) parts.push('घर-परिवार में कौन-कौन है');
    if (/(ward|वार्ड)/i.test(t)) parts.push('आप किस वार्ड से हैं');
    if (!parts.length) parts.push('घर में सब राज़ी-ख़ुशी है');
    return `${honOf(user)} 🙏 ${parts.slice(0, 2).join(', और ')}?`;
}

async function safetyCheck(instruction, { llm = null } = {}) {
    const t = String(instruction || '').trim();
    if (!t) return { ok: false, refused: true, category: 'empty', reason: 'Write an instruction first.', options: [] };
    if (t.length > 400) return { ok: false, refused: true, category: 'too_long', reason: 'Keep the instruction short (under 400 characters).', options: [] };
    const cat = rulesCheck(t);
    if (cat) return { ...refusal(cat), by: 'rules' };
    if (llm) {
        try {
            const out = await llm(LLM_SAFETY_SYS, [], 'Instruction: ' + t);
            const m = String(out || '').replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\{[\s\S]*?\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                if (j && j.allow === false && !(asksAboutSelf(t) && /^(private_data|unsafe|ok)$/.test(String(j.category || 'unsafe')))) return { ...refusal(String(j.category || 'unsafe')), by: 'llm' };
            }
        } catch (e) { /* LLM screen is a second layer; rules already passed */ }
    }
    return { ok: true };
}

// ---------------- fact matching ----------------
const SYN = [
    [/(paani|pani|water|tanki|tankiy|jal\b|jal\s*jeevan|nal\b|पानी|टंकी|जल)/i, ['paani', 'tanki', 'jal']],
    [/(sadak|sadke|road|rasta|raasta|gali|cc\s*road|सड़क|रास्ता|गली)/i, ['sadak', 'road', 'rasta', 'gali']],
    [/(school|skool|padhai|vidyalay|स्कूल|विद्यालय|पढ़ाई)/i, ['school', 'vidyalay']],
    [/(hospital|aspatal|swasthya|health|doctor|dawai|अस्पताल|स्वास्थ्य)/i, ['swasthya', 'aspatal', 'kendra']],
    [/(bijli|light|lait|street\s*light|बिजली|लाइट)/i, ['bijli', 'light', 'roshni']],
    [/(nali|naali|drain|ganda\s*paani|नाली)/i, ['nali', 'naali']],
    [/(stadium|khel|ground|maidan|gym|स्टेडियम|खेल|मैदान)/i, ['khel', 'maidan', 'stadium']],
    [/(sarovar|talab|talaab|johad|सरोवर|तालाब|जोहड़)/i, ['sarovar', 'talab', 'johad']],
    [/(moksh|shmashan|samshan|मोक्ष|श्मशान)/i, ['mokshdham']],
    [/(pension|पेंशन)/i, ['pension']],
    [/(gaushala|gau|गौशाला)/i, ['gaushala']],
    [/(mandir|temple|मंदिर)/i, ['mandir']]
];
const NEEDS_FACT = /(baare|bare|bata|batao|bataiye|samjha|kaam|work|vikas|बारे|बता|काम|विकास|tanki|sadak|road|school|hospital|bijli|nali|stadium|sarovar|pension|gaushala|mandir|टंकी|सड़क|स्कूल|अस्पताल|बिजली|नाली|स्टेडियम|सरोवर)/i;
const STOPI = new Set('isko usko inko unko isse usse iske uske ko ke ki ka me mein mai se par aur bhi bata batao bata do de do dena baare bare bol bolo kaho keh kehna samjha samjhao ji haan ek yaad dila dilao message bhejo likho ye wo vo hai hain tha the'.split(/\s+/));
function toks(s) { return String(s || '').toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOPI.has(w)); }
function factsFor(instruction, n = 3) {
    const t = String(instruction || '');
    const want = new Set(toks(t));
    for (const [rx, words] of SYN) if (rx.test(t)) words.forEach(w => want.add(w));
    const scored = [];
    for (const it of facts().items) {
        const hay = (String(it.roman || '') + ' ' + String(it.romanFull || '') + ' ' + String(it.title_hi || '') + ' ' + String(it.hi || '') + ' ' + (it.topics || []).join(' ')).toLowerCase();
        let s = 0;
        for (const w of want) if (w.length >= 4 ? hay.includes(w.slice(0, Math.max(4, w.length - 2))) : new RegExp('\\b' + w + '\\b').test(hay)) s++;
        if (s > 0) scored.push({ it, s: s + (it.kind === 'done' && /^M/.test(it.id) ? 0.5 : 0) });
    }
    scored.sort((a, b) => b.s - a.s);
    const top = scored.length ? scored[0].s : 0;
    return scored.filter(x => x.s >= Math.max(1, top - 1)).slice(0, n).map(x => x.it);
}
function factLine(it) {
    const label = it.kind === 'sankalp' ? 'आगे का संकल्प (not done yet — say "आगे का संकल्प")' : (it.kind === 'ongoing' ? 'चालू (ongoing — say "चालू")' : 'पिछले कार्यकाल में पंचायत में करवाया गया काम');
    return `- [${label}] ${it.hi}`;
}
function templateFrom(it, hon) {
    const body = String(it.hi || '').trim();
    if (it.kind === 'sankalp') return `${hon} 🙏 अभय सिंह जी का आगे का संकल्प है: ${body}`;
    if (it.kind === 'ongoing') return `${hon} 🙏 ${body.replace(/।?$/, '')} — यह काम अभी चालू है।`;
    return `${hon} 🙏 पिछले कार्यकाल में पंचायत में यह काम करवाया गया: ${body}`;
}

// ---------------- hard rules for voter-facing text ----------------
const INSTR_LEAK_RX = /(मुझे\s*कहा\s*गया|कहा\s*गया\s*है|हमें\s*कहा|बोला\s*गया|टीम\s*ने\s*(कहा|बोला|बताया|लिखा)|निर्देश|हिदायत|आदेश\s*मिला|आपको\s*बताने\s*(को|के\s*लिए)\s*कहा|instruction|instruct|operator|dashboard|डैशबोर्ड|mujhe\s*kaha\s*gaya|team\s*ne\s*(kaha|bola|bataya)|bataane\s*ko\s*kaha)/i;
const ROLL_RX = /(\b[A-Z]{3}\d{7}\b|EPIC|एपिक|भाग\s*संख्या|भाग\s*सं\.|मकान\s*(नं|नंबर|संख्या)|मतदाता\s*क्रमांक|bhag\s*sankhya|makaan\s*(no|number))/i;
const OUT_CATS = new Set(['harass', 'threaten', 'insult', 'bribe', 'caste_religion', 'attack_opponent', 'private_data', 'symbol', 'sarpanch_claim']);
function checkText(text, user, { allowedText = '', strictBrain = true } = {}) {
    const r = String(text || '').trim();
    if (!r) return 'empty';
    if (r.length > 600) return 'too_long';
    if (INSTR_LEAK_RX.test(r)) return 'leak_instruction';
    const lk = oc.leakCheck(r, user || {}, { allowedText });
    if (lk) return lk;
    if (ROLL_RX.test(r) && !(user && user.slipDeliveredAt)) return 'voter_roll_detail';
    if (/(सरोवर|sarovar)/i.test(r) && !/(चालू|जारी|chalu|jaari)/i.test(r)) return 'sarovar_not_chalu';
    if (/(स्टेडियम|stadium)/i.test(r) && !/(प्रयास|prayas|संकल्प|sankalp)/i.test(r)) return 'stadium_claim';
    if (/(₹|रुपय|रुपए|रुपये|करोड़|लाख|बजट|rupay|crore|lakh|budget)/i.test(r)) return 'money';
    const g = voterGender(user);
    if (g !== 'F' && /(देंगी|लेंगी|चाहेंगी|करेंगी|आएंगी|आएँगी|जाएंगी|सकेंगी|रहेंगी|सकती हैं|चाहती हैं|बहन जी|माता जी|dengi|chahengi|karengi|aayengi)/i.test(r)) return 'gender_guess';
    if (!g && /(भाई साहब|दादा जी|ताऊ जी|bhai sahab)/i.test(r)) return 'gender_guess';
    const cat = rulesCheck(r.replace(/(अभय सिंह जी|पंचायत)/g, ''));
    if (cat && OUT_CATS.has(cat)) return 'unsafe:' + cat;
    if (strictBrain) {
        try {
            const brain = require('./reply_brain.js');
            const why = brain.validateLLM(r, { allowedText: allowedText + ' 16 2026 40 7:30 5:30', user: null, l: /[\u0900-\u097F]/.test(r) ? 'hi' : 'en' });
            if (why && !/^(truncated|multi_question)$/.test(why)) return why;
        } catch (e) {}
    }
    return null;
}

function voterGender(user) {
    if (!user) return null;
    const m = user.memory || {};
    const g = m.gender || user.genderDetected || null;
    return g === 'F' || g === 'M' ? g : null;
}
function honOf(user) {
    try {
        const brain = require('./reply_brain.js');
        const nm = brain.nameFor ? brain.nameFor(user, 'hi') : '';
        return nm ? `राम राम ${nm} जी` : 'राम राम जी';
    } catch (e) { return 'राम राम जी'; }
}
function clean(out) {
    let r = String(out || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
    r = r.replace(/^\s*(reply|message|draft|jawab|जवाब|संदेश)\s*[:：-]\s*/i, '').replace(/\*\*/g, '').replace(/^\s*["“'](.*)["”']\s*$/s, '$1').trim();
    return r;
}

function draftPrompt(user, instruction, items, { pendingStyle = false } = {}) {
    const C = facts().candidate;
    return [
        'You write a WhatsApp message in Hindi (Devanagari only, no English words) for Abhay Singh ji\'s campaign, Gram Panchayat Sihali Khurd. You are a warm woman volunteer of the village ("मैं ... करती हूँ").',
        pendingStyle ? 'Write ONE short sentence (no greeting) that carries out the point below, so it can be added to a reply.' : `Write 1-2 short, warm sentences that carry out the point below. Start with "${honOf(user)}".`,
        `THE POINT TO MAKE (operator's private note in Hinglish; carry it out, NEVER mention that anyone asked or told you, never say "मुझे बताया/कहा गया", "टीम ने कहा", never mention a note or instruction): ${instruction}`,
        'USE ONLY THESE FACTS (from the parchas), no other works, numbers, dates, names or promises:',
        ...items.map(factLine),
        `- ${C.service_hi || '40 वर्षों की निष्कलंक समाज सेवा'}`,
        voterGender(user) ? `The voter is ${voterGender(user) === 'F' ? 'a woman' : 'a man'}.` : 'The voter\'s gender is unknown: never use gendered verbs or titles for them (say "आप ... चाहेंगे", not चाहेंगी). Do not ask for the vote unless the point asks for it.',
        'HARD RULES: never say Abhay Singh ji was sarpanch before; say "अभय सिंह जी", never "बाबा जी". No budgets, rupees or counts of works, no ballot serial number, no election symbol. Amrit Sarovar is "चालू"; the mini stadium is only a "प्रयास"; sankalp items are "आगे का संकल्प". No promised dates or guarantees, no threats, no bribes, no caste or religion, never attack opponents. At most one question. Output only the message.',
        oc.promptBlock(user || {})
    ].filter(Boolean).join('\n');
}

async function draft(user, instruction, { llm = null, pendingStyle = false } = {}) {
    const safe = await safetyCheck(instruction, { llm });
    if (!safe.ok) return { ok: false, refused: true, reason: safe.reason, category: safe.category, options: safe.options || [] };
    if (user && (user.broadcastOptOut || user.consentStatus === 'REJECTED')) return { ok: false, refused: true, category: 'stop', reason: 'Can\'t do that: this voter said STOP / declined. The bot will not message them.', options: [] };
    const selfAsk = asksAboutSelf(instruction);
    const items = selfAsk ? [] : factsFor(instruction);
    const needs = !selfAsk && NEEDS_FACT.test(instruction);
    if (!items.length && needs) {
        return { ok: true, draft: '', facts: [], missingFact: true, note: 'The parchas have no fact for this — nothing was invented. Write your own message below or change the instruction.' };
    }
    const allowed = items.map(i => i.hi + ' ' + (i.hiFull || '')).join(' ') + ' ' + (facts().candidate.service_hi || '');
    const hon = honOf(user);
    let lastWhy = null;
    if (llm) {
        const sys = draftPrompt(user, instruction, items, { pendingStyle });
        for (let i = 0; i < 2; i++) {
            try {
                const extra = lastWhy ? `\nYOUR LAST DRAFT WAS REJECTED (${lastWhy}). Write it again following every rule.` : '';
                const d = clean(await llm(sys + extra, [], instruction));
                const why = checkText(d, user, { allowedText: allowed + ' ' + hon });
                if (!why) return { ok: true, draft: d, facts: items.map(x => x.id), source: 'llm' };
                lastWhy = why;
            } catch (e) { lastWhy = 'llm_error'; break; }
        }
    }
    // backstop for "ask them their name / work / family": a plain question, no facts needed
    if (selfAsk) {
        const q = selfQuestion(instruction, user);
        const qq = pendingStyle ? q.replace(/^[^🙏]*🙏\s*/, '') : q;
        return { ok: true, draft: qq, facts: [], source: 'template', note: lastWhy ? 'AI draft was rejected (' + lastWhy + '); using a simple question.' : undefined };
    }
    // backstop: the parcha line itself (grounded, rule-checked)
    if (items.length) {
        const t = pendingStyle ? templateFrom(items[0], '').replace(/^\s*🙏\s*/, '') : templateFrom(items[0], hon);
        if (!checkText(t, user, { allowedText: allowed + ' ' + hon, strictBrain: false })) return { ok: true, draft: t, facts: [items[0].id], source: 'template', note: lastWhy ? 'AI draft was rejected (' + lastWhy + '); using the parcha line.' : undefined };
    }
    return { ok: true, draft: '', facts: items.map(x => x.id), source: 'none', note: 'No safe draft right now (' + (lastWhy || 'no AI') + '). Write your own message below.' };
}

// ---------------- pending (one-time) instruction ----------------
function pendingOf(user) { const op = user && user.memory && user.memory.op; return op && op.pendingInstr && op.pendingInstr.text ? op.pendingInstr : null; }
async function setPending(user, instruction, { llm = null, by = 'dashboard' } = {}) {
    const op = oc.ensureOp(user);
    const d = await draft(user, instruction, { llm, pendingStyle: true });
    if (d.refused) return d;
    if (d.missingFact) return { ok: false, refused: false, missingFact: true, reason: d.note };
    if (!d.draft) return { ok: false, reason: d.note || 'No safe line for this instruction.' };
    op.pendingInstr = { text: String(instruction).slice(0, 300), line: d.draft, facts: d.facts || [], at: new Date().toISOString(), by };
    return { ok: true, pending: op.pendingInstr };
}
function clearPending(user) { const op = oc.ensureOp(user); const had = !!op.pendingInstr; delete op.pendingInstr; return had; }

const SKIP_INTENTS = new Set(['stop', 'abuse', 'condolence', 'wrong_number', 'grievance', 'opposed', 'bribe', 'bribe_others', 'privacy_probe', 'insult', 'health_concern', 'apology', 'no_politics', 'corruption', 'script_pref']);
/** Weave the pending point into this reply once, then clear it. Returns {text, used, how}. */
async function weavePending(text, user, { llm = null, intent = null, message = '', allowedText = '' } = {}) {
    const p = pendingOf(user);
    if (!p || !text) return { text, used: false };
    if (isMuted(user) || user.broadcastOptOut || user.consentStatus === 'REJECTED') return { text, used: false };
    if (intent && SKIP_INTENTS.has(intent)) return { text, used: false, how: 'deferred' };
    const allowed = (p.facts || []).map(id => { const it = facts().items.find(x => x.id === id); return it ? it.hi + ' ' + (it.hiFull || '') : ''; }).join(' ') + ' ' + p.line + ' ' + text + ' ' + message + ' ' + allowedText;
    let out = null, how = 'appended';
    if (llm) {
        try {
            const sys = `You edit ONE WhatsApp reply (Hindi Devanagari, warm woman volunteer of Abhay Singh ji's campaign). Keep the reply's meaning and add this point naturally in one short sentence: "${p.line}". Never say anyone asked or told you anything. No new facts, numbers, dates or promises. At most one question. Max 3 short sentences. Output only the final reply.\nREPLY: ${text}`;
            const d = clean(await llm(sys, [], message || 'राम राम'));
            if (d && !checkText(d, user, { allowedText: allowed, strictBrain: true })) { out = d; how = 'llm'; }
        } catch (e) {}
    }
    if (!out) {
        if (checkText(p.line, user, { allowedText: allowed, strictBrain: false })) return { text, used: false, how: 'line_rejected' };
        const q = text.match(/[^।?!.]*\?\s*(😊|🙏)?\s*$/);
        out = q ? text.slice(0, q.index).trim() + ' ' + p.line + ' ' + q[0].trim() : text.trim() + ' ' + p.line;
    }
    const op = oc.ensureOp(user);
    op.lastPendingUsed = { text: p.text, line: p.line, at: new Date().toISOString(), how };
    delete op.pendingInstr;
    return { text: out, used: true, how };
}

// ---------------- mute ----------------
function isMuted(user) { return !!(user && user.botMuted); }
function setMute(user, on, by = 'dashboard') {
    if (!user) return false;
    if (on) { user.botMuted = { at: new Date().toISOString(), by }; user.autoPilot = false; }
    else { delete user.botMuted; user.autoPilot = true; }
    return !!on;
}

function status(user) {
    const p = pendingOf(user);
    const op = (user && user.memory && user.memory.op) || {};
    return { pending: p ? { text: p.text, line: p.line, at: p.at, by: p.by } : null, lastPendingUsed: op.lastPendingUsed || null, muted: isMuted(user), mutedAt: user && user.botMuted ? user.botMuted.at : null, optedOut: !!(user && (user.broadcastOptOut || user.consentStatus === 'REJECTED')), effectiveMode: oc.effectiveMode(user) };
}

module.exports = { asksAboutSelf, selfQuestion, safetyCheck, rulesCheck, factsFor, draft, checkText, setPending, clearPending, pendingOf, weavePending, setMute, isMuted, status, refusal, INSTR_LEAK_RX, SKIP_INTENTS };
