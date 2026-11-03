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
                campaignGoal: '', // Specific conversational target for this voter (e.g. invite to chaupal, clarify water)
                familyNotes: '',
                mahoolNotes: '',
                babaNotes: '',
                askedLifeQuestion: false,
                gender: 'M',
                conversationStage: 'INIT', // INIT | ASKED_MAHOOL | ASKED_OCCUPATION | OFFERED_VISIT | ASKED_PROBLEM | ASKED_VOTE_INTENT | VOTE_COMMITTED | VOTE_DOUBTFUL
                occupation: '',
                wantsVisit: null,
                voteIntent: null, // 'yes' | 'no' | 'doubtful' | null
                consented: null,
                consentStatus: 'PENDING',
                lastUploadedPhotoPath: null,
                botPersonaGender: 'F', // Opposite of voter: Female persona for male voters, Male persona for female voters
                sentQuestions: [],
                sentTopics: [],
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
            if (this.users[phone].campaignGoal === undefined) this.users[phone].campaignGoal = '';
            if (this.users[phone].familyNotes === undefined) this.users[phone].familyNotes = '';
            if (this.users[phone].mahoolNotes === undefined) this.users[phone].mahoolNotes = '';
            if (this.users[phone].babaNotes === undefined) this.users[phone].babaNotes = '';
            if (this.users[phone].conversationStage === undefined) this.users[phone].conversationStage = 'INIT';
            if (this.users[phone].occupation === undefined) this.users[phone].occupation = '';
            if (this.users[phone].wantsVisit === undefined) this.users[phone].wantsVisit = null;
            if (this.users[phone].voteIntent === undefined) this.users[phone].voteIntent = null;
            if (this.users[phone].consented === undefined) this.users[phone].consented = null;
            if (this.users[phone].consentStatus === undefined) this.users[phone].consentStatus = 'PENDING';
            if (this.users[phone].lastUploadedPhotoPath === undefined) this.users[phone].lastUploadedPhotoPath = null;
            if (this.users[phone].botPersonaGender === undefined) {
                this.users[phone].botPersonaGender = (this.users[phone].gender === 'F' ? 'M' : 'F');
            }
            if (!this.users[phone].sentQuestions) this.users[phone].sentQuestions = [];
            if (!this.users[phone].sentTopics) this.users[phone].sentTopics = [];
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

    recordMessage(rawPhone, role, text, mediaType = null, sessionName = 'Primary', mediaUrl = null) {
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
        user.lastSession = sessionName;
        if (sessionName && (sessionName.includes('Canada') || sessionName.includes('+1'))) {
            user.lastSessionId = 'canada';
        } else if (sessionName && sessionName.includes('Aux')) {
            user.lastSessionId = 'baba_aux';
        } else {
            user.lastSessionId = 'sim_636';
        }

        if (mediaType && user.sentMedia.hasOwnProperty(mediaType)) {
            user.sentMedia[mediaType] = true;
        }

        // Automatic Tagging and Ground Intelligence Detection
        if (role === 'user' && text) {
            const lower = text.toLowerCase();
            user.tags = user.tags || [];
            const newTags = [];

            // Background Name Extraction (e.g. "मेरा नाम रमेश है", "main sunil bol raha hu")
            if (!user.name || user.name === 'ग्रामवासी' || user.name === 'Voter') {
                const namePatterns = [
                    /(?:mera naam|mera name|मेरा नाम|नाम है|naam hai|naam h|my name is)\s*(?:hai|h|:)?\s*([A-Za-z\u0900-\u097F]{2,20}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)/i,
                    /(?:main|mai|m|मैं)\s+([A-Za-z\u0900-\u097F]{2,20}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)\s+(?:bol raha|bol rha|bol rahi|बोल रहा|बोल रही)/i,
                    /(?:naam likho|naam note karo|नाम लिखो)\s*:?\s*([A-Za-z\u0900-\u097F]{2,20}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)/i
                ];
                const stopWords = [
                    'kya', 'hai', 'है', 'हूँ', 'hoon', 'hu', 'bhai', 'baba', 'ji', 'जी', 'भाई', 'sir', 'yaha', 'यहाँ',
                    'kaise', 'kaam', 'काम', 'vote', 'वोट', 'nahi', 'नहीं', 'nhi', 'dekh', 'dekho', 'dekhna',
                    'bol', 'raha', 'rha', 'batana', 'batao', 'aaya', 'gaya', 'kar', 'karo', 'dunga', 'denge',
                    'to', 'bhi', 'भी', 'kuch', 'कुछ', 'mat', 'kyu', 'kyun', 'parchi', 'slip', 'list', 'ward', 'gaon'
                ];
                for (const pat of namePatterns) {
                    const match = text.match(pat);
                    if (match && match[1]) {
                        const candidate = match[1].trim();
                        const parts = candidate.toLowerCase().split(/\s+/);
                        const hasStopWord = parts.some(p => stopWords.includes(p));
                        if (candidate.length >= 2 && candidate.length <= 30 && !hasStopWord) {
                            user.name = candidate;
                            console.log(`[UserMemory] Extracted voter name: "${candidate}" for ${user.phone}`);
                            break;
                        }
                    }
                }
            }

            // 1. Opposition / Slurs / Critical
            if (
                lower.includes('mc') || lower.includes('bc') || lower.includes('bhadwe') || lower.includes('kutte') ||
                lower.includes('pagal') || lower.includes('chor') || lower.includes('koi kaam nhi') || lower.includes('koi kaam nahi') ||
                lower.includes('bekar') || lower.includes('loot') || lower.includes('dhokha') || lower.includes('rajesh ka vikas purush') ||
                lower.includes('bhosad') || lower.includes('gussa') || lower.includes('kuch nahi kiya') || lower.includes('harayenge') ||
                lower.includes('harna tay') || lower.includes('vote nahi denge') || lower.includes('jhooth') || lower.includes('dhongi') ||
                lower.includes('bakwas') || lower.includes('farji')
            ) {
                newTags.push('🔴 विरोधी / नाराज');
                user.voterSentiment = 'critical';
            }

            // 2. Strong Supporter / Praise / Victory
            if (
                lower.includes('vijay') || lower.includes('jeet') || lower.includes('vote baba') || lower.includes('baba ko') ||
                lower.includes('saath h') || lower.includes('saath hai') || lower.includes('jai baba') || lower.includes('baba hi aayenge') ||
                lower.includes('zindabad') || lower.includes('support') || lower.includes('ashirwad') || lower.includes('vote denge') ||
                lower.includes('vote karenge') || lower.includes('samarthan') || lower.includes('hum baba ke') || lower.includes('baba abhay singh ko') ||
                lower.includes('bhaari mato') || lower.includes('lead rahegi') || lower.includes('pura gaon baba') || lower.includes('moti aangli') ||
                lower.includes('badhai') || lower.includes('shubhkamna')
            ) {
                newTags.push('🟢 पक्का समर्थक');
                user.voterSentiment = 'positive';
            }

            // 3. Swing Voter / Undecided
            if (
                lower.includes('dekhenge') || lower.includes('soch rahe') || lower.includes('sochte h') || lower.includes('dekh rahe h') ||
                lower.includes('abhi decide nahi') || lower.includes('faisla nahi') || lower.includes('kisko de') || lower.includes('confuse') ||
                lower.includes('sab ek jaise') || lower.includes('samajh nahi aa raha') || lower.includes('vichaar') || lower.includes('bataenge baad me') ||
                lower.includes('puch ke bataenge') || lower.includes('ghar walo se puch')
            ) {
                newTags.push('🟡 सोच विचार');
                if (user.voterSentiment !== 'positive' && user.voterSentiment !== 'critical') {
                    user.voterSentiment = 'swing';
                }
            }

            // 4. Family / Household Mention & Vote Strength
            if (
                lower.includes('ghar') || lower.includes('family') || lower.includes('parivar') || lower.includes('parivaar') ||
                lower.includes('chacha') || lower.includes('taau') || lower.includes('tau') || lower.includes('bhai') ||
                lower.includes('mata') || lower.includes('pitaji') || lower.includes('papa') || lower.includes('bahu') ||
                lower.includes('beta') || lower.includes('vote hamare') || lower.includes('sadasya') || lower.includes('patni') ||
                lower.includes('dada') || lower.includes('dadi') || lower.includes('sasur') || lower.includes('saas') ||
                lower.includes('bhabhi') || lower.includes('kunba') || lower.includes('khandan') || lower.includes('kul vote')
            ) {
                newTags.push('👨‍👩‍👧 परिवार विवरण');
            }

            // 5. Ground Mahool / Election Pulse & Competitors
            if (
                lower.includes('mahool') || lower.includes('mahol') || lower.includes('chunav') || lower.includes('hawa') ||
                lower.includes('takkar') || lower.includes('kaun jeet') || lower.includes('rajesh') || lower.includes('opp') ||
                lower.includes('lead') || lower.includes('position') || lower.includes('kya lag raha') || lower.includes('kya mahol') ||
                lower.includes('sihali kalan') || lower.includes('sihali khurd') || lower.includes('hadahedi') || lower.includes('badi sihali') ||
                lower.includes('booth') || lower.includes('ward me kaisa')
            ) {
                newTags.push('📢 चुनावी माहौल');
            }

            // 6. Civic Infrastructure Complaints / Unfinished Work
            if (
                lower.includes('sadak') || lower.includes('road') || lower.includes('cc road') || lower.includes('interlocking') ||
                lower.includes('damar') || lower.includes('pani') || lower.includes('paani') || lower.includes('meetha pani') ||
                lower.includes('tanki') || lower.includes('boring') || lower.includes('naali') || lower.includes('nali') ||
                lower.includes('light') || lower.includes('bijli') || lower.includes('pole') || lower.includes('khamba') ||
                lower.includes('kichad') || lower.includes('keechad') || lower.includes('gaddha') || lower.includes('shikayat') ||
                lower.includes('problem') || lower.includes('pareshani') || lower.includes('bache hue kaam') || lower.includes('andhera') ||
                lower.includes('safai') || lower.includes('kachra')
            ) {
                newTags.push('📝 काम की शिकायत');
            }

            // 7. Voter Slip / Electoral List Inquiry
            if (
                lower.includes('parchi') || lower.includes('slip') || lower.includes('voter list') || lower.includes('naam') ||
                lower.includes('पर्ची') || lower.includes('वोटर') || lower.includes('epic') || lower.includes('kramank') ||
                lower.includes('serial number') || lower.includes('voter id') || lower.includes('kaha vote') || lower.includes('list me dekho')
            ) {
                newTags.push('🎫 वोटर पर्ची');
            }

            // 8. Direct Meeting with Baba Abhay Singh / Chaupal
            if (
                lower.includes('milna') || lower.includes('baba se mil') || lower.includes('baba se baat') ||
                lower.includes('number do') || lower.includes('sampark') || lower.includes('chaupal') || lower.includes('ghar aao') ||
                lower.includes('meeting') || lower.includes('kab aayenge') || lower.includes('baat karni h')
            ) {
                newTags.push('🤝 सीधी मुलाकात');
            }

            // 9. Youth Squad & Social Media Status / Creative Warriors
            if (
                lower.includes('status') || lower.includes('whatsapp status') || lower.includes('poster bana') || lower.includes('reel') ||
                lower.includes('dp') || lower.includes('insta') || lower.includes('instagram') || lower.includes('facebook') ||
                lower.includes('photo bana') || lower.includes('mera poster') || lower.includes('youth') || lower.includes('yuva') ||
                lower.includes('stadium') || lower.includes('khel') || lower.includes('cricket') || lower.includes('ground') ||
                lower.includes('gym') || lower.includes('library')
            ) {
                newTags.push('🚩 युवा टीम');
            }

            // 10. Farmers & Animal Husbandry
            if (
                lower.includes('kisan') || lower.includes('kisaan') || lower.includes('kheti') || lower.includes('fasal') ||
                lower.includes('tubewell') || lower.includes('tube well') || lower.includes('khet') || lower.includes('muavza') ||
                lower.includes('khad') || lower.includes('urea') || lower.includes('dap') || lower.includes('bijli kheti') ||
                lower.includes('paashu') || lower.includes('gaay') || lower.includes('bhains') || lower.includes('goshala') ||
                lower.includes('gaushala') || lower.includes('charagah') || lower.includes('johad')
            ) {
                newTags.push('🌾 किसान व पशुपालक');
            }

            // 11. Seniors & Pension / Welfare
            if (
                lower.includes('pension') || lower.includes('bujurg') || lower.includes('budhapa') || lower.includes('dawai') ||
                lower.includes('illaj') || lower.includes('dada ji') || lower.includes('dadi ji') || lower.includes('charan sparsh') ||
                lower.includes('vriddha') || lower.includes('baba ka aashirwad')
            ) {
                newTags.push('👵 बुजुर्ग व पेंशन');
            }

            // 12. Women Welfare & Empowerment
            if (
                lower.includes('mahila') || lower.includes('matao') || lower.includes('bahano') || lower.includes('behen') ||
                lower.includes('bahu') || lower.includes('beti') || lower.includes('suraksha') || lower.includes('cctv') ||
                lower.includes('shauchalay') || lower.includes('toilet') || lower.includes('aanganwadi') || lower.includes('ashakaryakarta') ||
                lower.includes('self help') || lower.includes('samuh')
            ) {
                newTags.push('👩‍🦰 महिला शक्ति');
            }

            // 13. Electoral Malpractice & Secret Alerts (Liquor / Cash)
            if (
                lower.includes('daroo') || lower.includes('sharab') || lower.includes('botal') || lower.includes('paise baant') ||
                lower.includes('paisa baant') || lower.includes('500 rupay') || lower.includes('1000 rupay') || lower.includes('gaddi') ||
                lower.includes('dhamki') || lower.includes('dara rahe') || lower.includes('bikaau') || lower.includes('sharab pilana') ||
                lower.includes('dhandli') || lower.includes('pralobhan')
            ) {
                newTags.push('🚨 धांधली अलर्ट');
            }

            // 14. Manifesto & Future Village Sankalp
            if (
                lower.includes('sankalp') || lower.includes('vada') || lower.includes('vaada') || lower.includes('ghoshna patra') ||
                lower.includes('manifesto') || lower.includes('kya karoge') || lower.includes('aage ka plan') || lower.includes('bhavishya') ||
                lower.includes('aage kya') || lower.includes('vision') || lower.includes('mudda')
            ) {
                newTags.push('📜 संकल्प पत्र');
            }

            // 15. Outstation / Migrant Villagers (Jaipur, Delhi, Gurgaon, Alwar)
            if (
                lower.includes('bahar hu') || lower.includes('jaipur hu') || lower.includes('delhi hu') || lower.includes('gurgaon hu') ||
                lower.includes('alwar hu') || lower.includes('bhiwadi hu') || lower.includes('bahar rehta') || lower.includes('job karta') ||
                lower.includes('company me') || lower.includes('chhutti leke') || lower.includes('vote dalne aaunga') || lower.includes('aana padega') ||
                lower.includes('train') || lower.includes('bus ticket') || lower.includes('bahar se aaunga') || lower.includes('gaon aaunga')
            ) {
                newTags.push('🚆 प्रवासी मतदाता');
            }

            if (newTags.length > 0) {
                user.tags = user.tags.filter(t => t !== '⚪ सामान्य संपर्क');
                for (const t of newTags) {
                    if (!user.tags.includes(t)) user.tags.push(t);
                }
            }

            // Automatic Occupation Detection
            const occMap = {
                'farmer': ['kisan', 'kisaan', 'kheti', 'zamindar', 'fasal'],
                'student': ['student', 'padhai', 'study', 'college', 'school', 'tayari', 'prep'],
                'army': ['army', 'fauj', 'fauji', 'defense', 'sena', 'commando'],
                'police': ['police', 'daroga', 'constable', 'thana'],
                'teacher': ['teacher', 'master', 'adhyapak', 'shikshak', 'shiksha'],
                'lawyer': ['lawyer', 'vakil', 'vakeel', 'court', 'advocate'],
                'driver': ['driver', 'gaadi', 'trolla', 'dumper'],
                'business': ['dukan', 'shop', 'vyapar', 'dhandha', 'business'],
                'private_job': ['company', 'job', 'private', 'naukri', 'gurgaon', 'delhi', 'jaipur', 'bhiwadi']
            };
            for (const [prof, kws] of Object.entries(occMap)) {
                if (kws.some(k => lower.includes(k))) {
                    user.occupation = prof;
                    break;
                }
            }

            // Automatic Vote Intent Detection
            if (user.conversationStage === 'ASKED_VOTE_INTENT' || lower.includes('vote') || lower.includes('वोट')) {
                if (lower.includes('haan') || lower.includes('ha') || lower.includes('yes') || lower.includes('baba ko') || lower.includes('denge') || lower.includes('pakka') || lower.includes('full support')) {
                    user.voteIntent = 'yes';
                    user.conversationStage = 'VOTE_COMMITTED';
                } else if (lower.includes('nahi') || lower.includes('nhi') || lower.includes('no') || lower.includes('kisi aur') || lower.includes('rajesh')) {
                    user.voteIntent = 'no';
                    user.conversationStage = 'VOTE_DOUBTFUL';
                } else if (lower.includes('dekhenge') || lower.includes('soch') || lower.includes('confuse') || lower.includes('baad me')) {
                    user.voteIntent = 'doubtful';
                    user.conversationStage = 'VOTE_DOUBTFUL';
                }
            }
        }

        const now = Date.now();
        const electionDate = new Date('2026-11-16T18:00:00+05:30').getTime();
        // 30 days retention standard; 16 days post-election auto-delete
        const retentionDays = (now > electionDate) ? 16 : 30;
        const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

        user.history.push({
            role: role, // 'user' or 'bot'
            text: text,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            session: sessionName,
            time: timestamp,
            createdAt: now
        });

        // Automatic Time-based Cleanup (30 days / 16 days post-election)
        user.history = user.history.filter(h => !h.createdAt || (now - h.createdAt <= maxAgeMs));
        if (user.history.length > 50) {
            user.history = user.history.slice(-50);
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

    setCampaignGoal(rawPhone, goal) {
        const user = this.getUser(rawPhone);
        if (!user) return null;
        user.campaignGoal = (goal || '').trim();
        this.save();
        return user.campaignGoal;
    }

    getDynamicGreeting(rawPhone) {
        const user = this.getUser(rawPhone);
        if (!user) return "राम राम भाई जी! 🙏";

        if (user.name && user.name.trim()) {
            const cleanName = user.name.trim();
            const greetingsWithName = [
                `राम राम ${cleanName} भैया! 🙏🚩 बाबा अभय सिंह सेवा केंद्र में आपका स्वागत है। बताइए परिवार में सब कुशल-मंगल?`,
                `प्रणाम ${cleanName} जी! 🙏 आशा है आप सकुशल हैं। बताइए आज बाबा के प्रचार या अपने मोहल्ले के विकास पर क्या विचार हैं?`,
                `जय बाबा की ${cleanName} भैया! 🚩 सिहाली खुर्द के विकास में आपका स्नेह व आशीर्वाद सदा साथ रहता है। आज कैसे याद किया भैया? 😊`,
                `राम राम भाई ${cleanName}! 🙏 घर-परिवार में सब ठीक-ठाक हैं न भैया? भाभी जी और बच्चे कैसे हैं? 😊`,
                `प्रणाम ${cleanName} जी! 🙏 16 नवम्बर 2026 बाबा अभय सिंह के पक्ष में मतदान का संकल्प। बताइए आपकी क्या सेवा कर सकती हूँ? 🚩`,
                `राम राम ${cleanName} भैया! 🙏 आज अपनी गली-मोहल्ले में क्या चुनावी माहौल लग रहा है भैया?`
            ];
            const idx = (user.interactionCount || 0) % greetingsWithName.length;
            return greetingsWithName[idx];
        } else {
            const greetingsWithoutName = [
                "राम राम भाई जी! 🙏 बाबा अभय सिंह सेवा केंद्र में आपका स्वागत है। भैया, आपका शुभ नाम जान सकते हैं ताकि लिस्ट में आपकी वोटर पर्ची देख सकें? 😊",
                "प्रणाम भाई जी! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र में आपका स्वागत है। भैया, आपका नाम क्या है? ताकि लिस्ट में आपकी वोटर पर्ची भी देख सकूँ!",
                "राम राम भैया! 🚩 सिहाली खुर्द 2026 चुनाव सेवा केंद्र। भैया, अपना नाम या वार्ड नंबर बता दीजिए न, ताकि आपसे आत्मीयता से बात हो सके! 😊",
                "प्रणाम भैया! 🙏 बाबा अभय सिंह सेवा केंद्र में आपका स्वागत है। भैया, आपका शुभ नाम बता दीजिए, ताकि आगे से आपको नाम से पुकार सकूँ! 🚩"
            ];
            const idx = (user.interactionCount || 0) % greetingsWithoutName.length;
            return greetingsWithoutName[idx];
        }
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
        if (user.campaignGoal) ctx += ` | TARGET CAMPAIGN GOAL: ${user.campaignGoal} (Gently steer conversation towards this goal!)`;
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
