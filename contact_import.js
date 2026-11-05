/**
 * Contact import for bulk campaigns (6 Nov 2026): one entry point for whatever file the operator has.
 *
 *   .csv / .txt  any headers (Name / Mobile / Phone / Number / नाम / मोबाइल / Google "Phone 1 - Value",
 *                First+Last name …), or no header at all; comma / tab / semicolon
 *   .xlsx        first sheet, read with a tiny built-in zip+XML reader (no npm dependency)
 *   .vcf         phone exports (Android/iPhone): FN or N, several TEL lines, QUOTED-PRINTABLE Hindi names,
 *                folded lines
 *   pasted text  one contact per line ("Ram Lal 98765 43210", "98765-43210, Ram", several numbers per line)
 *
 * Numbers: +91 / 0 / 0091 prefixes, spaces, dashes, brackets, Excel numbers (9.87654321E9) → 91XXXXXXXXXX.
 * Anything that is not an Indian mobile is reported as invalid (never imported).
 * analyze() is a dry run: valid / invalid / duplicates in file / already saved / opted-out / virodhi / voter-roll
 * matches. commit() saves with a batch tag (default "📥 Bulk 6 Nov") so the audience can be picked by tag;
 * deleteBatch() undoes an import (contacts it created are removed, the tag is taken off the others).
 */
const zlib = require('zlib');
const contactUtils = require('./contact_utils.js');

const MAX_ROWS = 5000;
const PLACEHOLDER_NAMES = new Set(['', 'ग्रामवासी', 'contact', 'test', 'unknown']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function istParts(now = new Date()) {
    const d = new Date(now.getTime() + 5.5 * 3600e3);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}
/** "📥 Bulk 6 Nov" for the IST date (or the given YYYY-MM-DD). */
function defaultTag(date) {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { const [, m, d] = date.split('-').map(Number); return `📥 Bulk ${d} ${MONTHS[m - 1]}`; }
    const p = istParts(); return `📥 Bulk ${p.d} ${MONTHS[p.m]}`;
}
function cleanTag(t) { return String(t || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); }

// ---------------- XML / XLSX ----------------
function xmlDecode(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
        const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    });
}

/** Minimal zip reader: { name -> Buffer } (stored + deflate). */
function unzip(buf) {
    const files = {};
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory missing). Save it again from Excel, or as CSV.');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;
        if (buf.readUInt32LE(local) !== 0x04034b50) continue;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.slice(start, start + csize);
        try { files[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null; } catch (_) { files[name] = null; }
    }
    return files;
}

function colIndex(ref) { const m = String(ref || '').match(/^([A-Z]+)/i); if (!m) return -1; let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function numToText(v) {
    const s = String(v).trim();
    if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(s)) { const n = Number(s); if (Number.isFinite(n)) return BigInt(Math.round(n)).toString(); }
    if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
    return s;
}

/** First worksheet of an .xlsx buffer → array of rows (arrays of strings). */
function xlsxToTable(buf) {
    const files = unzip(buf);
    const shared = [];
    const ss = files['xl/sharedStrings.xml'];
    if (ss) for (const si of ss.toString('utf8').match(/<si\b[\s\S]*?<\/si>/g) || []) {
        shared.push(xmlDecode((si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<t\b[^>]*>|<\/t>/g, '')).join('')));
    }
    let sheetName = null;
    try {
        const wb = files['xl/workbook.xml'].toString('utf8');
        const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
        const first = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
        if (first) { const rel = rels.match(new RegExp('<Relationship\\b[^>]*Id="' + first[1] + '"[^>]*Target="([^"]+)"')) || rels.match(new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + first[1] + '"')); if (rel) sheetName = 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, ''); }
    } catch (_) {}
    if (!sheetName || !files[sheetName]) sheetName = Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
    if (!sheetName || !files[sheetName]) throw new Error('No worksheet found in the .xlsx file');
    const xml = files[sheetName].toString('utf8');
    const table = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
        const out = [];
        let auto = 0;
        for (const c of row.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) || []) {
            const attrs = c.match(/^<c\b([^>]*)>/) ? c.match(/^<c\b([^>]*)>/)[1] : c;
            const ref = (attrs.match(/\br="([^"]+)"/) || [])[1];
            const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
            const idx = ref ? colIndex(ref) : auto;
            auto = idx + 1;
            let v = '';
            if (t === 'inlineStr') v = xmlDecode((c.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(x => x.replace(/<t\b[^>]*>|<\/t>/g, '')).join(''));
            else {
                const vm = c.match(/<v>([\s\S]*?)<\/v>/);
                v = vm ? xmlDecode(vm[1]) : '';
                if (t === 's') v = shared[Number(v)] || '';
                else if (t === 'n') v = numToText(v);
            }
            out[idx] = String(v).trim();
        }
        for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
        if (out.some(Boolean)) table.push(out);
        if (table.length > MAX_ROWS + 1) break;
    }
    return table;
}

