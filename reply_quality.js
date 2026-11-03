function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, ' ')
        .trim();
}

function isRepeated(reply, user, lookback = 6) {
    const candidate = normalize(reply);
    if (!candidate || !user || !Array.isArray(user.history)) return false;
    return user.history
        .filter(item => item.role === 'bot')
        .slice(-lookback)
        .some(item => normalize(item.text) === candidate);
}

function buildContextRedirect(user, incoming = '') {
    const hinglish = user?.languagePreference === 'hinglish' ||
        (user?.languagePreference !== 'hi' && !/[\u0900-\u097F]/.test(incoming));
    const name = user?.name ? `${user.name} ji, ` : '';

    if (user?.lastFoundVoter) {
        return hinglish
            ? `${name}aapki voter details yaad hain. Parchi dobara bhejun, family member dekhu, ya ward ki jankari doon?`
            : `${name}आपकी मतदाता जानकारी याद है। पर्ची दोबारा भेजूँ, परिवार का नाम देखूँ, या वार्ड की जानकारी दूँ?`;
    }
    if (user?.wantsVisit === true) {
        return hinglish
            ? `${name}mulaqat ki baat note hai. Ab apni gali ya ward ki sabse zaroori samasya bata dijiye.`
            : `${name}मुलाकात की बात नोट है। अब अपनी गली या वार्ड की सबसे जरूरी समस्या बता दीजिए।`;
    }
    if (user?.occupation) {
        return hinglish
            ? `${name}aapka kaam yaad hai. Ab voter parchi, ward information, ya gaon ki samasya—kis par baat karein?`
            : `${name}आपका काम याद है। अब मतदाता पर्ची, वार्ड जानकारी या गाँव की समस्या—किस पर बात करें?`;
    }
    return hinglish
        ? `${name}main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye?`
        : `${name}मैं पिछली बात दोहराऊँगा नहीं। मतदाता पर्ची, वार्ड जानकारी या गाँव की समस्या में क्या सहायता चाहिए?`;
}

function improve(reply, incoming, user) {
    if (!isRepeated(reply, user)) return reply;
    return buildContextRedirect(user, incoming);
}

module.exports = { normalize, isRepeated, buildContextRedirect, improve };
