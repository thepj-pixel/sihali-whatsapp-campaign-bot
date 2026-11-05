/** Script preference (owner 5 Nov): default Hindi, ask once early, save scriptPref, honour + switch any time. npm run test:script */
const os = require('os'), fs = require('fs'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'script_'));
process.env.SAMASYA_PATH = path.join(tmp, 's.json'); process.env.MULAQAT_PATH = path.join(tmp, 'm.json'); process.env.CHAT_ARCHIVE_DIR = tmp;
delete process.env.DEFAULT_SCRIPT; delete process.env.SCRIPT_ASK;
const userMemory = require('./user_memory.js'); userMemory.save = () => {};
const brain = require('./reply_brain.js');
const vm = require('./voter_memory.js');
const crm = require('./crm_routes.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('❌', m); } };
const dev = t => (String(t).match(/[\u0900-\u097F]/g) || []).length;
const lat = t => (String(t).match(/[a-z]/gi) || []).length;
const isHindi = t => dev(t) > lat(t.replace(/Hinglish \(Roman\)/, ''));
const isRoman = t => dev(t) <= 3;
const ASK = /हिंदी में बात करना पसंद करेंगे या Hinglish/;

async function talk(u, msg, opts = {}) {
    u.history.push({ role: 'user', text: msg });
    const r = await brain.respond(msg, u, opts);
    u.history.push({ role: 'bot', text: r.text });
    return r;
}
const mk = () => ({ phone: '9198' + Math.floor(Math.random() * 1e8), history: [] });

(async () => {
    // 1. default Hindi + ask once in the first reply
    let u = mk();
    let r = await talk(u, 'ram ram');
    ok(isHindi(r.text), 'Roman greeting gets a Hindi reply: ' + r.text);
    // v6: never stacked on a reply that already asks something -> asked in one of the first 3 replies
    let asked = ASK.test(r.text);
    for (const m2 of ['library ke baare me batao', 'achha theek hai']) { if (asked) break; asked = ASK.test((await talk(u, m2)).text); }
    ok(asked, 'script question asked in the first 3 replies');
    ok(u.history.filter(h => h.role === 'bot' && ASK.test(h.text)).every(h => (h.text.replace(brain.SCRIPT_ASK_HI, '').match(/\?/g) || []).length === 0), 'script question never stacked on another question');
    const askCount = () => u.history.filter(h => h.role === 'bot' && ASK.test(h.text)).length;
    r = await talk(u, 'hinglish');
    ok(r.intent === 'script_pref' && u.memory.scriptPref === 'hinglish' && isRoman(r.text), 'answer "hinglish" saved + confirmed in Roman: ' + r.text);
    for (const m of ['abhay singh ne kya kaam karwaye', 'aur aage kya karenge', 'vote kab hai']) {
        r = await talk(u, m);
        ok(isRoman(r.text) && !ASK.test(r.text), `Hinglish honoured: ${m} -> ${r.text.slice(0, 80)}`);
    }
    ok(askCount() === 1, 'asked exactly once');
    r = await talk(u, 'हिंदी में लिखो');
    ok(u.memory.scriptPref === 'hindi' && isHindi(r.text), 'switch to Hindi any time: ' + r.text);
    r = await talk(u, 'kaam bata saara ka saara');
    ok(isHindi(r.text), 'Hindi honoured after switch (Roman input): ' + r.text.slice(0, 80));
    r = await talk(u, 'hinglish me baat karo');
    ok(u.memory.scriptPref === 'hinglish' && isRoman(r.text), 'switch back to Hinglish: ' + r.text);

    // 1b. a bare "hinglish" before we asked
    u = mk(); await talk(u, 'ram ram');
    r = await talk(u, 'hinglish');
    ok(u.memory.scriptPref === 'hinglish' && isRoman(r.text) && !ASK.test(r.text), 'bare "hinglish" = choice even unasked: ' + r.text);
    u = mk(); await talk(u, 'ram ram');
    r = await talk(u, 'हिंदी में');
    ok(u.memory.scriptPref === 'hindi' && !ASK.test(r.text), 'bare "हिंदी में" = choice');

    // 2. ignored question -> stays Hindi, never asked again
    u = mk();
    await talk(u, 'namaste');
    await talk(u, 'hamare yahan paani ki dikkat hai ward 2 me');
    await talk(u, 'do mahine se');
    for (const m of ['theek hai', 'aur kya kiya', 'acha']) { r = await talk(u, m); ok(isHindi(r.text), 'ignored -> Hindi: ' + r.text.slice(0, 60)); }
    ok(u.history.filter(h => h.role === 'bot' && ASK.test(h.text)).length <= 1, 'ignored question never re-asked');
    ok(!u.memory.scriptPref, 'no pref saved when ignored');

    // 3. first message is a problem (flow) -> the question does not interrupt the samasya questions
    u = mk();
    r = await talk(u, 'gali me naali band hai');
    ok(!ASK.test(r.text), 'no script question on top of a samasya question');

    // 4. Haryanvi dialect stays separate from script
    u = mk(); brain.setScriptPref(u, 'hindi');
    r = await talk(u, 'haryanvi me bol bhai');
    ok(u.dialectPref === 'haryanvi' && u.memory.scriptPref === 'hindi', 'dialect switch keeps script pref');
    r = await talk(u, 'aapka kaam kya hai');
    ok(isHindi(r.text), 'Haryanvi + Hindi script reply: ' + r.text.slice(0, 80));
    u = mk(); brain.setScriptPref(u, 'hinglish');
    await talk(u, 'haryanvi me bol');
    r = await talk(u, 'gaon me kya kaam hua');
    ok(isRoman(r.text) && u.dialectPref === 'haryanvi', 'Haryanvi + Hinglish script reply: ' + r.text.slice(0, 80));

    // 5. LLM in the wrong script is rejected
    u = mk(); brain.setScriptPref(u, 'hindi');
    const romanLLM = async () => 'Abhay Singh ji ne gaon me library aur khel maidan banwaya hai.';
    r = await talk(u, 'abhay singh ne kya kaam karwaye', { llm: romanLLM });
    ok(r.source !== 'llm' && isHindi(r.text) && /wrong_script/.test(r.source), 'Roman LLM output rejected for a Hindi voter: ' + r.source);
    ok(brain.scriptMismatch('नमस्ते जी', 'en') === 'wrong_script' && !brain.scriptMismatch('Namaste ji', 'en'), 'validator script check units');

    // 6. CRM profile + memory card
    u = userMemory.getUser('919000077788'); u.history = [];
    crm.saveProfile(u, { scriptPref: 'hinglish' });
    ok(u.memory.scriptPref === 'hinglish' && u.languagePreference === 'hinglish', 'CRM profile sets scriptPref');
    ok(/replyScript: hinglish/.test(vm.buildCard(u)), 'memory card carries the script');
    ok(crm.buildProfile(u, {}).scriptPref === 'hinglish', 'profile shows scriptPref');
    r = await brain.respond('pani ki dikkat', u, {});
    ok(isRoman(r.text) && !ASK.test(r.text), 'operator-set pref honoured, no question: ' + r.text.slice(0, 60));

    // 7. slip flow follows the pref
    const slip = require('./slip_flow.js');
    u = mk(); brain.setScriptPref(u, 'hindi');
    const p = slip.decide('parchi', u, { slipIntent: true });
    ok(p && isHindi(p.text), 'slip prompt in Hindi for a Hindi voter: ' + (p && p.text.slice(0, 50)));

    console.log(`\ntest:script — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