// ---------------- tables (CSV / XLSX) ----------------
const normHead = h => String(h || '').toLowerCase().replace(/[._:#()\-]+/g, ' ').replace(/\s+/g, ' ').trim();
const PHONE_HEAD = /(^|\s)(phone|mobile|mob|mobile no|number|no|contact|cell|whatsapp|tel|telephone)(\s|$)|फोन|फ़ोन|मोबाइल|नंबर|नम्बर|संपर्क/;
const VALUE_TYPE_HEAD = /(phone|mobile)\s*\d*\s*(type|label)/;
const NOT_PHONE_HEAD = /^(s|sr|sl|serial|sno|srno|क्र|क्रम)(\s|$)|house|मकान|epic|ward|वार्ड|booth|बूथ|age|आयु|उम्र|pin/;
const NAME_HEAD = /(^|\s)(name|naam|full name|contact name|display name|voter name)(\s|$)|नाम/;
const RELATION_HEAD = /father|husband|pita|pati|पिता|पति|relation|संबंधी|guardian/;
const FIRST_HEAD = /^(first name|given name)$/, MIDDLE_HEAD = /^(middle name|additional name)$/, LAST_HEAD = /^(last name|family name|surname)$/;
const WARD_HEAD = /(^|\s)ward(\s|$)|वार्ड/, VILLAGE_HEAD = /village|gaon|gram|गाँव|गांव|ग्राम/, NOTES_HEAD = /^(notes?|remarks?|टिप्पणी|नोट)$/;
const looksPhone = v => String(v || '').replace(/[^\d]/g, '').length >= 10 && /^[+\d\s()\-.:eE]+$/.test(String(v || '').split(':::')[0].trim());

function mapHeader(head) {
    const h = head.map(normHead);
    const idx = { phones: [], name: -1, first: -1, middle: -1, last: -1, ward: -1, village: -1, notes: -1 };
    h.forEach((x, i) => {
        if (!x) return;
        if (VALUE_TYPE_HEAD.test(x)) return;
        if (NOT_PHONE_HEAD.test(x) && !NAME_HEAD.test(x)) { if (WARD_HEAD.test(x) && idx.ward === -1) idx.ward = i; return; }
        if (FIRST_HEAD.test(x)) idx.first = i;
        else if (MIDDLE_HEAD.test(x)) idx.middle = i;
        else if (LAST_HEAD.test(x)) idx.last = i;
        else if (PHONE_HEAD.test(x) && !NAME_HEAD.test(x.replace(/number|no/g, ''))) idx.phones.push(i);
        else if (NAME_HEAD.test(x) && !RELATION_HEAD.test(x) && idx.name === -1) idx.name = i;
        else if (WARD_HEAD.test(x) && idx.ward === -1) idx.ward = i;
        else if (VILLAGE_HEAD.test(x) && idx.village === -1) idx.village = i;
        else if (NOTES_HEAD.test(x) && idx.notes === -1) idx.notes = i;
    });
    return idx;
}

/** Rows (arrays) → [{phone (raw), name, ward, village, notes}] */
function tableToContacts(table) {
    const rows = table.filter(r => r && r.some(c => String(c || '').trim()));
    if (!rows.length) return [];
    // header = first of the first 3 rows that has a phone/name column and no phone-looking cell
    let hi = -1, idx = null;
    for (let i = 0; i < Math.min(3, rows.length); i++) {
        if (rows[i].some(looksPhone)) continue;
        const m = mapHeader(rows[i]);
        if (m.phones.length || m.name !== -1 || m.first !== -1) { hi = i; idx = m; break; }
    }
    const out = [];
    for (let i = hi + 1; i < rows.length && out.length < MAX_ROWS; i++) {
        const cols = rows[i].map(c => String(c === undefined || c === null ? '' : c).trim());
        let phone = '', name = '', ward = '', village = '', notes = '';
        if (idx && idx.phones.length) {
            const cands = [];
            for (const pi of idx.phones) for (const part of String(cols[pi] || '').split(/:::|\/|;|,(?=\s*\+?\d)/)) if (part.trim()) cands.push(part.trim());
            phone = cands.find(p => contactUtils.normalizeIndianPhone(p)) || cands[0] || '';
            if (!phone) { const any = cols.find(looksPhone); if (any) phone = any; }
            name = idx.name !== -1 ? cols[idx.name] : [idx.first, idx.middle, idx.last].filter(k => k !== -1).map(k => cols[k]).filter(Boolean).join(' ');
            ward = idx.ward !== -1 ? cols[idx.ward] : '';
            village = idx.village !== -1 ? cols[idx.village] : '';
            notes = idx.notes !== -1 ? cols[idx.notes] : '';
        } else {
            const pi = cols.findIndex(looksPhone);
            phone = pi === -1 ? (cols.find(c => /\d{6,}/.test(c)) || cols[0] || '') : cols[pi];
            const rest = cols.filter((_, j) => j !== pi);
            if (idx && (idx.name !== -1 || idx.first !== -1)) name = idx.name !== -1 ? cols[idx.name] : [idx.first, idx.middle, idx.last].filter(k => k !== -1).map(k => cols[k]).filter(Boolean).join(' ');
            else name = rest.find(c => c && !/^[\d\s+\-().]+$/.test(c)) || '';
            const w = rest.find(c => /^\d{1,2}$/.test(c));
            ward = w || '';
        }
        out.push({ phone: numToText(phone), name: cleanName(name), ward: /^\d{1,2}$/.test(String(ward).trim()) ? String(ward).trim() : '', village: String(village || '').slice(0, 40), notes: String(notes || '').slice(0, 200) });
    }
    return out;
}

function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }

// ---------------- VCF ----------------
function decodeQP(s, charset) {
    const bytes = [];
    const str = String(s).replace(/=\r?\n/g, '');
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '=' && /^[0-9A-F]{2}$/i.test(str.substr(i + 1, 2))) { bytes.push(parseInt(str.substr(i + 1, 2), 16)); i += 2; }
        else { const b = Buffer.from(str[i], 'utf8'); for (const x of b) bytes.push(x); }
    }
    return Buffer.from(bytes).toString(/latin|8859/i.test(charset || '') ? 'latin1' : 'utf8');
}
function vcfValue(line) {
    const i = line.indexOf(':');
    if (i < 0) return '';
    const params = line.slice(0, i);
    let v = line.slice(i + 1);
    if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/i.test(params)) v = decodeQP(v, (params.match(/CHARSET=([^;:]+)/i) || [])[1]);
    return v.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').trim();
}
function parseVcf(text) {
    // unfold: RFC folding (CRLF + space) and QP soft breaks (= at line end)
    let s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    s = s.replace(/=\n(?=[^\n])/g, '=\n'); // keep QP soft breaks for decodeQP, join below
    const lines = [];
    for (const raw of s.split('\n')) {
        if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
        else if (lines.length && /ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]) && /=$/.test(lines[lines.length - 1])) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + raw;
        else lines.push(raw);
    }
    const out = [];
    let card = null;
    for (const l of lines) {
        if (/^BEGIN:VCARD/i.test(l)) { card = { fn: '', n: '', tels: [], note: '' }; continue; }
        if (/^END:VCARD/i.test(l)) {
            if (card) {
                const nParts = card.n.split(';').map(x => x.trim());
                const name = card.fn || [nParts[3], nParts[1], nParts[2], nParts[0], nParts[4]].filter(Boolean).join(' ');
                const phone = card.tels.find(t => contactUtils.normalizeIndianPhone(t)) || card.tels[0] || '';
                if (phone || name) out.push({ phone, name: cleanName(name), ward: '', village: '', notes: card.note.slice(0, 200) });
            }
            card = null; if (out.length >= MAX_ROWS) break; continue;
        }
        if (!card) continue;
        const key = l.split(/[;:]/)[0].replace(/^item\d+\./i, '').toUpperCase();
        if (key === 'FN') card.fn = vcfValue(l);
        else if (key === 'N') card.n = vcfValue(l);
        else if (key === 'TEL') { const v = vcfValue(l).replace(/^tel:/i, ''); if (v) card.tels.push(v); }
        else if (key === 'NOTE') card.note = vcfValue(l);
    }
    return out;
}

