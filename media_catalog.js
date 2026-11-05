const fs = require('fs');
const path = require('path');
const userMemory = require('./user_memory.js');

const REELS = [
    {
        id: 'reel_sankalp_3d',
        filename: 'campaign_reel.mp4',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/campaign_reel.mp4',
        title: 'सिहाली खुर्द विकास संकल्प 3D रील',
        caption: 'सिहाली खुर्द के विकास का संकल्प - बाबा अभय सिंह (मोटी आंगली वाले बाबा) 🚩📹\n16 नवम्बर 2026 को भारी मतों से विजयी बनाएं!'
    },
    {
        id: 'reel_namaste_hero',
        filename: 'baba_namaste_ai.mp4',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/baba_namaste_ai.mp4',
        title: 'बाबा अभय सिंह जनसंपर्क रील',
        caption: '40 वर्षों की निष्कलंक समाज सेवा — आपका अपना सेवक बाबा अभय सिंह! 🙏🚩\nसोमवार, 16 नवम्बर 2026 — मतदान जरूर करें!'
    }
];

const POSTERS = [
    {
        id: 'poster_vikas_card',
        filename: 'poster.jpg',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster.jpg',
        title: 'विकास रिपोर्ट कार्ड',
        tags: ['vikas', 'kaam', 'report', 'card', 'विकास', 'काम'],
        caption: 'बाबा अभय सिंह (मोटी आंगली वाले बाबा) — ग्राम पंचायत सिहाली खुर्द 🚩\nसच्चा विकास, ईमानदार नेतृत्व।\nवोटर पर्ची देखने के लिए अपना नाम लिखकर भेजें!'
    }
];

// Retired from AUTO-SEND on 4 Nov 2026 (Brain v3 review): these images carry claims that are not on the owner's parcha —
// rupee budgets ("₹3.21 करोड़+"), "48 घंटे में हल", invented counts/sankalp (3-phase bijli, smart class...), and a second
// person's photo. The files stay in the media bank for the owner; the bot never picks them by itself.
const RETIRED_POSTERS = [
    {
        id: 'poster_sankalp_3d',
        filename: 'poster_sankalp.png',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster_sankalp.png',
        title: '7 प्राथमिक संकल्प पत्र',
        tags: ['sankalp', 'vada', 'future', 'संकल्प', 'वादा'],
        caption: 'साफ़ नीयत, सच्चा इरादा — ना कोई गाँव छूटा, ना कोई वादा झूठा! 🚩\nमिनी स्टेडियम, CCTV सुरक्षा, सोलर लाइट, नियमित डॉक्टर — बाबा अभय सिंह'
    },
    {
        id: 'poster_infra_vikas',
        filename: 'poster_vikas_infra.png',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster_vikas_infra.png',
        title: 'डिजिटल पंचायत इंफ्रास्ट्रक्चर',
        tags: ['digital', 'sadak', 'pani', 'jjm', 'सड़क', 'पानी'],
        caption: 'हर घर तक मीठा पानी, बेहतर स्वास्थ्य सेवा और सुरक्षित मुख्य रास्ते — बाबा अभय सिंह का संकल्प 🚩\n16 नवम्बर 2026 — मतदान जरूर करें!'
    },
    {
        id: 'poster_statesman',
        filename: 'poster_statesman.png',
        github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster_statesman.png',
        title: '40 वर्ष निष्कलंक सेवा',
        tags: ['swabhimaan', 'moti_ungli', 'statesman', 'ईमानदारी', 'स्वाभिमान'],
        caption: 'थारी उंगली से... मोटी आंगली वाले के नाम के आगे मुहर लगाइए! 🚩\n40 वर्षों की निष्कलंक समाज सेवा • अटूट भाईचारा — बाबा अभय सिंह'
    }
];

// Persistent Direct Complaints & Register
const DIRECT_REGISTER_FILE = path.join(__dirname, 'baba_direct_register.json');
let BABA_REGISTER = [];
try {
    if (fs.existsSync(DIRECT_REGISTER_FILE)) {
        BABA_REGISTER = JSON.parse(fs.readFileSync(DIRECT_REGISTER_FILE, 'utf8'));
    }
} catch (e) {
    BABA_REGISTER = [];
}

// Persistent Ground Intelligence
const INTEL_FILE = path.join(__dirname, 'ground_intelligence_feed.json');
let INTEL_FEED = [];
try {
    if (fs.existsSync(INTEL_FILE)) {
        INTEL_FEED = JSON.parse(fs.readFileSync(INTEL_FILE, 'utf8'));
    }
} catch (e) {
    INTEL_FEED = [];
}

// Mode toggle: Use clean demo poster while campaign posters are being finalized
let USE_DEMO_POSTERS = process.env.USE_DEMO_POSTERS === "true"; // production default OFF: the demo poster says "Testing Mode"

const DEMO_POSTER = {
    id: 'poster_demo_test',
    filename: 'poster_demo_test.png',
    github_url: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster_demo_test.png',
    title: 'चुनावी पोस्टर (प्रारूप डेमो)',
    tags: ['demo', 'poster', 'photo', 'तस्वीर', 'फोटो', 'पोस्टर'],
    caption: 'बाबा अभय सिंह (मोटी आंगली वाले बाबा) — सिहाली खुर्द जनसंपर्क 🚩\n(प्रारूप डेमो पोस्टर — अंतिम चुनावी पोस्टर जल्द जारी होगा!)\nवोटर पर्ची देखने के लिए अपना नाम लिखकर भेजें।'
};

