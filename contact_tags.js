/**
 * Contact tags — the owner's विरोधी (opposition) list.
 *
 * The owner pastes numbers of people from the other side. For them the bot switches to a GENTLE mode:
 * very respectful, no persuasion pressure, no vote asks, it listens, logs samasya and keeps the relationship
 * warm. The list lives in contact_tags.json (gitignored) and is mirrored into user_memory as `user.virodhi = true`
 * so any module (reply_brain, overview, bulk scheduler) can read it.
 *
 * reply_brain reads it through ONE line: `if (contactTags.isVirodhiUser(user)) text = contactTags.gentle(text, l)`.
 * installGentleMode(brain) also post-filters respond()/respondSync() so an LLM rephrase can never add a vote ask.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const contactUtils = require('./contact_utils.js');

const IS_TEST = /^test/.test(process.env.npm_lifecycle_event || '') || /test_/.test(process.argv[1] || '');
const FILE = process.env.CONTACT_TAGS_PATH || (IS_TEST ? path.join(os.tmpdir(), `contact_tags_test_${process.pid}.json`) : path.join(__dirname, 'contact_tags.json'));

let state = null;
function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { state = null; }
    if (!state || typeof state !== 'object') state = {};
    if (!state.virodhi || typeof state.virodhi !== 'object') state.virodhi = {};
    return state;
}
function save() {
    const tmp = FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8'); fs.renameSync(tmp, FILE); } catch (e) { console.warn('[ContactTags] save failed:', e.message); }
}
function norm(phone) {
    const p = contactUtils.normalizeIndianPhone(phone);
    if (p) return p;
    const d = String(phone || '').replace(/[^\d]/g, '');
    return d.length >= 10 && d.length <= 15 ? d : null;
}

function isVirodhi(phone) { const p = norm(phone); return !!(p && load().virodhi[p]); }
function isVirodhiUser(user) {
    if (!user) return false;
    if (user.virodhi === true) return true;
    return !!(user.phone && isVirodhi(user.phone));
}

/** Add numbers (pasted text "phone, name" per line, or an array). Mirrors the flag into userMemory when given. */
function addVirodhi(input, { note = '', userMemory = null, by = 'dashboard' } = {}) {
    const rows = Array.isArray(input)
        ? input.map(x => (typeof x === 'object' ? x : { phone: x }))
        : contactUtils.parsePastedContacts(String(input || ''));
    const s = load();
    const out = { added: [], already: [], invalid: [] };
    for (const r of rows) {
        const p = norm(r.phone);
        if (!p) { out.invalid.push(String(r.phone || '').slice(0, 30)); continue; }
        if (s.virodhi[p]) { out.already.push(p); continue; }
        s.virodhi[p] = { name: String(r.name || '').trim().slice(0, 60), note: String(note || '').slice(0, 200), at: new Date().toISOString(), by };
        out.added.push(p);
        if (userMemory && userMemory.users) {
            const u = userMemory.users[p];
            if (u) { u.virodhi = true; u.virodhiAt = s.virodhi[p].at; }
        }
    }
    save();
    if (userMemory && out.added.length && typeof userMemory.save === 'function') { try { userMemory.save(); } catch (e) {} }
    return out;
}

function removeVirodhi(phone, { userMemory = null } = {}) {
    const p = norm(phone);
    const s = load();
    if (!p || !s.virodhi[p]) return false;
    delete s.virodhi[p];
    save();
    if (userMemory && userMemory.users && userMemory.users[p]) { delete userMemory.users[p].virodhi; try { userMemory.save(); } catch (e) {} }
    return true;
}

function list() { const s = load(); return Object.entries(s.virodhi).map(([phone, v]) => ({ phone, ...v })).sort((a, b) => (a.at < b.at ? 1 : -1)); }

