// 40 realistic voter messages -> intent, stage and reply checks for reply_brain.js (no network).
// Usage: node test_reply_brain.cjs            (assertions)
//        node test_reply_brain.cjs --print    (also print every reply)
//        BEFORE_DIR=/path/to/old/checkout node test_reply_brain.cjs --compare  (writes REPLY_BRAIN_BEFORE_AFTER.md)
const fs = require('fs');
const path = require('path');
const brain = require('./reply_brain.js');

const CASES = [
    // [message, expected intent, user overrides]
    ['राम राम', 'greeting'],
    ['Ram ram bhai', 'greeting'],
    ['kaise ho', 'greeting'],
    ['Baba Abhay Singh kaun hai?', 'about_baba'],
    ['अभय सिंह जी के बारे में बताओ', 'about_baba'],
    ['Abhay singh ne kya kaam kiya gaon me?', 'works'],
    ['पानी की टंकी का क्या हुआ? हमारे यहाँ नल नहीं आता', 'complaint'],
    ['hamari gali me naali tooti padi hai 2 mahine se', 'complaint'],
    ['sadak me bahut gaddhe hai ward 4 me', 'complaint'],
    ['hospital me doctor nahi aata', 'complaint'],
    ['bijli ka khamba tuta hai', 'complaint'],
    ['बच्चों की पढ़ाई के लिए क्या किया?', 'works'],
    ['yuvaon ke liye kya hai? naukri ka kya', 'works'],
    ['kisan ke liye kya karoge', 'future'],
    ['आगे क्या करेंगे गाँव के लिए', 'future'],
    ['meri parchi bhej do', 'voter_slip'],
    ['मेरा नाम वोटर लिस्ट में है क्या', 'voter_slip'],
    ['vote kab hai aur kahan dalna hai', 'polling'],
    ['मतदान कब है', 'polling'],
    ['Baba se milna hai, ghar aao kabhi', 'meeting'],
    ['चौपाल पर कब आओगे', 'meeting'],
    ['pakka vote denge baba ko hi', 'commit'],
    ['हम आपके साथ हैं, पूरा परिवार वोट देगा', 'commit'],
    ['abhi soch rahe hai', 'undecided'],
    ['देखेंगे, अभी तय नहीं किया', 'undecided'],
    ['hum vote nahi denge kisi aur ko denge', 'opposed'],
    ['40 saal me kya kiya kuch nahi kiya', 'taunt'],
    ['सब झूठ बोलते हो चुनाव में', 'taunt'],
    ['kitna paisa doge vote ka', 'bribe'],
    ['daru milegi kya', 'bribe'],
    ['bc kya bakwas hai', 'abuse'],
    ['achha kaam kiya hai baba ne', 'positive'],
    ['ok', 'thanks'],
    ['धन्यवाद', 'thanks'],
    ['ward 3', 'gave_ward'],
    ['7', 'gave_ward'],
    ['pension nahi mil rahi buzurgon ko', 'complaint', { lastFoundVoter: { gender: 'महिला', age: 67 } }],
    ['बेटियों की सुरक्षा का क्या', 'works', { lastFoundVoter: { gender: 'महिला', age: 32 } }],
    ['shmashan ghat ka kaam hua kya', 'works'],
    ['asdkj qwe zzz lorem ipsum dolor amet blah random text here', 'unclear']
];

const FORBIDDEN = /(बाबा जी|बाबाजी|\bbaba ji\b|पैसे देंगे|दारू देंगे|हिंदू|मुसलमान|जाति)/i;

let passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; } else { failed++; console.error('FAIL ' + name); } }

function freshUser(extra = {}) { return { phone: '919000000000', name: '', history: [], context: {}, ...extra }; }

