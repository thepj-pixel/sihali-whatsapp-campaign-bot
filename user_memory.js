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
                ward: null,
                fatherOrSpouse: '',
                occupation: '',
                voterSentiment: 'neutral', // positive | swing | critical | neutral
                autoPilot: true, // Default true: Bot replies automatically. Set false for admin manual takeover
                tags: ['⚪ सामान्य संपर्क'],
                familyNotes: '',
                mahoolNotes: '',
                babaNotes: '',
                askedLifeQuestion: false,
                gender: 'M',
                lastFoundVoter: null,
                lastSearchResults: [],
                proactivePingCount: 0,
                lastPingTime: null,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                interactionCount: 0,
                sentMedia: {
                    welcome: false,
                    poster: false,
                    video: false,
                    voterSlip: false,
                    demoPoster: false
                },
                sentSlogans: [],
                history: []
            };
            this.save();
        } else {
            // Ensure schema integrity for existing records
            if (this.users[phone].autoPilot === undefined) this.users[phone].autoPilot = true;
            if (!this.users[phone].tags) this.users[phone].tags = ['⚪ सामान्य संपर्क'];
            if (this.users[phone].familyNotes === undefined) this.users[phone].familyNotes = '';
            if (this.users[phone].mahoolNotes === undefined) this.users[phone].mahoolNotes = '';
            if (this.users[phone].babaNotes === undefined) this.users[phone].babaNotes = '';
            if (this.users[phone].sentMedia && this.users[phone].sentMedia.demoPoster === undefined) {
                this.users[phone].sentMedia.demoPoster = false;
            }
            if (defaultName && !this.users[phone].name) {
                this.users[phone].name = defaultName;
                this.save();
            }
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

        // Automatic Tagging and Ground Intelligence Detection
        if (role === 'user' && text) {
            const lower = text.toLowerCase();
            user.tags = user.tags || [];
            const newTags = [];

            // 1. Opposition / Slurs / Critical
            if (
                lower.includes('mc') || lower.includes('bc') || lower.includes('bhadwe') || lower.includes('kutte') ||
                lower.includes('pagal') || lower.includes('chor') || lower.includes('koi kaam nhi') || lower.includes('koi kaam nahi') ||
                lower.includes('bekar') || lower.includes('loot') || lower.includes('dhokha') || lower.includes('rajesh ka vikas purush') ||
                lower.includes('bhosad') || lower.includes('gussa')
            ) {
                newTags.push('🔴 विरोधी / नाराज');
                user.voterSentiment = 'critical';
            }

            // 2. Strong Supporter / Praise / Victory
            if (
                lower.includes('vijay') || lower.includes('jeet') || lower.includes('vote baba') || lower.includes('baba ko') ||
                lower.includes('saath h') || lower.includes('saath hai') || lower.includes('jai baba') || lower.includes('baba hi aayenge') ||
                lower.includes('zindabad') || lower.includes('support') || lower.includes('ashirwad') || lower.includes('vote denge') ||
                lower.includes('vote karenge') || lower.includes('samarthan') || lower.includes('hum baba ke') || lower.includes('baba abhay singh ko')
            ) {
                newTags.push('🟢 पक्का समर्थक');
                user.voterSentiment = 'positive';
            }

            // 3. Family / Household Mention
            if (
                lower.includes('ghar') || lower.includes('family') || lower.includes('parivar') || lower.includes('chacha') ||
                lower.includes('taau') || lower.includes('tau') || lower.includes('bhai') || lower.includes('mata') ||
                lower.includes('pitaji') || lower.includes('papa') || lower.includes('bahu') || lower.includes('beta') ||
                lower.includes('vote hamare') || lower.includes('sadasya')
            ) {
                newTags.push('👨‍👩‍👧 परिवार विवरण');
            }

            // 4. Ground Mahool / Election Mood
            if (
                lower.includes('mahool') || lower.includes('mahol') || lower.includes('chunav') || lower.includes('hawa') ||
                lower.includes('takkar') || lower.includes('kaun jeet') || lower.includes('rajesh') || lower.includes('opp') ||
                lower.includes('lead') || lower.includes('position') || lower.includes('kya lag raha')
            ) {
                newTags.push('📢 चुनावी माहौल');
            }

            // 5. Civic Complaints / Unfinished Work
            if (
                lower.includes('sadak') || lower.includes('pani') || lower.includes('paani') || lower.includes('naali') ||
                lower.includes('nali') || lower.includes('light') || lower.includes('kichad') || lower.includes('keechad') ||
                lower.includes('shikayat') || lower.includes('problem') || lower.includes('pareshani') || lower.includes('bache hue kaam')
            ) {
                newTags.push('📝 काम की शिकायत');
            }

            // 6. Voter Slip
            if (
                lower.includes('parchi') || lower.includes('slip') || lower.includes('voter list') || lower.includes('naam') ||
                lower.includes('पर्ची') || lower.includes('वोटर')
            ) {
                newTags.push('🎫 वोटर पर्ची');
            }

            // 7. Direct Meeting
            if (
                lower.includes('milna') || lower.includes('baba se mil') || lower.includes('baba se baat') ||
                lower.includes('number do') || lower.includes('sampark')
            ) {
                newTags.push('🤝 सीधी मुलाकात');
            }

            if (newTags.length > 0) {
                user.tags = user.tags.filter(t => t !== '⚪ सामान्य संपर्क');
                for (const t of newTags) {
                    if (!user.tags.includes(t)) user.tags.push(t);
                }
            }
        }

        user.history.push({
            role: role, // 'user' or 'bot'
            text: text,
            mediaType: mediaType || null,
            session: sessionName,
            time: timestamp
        });

        // Keep last 40 messages in history
        if (user.history.length > 40) {
            user.history.shift();
        }

        this.save();
    }

    toggleAutoPilot(rawPhone, enabled) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        user.autoPilot = Boolean(enabled);
        this.save();
        return user.autoPilot;
    }

    updateTags(rawPhone, tags) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        user.tags = Array.isArray(tags) ? tags : [];
        this.save();
        return user.tags;
    }

    setSentiment(rawPhone, sentiment) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        user.voterSentiment = sentiment;
        this.save();
        return user.voterSentiment;
    }

    updateNotes(rawPhone, notes = {}) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        if (notes.familyNotes !== undefined) user.familyNotes = notes.familyNotes;
        if (notes.mahoolNotes !== undefined) user.mahoolNotes = notes.mahoolNotes;
        if (notes.babaNotes !== undefined) user.babaNotes = notes.babaNotes;
        this.save();
        return user;
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

    updateProfile(rawPhone, updates = {}) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        for (const [k, v] of Object.entries(updates)) {
            if (v !== undefined && v !== null && v !== '') {
                user[k] = v;
            }
        }
        this.save();
        return user;
    }

    getUserContextRAG(rawPhone) {
        const user = this.getUser(rawPhone);
        if (!user) return '';
        let ctx = `[VOTER CONTEXT: Phone: ${user.phone}`;
        if (user.name) ctx += ` | Name: ${user.name}`;
        if (user.ward) ctx += ` | Ward: ${user.ward}`;
        if (user.fatherOrSpouse) ctx += ` | Relation: ${user.fatherOrSpouse}`;
        if (user.voterSentiment) ctx += ` | Sentiment: ${user.voterSentiment}`;
        if (user.tags && user.tags.length > 0) ctx += ` | Tags: ${user.tags.join(', ')}`;
        if (user.familyNotes) ctx += ` | Family Notes: ${user.familyNotes}`;
        if (user.mahoolNotes) ctx += ` | Ground Mahool: ${user.mahoolNotes}`;
        if (user.babaNotes) ctx += ` | Note for Baba: ${user.babaNotes}`;
        if (user.interactionCount) ctx += ` | Total Chats: ${user.interactionCount}`;
        ctx += `]`;
        return ctx;
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