// ---------------- entry point ----------------
/**
 * @param {{fileName?, fileText?, fileBase64?, text?}} input
 * @returns {{format, rows, error?}}
 */
function parseInput(input = {}) {
    const name = String(input.fileName || '').toLowerCase();
    const rows = [];
    const formats = [];
    if (input.fileBase64 || input.fileText) {
        let buf = null, text = input.fileText || '';
        if (input.fileBase64) { buf = Buffer.from(String(input.fileBase64).replace(/^data:[^,]*,/, ''), 'base64'); }
        const isZip = buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
        if (/\.xls$/.test(name) && !isZip) throw new Error('Old .xls files are not supported — open it in Excel/Sheets and "Save as" .xlsx or .csv.');
        if (/\.(xlsx|xlsm)$/.test(name) || isZip) { rows.push(...tableToContacts(xlsxToTable(buf || Buffer.from(text, 'binary')))); formats.push('xlsx'); }
        else {
            if (buf) {
                text = buf.toString('utf8');
                if (/^\uFFFD|\u0000/.test(text.slice(0, 4)) || (buf[0] === 0xff && buf[1] === 0xfe)) text = buf.toString('utf16le');
            }
            text = text.replace(/^\uFEFF/, '');
            if (/\.vcf$/.test(name) || /BEGIN:VCARD/i.test(text)) { rows.push(...parseVcf(text)); formats.push('vcf'); }
            else { const delim = contactUtils.detectDelimiter(text.split(/\r?\n/).find(l => l.trim()) || ''); rows.push(...tableToContacts(text.split(/\r?\n/).filter(l => l.trim()).map(l => contactUtils.parseCsvLine(l, delim)))); formats.push('csv'); }
        }
    }
    if (input.text && String(input.text).trim()) {
        const t = String(input.text);
        if (/BEGIN:VCARD/i.test(t)) { rows.push(...parseVcf(t)); formats.push('vcf-paste'); }
        else { rows.push(...contactUtils.parsePastedContacts(t).map(r => ({ ...r, name: cleanName(r.name) }))); formats.push('paste'); }
    }
    return { format: formats.join('+') || 'empty', rows: rows.slice(0, MAX_ROWS) };
}

