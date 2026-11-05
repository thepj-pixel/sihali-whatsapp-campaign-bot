/**
 * One identity for a voter across every dashboard tab.
 *  - normalizePhone(): the ONLY phone format the dashboard shows: Indian mobiles as 91XXXXXXXXXX,
 *    other countries as full international digits (e.g. 14502790497). WhatsApp JIDs
 *    ("916367810227:8@s.whatsapp.net") are reduced to the number; @lid ids are not phones -> ''.
 *  - nameFor(): one name source of truth: the operator-saved contact name (Contacts book) when it is a real
 *    name, else the voter-memory name, else the WhatsApp profile name. Placeholders (ग्रामवासी/Contact/Voter) never win.
 *  - harmonize(): walks an API payload and rewrites every {phone, name} record to that identity.
 */
const contactUtils = require('./contact_utils.js');

const PLACEHOLDER = /^(ग्रामवासी|ग्रामवासी जी|contact|voter|unknown|भाई जी|-|—)?$/i;

function normalizePhone(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim();
    if (!s) return '';
    if (/@lid\b/i.test(s) || /@g\.us\b/i.test(s) || /@broadcast\b/i.test(s)) return '';
    s = s.split('@')[0].split(':')[0];
    const indian = contactUtils.normalizeIndianPhone(s);
    if (indian) return indian;
    let d = s.replace(/[^\d]/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 10) return '91' + d;           // legacy rule (user_memory.cleanPhone) kept for 10-digit input
    if (d.length >= 11 && d.length <= 15) return d;  // international (e.g. +1 450 279 0497 -> 14502790497)
    return '';
}

function isRealName(n) {
    const v = String(n || '').trim();
    return !!v && !PLACEHOLDER.test(v) && !/^\+?\d[\d\s-]{6,}$/.test(v);
}

function makeResolver({ contactsManager, userMemory, voterMemory }) {
    function nameFor(phone, fallback) {
        const p = normalizePhone(phone);
        if (!p) return isRealName(fallback) ? String(fallback).trim() : '';
        try {
            const c = contactsManager && contactsManager.findByPhone(p);
            if (c && isRealName(c.name)) return String(c.name).trim();
        } catch (e) {}
        const u = userMemory && userMemory.users && userMemory.users[p];
        if (u) {
            let mm = null;
            mm = u.memory && typeof u.memory === 'object' ? u.memory : null; // read-only (no ensure() mutation)
            if (mm && isRealName(mm.name)) return String(mm.name).trim();
            if (isRealName(u.name)) return String(u.name).trim();
            if (u.lastFoundVoter && isRealName(u.lastFoundVoter.name_hi || u.lastFoundVoter.name)) return String(u.lastFoundVoter.name_hi || u.lastFoundVoter.name).trim();
            if (isRealName(u.pushName)) return String(u.pushName).trim();
        }
        return isRealName(fallback) ? String(fallback).trim() : '';
    }

    /** Deep-copies payload and rewrites phone/name on every record that has a phone. */
    function harmonize(payload, { addName = false } = {}) {
        const data = JSON.parse(JSON.stringify(payload === undefined ? null : payload));
        const walk = (o, depth) => {
            if (!o || typeof o !== 'object' || depth > 8) return;
            if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
            if (typeof o.phone === 'string' || typeof o.phone === 'number') {
                const p = normalizePhone(o.phone);
                if (p) {
                    o.phone = p;
                    if ('name' in o || addName) {
                        const n = nameFor(p, o.name);
                        if (n) o.name = n;
                    }
                }
            }
            for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
        };
        walk(data, 0);
        return data;
    }
    return { nameFor, harmonize, normalizePhone };
}

module.exports = { normalizePhone, isRealName, makeResolver };
