/**
 * 📊 Overview / निष्कर्ष — one conclusion row per conversation plus campaign totals.
 *
 * Pure, rule-based (no network): reads user_memory records (history, persuasionStage, voter_memory card),
 * the samasya and mulaqat registers and the विरोधी list. Nothing here exports numbers to files (no CSV).
 *
 * Stance:  commit (पक्का) > विरोधी (owner list or opposed stage) > नाराज़ (abuse / angry words) > समर्थक (leaning/positive) > सोच रहे
 */
const STANCES = ['commit', 'समर्थक', 'सोच रहे', 'विरोधी', 'नाराज़'];

const ANGRY_RX = /(chor|चोर|bakwas|बकवास|pagal|पागल|bewakoof|बेवकूफ|kutt|कुत्त|kamine|कमीन|harami|हरामी|saala|साला|gadha|गधा|dhokebaaz|dhokhebaz|धोखेबाज|jhootha|jhuthe|झूठा|झूठे|nikamm|निकम्म|ghatiya|घटिया|bhaag|भाग जा|mat bhejo|मत भेजो|pareshan mat|tang mat|तंग मत|faltu|फालतू|block kar|ब्लॉक|gussa|गुस्सा|naraz|नाराज़|नाराज|bekar|बेकार|kuch nahi kiya|कुछ नहीं किया)/i;
const ABUSE_INTENTS = new Set(['abuse', 'insult', 'taunt', 'corruption']);
const POSITIVE_RX = /(pakka|पक्का|saath (hai|hain|denge)|साथ (है|हैं|देंगे)|vote (denge|dunga|dungi)|वोट (देंगे|दूंगा|दूँगा|दूंगी)|jitayenge|जिताएंगे|जिताएँगे|achha aadmi|अच्छा आदमी|badhiya|बढ़िया|shandar|शानदार|zindabad|जिंदाबाद|ज़िंदाबाद|aashirwad|आशीर्वाद)/i;

const TOPIC_HI = { water: 'पानी', road: 'सड़क', health: 'स्वास्थ्य', education: 'शिक्षा', youth: 'युवा', farming: 'खेती', safety: 'सुरक्षा', electricity: 'बिजली', drainage: 'नाली', pension: 'पेंशन', housing: 'आवास', light: 'रोशनी', other: 'अन्य' };
const INTENT_HI = { voter_slip: 'पर्ची माँगी', works: 'काम पूछे', future: 'आगे की योजना पूछी', about_baba: 'प्रत्याशी के बारे में पूछा', polling: 'मतदान जानकारी', ballot: 'मतपत्र/क्रम', meeting: 'मुलाक़ात की बात', commit: 'साथ देने का वादा', family_votes: 'परिवार के वोट बताए', undecided: 'अभी सोच रहे', opposed: 'असहमति जताई', taunt: 'ताना मारा', abuse: 'नाराज़गी/गाली', bribe: 'पैसे की बात', complaint: 'शिकायत', grievance: 'शिकायत', positive: 'तारीफ़', opponent: 'विरोधी की बात', corruption: 'भ्रष्टाचार आरोप', health_concern: 'स्वास्थ्य चिंता' };

let CAT_LABEL = {};
try { CAT_LABEL = require('./knowledge_base.js').CATEGORY_LABEL || {}; } catch (e) {}
const catLabel = c => CAT_LABEL[c] || TOPIC_HI[c] || c || 'अन्य';
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const lastTime = u => {
    const h = Array.isArray(u.history) ? u.history : [];
    const t = h.length ? (h[h.length - 1].createdAt || Date.parse(h[h.length - 1].time) || null) : null;
    return t || Date.parse(u.lastSeen) || null;
};