/**
 * Dry run. deps: { contactsManager?, isOptedOut?(phone91), isVirodhi?(phone91), matchVoter?(row) }
 */
function analyze(rows, deps = {}) {
    const seen = new Map();
    const valid = [], invalid = [];
    let duplicates = 0;
    for (const r of rows) {
        const raw = String(r.phone || '').trim();
        const phone = contactUtils.normalizeIndianPhone(raw);
        if (!phone) { invalid.push({ raw: raw.slice(0, 30), name: r.name || '', reason: !raw ? 'no_number' : (raw.replace(/\D/g, '').length < 10 ? 'too_short' : 'not_indian_mobile') }); continue; }
        if (seen.has(phone)) { duplicates++; const first = seen.get(phone); if (!first.name && r.name) first.name = r.name; continue; }
        const row = { phone, name: cleanName(r.name), ward: r.ward || '', village: r.village || '', notes: r.notes || '' };
        seen.set(phone, row);
        valid.push(row);
    }
    let alreadySaved = 0, optedOut = 0, virodhi = 0, voterMatched = 0;
    for (const v of valid) {
        const ex = deps.contactsManager ? deps.contactsManager.findByPhone(v.phone) : null;
        if (ex) { v.existing = true; alreadySaved++; }
        try { if (deps.isOptedOut && deps.isOptedOut(v.phone)) { v.optedOut = true; optedOut++; } } catch (_) {}
        try { if (deps.isVirodhi && deps.isVirodhi(v.phone)) { v.virodhi = true; virodhi++; } } catch (_) {}
        try {
            const m = v.name && deps.matchVoter ? deps.matchVoter({ name: v.name, ward: v.ward }) : null;
            if (m && m.matched) { v.voterMatch = m; voterMatched++; if (!v.ward && m.ward) v.ward = String(m.ward); }
        } catch (_) {}
    }
    return {
        total: rows.length, valid, invalid, duplicates,
        counts: { rows: rows.length, valid: valid.length, invalid: invalid.length, duplicatesInFile: duplicates, alreadySaved, newContacts: valid.length - alreadySaved, optedOut, virodhi, voterMatched, sendable: valid.filter(v => !v.optedOut && !v.virodhi).length }
    };
}

