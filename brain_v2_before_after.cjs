// Regenerates the dialogue section of BRAIN_V2.md: 20 multi-turn dialogues, "before" = reply_brain.js at commit dd67584 (v1),
// "after" = Brain v2 (this checkout). Offline, no LLM keys (template path for both).
// Usage: git archive dd67584 | tar -x -C /tmp/before && BEFORE_DIR=/tmp/before node brain_v2_before_after.cjs
const fs = require('fs');
const path = require('path');
const before = require(path.join(process.env.BEFORE_DIR || '/tmp/before', 'reply_brain.js'));
const after = require('./reply_brain.js');

const DIALOGUES = [
    ['Road concern, then asked to recall it', ['Ram ram', 'main ward 5 Sihali Khurd se hu', 'hamare ward me sadak tooti padi hai, kab banegi?', 'meri sadak wali baat yaad hai?']],
    ['Same question three times', ['kya kaam kiya?', 'kya kaam kiya?', 'kya kaam kiya?']],
    ['Water question in Hindi from Hadahedi woman', ['मैं हाड़ाहेड़ी से बोल रही हूँ', 'हमारे यहाँ पानी की बहुत दिक्कत है', 'आगे क्या करेंगे पानी के लिए?']],
    ['Committed voter gives family votes', ['pakka vote denge', 'ghar ke 4 vote hain', 'dhanyavad']],
    ['Opponent mentioned', ['dusra candidate bolta hai abhay singh ne kuch nahi kiya', 'aur kya kaam kiya?']],
    ['"Was he sarpanch before?"', ['kya abhay singh pehle sarpanch the?', 'achha']],
    ['Who are you / bot?', ['tum kaun ho?', 'bot ho kya?']],
    ['Joke and party politics', ['joke sunao', 'modi ke baare me kya kehna hai']],
    ['Lane CC/interlocking (content hold)', ['hamari gali me interlocking kab lagegi?', 'kitni cc sadkein bani?']],
    ['Jobs (no sankalp in sheets)', ['naukri ka kya?', 'gym kahan hai?']],
    ['Bribe asked twice', ['paisa doge kya vote ke', 'daru milegi?']],
    ['Abuse then real issue', ['bc bakwas band karo', 'sorry gussa tha, naali ki gandagi hai', 'ward 9']],
    ['Elder introduces himself', ['ram ram beta', 'meri umar 70 saal ki hai, main vote dalne zaroor aaunga', 'pension nahi milti budhape ki']],
    ['Farmer, Haryanvi flavour', ['mhara gaam sihali kalan se hu, kisan hu', 'khaad beej ki dikkat ghani hai', 'patwari ke chakkar lagane padte hain']],
    ['Medicine cost vs doctor', ['अस्पताल में डॉक्टर नहीं आता', 'दवाई बहुत महंगी है']],
    ['Returning voter greets again', ['paani ki dikkat hai ward 2 me', 'ok', 'ram ram']],
    ['Student wants a ground', ['main student hu, khel ka maidan chahiye', 'library kahan hai?']],
    ['Undecided voter with a known concern', ['bijli ke khambe toote hain ward 3 me', 'abhi soch rahe hain']],
    ['Polling + booth after ward', ['vote kab hai?', 'ward 7', 'booth kaun sa hai?']],
    ['Unclear twice', ['asdf qwer zxcv lorem ipsum dolor sit amet blah', 'qqq www eee rrr ttt yyy uuu iii ooo ppp']]
];

async function run(mod, msgs) {
    const u = { phone: '919000000009', name: '', history: [], context: {} };
    const out = [];
    for (const m of msgs) {
        u.history.push({ role: 'user', text: m, createdAt: Date.now() });
        let r;
        try { r = await mod.respond(m, u, {}); } catch (e) { r = { text: '[error ' + e.message + ']' }; }
        u.history.push({ role: 'bot', text: r.text, createdAt: Date.now() });
        out.push(r.text);
    }
    return out;
}

(async () => {
    let md = `# Brain v2 — 20 before/after dialogues\n\n"Before" = \`reply_brain.js\` at dd67584 (v1, template path). "After" = Brain v2 (fact-sheet retrieval + per-voter memory + concern-tied closers + non-repetition), also template path — no LLM keys in the sandbox. With keys on the VM, the LLM rewrites the v2 draft from the full context and is validated against the same rules.\n\n`;
    let i = 0;
    for (const [title, msgs] of DIALOGUES) {
        i++;
        const b = await run(before, msgs);
        const a = await run(after, msgs);
        md += `## ${i}. ${title}\n\n| Voter | Before (v1) | After (v2) |\n|---|---|---|\n`;
        msgs.forEach((m, k) => { md += `| ${m.replace(/\|/g, '/')} | ${String(b[k]).replace(/\n+/g, ' ').replace(/\|/g, '/')} | ${String(a[k]).replace(/\n+/g, ' ').replace(/\|/g, '/')} |\n`; });
        md += '\n';
    }
    const file = path.join(__dirname, 'BRAIN_V2.md');
    const doc = fs.readFileSync(file, 'utf8');
    const out = doc.replace(/<!-- DIALOGUES:START -->[\s\S]*<!-- DIALOGUES:END -->/, '<!-- DIALOGUES:START -->\n' + md.replace(/^# .*\n\n/, '## 20 before/after dialogues\n\n') + '<!-- DIALOGUES:END -->');
    fs.writeFileSync(file, out);
    console.log('updated BRAIN_V2.md');
})();
