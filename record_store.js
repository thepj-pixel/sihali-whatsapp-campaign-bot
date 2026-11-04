/**
 * Tiny durable JSON record store used for Samasya (problems voters report) and Mulaqat (requests to meet /
 * invite Abhay Singh ji home). One file per store, atomic write (tmp + rename), gitignored runtime data.
 *
 *   const s = new RecordStore({ file, prefix: 'S', statuses: ['new','in-progress','resolved'] })
 *   s.create({...}) -> record with id 'S-0001', createdAt (ISO), createdAtIST ('Wed 04 Nov 2026, 7:41 PM IST')
 *   s.update(id, patch) / s.get(id) / s.list({ village, ward, status, category, phone, q, includeTest })
 *   s.toCSV(filter) / s.remove(id) / s.removeWhere(fn)
 */
const fs = require('fs');
const path = require('path');

function istString(d = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d) + ' IST';
    } catch (e) { return d.toISOString(); }
}

function csvCell(v) {
    if (v === undefined || v === null) return '';
    const s = Array.isArray(v) ? v.join('; ') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

class RecordStore {
    constructor({ file, prefix, statuses, columns }) {
        this.file = file;
        this.prefix = prefix;
        this.statuses = statuses;
        this.columns = columns;
        this.data = this._load();
    }
    _load() {
        try {
            if (fs.existsSync(this.file)) {
                const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (d && Array.isArray(d.records)) return { seq: d.seq || d.records.length, records: d.records };
            }
        } catch (e) { console.warn(`[RecordStore] could not read ${path.basename(this.file)}:`, e.message); }
        return { seq: 0, records: [] };
    }
    reload() { this.data = this._load(); return this; }
    _save() {
        try {
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (e) { console.warn(`[RecordStore] could not write ${path.basename(this.file)}:`, e.message); }
    }
    create(fields = {}) {
        this.data.seq = (this.data.seq || 0) + 1;
        const now = new Date();
        const rec = {
            id: `${this.prefix}-${String(this.data.seq).padStart(4, '0')}`,
            ...fields,
            status: this.statuses.includes(fields.status) ? fields.status : this.statuses[0],
            createdAt: now.toISOString(),
            createdAtIST: istString(now),
            updatedAt: now.toISOString(),
            history: [{ at: now.toISOString(), status: this.statuses.includes(fields.status) ? fields.status : this.statuses[0], by: fields.source || 'bot' }]
        };
        this.data.records.push(rec);
        this._save();
        return rec;
    }
    get(id) { return this.data.records.find(r => r.id === id) || null; }
    update(id, patch = {}, by = 'dashboard') {
        const r = this.get(id);
        if (!r) return null;
        const prevStatus = r.status;
        for (const [k, v] of Object.entries(patch)) {
            if (['id', 'createdAt', 'createdAtIST', 'history'].includes(k)) continue;
            if (k === 'status' && !this.statuses.includes(v)) continue;
            if (v === undefined) continue;
            r[k] = v;
        }
        r.updatedAt = new Date().toISOString();
        if (patch.status && patch.status !== prevStatus && this.statuses.includes(patch.status)) {
            r.history = (r.history || []).concat([{ at: r.updatedAt, status: patch.status, by }]).slice(-20);
        }
        this._save();
        return r;
    }
    remove(id) {
        const n = this.data.records.length;
        this.data.records = this.data.records.filter(r => r.id !== id);
        if (this.data.records.length !== n) { this._save(); return true; }
        return false;
    }
    removeWhere(fn) {
        const before = this.data.records.length;
        this.data.records = this.data.records.filter(r => !fn(r));
        const removed = before - this.data.records.length;
        if (removed) this._save();
        return removed;
    }
    list(f = {}) {
        let rs = this.data.records.slice();
        if (!f.includeTest) rs = rs.filter(r => !r.test);
        if (f.onlyTest) rs = this.data.records.filter(r => r.test);
        if (f.status) rs = rs.filter(r => r.status === f.status);
        if (f.village) rs = rs.filter(r => r.village === f.village);
        if (f.ward) rs = rs.filter(r => String(r.ward || '') === String(f.ward));
        if (f.category) rs = rs.filter(r => r.category === f.category);
        if (f.phone) rs = rs.filter(r => String(r.phone) === String(f.phone));
        if (f.q) { const q = String(f.q).toLowerCase(); rs = rs.filter(r => JSON.stringify(r).toLowerCase().includes(q)); }
        return rs.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || String(b.id).localeCompare(String(a.id)));
    }
    openForPhone(phone) { return this.data.records.filter(r => String(r.phone) === String(phone) && r.status !== this.statuses[this.statuses.length - 1] && r.status !== 'cancelled'); }
    counts(dayIst = null) {
        const out = { total: 0, byStatus: {}, today: 0 };
        for (const r of this.data.records) {
            if (r.test) continue;
            out.total++;
            out.byStatus[r.status] = (out.byStatus[r.status] || 0) + 1;
            if (dayIst && istDay(r.createdAt) === dayIst) out.today++;
        }
        return out;
    }
    toCSV(f = {}) {
        const cols = this.columns;
        const lines = [cols.join(',')];
        for (const r of this.list(f)) lines.push(cols.map(c => csvCell(r[c])).join(','));
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }
}

function istDay(iso) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso)); } catch (e) { return String(iso).slice(0, 10); }
}

module.exports = { RecordStore, istString, istDay, csvCell };