(async () => {
    const rows = [];
    for (const [msg, expected, extra] of CASES) {
        const user = freshUser(extra || {});
        const r = await brain.respond(msg, user, {});
        rows.push({ msg, expected, r });
        check(`intent "${msg}" -> ${expected} (got ${r.intent})`, r.intent === expected);
        check(`reply short for "${msg}"`, r.text.length <= 420);
        check(`no forbidden content for "${msg}"`, !FORBIDDEN.test(r.text));
        check(`script matches for "${msg}"`, /[\u0900-\u097F]/.test(msg) ? /[\u0900-\u097F]/.test(r.text) : !/[\u0900-\u097F]/.test(r.text));
        if (process.argv.includes('--print')) console.log(`\n> ${msg}\n[${r.intent}|${r.stage}|${r.honorific}] ${r.text}`);
    }

    // Persuasion stage tracking across a conversation
    const u = freshUser();
    await brain.respond('Abhay singh ne kya kaam kiya?', u, {});
    check('stage unknown -> undecided after works question', u.persuasionStage === 'undecided');
    await brain.respond('achha kaam kiya hai', u, {});
    check('stage -> leaning after positive', u.persuasionStage === 'leaning');
    const c = await brain.respond('haan pakka vote denge', u, {});
    check('stage -> committed', u.persuasionStage === 'committed' && /परिवार|ghar|parivar/i.test(c.text));
    check('stage history recorded', (u.persuasionHistory || []).length === 3);

    // Gender-aware honorifics
    const f60 = await brain.respond('राम राम', freshUser({ lastFoundVoter: { gender: 'महिला', age: 66 } }), {});
    check('elder woman -> माता जी', f60.text.includes('माता जी'));
    const f45 = await brain.respond('राम राम', freshUser({ lastFoundVoter: { gender: 'महिला', age: 45 } }), {});
    check('middle-age woman -> ताई जी', f45.text.includes('ताई जी'));
    const f25 = await brain.respond('राम राम', freshUser({ name: 'सुनीता देवी' }), {});
    check('woman by name -> बहन जी', f25.text.includes('बहन जी'));
    const m70 = await brain.respond('राम राम', freshUser({ lastFoundVoter: { gender: 'पुरुष', age: 72 } }), {});
    check('elder man -> दादा जी', m70.text.includes('दादा जी'));
    const m50 = await brain.respond('राम राम', freshUser({ lastFoundVoter: { gender: 'पुरुष', age: 50 } }), {});
    check('middle-age man -> ताऊ जी', m50.text.includes('ताऊ जी'));
    const m25 = await brain.respond('राम राम', freshUser({ lastFoundVoter: { gender: 'पुरुष', age: 25 } }), {});
    check('young man -> भाई साहब', m25.text.includes('भाई साहब'));
    const fTopic = await brain.respond('देखेंगे, अभी तय नहीं किया', freshUser({ lastFoundVoter: { gender: 'महिला', age: 35 } }), {});
    check('women talking point = water', /पानी|नल/.test(fTopic.text));
    const mTopic = await brain.respond('देखेंगे, अभी तय नहीं किया', freshUser({ lastFoundVoter: { gender: 'पुरुष', age: 35 } }), {});
    check('men talking point = roads', /सड़क/.test(mTopic.text));

    // Booth from ward
    const pw = await brain.respond('vote kab hai', freshUser({ ward: 5 }), {});
    check('booth for ward 5 is 96 room 2', /booth 96, room 2/i.test(pw.text));

    // No repeated closer on consecutive turns
    const ru = freshUser();
    const a1 = await brain.respond('abhi soch rahe hai', ru, {});
    ru.history.push({ role: 'bot', text: a1.text });
    const a2 = await brain.respond('dekhenge', ru, {});
    check('persuasion ask not repeated verbatim', a1.text !== a2.text);

    // Opposed: ask reason once, then back off
    const ou = freshUser();
    const o1 = await brain.respond('vote nahi denge', ou, {});
    const o2 = await brain.respond('vote nahi denge', ou, {});
    check('opposed: asks reason first, backs off second', /zaroori|baat|khatak/i.test(o1.text) && o2.text !== o1.text && !/vote denge na/i.test(o2.text));

    // Unclear -> clarifying question + admin flag
    const uu = freshUser();
    const un = await brain.respond('asdkj qwe zzz lorem ipsum dolor amet blah random text here', uu, {});
    check('unclear flags admin', un.needsAdmin && uu.needsAdmin && /\?/.test(un.text));

    // LLM validation: invented number / banned words rejected, good reply accepted
    const facts = 'Polling is Monday, 16 November 2026';
    check('LLM reply with invented number rejected', brain.validateLLM('हमने 500 सड़कें बनाई', { allowedText: facts }) !== null);
    check('LLM reply with "बाबा जी" rejected', brain.validateLLM('बाबा जी आपके साथ हैं', { allowedText: facts }) !== null);
    check('LLM bribe offer rejected', brain.validateLLM('वोट दो, पैसे देंगे', { allowedText: facts }) !== null);
    check('clean LLM reply accepted', brain.validateLLM('16 नवंबर को अभय सिंह जी का साथ देंगे ना?', { allowedText: facts }) === null);
    const llmUser = freshUser();
    const viaLlm = await brain.respond('Abhay singh ne kya kaam kiya?', llmUser, { llm: async () => 'Hamne 999 kaam kiye!' });
    check('invalid LLM output falls back to grounded template', viaLlm.source.startsWith('template(llm_rejected') && !viaLlm.text.includes('999'));
    const viaLlm2 = await brain.respond('Abhay singh ne kya kaam kiya?', freshUser(), { llm: async () => { throw new Error('timeout'); } });
    check('LLM error falls back to template', viaLlm2.source === 'template(llm_error)' && viaLlm2.text.length > 10);

    if (process.argv.includes('--compare') && process.env.BEFORE_DIR) {
        const before = require(path.join(process.env.BEFORE_DIR, 'ai_assistant_service.js'));
        const oldMem = require(path.join(process.env.BEFORE_DIR, 'user_memory.js'));
        oldMem.save = () => {};
        let md = '# Reply Brain — before / after (40 messages, local engine, no LLM keys)\n\n"Before" = commit 5dc064e local fallback (`getFastLocalAnswer`, what voters got when the LLM was down or keys missing). "After" = `reply_brain.js` grounded reply.\n\n';
        for (let i = 0; i < rows.length; i++) {
            const { msg, r } = rows[i];
            const phone = '9199000' + String(10000 + i);
            let old = '';
            try { old = before.getFastLocalAnswer(msg, phone); } catch (e) { old = '[error ' + e.message + ']'; }
            md += `### ${i + 1}. "${msg}"\n- **Before:** ${String(old).replace(/\n+/g, ' ')}\n- **After** _(intent: ${r.intent}, stage: ${r.stage})_: ${r.text}\n\n`;
        }
        fs.writeFileSync(path.join(__dirname, 'REPLY_BRAIN_BEFORE_AFTER.md'), md);
        console.log('Wrote REPLY_BRAIN_BEFORE_AFTER.md');
    }

    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