function stanceOf(u, { virodhi = false } = {}) {
    const stage = u.persuasionStage || 'unknown';
    const commitment = u.memory && u.memory.commitment && u.memory.commitment.status;
    const userTexts = (u.history || []).filter(h => h.role === 'user').map(h => String(h.text || ''));
    const intents = (u.persuasionHistory || []).map(x => x.intent);
    const angry = intents.some(i => ABUSE_INTENTS.has(i)) || (u.needsAdmin && ABUSE_INTENTS.has(u.needsAdmin.intent)) || userTexts.some(t => ANGRY_RX.test(t));
    if (stage === 'committed' || commitment === 'committed') return virodhi ? 'विरोधी' : 'commit';
    if (virodhi || stage === 'opposed' || commitment === 'opposed') return 'विरोधी';
    if (angry) return 'नाराज़';
    if (stage === 'leaning' || commitment === 'leaning' || userTexts.some(t => POSITIVE_RX.test(t))) return 'समर्थक';
    return 'सोच रहे';
}

function summaryOf(u, { samasya = [], mulaqat = [] } = {}) {
    const bits = [];
    const intents = [];
    for (const x of (u.persuasionHistory || [])) if (x.intent && INTENT_HI[x.intent] && !intents.includes(INTENT_HI[x.intent])) intents.push(INTENT_HI[x.intent]);
    const m = u.memory || {};
    if (u.lastFoundVoter) bits.push('पर्ची मिली');
    const topics = [];
    for (const c of (m.concerns || [])) { const t = TOPIC_HI[c.topic] || c.topic; if (t && !topics.includes(t)) topics.push(t); }
    if (topics.length) bits.push('मुद्दे: ' + topics.slice(0, 3).join(', '));
    if (m.familyVotes) bits.push(`घर के ${m.familyVotes} वोट`);
    bits.push(...intents.slice(-3));
    if (samasya.length) bits.push(`समस्या ${samasya.map(s => catLabel(s.category)).join(', ')}`);
    if (mulaqat.length) bits.push('मुलाक़ात माँगी');
    const lastUser = [...(u.history || [])].reverse().find(h => h.role === 'user' && h.text && !/^\[/.test(h.text));
    const base = bits.filter(Boolean).join(' · ');
    if (base) return clip(base + (lastUser ? ` — "${clip(lastUser.text, 50)}"` : ''), 180);
    if (lastUser) return clip(`कहा: "${lastUser.text}"`, 180);
    const bot = [...(u.history || [])].reverse().find(h => h.role === 'bot');
    return bot ? clip('सिर्फ़ हमारा संदेश गया (जवाब नहीं): ' + bot.text, 180) : '—';
}

/**
 * @param {object} o
 * @param {object[]} o.users       user_memory records (must carry .phone)
 * @param {object[]} o.samasya     samasya records
 * @param {object[]} o.mulaqat     mulaqat records
 * @param {(phone)=>boolean} o.isVirodhi
 * @param {(phone)=>object|null} [o.contactOf]  contacts_manager lookup (name/ward)
 * @param {object} [o.filter] { stance, line, ward, q, includeTest }
 */
function build({ users = [], samasya = [], mulaqat = [], isVirodhi = () => false, contactOf = () => null, filter = {} } = {}) {
    const rows = [];
    const sBy = {}, mBy = {};
    for (const r of samasya) (sBy[r.phone] = sBy[r.phone] || []).push(r);
    for (const r of mulaqat) (mBy[r.phone] = mBy[r.phone] || []).push(r);
    for (const u of users) {
        if (!u || !u.phone || /self/i.test(String(u.phone))) continue;
        const test = !!(u.selfTest || u.opsTest);
        if (test && !filter.includeTest) continue;
        const h = Array.isArray(u.history) ? u.history : [];
        if (!h.length) continue;
        const virodhi = !!(u.virodhi === true || isVirodhi(u.phone));
        const c = contactOf(u.phone) || {};
        const s = (sBy[u.phone] || []).filter(r => filter.includeTest || !r.test);
        const mq = (mBy[u.phone] || []).filter(r => filter.includeTest || !r.test);
        const mm = u.memory || {};
        const row = {
            phone: u.phone,
            name: mm.name || (u.name && !/ग्रामवासी/.test(u.name) ? u.name : '') || c.name || u.pushName || '',
            line: u.assignedLine || c.line || (h[h.length - 1] && h[h.length - 1].session) || '',
            ward: u.ward || mm.ward || c.ward || '',
            stance: stanceOf(u, { virodhi }),
            mode: (() => { try { return require('./operator_control.js').effectiveMode(u); } catch (e) { return 'normal'; } })(),
            brief: !!(u.memory && u.memory.op && (u.memory.op.about || u.memory.op.style)),
            virodhi,
            stage: u.persuasionStage || 'unknown',
            lastAt: lastTime(u) ? new Date(lastTime(u)).toISOString() : null,
            userMsgs: h.filter(x => x.role === 'user').length,
            summary: summaryOf(u, { samasya: s, mulaqat: mq }),
            samasya: s.map(r => ({ id: r.id, category: catLabel(r.category), status: r.status })),
            mulaqat: mq.map(r => ({ id: r.id, status: r.status, when: r.preferredWhen || r.preferredDate || '', place: r.place || '' })),
            familyVotes: mm.familyVotes || null,
            optedOut: !!u.broadcastOptOut,
            test
        };
        rows.push(row);
    }
    // totals over ALL rows (before the view filter)
    const totals = { conversations: rows.length, commit: 0, 'समर्थक': 0, 'सोच रहे': 0, 'विरोधी': 0, 'नाराज़': 0, samasyaByCategory: {}, samasyaTotal: 0, mulaqatTotal: 0 };
    for (const r of rows) {
        totals[r.stance] = (totals[r.stance] || 0) + 1;
        for (const s of r.samasya) { const k = catLabel(s.category); totals.samasyaByCategory[k] = (totals.samasyaByCategory[k] || 0) + 1; totals.samasyaTotal++; }
        totals.mulaqatTotal += r.mulaqat.length;
    }
    const mulaqatScheduled = mulaqat.filter(r => (filter.includeTest || !r.test) && r.status !== 'cancelled').map(r => ({
        id: r.id, name: r.name || '', phone: r.phone, status: r.status, type: r.type || 'visit', when: r.preferredWhen || '', date: r.preferredDate || '', place: r.place || '', ward: r.ward || '', village: r.village || '', purpose: clip(r.purpose || '', 80)
    }));
    const good = rows.filter(r => r.stance === 'commit' || r.stance === 'समर्थक' || r.mulaqat.length || (r.familyVotes && r.stance !== 'विरोधी'))
        .sort((a, b) => (b.familyVotes || 0) - (a.familyVotes || 0)).slice(0, 15)
        .map(r => ({ phone: r.phone, name: r.name, why: r.stance === 'commit' ? 'पक्का साथ' + (r.familyVotes ? ` (घर के ${r.familyVotes} वोट)` : '') : (r.mulaqat.length ? 'मुलाक़ात माँगी' : 'समर्थन में') }));
    const bad = rows.filter(r => r.stance === 'नाराज़' || r.stance === 'विरोधी' || r.optedOut || r.samasya.some(s => s.status === 'new'))
        .slice(0, 15)
        .map(r => ({ phone: r.phone, name: r.name, why: r.stance === 'नाराज़' ? 'नाराज़/गुस्सा — शांति से बात करें' : r.stance === 'विरोधी' ? 'विरोधी — सम्मान से, दबाव नहीं' : r.optedOut ? 'STOP किया' : 'नई समस्या, अभी कार्रवाई नहीं' }));

    let view = rows;
    if (filter.stance) view = view.filter(r => r.stance === filter.stance);
    if (filter.line) view = view.filter(r => r.line === filter.line);
    if (filter.ward) view = view.filter(r => String(r.ward) === String(filter.ward));
    if (filter.q) { const q = String(filter.q).toLowerCase(); view = view.filter(r => (r.name + ' ' + r.phone + ' ' + r.summary).toLowerCase().includes(q)); }
    view.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return { totals, mulaqatScheduled, good, bad, rows: view, generatedAt: new Date().toISOString() };
}

module.exports = { build, stanceOf, summaryOf, STANCES, ANGRY_RX };