class MediaCatalogEngine {
    constructor() {
        this.reels = REELS;
        this.posters = POSTERS;
        this.useDemoPosters = USE_DEMO_POSTERS;
    }

    setDemoMode(enabled) {
        // 5 Nov 2026: the demo poster says "Testing Mode" -> it can only be enabled when the VM sets USE_DEMO_POSTERS=true
        this.useDemoPosters = Boolean(enabled) && process.env.USE_DEMO_POSTERS === 'true';
        return this.useDemoPosters;
    }

    isDemoMode() {
        return this.useDemoPosters;
    }

    getDemoPoster() {
        const localPath = path.join(__dirname, 'media', DEMO_POSTER.filename);
        return {
            id: DEMO_POSTER.id,
            title: DEMO_POSTER.title,
            caption: DEMO_POSTER.caption,
            localPath: fs.existsSync(localPath) ? localPath : null,
            remoteUrl: DEMO_POSTER.github_url
        };
    }

    getNextVideo(phone) {
        const user = userMemory.getUser(phone);
        user.sentVideos = user.sentVideos || [];

        const unSent = this.reels.filter(r => !user.sentVideos.includes(r.id));
        let picked = unSent.length > 0 ? unSent[0] : this.reels[user.sentVideos.length % this.reels.length];

        if (!user.sentVideos.includes(picked.id)) {
            user.sentVideos.push(picked.id);
            userMemory.save();
        }

        const localPath = path.join(__dirname, 'media', picked.filename);
        return {
            id: picked.id,
            title: picked.title,
            caption: picked.caption,
            localPath: fs.existsSync(localPath) ? localPath : null,
            remoteUrl: picked.github_url
        };
    }

    getNextPoster(phone, query = '') {
        // If demo poster mode is active, strictly serve demo poster
        if (this.useDemoPosters) {
            const user = userMemory.getUser(phone);
            user.sentPosters = user.sentPosters || [];
            if (!user.sentPosters.includes(DEMO_POSTER.id)) {
                user.sentPosters.push(DEMO_POSTER.id);
                userMemory.save();
            }
            return this.getDemoPoster();
        }

        const user = userMemory.getUser(phone);
        user.sentPosters = user.sentPosters || [];
        const q = (query || '').toLowerCase();

        // Topic-based match
        let matched = this.posters.find(p => p.tags && p.tags.some(t => q.includes(t)));

        if (!matched) {
            const unSent = this.posters.filter(p => !user.sentPosters.includes(p.id));
            matched = unSent.length > 0 ? unSent[0] : this.posters[user.sentPosters.length % this.posters.length];
        }

        if (matched && !user.sentPosters.includes(matched.id)) {
            user.sentPosters.push(matched.id);
            userMemory.save();
        }

        const localPath = path.join(__dirname, 'media', matched.filename);
        return {
            id: matched.id,
            title: matched.title,
            caption: matched.caption,
            localPath: fs.existsSync(localPath) ? localPath : null,
            remoteUrl: matched.github_url
        };
    }

    recordDirectComplaint(phone, voterName, ward, messageText) {
        const entry = {
            id: 'COMPL-' + Date.now().toString(36).toUpperCase(),
            phone: phone,
            voterName: voterName || 'ग्रामीण मतदाता',
            ward: ward || null,
            message: messageText,
            timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            status: 'SUBMITTED_TO_BABA'
        };
        BABA_REGISTER.push(entry);
        try {
            fs.writeFileSync(DIRECT_REGISTER_FILE, JSON.stringify(BABA_REGISTER, null, 2), 'utf8');
        } catch (e) {
            console.error('Error saving baba_direct_register:', e.message);
        }
        return entry;
    }

    recordGroundIntel(phone, voterName, ward, intelText) {
        const entry = {
            id: 'INTEL-' + Date.now().toString(36).toUpperCase(),
            phone: phone,
            voterName: voterName || 'ग्रामीण साथी',
            ward: ward || null,
            intelText: intelText,
            timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            priority: 'HIGH_ELECTION_PULSE'
        };
        INTEL_FEED.push(entry);
        try {
            fs.writeFileSync(INTEL_FILE, JSON.stringify(INTEL_FEED, null, 2), 'utf8');
        } catch (e) {
            console.error('Error saving ground_intelligence_feed:', e.message);
        }
        return entry;
    }

    getMeetingDetails() {
        return (
            "राम राम भैया! 🙏🚩\n" +
            "बाबा अभय सिंह (मोटी आंगली वाले बाबा) 24 घंटे सिहाली खुर्द में ही जनता के बीच रहते हैं:\n\n" +
            "📍 मिलने का मुख्य स्थान: बाबा अभय सिंह जन सेवा केंद्र, मुख्य मार्ग, सिहाली खुर्द\n" +
            "⏰ दैनिक जन चौपाल: प्रतिदिन सुबह 8:00 बजे से 11:30 बजे तक\n\n" +
            "अगर आपको किसी विशेष मुद्दे या परिवार के साथ सीधे मिलना है, तो अपनी बात और समय यहाँ लिख दीजिए। मैं बाबा अभय सिंह से आपकी सीधी मुलाकात तय करवा दूंगी! 😊"
        );
    }
}

module.exports = new MediaCatalogEngine();
