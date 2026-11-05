const fs = require('fs');
const path = require('path');
const contactUtils = require('./contact_utils.js');

const DB_PATH = process.env.CONTACTS_DB_PATH || path.join(__dirname, 'contacts_db.json');
const LEGACY_VOTERS_PATH = path.join(__dirname, 'voters.json');
const VOTERS_PATH = process.env.VOTERS_PATH
    || (fs.existsSync(LEGACY_VOTERS_PATH) ? LEGACY_VOTERS_PATH : path.join(__dirname, 'voters_cleaned.json'));

class ContactsManager {
    constructor() {
        this.contacts = [];
        this.voters = [];
        this.loadVoters();
        this.load();
    }

    loadVoters() {
        try {
            this.voters = fs.existsSync(VOTERS_PATH) ? JSON.parse(fs.readFileSync(VOTERS_PATH, 'utf8')) : [];
        } catch (e) {
            console.error('[ContactsManager] Error loading voter list:', e.message);
            this.voters = [];
        }
    }

    normalizeName(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/\b(shri|smt|mr|mrs|ji|kumar|kumari)\b/g, ' ')
            .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    matchVoter(contact = {}) {
        const targetName = this.normalizeName(contact.name);
        if (!targetName || targetName === 'contact') return null;
        let matches = this.voters.filter(v => {
            const names = [v.name, v.name_hi, v.name_en, v.n, v.ne].map(value => this.normalizeName(value));
            return names.includes(targetName);
        });
        const requestedWard = Number(contact.ward);
        if (requestedWard > 0) {
            const sameWard = matches.filter(v => Number(v.ward || v.w) === requestedWard);
            if (sameWard.length) matches = sameWard;
        }
        if (matches.length !== 1) return null;
        const voter = matches[0];
        return {
            matched: true,
            voterId: voter.epic || voter.e || `W${voter.ward || voter.w}-${voter.sr_no || voter.s}`,
            epic: voter.epic || voter.e || '',
            serial: voter.sr_no || voter.s || '',
            ward: voter.ward || voter.w || '',
            booth: voter.booth || voter.b || '',
            voterName: voter.name || voter.name_hi || '',
            confidence: 'exact_name'
        };
    }

    load() {
        try {
            if (fs.existsSync(DB_PATH)) {
                const raw = fs.readFileSync(DB_PATH, 'utf8');
                this.contacts = JSON.parse(raw);
            } else {
                this.contacts = [];
                this.save();
            }
        } catch (e) {
            console.error('[ContactsManager] Error loading contacts_db.json:', e.message);
            this.contacts = [];
        }
    }