/** Make sure every listed number carries user.virodhi in memory (call at boot and when a new record appears). */
function syncToMemory(userMemory) {
    if (!userMemory || !userMemory.users) return 0;
    let n = 0;
    for (const [phone, u] of Object.entries(userMemory.users)) {
        if (!u) continue;
        const listed = !!load().virodhi[phone];
        if (listed && u.virodhi !== true) { u.virodhi = true; n++; }
        else if (!listed && u.virodhi === true && !u.virodhiManual) { delete u.virodhi; n++; }
    }
    return n;
}

// ---------------- gentle mode ----------------
// Sentences that push for a vote / commitment / numbers — removed for विरोधी contacts.
const PUSH_RX = /(साथ देंगे|साथ दीजिए|साथ दें\b|वोट देंगे|वोट दीजिए|वोट दें\b|अपना वोट|आशीर्वाद देंगे|आशीर्वाद दीजिए|पक्का रहा|पक्का\?|देखेंगे ना|सोचिएगा|मुहर|कितने वोट|परिवार के वोट|घर बुलाना चाहेंगे|मुलाक़ात करवा|saath denge|saath dijiye|vote denge|vote dijiye|apna vote|aashirwad denge|ashirwad denge|aashirwad dijiye|pakka raha|dekhenge na|sochiyega|muhar|kitne vote|parivar ke vote|ghar bulana chahenge)/i;
const LISTEN = {
    hi: ['आपकी बात सुनना हमारे लिए ज़रूरी है 🙏', 'आपकी राय का पूरा सम्मान है जी 🙏', 'कोई भी समस्या हो तो बेझिझक बताइए, हम ध्यान से सुनेंगे 🙏', 'गाँव सबका है, आपकी बात हम तक पहुँचती रहे 🙏'],
    en: ['Aapki baat sunna hamare liye zaroori hai 🙏', 'Aapki raay ka poora samman hai ji 🙏', 'Koi bhi samasya ho to bejhijhak bataiye, hum dhyan se sunenge 🙏', 'Gaon sabka hai, aapki baat hum tak pahunchti rahe 🙏']
};
function splitSentences(text) { return String(text || '').match(/[^.?!।]+[.?!।]*\s*(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\s*)*/gu) || []; }

/** Strip every persuasion push from a reply; keep the respectful/informative part; never leave it empty. */
function gentle(text, l = 'hi') {
    const lang = l === 'hi' ? 'hi' : 'en';
    const parts = splitSentences(text);
    const kept = parts.filter(s => !PUSH_RX.test(s));
    let out = kept.join('').replace(/\s+/g, ' ').trim();
    if (out.length < 8 || kept.length < parts.length) {
        const pool = LISTEN[lang];
        const pick = pool.find(p => !out.includes(p)) || pool[0];
        out = out.length < 8 ? pick : (out + ' ' + pick);
    }
    return out;
}

function installGentleMode(brain) {
    if (!brain || brain.__gentleInstalled) return brain;
    const lOf = t => (/[\u0900-\u097F]/.test(String(t || '')) ? 'hi' : 'en');
    if (typeof brain.respond === 'function') {
        const orig = brain.respond;
        brain.respond = async function (message, user = {}, opts = {}) {
            const r = await orig.call(this, message, user, opts);
            if (r && r.text && isVirodhiUser(user)) { r.text = gentle(r.text, lOf(r.text)); r.gentle = true; }
            return r;
        };
    }
    if (typeof brain.respondSync === 'function') {
        const origS = brain.respondSync;
        brain.respondSync = function (message, user = {}, opts = {}) {
            const t = origS.call(this, message, user, opts);
            return (t && isVirodhiUser(user)) ? gentle(t, lOf(t)) : t;
        };
    }
    brain.__gentleInstalled = true;
    return brain;
}

function _reset() { state = null; }
module.exports = { FILE, isVirodhi, isVirodhiUser, addVirodhi, removeVirodhi, list, syncToMemory, gentle, installGentleMode, PUSH_RX, _reset };
