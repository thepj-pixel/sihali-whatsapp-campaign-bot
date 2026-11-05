// Single source of truth for "पिता" vs "पति" on the voter roll.
// voters_cleaned.json and the parcha CSV disagree on ~600 rows, so a label is
// only shown firmly when both agree; otherwise a woman's record shows "पिता/पति".
const fs = require('fs');
const path = require('path');

let CSV = null;
function loadCsv() {
    if (CSV) return CSV;
    CSV = new Map();
    const p = [path.join(__dirname, 'rag_vault', 'SIHALI_KHURD_VOTERS_AI_PERFECT.csv'), path.join(__dirname, 'SIHALI_KHURD_VOTERS_AI_PERFECT.csv')].find(f => fs.existsSync(f));
    if (!p) return CSV;
    try {
        const lines = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        const head = lines[0].split(',');
        const iw = head.indexOf('वार्ड_नं'), is = head.indexOf('मतदाता_क्र_Sr'), ir = head.indexOf('संबंध_Type');
        for (let i = 1; i < lines.length; i++) {
            const c = lines[i].split(',');
            if (c.length < 8) continue;
            CSV.set(`${parseInt(c[iw], 10)}-${parseInt(c[is], 10)}`, String(c[ir] || '').trim());
        }
    } catch (_) { /* keep empty */ }
    return CSV;
}

function norm(t) {
    const s = String(t || '').trim();
    if (s === 'H' || s === 'h' || s === 'पति') return 'पति';
    if (s === 'F' || s === 'f' || s === 'पिता') return 'पिता';
    if (s === 'M' || s === 'माता') return 'माता';
    return '';
}

const ROMAN = { 'पति': 'pati', 'पिता': 'pita', 'माता': 'mata', 'पिता/पति': 'pita/pati' };

function relLabel(v, en) {
    if (!v) return en ? 'pita/pati' : 'पिता/पति';
    const ward = parseInt(v.ward || v.w, 10), sr = parseInt(v.sr_no || v.s, 10);
    const a = norm(v.rt) || norm(v.rel_type);
    const b = norm(loadCsv().get(`${ward}-${sr}`));
    const female = /महिला|^f/i.test(String(v.gender || v.g || ''));
    let out;
    if (a && b && a === b) out = a;
    else if (!b && a) out = a;
    else if (!a && b) out = b;
    else out = female ? 'पिता/पति' : 'पिता';
    return en ? ROMAN[out] : out;
}

module.exports = { relLabel };
