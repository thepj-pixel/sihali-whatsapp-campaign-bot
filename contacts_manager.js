const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'contacts_db.json');
const VOTERS_PATH = path.join(__dirname, 'voters.json');

class ContactsManager {
    constructor() {
        this.contacts = [];
        this.load();
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
            ward: parseInt(contact.ward) || 1,
            village: contact.village || 'सिहाली खुर्द',
            line: contact.line || 'sim_636',
            notes: contact.notes || '',
            tags: contact.tags || ['नया संपर्क'],
            updatedAt: new Date().toISOString()
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
        const voters = JSON.parse(fs.readFileSync(VOTERS_PATH, 'utf8'));
        let target = voters;
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

            const pseudoPhone = v.phone || `9198${String(vWard).padStart(2,'0')}${String(v.sr_no||v.s).padStart(4,'0')}`;
            
            this.add({
                name: name,
                phone: pseudoPhone,
                ward: vWard,
                village: v.village || 'सिहाली खुर्द',
                line: line,
                notes: `EPIC: ${epic} | मकान: ${house} | संबंधी: ${relName}`,
                tags: [`वार्ड ${vWard}`, '📋 वोटर लिस्ट']
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

    parseCSV(csvText) {
        if (!csvText) return [];
        const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length === 0) return [];

        const imported = [];
        const headerLine = lines[0].toLowerCase();
        const isHeader = headerLine.includes('name') || headerLine.includes('phone') || headerLine.includes('naam') || headerLine.includes('mobile');
        const startIdx = isHeader ? 1 : 0;

        for (let i = startIdx; i < lines.length; i++) {
            const row = lines[i].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
            if (row.length === 0) continue;

            let name = '';
            let phone = '';
            let ward = 1;
            let notes = '';

            if (row.length === 1) {
                phone = row[0].replace(/[^\d]/g, '');
                name = 'ग्रामवासी';
            } else if (row.length >= 2) {
                const p1 = row[0].replace(/[^\d]/g, '');
                const p2 = row[1].replace(/[^\d]/g, '');
                if (p1.length >= 10) {
                    phone = p1;
                    name = row[1];
                } else {
                    name = row[0];
                    phone = p2;
                }
                if (row.length >= 3 && !isNaN(parseInt(row[2]))) {
                    ward = parseInt(row[2]);
                }
                if (row.length >= 4) {
                    notes = row.slice(3).join(' | ');
                }
            }

            if (phone && phone.length >= 10) {
                imported.push(this.add({
                    name: name || 'ग्रामवासी',
                    phone: phone,
                    ward: ward || 1,
                    notes: notes,
                    tags: ['📊 CSV Import']
                }));
            }
        }
        return imported;
    }

    generateVCF(filter = {}) {
        const list = this.getAll(filter);
        let vcf = '';

        for (const c of list) {
            const formattedPhone = c.phone.startsWith('+') ? c.phone : '+' + c.phone;
            const displayName = `[SK26-W${c.ward}] ${c.name}`;
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
            csv += `${safeName},+${c.phone},${c.ward || 1},${c.village || 'सिहाली खुर्द'},${c.line || 'sim_636'},${safeNotes},${safeTags}\n`;
        }

        return csv;
    }
}

module.exports = new ContactsManager();
