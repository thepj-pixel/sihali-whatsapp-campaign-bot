const fs = require('fs');
const path = require('path');

const AGENDA_FILE = path.join(__dirname, 'campaign_agenda.json');

const DEFAULT_AGENDA = {
    date: new Date().toISOString().split('T')[0],
    topic: 'JJM घर-घर शुद्ध पेयजल और मुख्य रास्तों पर पक्की सी.सी. सड़कें',
    talkingPoints: 'मतदाता से पूछें कि उनके मोहल्ले में पानी और रास्ते की क्या स्थिति है। कोई झूठे या गैर-जरूरी वादे नहीं करने — साफ़ कहना कि जो भी संभव होगा, बाबा जी पूरी निष्ठा से करवाएंगे।',
    dailySchedule: {
        morning: {
            timeWindow: '08:30 AM - 10:30 AM',
            startHour: 8.5,
            endHour: 10.5,
            type: 'poster',
            name: 'सुबह का पोस्टर (Morning Poster & Daily Agenda Hook)',
            hook: 'राम राम भैया! 🙏 आज की ताज़ा सुबह की राम-राम। आपके मोहल्ले और परिवार में सब कुशल-मंगल? इस बार गाँव का क्या माहौल लग रहा है भैया?'
        },
        dopahar: {
            timeWindow: '01:30 PM - 03:30 PM',
            startHour: 13.5,
            endHour: 15.5,
            type: 'poster',
            name: 'दोपहर का विकास पोस्टर (Afternoon Major Work Highlight)',
            hook: 'नमस्ते भैया! ☀️ दोपहर का समय है, सोचा आज बाबा द्वारा करवाए गए प्रमुख विकास कार्यों की एक झलक आपके साथ साझा करूँ।'
        },
        evening: {
            timeWindow: '05:30 PM - 07:30 PM',
            startHour: 17.5,
            endHour: 19.5,
            type: 'poster',
            name: 'शाम का संकल्प / स्टेटस पोस्टर (Evening Status Card)',
            hook: 'शुभ संध्या भैया! 🌇 आज शाम का विशेष संकल्प पोस्टर आपके लिए। अपने WhatsApp स्टेटस पर जरूर लगाइएगा!'
        },
        night: {
            timeWindow: '08:00 PM - 09:30 PM',
            startHour: 20.0,
            endHour: 21.5,
            type: 'video',
            name: 'रात की वीडियो रील (Night Campaign Video Drip)',
            hook: 'राम राम भैया! 🌙 दिनभर की भागदौड़ के बाद बाबा अभय सिंह का यह 1 मिनट का प्रेरणादायक वीडियो जरूर देखिएगा।'
        }
    },
    activeMediaDrip: [
        {
            id: 'poster_vikas_card',
            title: 'विकास रिपोर्ट कार्ड',
            type: 'image',
            description: 'मुख्य विकास कार्यों का प्रमाणित रिपोर्ट कार्ड'
        },
        {
            id: 'reel_sankalp_3d',
            title: 'सिहाली खुर्द विकास संकल्प रील',
            type: 'video',
            description: 'विकास संकल्प व भावी प्राथमिकताओं की वीडियो रील'
        },
        {
            id: 'poster_sankalp_3d',
            title: 'संकल्प पत्र 2026',
            type: 'image',
            description: 'आगामी 5 वर्षों के 15 प्रमाणित संकल्प'
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
        if (updates.dailySchedule && typeof updates.dailySchedule === 'object') {
            for (const slot of ['morning', 'dopahar', 'evening', 'night']) {
                const incoming = updates.dailySchedule[slot];
                const existing = this.agenda.dailySchedule && this.agenda.dailySchedule[slot];
                if (!incoming || !existing) continue;
                const startHour = Number(incoming.startHour);
                const endHour = Number(incoming.endHour);
                if (Number.isFinite(startHour) && Number.isFinite(endHour) && startHour >= 0 && endHour <= 24 && startHour < endHour) {
                    existing.startHour = startHour;
                    existing.endHour = endHour;
                    existing.timeWindow = incoming.timeWindow || existing.timeWindow;
                }
            }
        }
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

    getCurrentScheduledSlot() {
        const now = new Date();
        const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
        const istMinutes = (now.getUTCMinutes() + 30) % 60;
        const currentFraction = istHours + (istMinutes / 60);

        const schedule = this.agenda.dailySchedule || DEFAULT_AGENDA.dailySchedule;
        if (currentFraction >= schedule.morning.startHour && currentFraction < schedule.morning.endHour) {
            return { slot: 'morning', ...schedule.morning };
        }
        if (currentFraction >= schedule.dopahar.startHour && currentFraction < schedule.dopahar.endHour) {
            return { slot: 'dopahar', ...schedule.dopahar };
        }
        if (currentFraction >= schedule.evening.startHour && currentFraction < schedule.evening.endHour) {
            return { slot: 'evening', ...schedule.evening };
        }
        if (currentFraction >= schedule.night.startHour && currentFraction < schedule.night.endHour) {
            return { slot: 'night', ...schedule.night };
        }
        return null;
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
