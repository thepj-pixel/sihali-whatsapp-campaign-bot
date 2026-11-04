const LINE_CONTACTS = Object.freeze({
    sim_636: {
        id: 'sim_636',
        waid: '916367810227',
        display: '+91 63678 10227',
        label: 'Primary Line'
    },
    baba_aux: {
        id: 'baba_aux',
        waid: '919509352067',
        display: '+91 95093 52067',
        label: 'Baba Aux Line'
    },
    canada: {
        id: 'canada',
        waid: '14502790497',
        display: '+1 (450) 279-0497',
        label: 'Canada Line'
    }
});

function getLineContact(lineId = 'sim_636') {
    return LINE_CONTACTS[lineId] || LINE_CONTACTS.sim_636;
}

function buildCampaignVCard(lineId = 'sim_636') {
    const contact = getLineContact(lineId);
    return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:बाबा अभय सिंह (मोटी आंगली वाले)',
        'ORG:ग्राम पंचायत सिहाली खुर्द',
        'TITLE:जनसंपर्क 2026',
        `TEL;type=Primary,pref;type=VOICE;waid=${contact.waid}:${contact.display}`,
        `NOTE:इस संपर्क को सेव करें। यह कार्ड केवल ${contact.display} WhatsApp लाइन का है।`,
        'END:VCARD'
    ].join('\n');
}

function buildSaveContactPrompt(lineId = 'sim_636', language = 'hi') {
    const contact = getLineContact(lineId);
    if (language === 'hinglish') {
        return `Ye isi WhatsApp line ${contact.display} ka contact card hai. “Add to Contacts” dabakar save kar lein, taaki aapke maange hue updates sahi number se milen. 🙏`;
    }
    return `यह इसी WhatsApp लाइन ${contact.display} का संपर्क कार्ड है। “Add to Contacts / संपर्क में जोड़ें” दबाकर सेव कर लें, ताकि आपके माँगे हुए अपडेट सही नंबर से मिलें। 🙏`;
}

function buildConsentPrompt(name = '', language = 'hi') {
    if (language === 'hinglish' || language === 'en') {
        const g = name && !/[\u0900-\u097F]/.test(name) ? `${name} ji` : 'ji';
        return `Ram Ram ${g} 🙏 Main Abhay Singh ji ki team se hoon. Bataiye, kya madad karun—parchi, booth ya gaon ka koi kaam?`;
    }
    const greeting = name && /[\u0900-\u097F]/.test(name) ? `${name} जी` : 'जी';
    return `राम राम ${greeting} 🙏 मैं अभय सिंह जी की टीम से हूँ। बताइए, क्या मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?`;
}

/** Script of a message: 'hinglish' for Roman-only text, else 'hi'. */
function messageLanguage(text) {
    const t = String(text || '');
    return /[\u0900-\u097F]/.test(t) ? 'hi' : (/[a-z]/i.test(t) ? 'hinglish' : 'hi');
}

function buildOptOutAck(language = 'hi') {
    return language === 'hinglish'
        ? 'Ji, aapka faisla darj kar liya hai. Ab aapko koi chunavi message nahi bheja jayega. 🙏 (Dobara judne ke liye START likhein)'
        : 'जी, आपका निर्णय दर्ज कर लिया है। अब आपको कोई चुनावी संदेश नहीं भेजा जाएगा। 🙏 (दोबारा जुड़ने के लिए START लिखें)';
}

// Explicit opt-out messages. Matched against the WHOLE message (after trimming punctuation),
// so ordinary sentences like "ruko main batata hoon" or "pata nahi" are not treated as opt-outs.
const OPT_OUT_TERMS = Object.freeze([
    'stop', 'stop karo', 'stop kro', 'unsubscribe', 'band', 'band karo', 'band kro', 'ruko',
    'mat bhejo', 'message mat karo', 'message mat bhejo', 'msg mat karo', 'msg mat bhejo',
    'बंद', 'बन्द', 'बंद करो', 'बन्द करो', 'रुको', 'स्टॉप', 'मत भेजो', 'मैसेज मत करो', 'मैसेज मत भेजो', 'संदेश बंद करो', 'मैसेज बंद करो'
]);
const OPT_IN_TERMS = Object.freeze(['start', 'unstop', 'shuru', 'shuru karo', 'शुरू', 'शुरू करो']);

function normalizeShortReply(text) {
    return String(text || '').toLowerCase().replace(/[!।.,?🙏🚩\s]+/g, ' ').trim();
}

function isOptOutMessage(text) {
    return OPT_OUT_TERMS.includes(normalizeShortReply(text));
}

