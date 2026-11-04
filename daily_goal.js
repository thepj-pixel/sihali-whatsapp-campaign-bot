const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'campaign_runtime.json');
const DEFAULT_GOAL = {
    date: new Date().toISOString().slice(0, 10),
    targetType: 'voter_help',
    title: 'आज का मतदाता सहायता लक्ष्य',
    instruction: 'सहमति देने वाले लोगों को मतदाता पर्ची, कार्यक्रम और पंचायत जानकारी उपलब्ध कराना।',
    targetContacts: 400,
    targetCommitted: 100,
    completedContacts: 0,
    completedContactHashes: []
};

function load() {
    try {
        if (fs.existsSync(FILE)) return { ...DEFAULT_GOAL, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    } catch (error) {
        console.warn('[DailyGoal] Could not load runtime goal:', error.message);
    }
    return { ...DEFAULT_GOAL };
}

let goal = load();

function get() {
    const { completedContactHashes, stats, ...publicGoal } = goal;
    return { ...publicGoal };
}

function update(changes = {}) {
    const allowed = ['date', 'targetType', 'title', 'instruction', 'targetContacts', 'completedContacts', 'targetCommitted', 'targetWard', 'task'];
    for (const key of allowed) {
        if (changes[key] !== undefined) goal[key] = changes[key];
    }
    goal.targetContacts = Math.max(0, Number(goal.targetContacts) || 0);
    goal.completedContacts = Math.max(0, Number(goal.completedContacts) || 0);
    goal.targetCommitted = Math.max(0, Number(goal.targetCommitted) || 0);
    fs.writeFileSync(FILE, JSON.stringify(goal, null, 2), 'utf8');
    return get();
}

function currentIstDate() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function markContact(phone) {
    const today = currentIstDate();
    if (goal.date !== today) {
        goal.date = today;
        goal.completedContacts = 0;
        goal.completedContactHashes = [];
    }
    if (!Array.isArray(goal.completedContactHashes)) goal.completedContactHashes = [];
    const hash = crypto.createHash('sha256').update(String(phone || '')).digest('hex').slice(0, 16);
    if (!hash || goal.completedContactHashes.includes(hash)) return get();
    goal.completedContactHashes.push(hash);
    goal.completedContacts = Math.max(0, Number(goal.completedContacts) || 0) + 1;
    fs.writeFileSync(FILE, JSON.stringify(goal, null, 2), 'utf8');
    return get();
}

// ---------------- live progress (per day, per line, per ward) ----------------
const STAGE_ORDER = ['unknown', 'undecided', 'leaning', 'committed', 'opposed'];
let dirty = false;
function persistSoon() {
    if (dirty) return;
    dirty = true;
    setTimeout(() => {
        dirty = false;
        try { fs.writeFileSync(FILE, JSON.stringify(goal, null, 2), 'utf8'); } catch (e) {}
    }, 1500).unref?.();
}
const hashOf = phone => crypto.createHash('sha256').update(String(phone || '')).digest('hex').slice(0, 16);

function dayStats(date = currentIstDate()) {
    goal.stats = goal.stats || {};
    if (!goal.stats[date]) {
        goal.stats[date] = { reached: [], replied: [], replies: 0, stageChanges: {}, committed: [], opposed: [], byLine: {}, byWard: {}, summary: null };
        // keep 14 days
        const days = Object.keys(goal.stats).sort();
        while (days.length > 14) delete goal.stats[days.shift()];
    }
    return goal.stats[date];
}
function bucket(map, key) {
    const k = String(key || 'unknown');
    if (!map[k]) map[k] = { reached: 0, replies: 0, committed: 0, leaning: 0, opposed: 0 };
    return map[k];
}
function addUnique(list, h) { if (list.includes(h)) return false; list.push(h); return true; }

/**
 * type: 'reached' (we messaged them) | 'reply' (they messaged us) | 'stage' ({from,to})
 */
function recordEvent(type, { phone, line, ward, from, to } = {}) {
    const d = dayStats();
    const h = hashOf(phone);
    if (type === 'reached') {
        if (addUnique(d.reached, h)) { bucket(d.byLine, line).reached++; bucket(d.byWard, ward).reached++; }
    } else if (type === 'reply') {
        d.replies++;
        bucket(d.byLine, line).replies++; bucket(d.byWard, ward).replies++;
        addUnique(d.replied, h);
        addUnique(d.reached, h);
    } else if (type === 'stage' && from !== to) {
        const key = `${from || 'unknown'}→${to}`;
        d.stageChanges[key] = (d.stageChanges[key] || 0) + 1;
        if (to === 'committed' && addUnique(d.committed, h)) { bucket(d.byLine, line).committed++; bucket(d.byWard, ward).committed++; }
        if (to === 'leaning') { bucket(d.byLine, line).leaning++; bucket(d.byWard, ward).leaning++; }
        if (to === 'opposed' && addUnique(d.opposed, h)) { bucket(d.byLine, line).opposed++; bucket(d.byWard, ward).opposed++; }
    }
    persistSoon();
}

function progress(date = currentIstDate()) {
    const d = dayStats(date);
    return {
        date,
        goal: get(),
        reached: d.reached.length,
        repliedPeople: d.replied.length,
        replies: d.replies,
        committedToday: d.committed.length,
        opposedToday: d.opposed.length,
        targetContacts: goal.targetContacts,
        targetCommitted: goal.targetCommitted,
        stageChanges: d.stageChanges,
        byLine: d.byLine,
        byWard: d.byWard,
        summary: d.summary
    };
}

/** Build (and store) the night summary text for a day. */
function buildSummary(date = currentIstDate(), totals = null) {
    const p = progress(date);
    const lines = Object.entries(p.byLine).map(([k, v]) => `${k}: ${v.reached} पहुँचे, ${v.replies} जवाब, ${v.committed} पक्के`).join(' | ');
    const wards = Object.entries(p.byWard).filter(([k]) => k !== 'unknown' && k !== 'null').sort((a, b) => b[1].committed - a[1].committed).slice(0, 5)
        .map(([k, v]) => `वार्ड ${k}: ${v.committed} पक्के/${v.reached}`).join(', ');
    const text = `📊 ${date} — ${p.reached}/${p.targetContacts} लोगों तक पहुँचे, ${p.repliedPeople} ने जवाब दिया, आज ${p.committedToday}/${p.targetCommitted} पक्के वोट, ${p.opposedToday} विरोध में।` +
        (totals ? ` कुल अब तक: ${totals.committed} पक्के, ${totals.leaning} झुकाव, ${totals.undecided} असमंजस, ${totals.opposed} विरोध।` : '') +
        (lines ? ` लाइन: ${lines}.` : '') + (wards ? ` टॉप वार्ड: ${wards}.` : '') +
        (goal.instruction ? ` आज का काम: ${goal.instruction}` : '');
    dayStats(date).summary = { text, at: new Date().toISOString() };
    persistSoon();
    return text;
}

function history(days = 7) {
    goal.stats = goal.stats || {};
    return Object.keys(goal.stats).sort().reverse().slice(0, days).map(d => ({ date: d, summary: goal.stats[d].summary, reached: goal.stats[d].reached.length, committed: goal.stats[d].committed.length, replies: goal.stats[d].replies }));
}

module.exports = { get, update, markContact, recordEvent, progress, buildSummary, history, currentIstDate, STAGE_ORDER, FILE };
