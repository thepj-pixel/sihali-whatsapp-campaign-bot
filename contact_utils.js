/**
 * Shared phone / CSV helpers used by contacts_manager.js and broadcast_engine.js.
 * Pure functions, no I/O.
 */

/** Normalise an Indian mobile number to 91XXXXXXXXXX. Returns null if it is not a valid Indian mobile. */
function normalizeIndianPhone(raw) {
    if (raw === null || raw === undefined) return null;
    let d = String(raw).replace(/[^\d]/g, '');
    if (!d) return null;
    if (d.startsWith('00')) d = d.slice(2);                       // 0091...
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);     // 09876543210
    if (d.length === 10) d = '91' + d;                            // 9876543210
    if (d.length === 13 && d.startsWith('910')) d = '91' + d.slice(3); // +91 0 9876543210
    if (d.length !== 12 || !d.startsWith('91')) return null;
    if (!/^[6-9]$/.test(d[2])) return null;                       // Indian mobiles start 6-9
    if (/^(\d)\1+$/.test(d.slice(2))) return null;                // 9999999999
    return d;
}

function toTenDigit(phone91) {
    const p = normalizeIndianPhone(phone91);
    return p ? p.slice(2) : '';
}

function detectDelimiter(line) {
    const s = String(line || '');
    if (s.includes(',')) return ',';
    if (s.includes('\t')) return '\t';
    if (s.includes(';')) return ';';
    return ',';
}

function parseCsvLine(line, delim) {
    const d = delim || detectDelimiter(line);
    const out = [];
    let cur = '';
    let q = false;
    const s = String(line || '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') q = false;
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === d) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out.map(x => x.trim());
}

const HEADER_ALIASES = {
    phone: ['phone', 'mobile', 'number', 'mobile number', 'mobile no', 'mobile_no', 'phone number', 'phone_no', 'phone no', 'whatsapp', 'whatsapp number', 'contact', 'contact number', 'mob', 'mob no', 'फोन', 'मोबाइल', 'नंबर', 'मोबाइल नंबर', 'phone_91', 'phone_10'],
    name: ['name', 'naam', 'full name', 'full_name', 'voter name', 'नाम', 'मतदाता का नाम', 'contact name'],
    ward: ['ward', 'ward no', 'ward_no', 'ward number', 'वार्ड', 'वार्ड नं', 'वार्ड संख्या'],
    village: ['village', 'gaon', 'gram', 'गाँव', 'गांव', 'ग्राम', 'village name'],
    notes: ['notes', 'note', 'remarks', 'remark', 'टिप्पणी', 'नोट']
};

function headerIndex(cols, key) {
    return cols.findIndex(h => HEADER_ALIASES[key].includes(h.toLowerCase().replace(/\s+/g, ' ').trim()));
}

const looksLikePhone = v => String(v || '').replace(/[^\d]/g, '').length >= 10;

/**
 * Parse a contact CSV with flexible columns. Header names are matched case-insensitively
 * (phone/mobile/number, name, ward, village …). Without a header, the first phone-like
 * column is the phone and the first non-numeric column is the name; a small number column is the ward.
 * Returns [{ phone (raw), name, ward, village }].
 */
function parseContactCsv(csvText) {
    const lines = String(csvText || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const delim = detectDelimiter(lines[0]);
    const head = parseCsvLine(lines[0], delim);
    let idx = { phone: headerIndex(head, 'phone'), name: headerIndex(head, 'name'), ward: headerIndex(head, 'ward'), village: headerIndex(head, 'village'), notes: headerIndex(head, 'notes') };
    const hasHeader = Object.values(idx).some(i => i !== -1) && !head.some(looksLikePhone);
    let start = hasHeader ? 1 : 0;
    const rows = [];
    for (let i = start; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i], delim);
        if (!cols.some(Boolean)) continue;
        let phone = '', name = '', ward = '', village = '', notes = '';
        if (hasHeader && idx.phone !== -1) {
            phone = cols[idx.phone] || '';
            name = idx.name !== -1 ? (cols[idx.name] || '') : '';
            ward = idx.ward !== -1 ? (cols[idx.ward] || '') : '';
            village = idx.village !== -1 ? (cols[idx.village] || '') : '';
            notes = idx.notes !== -1 ? (cols[idx.notes] || '') : '';
        } else {
            const pi = cols.findIndex(looksLikePhone);
            phone = pi === -1 ? (cols[0] || '') : cols[pi];
            const rest = cols.filter((_, j) => j !== pi);
            name = rest.find(c => c && !/^\d+$/.test(c)) || '';
            const w = rest.find(c => /^\d{1,2}$/.test(c));
            ward = w || '';
            const others = rest.filter(c => c && c !== name && c !== w);
            village = others.find(c => !/^\d+$/.test(c) && c.length <= 40 && !/[|:]/.test(c)) || '';
        }
        rows.push({ phone, name, ward, village, notes });
    }
    return rows;
}

/**
 * Parse pasted lines. Each line may be "9876543210", "9876543210, Ram Lal, 5, सिहाली खुर्द",
 * "Ram Lal - +91 98765 43210", or several comma-separated numbers.
 */
function parsePastedContacts(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map(x => (x && typeof x === 'object')
            ? { phone: x.phone || x.mobile || x.number || '', name: x.name || '', ward: x.ward || '', village: x.village || '' }
            : { phone: String(x), name: '', ward: '', village: '' });
    }
    const out = [];
    for (let line of String(input).split(/\r?\n/)) {
        line = line.trim();
        if (!line) continue;
        const parts = parseCsvLine(line).filter(Boolean);
        if (parts.length > 1 && parts.every(p => /^[+\d\s()-]{10,}$/.test(p))) {
            parts.forEach(p => out.push({ phone: p, name: '', ward: '', village: '' }));
            continue;
        }
        if (parts.length > 1) {
            const [row] = parseContactCsv(line);
            if (row) { out.push(row); continue; }
        }
        const m = line.match(/(\+?\d[\d\s()-]{8,}\d)/);
        if (!m) { out.push({ phone: line, name: '', ward: '', village: '' }); continue; }
        const name = line.replace(m[1], '').replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '').trim();
        out.push({ phone: m[1], name, ward: '', village: '' });
    }
    return out;
}

function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Plain dialer / IVR CSV: name, phone_10, phone_91, ward, village. Skips non-Indian-mobile numbers. */
function buildDialerCsv(rows) {
    const seen = new Set();
    const lines = ['name,phone_10,phone_91,ward,village'];
    for (const r of rows) {
        const p = normalizeIndianPhone(r.phone);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        lines.push([r.name || '', p.slice(2), p, r.ward || '', r.village || ''].map(csvEscape).join(','));
    }
    return { csv: '\uFEFF' + lines.join('\n') + '\n', count: lines.length - 1 };
}

module.exports = { detectDelimiter, normalizeIndianPhone, toTenDigit, parseCsvLine, parseContactCsv, parsePastedContacts, buildDialerCsv, csvEscape };
