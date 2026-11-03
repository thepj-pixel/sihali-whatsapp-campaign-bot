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

function buildConsentPrompt(name = '') {
    const greeting = name ? `${name} जी` : 'भाई जी';
    return `राम राम ${greeting}! 🙏 हम बाबा अभय सिंह जनसंपर्क टीम से हैं। आपकी मतदाता पर्ची, वार्ड की जानकारी या गाँव की किसी समस्या में क्या सहायता चाहिए?`;
}

function parseConsentResponse(text) {
    const value = String(text || '').toLowerCase().trim();
    if (!value) return null;
    const negative = ['nahi', 'nhi', 'नहीं', 'no', 'stop', 'band karo', 'बंद करो', 'message mat karo', 'मैसेज मत करो'];
    if (negative.some(term => value === term || value.includes(term))) return 'rejected';
    // Any meaningful reply to the introductory assistance question starts the requested conversation.
    return value.length >= 2 ? 'accepted' : null;
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
    parseConsentResponse,
    markConsentPrompted,
    applyConsentDecision,
    canSendConsentReminder,
    buildConsentReminder,
    canSendProactive,
    shouldSendContactCard
};