function mask(p) { return p ? p.slice(0, 4) + '…' + p.slice(-3) : ''; }
function summary(a, { tag, format } = {}) {
    return {
        format, tag, counts: a.counts,
        sample: a.valid.slice(0, 8).map(v => ({ phone: mask(v.phone), name: v.name, ward: v.ward || '', voter: v.voterMatch ? (v.voterMatch.voterName || 'match') : '', flags: [v.existing ? 'saved' : 'new', v.optedOut ? 'STOP' : '', v.virodhi ? 'virodhi' : ''].filter(Boolean).join(' ') })),
        invalidSample: a.invalid.slice(0, 10)
    };
}

/** Save valid rows with the batch tag. Existing contacts keep their data and just get the tag (and a name if they had none). */
function commit(a, { contactsManager, tag, line } = {}) {
    const t = cleanTag(tag) || defaultTag();
    let created = 0, tagged = 0;
    const prevSave = contactsManager.save;
    contactsManager.save = () => {};
    try {
        for (const v of a.valid) {
            const ex = contactsManager.findByPhone(v.phone);
            if (ex) {
                const tags = Array.isArray(ex.tags) ? ex.tags.slice() : [];
                if (!tags.includes(t)) tags.push(t);
                ex.tags = tags;
                if (v.name && PLACEHOLDER_NAMES.has(String(ex.name || '').trim().toLowerCase())) ex.name = v.name;
                if (!ex.ward && v.ward) ex.ward = parseInt(v.ward) || null;
                if (!ex.voterMatch && v.voterMatch) ex.voterMatch = v.voterMatch;
                ex.updatedAt = new Date().toISOString();
                tagged++;
            } else {
                const c = contactsManager.add({ name: v.name || 'ग्रामवासी', phone: v.phone, ward: v.ward || null, village: v.village || undefined, line: line || undefined, notes: v.notes || '', tags: [t], voterMatch: v.voterMatch || undefined });
                if (c) { c.importBatch = t; created++; }
            }
        }
    } finally { contactsManager.save = prevSave; }
    contactsManager.save();
    return { tag: t, created, tagged, total: created + tagged };
}

/** Undo an import: delete the contacts this batch created, untag the rest. */
function deleteBatch(contactsManager, tag) {
    const t = cleanTag(tag);
    if (!t) throw new Error('tag required');
    let removed = 0, untagged = 0;
    contactsManager.contacts = contactsManager.contacts.filter(c => {
        if (c.importBatch === t) { removed++; return false; }
        if (Array.isArray(c.tags) && c.tags.includes(t)) { c.tags = c.tags.filter(x => x !== t); untagged++; }
        return true;
    });
    contactsManager.save();
    return { tag: t, removed, untagged };
}

function tagCounts(contacts) {
    const m = {};
    for (const c of contacts || []) for (const t of (c.tags || [])) m[t] = (m[t] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

module.exports = { parseInput, parseVcf, xlsxToTable, tableToContacts, unzip, analyze, summary, commit, deleteBatch, tagCounts, defaultTag, cleanTag, decodeQP };