    save() {
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(this.contacts, null, 2), 'utf8');
        } catch (e) {
            console.error('[ContactsManager] Error saving contacts_db.json:', e.message);
        }
    }

    getAll(filter = {}) {
        let result = [...this.contacts];
        if (filter.line && filter.line !== 'all') {
            result = result.filter(c => c.line === filter.line);
        }
        if (filter.ward && filter.ward !== 'all') {
            result = result.filter(c => String(c.ward) === String(filter.ward));
        }
        if (filter.village && filter.village !== 'all') {
            result = result.filter(c => String(c.village || '').trim() === String(filter.village).trim());
        }
        if (filter.tag && filter.tag !== 'all') {
            const tags = String(filter.tag).split('||').map(t => t.trim()).filter(Boolean);
            result = result.filter(c => Array.isArray(c.tags) && c.tags.some(t => tags.includes(t)));
        }
        if (filter.search) {
            const q = filter.search.toLowerCase().trim();
            result = result.filter(c => 
                (c.name && c.name.toLowerCase().includes(q)) ||
                (c.phone && c.phone.includes(q)) ||
                (c.notes && c.notes.toLowerCase().includes(q))
            );
        }
        return result;
    }

    cleanPhone(raw) {
        if (!raw) return '';
        // Indian mobiles: tolerate +91, 0-prefix, spaces, dashes -> 91XXXXXXXXXX
        const indian = contactUtils.normalizeIndianPhone(raw);
        if (indian) return indian;
        let cleaned = String(raw).replace(/[^\d]/g, '');
        if (cleaned.length === 10) cleaned = '91' + cleaned;
        return cleaned;
    }

    add(contact) {
        const cleanedPhone = this.cleanPhone(contact.phone);
        if (!cleanedPhone) return null;

        const existingIdx = this.contacts.findIndex(c => c.phone === cleanedPhone);
        const contactObj = {
            id: contact.id || `c_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: contact.name || 'ग्रामवासी',
            phone: cleanedPhone,
            ward: parseInt(contact.ward) || null,
            village: contact.village || 'सिहाली खुर्द',
            line: contact.line || 'sim_636',
            notes: contact.notes || '',
            tags: contact.tags || ['नया संपर्क'],
            updatedAt: new Date().toISOString(),
            voterMatch: contact.voterMatch || this.matchVoter(contact)
        };

        if (existingIdx !== -1) {
            this.contacts[existingIdx] = { ...this.contacts[existingIdx], ...contactObj };
        } else {
            this.contacts.unshift(contactObj);
        }

        this.save();
        return contactObj;
    }

    delete(id) {
        const initialLen = this.contacts.length;
        this.contacts = this.contacts.filter(c => c.id !== id && c.phone !== id);
        if (this.contacts.length !== initialLen) {
            this.save();
            return true;
        }
        return false;
    }

    importFromVoterDB(ward = 'all', line = 'sim_636', limit = 100) {
        if (!fs.existsSync(VOTERS_PATH)) {
            throw new Error('Master voter list not found');
        }
        let target = this.voters;
        if (ward !== 'all') {
            target = target.filter(v => String(v.ward || v.w) === String(ward));
        }
        if (limit && limit > 0) {
            target = target.slice(0, limit);
        }

        let addedCount = 0;
        for (const v of target) {
            const name = v.name_hi || v.name || 'ग्रामवासी';
            const vWard = v.ward || v.w || 1;
            const epic = v.epic || v.e || '';
            const house = v.house_no || v.h || '';
            const relName = v.rel_name_hi || v.rel_name || '';

            const realPhone = this.cleanPhone(v.phone || v.mobile || '');
            if (!realPhone || realPhone.length < 10) continue;
            
            this.add({
                name: name,
                phone: realPhone,
                ward: vWard,
                village: v.village || 'सिहाली खुर्द',
                line: line,
                notes: `EPIC: ${epic} | मकान: ${house} | संबंधी: ${relName}`,
                tags: [`वार्ड ${vWard}`, '📋 वोटर लिस्ट'],
                voterMatch: {
                    matched: true,
                    voterId: epic || `W${vWard}-${v.sr_no || v.s}`,
                    epic,
                    serial: v.sr_no || v.s || '',
                    ward: vWard,
                    booth: v.booth || v.b || '',
                    voterName: name,
                    confidence: 'voter_database'
                }
            });
            addedCount++;
        }
        return addedCount;
    }

    parseVCF(vcfText) {
        const cards = vcfText.split(/BEGIN:VCARD/i).filter(c => c.trim().length > 0);
        const imported = [];

        for (const card of cards) {
            let name = '';
            let phone = '';
            let note = '';

            const fnMatch = card.match(/FN[;:]([^\r\n]+)/i);
            if (fnMatch) name = fnMatch[1].trim();

            const telMatch = card.match(/TEL[^:]*:([^\r\n]+)/i);
            if (telMatch) phone = telMatch[1].replace(/[^0-9]/g, '');

            const noteMatch = card.match(/NOTE[;:]([^\r\n]+)/i);
            if (noteMatch) note = noteMatch[1].trim();

            if (phone) {
                imported.push(this.add({
                    name: name || 'Contact',
                    phone: phone,
                    notes: note,
                    tags: ['📥 VCF Import']
                }));
            }
        }
        return imported;
    }

    /**
     * Flexible CSV import. Header columns are matched by name (phone/mobile/number, name/naam,
     * ward, village/gaon, notes). Without a header the phone-like column is used as the phone.
     * Accepts +91, 0-prefixed, spaced or 10-digit numbers. Invalid numbers are skipped.
     */
    parseCSV(csvText, opts = {}) {
        if (!csvText) return [];
        const rows = contactUtils.parseContactCsv(csvText);
        const imported = [];
        for (const r of rows) {
            const phone = contactUtils.normalizeIndianPhone(r.phone);
            if (!phone) continue;
            imported.push(this.add({
                name: r.name || 'ग्रामवासी',
                phone,
                ward: r.ward || null,
                village: r.village || undefined,
                line: opts.line,
                notes: r.notes || '',
                tags: opts.tags || ['📊 CSV Import']
            }));
        }
        return imported;
    }

    /** Add many {phone,name,ward,village} rows (manual paste). Returns added contacts. */
    addMany(rows = [], opts = {}) {
        const out = [];
        const prevSave = this.save;
        this.save = () => {};
        try {
            for (const r of rows) {
                const phone = contactUtils.normalizeIndianPhone(r.phone);
                if (!phone) continue;
                const existing = this.contacts.find(c => c.phone === phone);
                out.push(this.add({
                    ...(existing || {}),
                    name: r.name || existing?.name || 'ग्रामवासी',
                    phone,
                    ward: r.ward || existing?.ward || null,
                    village: r.village || existing?.village || undefined,
                    line: opts.line || existing?.line,
                    tags: existing?.tags || opts.tags || ['✍️ Manual Entry']
                }));
            }
        } finally {
            this.save = prevSave;
        }
        this.save();
        return out;
    }

    findByPhone(phone) {
        const p = this.cleanPhone(phone);
        return this.contacts.find(c => c.phone === p) || null;
    }

    /**
     * Plain dialer/IVR CSV (name, phone_10, phone_91, ward, village).
     * @param {object} filter  same filter as getAll (line, ward, village, search)
     * @param {(phone:string)=>boolean} [isExcluded]  e.g. opted-out check; excluded rows are dropped
     */
    generateDialerCSV(filter = {}, isExcluded = null, rows = null) {
        const list = (rows || this.getAll(filter)).filter(c => !(isExcluded && isExcluded(c.phone)));
        return contactUtils.buildDialerCsv(list);
    }

    parseCsvLine(line) {
        const result = [];
        let current = '';
        let quoted = false;
        for (let i = 0; i < String(line || '').length; i++) {
            const char = line[i];
            if (char === '"' && quoted && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (char === ',' && !quoted) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    }

    generateVCF(filter = {}) {
        const list = this.getAll(filter);
        let vcf = '';

        for (const c of list) {
            const formattedPhone = c.phone.startsWith('+') ? c.phone : '+' + c.phone;
            const displayName = `[SK26-W${c.ward || 'NA'}] ${c.name}`;
            vcf += `BEGIN:VCARD\r\n`;
            vcf += `VERSION:3.0\r\n`;
            vcf += `FN:${displayName}\r\n`;
            vcf += `N:${c.name};;;;\r\n`;
            vcf += `TEL;TYPE=CELL:${formattedPhone}\r\n`;
            vcf += `NOTE:वार्ड ${c.ward} | ${c.notes || ''} | बाबा अभय सिंह समर्थक\r\n`;
            vcf += `CATEGORIES:सिहाली खुर्द चुनाव 2026,बाबा अभय सिंह\r\n`;
            vcf += `END:VCARD\r\n`;
        }

        return vcf;
    }

    generateCSV(filter = {}) {
        const list = this.getAll(filter);
        let csv = 'Name,Phone,Ward,Village,Line,Notes,Tags\n';

        for (const c of list) {
            const safeName = `"${(c.name || '').replace(/"/g, '""')}"`;
            const safeNotes = `"${(c.notes || '').replace(/"/g, '""')}"`;
            const safeTags = `"${(c.tags || []).join('; ')}"`;
            csv += `${safeName},+${c.phone},${c.ward || ''},${c.village || 'सिहाली खुर्द'},${c.line || 'sim_636'},${safeNotes},${safeTags}\n`;
        }

        return csv;
    }
}

module.exports = new ContactsManager();
