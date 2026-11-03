const TOPICS = [
    { id: 'water', label: 'water supply', words: ['pani', 'paani', 'water', 'tanki', 'boring', 'पानी', 'टंकी'] },
    { id: 'road', label: 'road and access', words: ['sadak', 'road', 'gaddha', 'kichad', 'interlocking', 'सड़क', 'गड्ढा'] },
    { id: 'drainage', label: 'drainage and cleanliness', words: ['nali', 'naali', 'safai', 'kachra', 'drain', 'नाली', 'सफाई'] },
    { id: 'electricity', label: 'electricity and lighting', words: ['bijli', 'light', 'pole', 'khamba', 'andhera', 'बिजली', 'लाइट'] },
    { id: 'education', label: 'education and youth', words: ['school', 'college', 'library', 'student', 'padhai', 'yuva', 'स्कूल', 'पढ़ाई'] },
    { id: 'health', label: 'health services', words: ['hospital', 'health', 'doctor', 'dispensary', 'swasthya', 'अस्पताल', 'स्वास्थ्य'] },
    { id: 'voter_slip', label: 'voter slip', words: ['parchi', 'voter slip', 'epic', 'serial', 'पर्ची', 'मतदाता'] },
    { id: 'meeting', label: 'meeting request', words: ['milna', 'meeting', 'ghar aao', 'chaupal', 'baba se baat', 'मिलना', 'चौपाल'] },
    { id: 'vote', label: 'voting decision', words: ['vote', 'support', 'samarthan', 'वोट', 'समर्थन'] }
];

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function detectTopic(text) {
    const lower = cleanText(text).toLowerCase();
    if (!lower) return null;
    const match = TOPICS.find(topic => topic.words.some(word => lower.includes(word)));
    return match ? { id: match.id, label: match.label } : null;
}

function isQuestion(text) {
    const lower = cleanText(text).toLowerCase();
    return /[?]$/.test(lower) || /\b(kya|kyu|kyun|kaise|kab|kahan|kidhar|batao|tell|why|how|when|where)\b/.test(lower) || /(क्या|क्यों|कैसे|कब|कहाँ)/.test(lower);
}

function isConcern(text) {
    const lower = cleanText(text).toLowerCase();
    return /(problem|pareshani|shikayat|nahi hua|nhi hua|bekar|jhooth|naraz|issue|समस्या|परेशानी|शिकायत|नहीं हुआ|नाराज)/.test(lower);
}

function updateFromMessage(user, role, text) {
    if (!user || !text) return user;
    const compact = cleanText(text).slice(0, 500);
    user.context = user.context || {};

    if (role === 'user') {
        const topic = detectTopic(compact);
        if (topic) {
            if (user.context.currentTopic && user.context.currentTopic !== topic.id) {
                user.context.previousTopic = user.context.currentTopic;
            }
            user.context.currentTopic = topic.id;
            user.context.currentTopicLabel = topic.label;
        }
        user.context.lastUserMessage = compact;
        user.context.lastUserAt = new Date().toISOString();
        user.context.awaitingUserReply = false;
        user.proactivePingCount = 0;

        if (isQuestion(compact)) user.context.lastUserQuestion = compact;
        if (isConcern(compact)) user.context.lastConcern = compact;
        if (user.voteIntent === 'no' || user.voteIntent === 'doubtful') {
            user.context.voteReasonKnown = compact.length > 12 && !/^\s*(no|nahi|nhi|नहीं)\s*[.!]?$/i.test(compact);
        }
    } else if (role === 'bot') {
        user.context.lastBotMessage = compact;
        user.context.lastBotAt = new Date().toISOString();
        user.context.awaitingUserReply = isQuestion(compact);
        if (user.context.awaitingUserReply) user.context.lastBotQuestion = compact;
    }
    return user;
}

function buildProactiveMessage(user) {
    if (!user) return null;
    const hinglish = user.languagePreference !== 'hi';
    const name = user.name ? ` ${user.name} ji` : '';
    const context = user.context || {};

    if ((user.voteIntent === 'no' || user.voteIntent === 'doubtful') && !context.voteReasonKnown) {
        return hinglish
            ? `Ram Ram${name}. Aapka main concern kya hai—gaon ka kaam, vyavahar, ya koi local issue? Main aapki baat samajhna chahta hoon.`
            : `राम राम${name}। आपकी मुख्य चिंता क्या है—गाँव का काम, व्यवहार या कोई स्थानीय समस्या? मैं आपकी बात समझना चाहता हूँ।`;
    }

    if (context.lastConcern) {
        const topic = context.currentTopicLabel || 'local issue';
        return hinglish
            ? `Ram Ram${name}. Pichli baar aapne ${topic} ki baat batayi thi. Jagah ya ward bata den to main verified jankari check karke bata doon?`
            : `राम राम${name}। पिछली बार आपने ${topic} की बात बताई थी। जगह या वार्ड बता दें तो मैं प्रमाणित जानकारी देखकर बता दूँ?`;
    }

    if (context.currentTopicLabel) {
        return hinglish
            ? `Ram Ram${name}. ${context.currentTopicLabel} wali baat par aur koi sawal reh gaya ho to bhej dena; main seedha verified jawab dunga.`
            : `राम राम${name}। ${context.currentTopicLabel} वाली बात पर कोई सवाल रह गया हो तो भेज दें; मैं सीधा प्रमाणित जवाब दूँगा।`;
    }

    return hinglish
        ? `Ram Ram${name}. Aapko voter parchi, ward ki jankari, ya kisi gaon ke mudde par verified madad chahiye?`
        : `राम राम${name}। आपको मतदाता पर्ची, वार्ड की जानकारी या गाँव के किसी मुद्दे पर प्रमाणित मदद चाहिए?`;
}

function getPromptContext(user) {
    const context = user?.context || {};
    const parts = [];
    if (context.currentTopicLabel) parts.push(`Current topic: ${context.currentTopicLabel}`);
    if (context.lastConcern) parts.push(`Last concern: ${context.lastConcern}`);
    if (context.lastUserQuestion) parts.push(`Last user question: ${context.lastUserQuestion}`);
    if (context.lastBotQuestion && context.awaitingUserReply) parts.push(`Question awaiting reply: ${context.lastBotQuestion}`);
    return parts.join(' | ');
}

module.exports = { detectTopic, updateFromMessage, buildProactiveMessage, getPromptContext };
