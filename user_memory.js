const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'user_memory.json');

// Authentic campaign slogans pool for rotation
const SLOGANS = [
    { id: 's1', text: 'सिहाली खुर्द का सच्चा सम्मान, बाबा अभय सिंह का काम महान! 🚩' },
    { id: 's2', text: '5 साल का सच्चा विकास, हर घर में अटूट विश्वास! 🙏' },
    { id: 's3', text: 'हर सुख-दुख में जो साथ खड़ा मिले, वही अपना सच्चा साथी है! 🚩' },
    { id: 's4', text: 'घर-घर शुद्ध पेयजल और पक्की सड़कें — बाबा अभय सिंह का संकल्प! 🚰' },
    { id: 's5', text: 'ईमानदारी और सेवा की मिसाल — बाबा अभय सिंह सिहाली खुर्द! 🚩' },
    { id: 's6', text: 'गांव का गौरव, किसानों का मान — 16 नवम्बर को बाबा का साथ! 🌾' }
];

class UserMemory {
    constructor() {
        this.users = {};
        this.load();
    }

    cleanPhone(rawPhone) {
        if (!rawPhone) return '';
        let cleaned = String(rawPhone).replace(/[^\d]/g, '');
        if (cleaned.length === 10) {
            cleaned = '91' + cleaned;
        }
        return cleaned;
    }

    load() {
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                const data = fs.readFileSync(MEMORY_FILE, 'utf8');
                this.users = JSON.parse(data);
            }
        } catch (e) {
            console.error('[UserMemory] Error loading memory:', e.message);
            this.users = {};
        }
    }

    save() {
        try {
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.users, null, 2), 'utf8');
        } catch (e) {
            console.error('[UserMemory] Error saving memory:', e.message);
        }
    }

    getUser(rawPhone, defaultName = null) {
        const phone = this.cleanPhone(rawPhone);
        if (!phone) return null;

        if (!this.users[phone]) {
            this.users[phone] = {
                phone: phone,
                name: defaultName || '',
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                interactionCount: 0,
                sentMedia: {
                    welcome: false,
                    poster: false,
                    video: false,
                    voterSlip: false
                },
                sentSlogans: [],
                history: []
            };
            this.save();
        } else if (defaultName && !this.users[phone].name) {
            this.users[phone].name = defaultName;
            this.save();
        }

        return this.users[phone];
    }

    recordMessage(rawPhone, role, text, mediaType = null, sessionName = 'Primary') {
        const phone = this.cleanPhone(rawPhone);
        if (!phone) return;

        const user = this.getUser(phone);
        const timestamp = new Date().toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        user.lastSeen = new Date().toISOString();
        user.interactionCount += 1;

        if (mediaType && user.sentMedia.hasOwnProperty(mediaType)) {
            user.sentMedia[mediaType] = true;
        }

        user.history.push({
            role: role, // 'user' or 'bot'
            text: text,
            mediaType: mediaType || null,
            session: sessionName,
            time: timestamp
        });

        // Keep last 30 messages in history
        if (user.history.length > 30) {
            user.history.shift();
        }

        this.save();
    }

    hasSentMedia(rawPhone, mediaType) {
        const user = this.getUser(rawPhone);
        if (!user) return false;
        return Boolean(user.sentMedia[mediaType]);
    }

    recordMediaSent(rawPhone, mediaType) {
        const user = this.getUser(rawPhone);
        if (user && user.sentMedia.hasOwnProperty(mediaType)) {
            user.sentMedia[mediaType] = true;
            this.save();
        }
    }

    getNextSlogan(rawPhone) {
        const user = this.getUser(rawPhone);
        if (!user) return SLOGANS[0].text;

        const sentIds = new Set(user.sentSlogans || []);
        const unUsed = SLOGANS.filter(s => !sentIds.has(s.id));

        let picked;
        if (unUsed.length > 0) {
            picked = unUsed[0];
            user.sentSlogans.push(picked.id);
        } else {
            // Reset rotation if all sent
            user.sentSlogans = [SLOGANS[0].id];
            picked = SLOGANS[0];
        }

        this.save();
        return picked.text;
    }

    getAllUsers() {
        return Object.values(this.users).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    }

    getUserHistory(rawPhone) {
        const user = this.getUser(rawPhone);
        return user ? user.history : [];
    }
}

module.exports = new UserMemory();
