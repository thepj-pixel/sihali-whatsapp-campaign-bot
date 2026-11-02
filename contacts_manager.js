const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'contacts_db.json');
const VOTERS_PATH = path.join(__dirname, 'voters_cleaned.json');

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

    add(contactData) {
        let cleanPhone = String(contactData.phone || '').replace(/[^0-9]/g, '');
        if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

        if (!cleanPhone) {
            throw new Error('Valid phone number is required');
        }

        const existingIdx = this.contacts.findIndex(c => c.phone === cleanPhone);
        const contactObj = {
            id: contactData.id || `c_${Date.now()}_${Math.floor(Math.random()*1000)}`,
            name: (contactData.name || 'ग्रामवासी').trim(),
            phone: cleanPhone,
            ward: contactData.ward || 1,
            village: contactData.village || 'सिहाली खुर्द',
            line: contactData.line || 'sim_636',
            notes: contactData.notes || '',
            tags: contactData.tags || ['⚪ सामान्य संपर्क'],
            updatedAt: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            this.contacts[existingIdx] = { ...this.contacts[existingIdx], ...contactObj };
        } else {
            this.contacts.unshift(contactObj);
        }

        this.save();
        return contactObj;
    }

    delete(idOrPhone) {
        this.contacts = this.contacts.filter(c => c.id !== idOrPhone && c.phone !== idOrPhone);
        this.save();
        return true;
    }

    // Import from Master Voter DB
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
            // If phone exists in voter record or use synthetic tracking
            const name = v.name_hi || v.name || 'ग्रामवासी';
            const vWard = v.ward || v.w || 1;
            const epic = v.epic || v.e || '';
            const house = v.house_no || v.h || '';
            const relName = v.rel_name_hi || v.rel_name || '';

            // If voter doesn't have mobile in DB, create entry ready for field number entry
            const pseudoPhone = v.phone || `VOTER_W${String(vWard).padStart(2,'0')}_${String(v.sr_no||v.s).padStart(4,'0')}`;
            
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
        this.save();
        return addedCount;
    }

    // Parse VCF content
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

    // Generate VCF (vCard 3.0) for Android / iPhone contacts import
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
            if (c.notes) vcf += `NOTE:${c.notes}\r\n`;
            vcf += `ORG:सिहाली खुर्द चुनाव 2026 (बाबा अभय सिंह)\r\n`;
            vcf += `END:VCARD\r\n`;
        }

        return vcf;
    }

    // Generate CSV export
    generateCSV(filter = {}) {
        const list = this.getAll(filter);
        let csv = 'Name,Phone,Ward,Village,Line,Notes,Tags,UpdatedAt\n';

        for (const c of list) {
            const safeName = `"${(c.name || '').replace(/"/g, '""')}"`;
            const safePhone = `"${c.phone || ''}"`;
            const safeWard = c.ward || '';
            const safeVillage = `"${(c.village || '').replace(/"/g, '""')}"`;
            const safeLine = `"${c.line || ''}"`;
            const safeNotes = `"${(c.notes || '').replace(/"/g, '""')}"`;
            const safeTags = `"${(c.tags || []).join('; ')}"`;
            const safeDate = c.updatedAt || '';

            csv += `${safeName},${safePhone},${safeWard},${safeVillage},${safeLine},${safeNotes},${safeTags},${safeDate}\n`;
        }

        return csv;
    }
}

module.exports = new ContactsManager();
