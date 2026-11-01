const fs = require('fs');
const path = require('path');

const AGENDA_FILE = path.join(__dirname, 'campaign_agenda.json');

const DEFAULT_AGENDA = {
    date: new Date().toISOString().split('T')[0],
    topic: '33KV जीएसएस और 24 घंटे थ्री-फेज बिजली का ऐतिहासिक कार्य',
    talkingPoints: 'मतदाता से पूछें कि अब बिजली कटौती की समस्या हल हुई या नहीं, और याद दिलाएं कि बाबा अभय सिंह ने धरने देकर 33KV सबस्टेशन मंजूर करवाया था।',
    activeMediaDrip: [
        {
            id: 'poster_gss',
            title: '33KV जीएसएस बिजली पोस्टर',
            type: 'image',
            description: '33KV जीएसएस सबस्टेशन के ऐतिहासिक कार्य का पोस्टर'
        },
        {
            id: 'video_bijli',
            title: 'बिजली सबस्टेशन वीडियो रील',
            type: 'video',
            description: '24 घंटे थ्री-फेज बिजली विकास कार्य वीडियो रील'
        },
        {
            id: 'poster_sankalp',
            title: 'संकल्प पत्र 2026',
            type: 'image',
            description: 'सिहाली-हाड़ाहेड़ी लिंक रोड व भविष्य के 15 संकल्प'
        }
    ]
};

class CampaignAgendaManager {
    constructor() {
        this.agenda = this.loadAgenda();
    }

    loadAgenda() {
        try {
            if (fs.existsSync(AGENDA_FILE)) {
                const raw = fs.readFileSync(AGENDA_FILE, 'utf8');
                return { ...DEFAULT_AGENDA, ...JSON.parse(raw) };
            }
        } catch (e) {
            console.error('[CampaignAgenda] Error loading agenda file:', e.message);
        }
        return { ...DEFAULT_AGENDA };
    }

    saveAgenda() {
        try {
            fs.writeFileSync(AGENDA_FILE, JSON.stringify(this.agenda, null, 2), 'utf8');
            console.log('[CampaignAgenda] Saved updated campaign agenda');
        } catch (e) {
            console.error('[CampaignAgenda] Error saving agenda file:', e.message);
        }
    }

    getAgenda() {
        return this.agenda;
    }

    updateAgenda(updates) {
        if (!updates || typeof updates !== 'object') return this.agenda;
        if (updates.topic) this.agenda.topic = updates.topic;
        if (updates.talkingPoints) this.agenda.talkingPoints = updates.talkingPoints;
        if (Array.isArray(updates.activeMediaDrip)) this.agenda.activeMediaDrip = updates.activeMediaDrip;
        this.agenda.date = new Date().toISOString().split('T')[0];
        this.saveAgenda();
        return this.agenda;
    }

    getNextDripMedia(user) {
        if (!user) return null;
        const sentDrips = (user.sentMedia && user.sentMedia.agendaDrips) || [];
        const items = this.agenda.activeMediaDrip || [];
        for (const item of items) {
            if (!sentDrips.includes(item.id)) {
                return item;
            }
        }
        return null;
    }

    recordDripSent(user, mediaId) {
        if (!user || !mediaId) return;
        user.sentMedia = user.sentMedia || {};
        user.sentMedia.agendaDrips = user.sentMedia.agendaDrips || [];
        if (!user.sentMedia.agendaDrips.includes(mediaId)) {
            user.sentMedia.agendaDrips.push(mediaId);
        }
    }

    getAgendaRAGPrompt() {
        if (!this.agenda || !this.agenda.topic) return '';
        return `[DAILY CAMPAIGN AGENDA / आज का चुनावी एजेंडा]:
विषय: ${this.agenda.topic}
बातचीत में शामिल करने योग्य मुख्य बिंदु: ${this.agenda.talkingPoints}
(⚠️ नियम: इसे जबरदस्ती न थोपें; यदि बातचीत आगे बढ़ रही हो तो स्वाभाविक रूप से एक पंक्ति में आत्मीयता से इसका ज़िक्र करें।)\n`;
    }
}

module.exports = new CampaignAgendaManager();
