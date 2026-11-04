function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, ' ')
        .trim();
}

function wordSet(text) {
    return new Set(normalize(text).split(' ').filter(word => word.length > 2));
}

function similarity(a, b) {
    const left = wordSet(a);
    const right = wordSet(b);
    if (left.size < 4 || right.size < 4) return 0;
    let shared = 0;
    for (const word of left) if (right.has(word)) shared++;
    return shared / Math.max(left.size, right.size);
}

function isRepeated(reply, user, lookback = 6) {
    const candidate = normalize(reply);
    if (!candidate || !user || !Array.isArray(user.history)) return false;
    return user.history
        .filter(item => item.role === 'bot')
        .slice(-lookback)
        .some(item => {
            const previous = normalize(item.text);
            if (previous === candidate) return true;
            if (candidate.length >= 60 && previous.length >= 60 &&
                (candidate.includes(previous) || previous.includes(candidate))) return true;
            return similarity(candidate, previous) >= 0.78;
        });
}

function buildContextRedirect(user, incoming = '') {
    const hinglish = user?.languagePreference === 'hinglish' ||
        (user?.languagePreference !== 'hi' && !/[\u0900-\u097F]/.test(incoming));
    const name = user?.name ? `${user.name} ji, ` : '';
    const context = user?.context || {};

    if (context.lastConcern || context.currentTopicLabel) {
        const topic = context.currentTopicLabel || 'local issue';
        return hinglish
            ? `${name}${topic} wali baat note hai. Same jawab repeat nahi karunga—exact jagah, ward, ya jo hissa clear nahi hua woh bata dijiye.`
            : `${name}${topic} वाली बात नोट है। वही जवाब दोहराऊँगा नहीं—सही जगह, वार्ड या जो हिस्सा स्पष्ट नहीं हुआ वह बता दीजिए।`;
    }

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

module.exports = { normalize, wordSet, similarity, isRepeated, buildContextRedirect, improve };