function isOptInMessage(text) {
    return OPT_IN_TERMS.includes(normalizeShortReply(text));
}

function parseConsentResponse(text) {
    const value = normalizeShortReply(text);
    if (!value) return null;
    if (isOptOutMessage(value)) return 'rejected';
    // Short refusals must be whole words in a short reply: "no" must not match "know"/"nominee",
    // and "pata nahi, parchi chahiye" is a question, not a refusal.
    const words = value.split(' ');
    const shortNegatives = ['nahi', 'nhi', 'नहीं', 'no', 'nahin'];
    if (words.length <= 3 && words.some(w => shortNegatives.includes(w)) && !/parchi|पर्ची|voter|वोटर|chahiye|चाहिए/.test(value)) return 'rejected';
    const phraseNegatives = ['band karo', 'बंद करो', 'message mat karo', 'मैसेज मत करो', 'mat bhejo', 'मत भेजो', 'stop karo'];
    if (phraseNegatives.some(term => value.includes(term))) return 'rejected';
    // Any meaningful reply to the introductory assistance question starts the requested conversation.
    return value.length >= 2 ? 'accepted' : null;
}

/** Whether a contact may receive a bulk broadcast. Returns null if allowed, or a skip reason. */
function broadcastBlockReason(user) {
    if (!user) return null;
    if (user.broadcastOptOut === true) return 'opted_out';
    if (user.consentStatus === 'REJECTED' || user.consented === false) return 'declined_outreach';
    return null;
}

/** Record an explicit opt-out (STOP/बंद/रुको): disables automation and all future broadcasts. */
function applyOptOut(user, now = new Date()) {
    if (!user) return user;
    applyConsentDecision(user, 'rejected');
    user.broadcastOptOut = true;
    user.broadcastOptOutAt = now.toISOString();
    return user;
}

/** Explicit re-enrolment (START/शुरू) — the only way to undo an opt-out. */
function applyOptIn(user, now = new Date()) {
    if (!user) return user;
    applyConsentDecision(user, 'accepted');
    user.broadcastOptOut = false;
    user.broadcastOptInAt = now.toISOString();
    return user;
}

function markConsentPrompted(user) {
    if (!user) return user;
    user.consented = null;
    user.consentStatus = 'PROMPTED';
    user.consentPromptedAt = new Date().toISOString();
    return user;
}

function applyConsentDecision(user, decision) {
    if (!user || !decision) return user;
    if (decision === 'accepted') {
        user.consented = true;
        user.consentStatus = 'ACCEPTED';
        user.autoPilot = true;
        user.conversationStage = 'INIT';
        user.consentAcceptedAt = new Date().toISOString();
    } else if (decision === 'rejected') {
        user.consented = false;
        user.consentStatus = 'REJECTED';
        user.autoPilot = false;
        user.consentRejectedAt = new Date().toISOString();
    }
    return user;
}

function canSendConsentReminder(user, now = Date.now()) {
    if (!user || user.consentStatus !== 'PROMPTED' || user.consented !== null) return false;
    if ((user.consentReminderCount || 0) >= 1 || !user.consentPromptedAt) return false;
    const elapsedHours = (now - new Date(user.consentPromptedAt).getTime()) / 3600000;
    return elapsedHours >= 3 && elapsedHours <= 12;
}

function buildConsentReminder(name = '') {
    const greeting = name ? `${name} जी` : 'भाई जी';
    return `राम राम ${greeting}! 🙏 बस याद दिलाना था—मतदाता पर्ची, वार्ड जानकारी या गाँव की समस्या में सहायता चाहिए तो यहीं लिख दें।`;
}

function canSendProactive(user) {
    return Boolean(
        user &&
        user.consented === true &&
        user.consentStatus === 'ACCEPTED' &&
        user.autoPilot !== false
    );
}

function shouldSendContactCard(user, userMessageCount) {
    return Boolean(
        canSendProactive(user) &&
        !user.contactCardSent &&
        userMessageCount >= 1 &&
        userMessageCount <= 3
    );
}

module.exports = {
    LINE_CONTACTS,
    getLineContact,
    buildCampaignVCard,
    buildSaveContactPrompt,
    buildConsentPrompt,
    messageLanguage,
    buildOptOutAck,
    parseConsentResponse,
    OPT_OUT_TERMS,
    OPT_IN_TERMS,
    isOptOutMessage,
    isOptInMessage,
    broadcastBlockReason,
    applyOptOut,
    applyOptIn,
    markConsentPrompted,
    applyConsentDecision,
    canSendConsentReminder,
    buildConsentReminder,
    canSendProactive,
    shouldSendContactCard
};
