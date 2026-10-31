const fs = require('fs');
const path = require('path');

// Load master cleaned voter data
const votersPath = path.join(__dirname, 'voters_cleaned.json');
let VOTERS = [];

try {
    const raw = fs.readFileSync(votersPath, 'utf8');
    VOTERS = JSON.parse(raw);
    console.log(`[VoterEngine] Loaded ${VOTERS.length} voters for Sihali Khurd.`);
} catch (e) {
    console.error('[VoterEngine] Error loading voters_cleaned.json:', e);
}

// Comprehensive Hinglish to Hindi transliteration mapping for local names and surnames
const TRANSLIT_MAP = {
    // Surnames / Communities
    'yadav': 'यादव',
    'yadavs': 'यादव',
    'sharma': 'शर्मा',
    'singh': 'सिंह',
    'kumar': 'कुमार',
    'devi': 'देवी',
    'gurjar': 'गुर्जर',
    'meena': 'मीणा',
    'jat': 'जाट',
    'saini': 'सैनी',
    'balai': 'बलाई',
    'meghwal': 'मेघवाल',
    'ahir': 'अहीर',
    'rao': 'राव',
    'prince': 'प्रिंस',

    // Common First Names
    'satyanarayan': 'सत्यनारायण',
    'satya': 'सत्य',
    'prakash': 'प्रकाश',
    'satyaprakash': 'सत्यप्रकाश',
    'satish': 'सतीश',
    'suresh': 'सुरेश',
    'mukesh': 'मुकेश',
    'ramesh': 'रमेश',
    'rajesh': 'राजेश',
    'dinesh': 'दिनेश',
    'naresh': 'नरेश',
    'sunil': 'सुनील',
    'anil': 'अनिल',
    'susheel': 'सुशील',
    'rahul': 'राहुल',
    'pankaj': 'पंकज',
    'panakaj': 'पंकज',
    'dharampal': 'धर्मपाल',
    'dharmpal': 'धर्मपाल',
    'rohit': 'रोहित',
    'amit': 'अमित',
    'sumit': 'सुमित',
    'deepak': 'दीपक',
    'dilip': 'दिलीप',
    'dileep': 'दिलीप',
    'pankaj': 'पंकज',
    'vikas': 'विकास',
    'vijay': 'विजय',
    'ajay': 'अजय',
    'sanjay': 'संजय',
    'kuldeep': 'कुलदीप',
    'sandeep': 'संदीप',
    'pradeep': 'प्रदीप',
    'jaipal': 'जयपाल',
    'dharampal': 'धर्मपाल',
    'balraj': 'बलराज',
    'hemant': 'हेमंत',
    'jogendra': 'जोगेंद्र',
    'joginder': 'जोगिंदर',
    'ajit': 'अजीत',
    'kamlesh': 'कमलेश',
    'kamal': 'कमल',
    'ashok': 'अशोक',
    'vinod': 'विनोद',
    'manoj': 'मनोज',
    'om': 'ओम',
    'omprakash': 'ओमप्रकाश',
    'hawa': 'हवा',
    'balwan': 'बलवान',
    'surender': 'सुरेंद्र',
    'narendra': 'नरेंद्र',
    'mahender': 'महेंद्र',
    'rajender': 'राजेंद्र',
    'ravinder': 'रविंद्र',
    'jitender': 'जितेंद्र',
    'dharmender': 'धर्मेंद्र',
    'bijender': 'बिजेंद्र',
    'sube': 'सूबे',
    'hardayal': 'हरदयाल',
    'gajraj': 'गजराज',
    'deshraj': 'देशराज',
    'satpal': 'सतपाल',
    'sheeshram': 'शीशराम',
    'ramkishan': 'रामकिशन',
    'ramavtar': 'रामावतार',
    'ramphal': 'रामफल',
    'mohari': 'मोहरी',
    'moolchand': 'मूलचन्द',
    'babulal': 'बाबूलाल',
    'ramji': 'रामजीलाल',
    'ramjilal': 'रामजीलाल',
    'hanuman': 'हनुमान',
    'sonu': 'सोनू',
    'monu': 'मोनू',

    // Female Names
    'manju': 'मंजू',
    'rekha': 'रेखा',
    'anita': 'अनिता',
    'sunita': 'सुनीता',
    'saroj': 'सरोज',
    'pooja': 'पूजा',
    'monika': 'मोनिका',
    'geeta': 'गीता',
    'babli': 'बबली',
    'santosh': 'संतोष',
    'suman': 'सुमन',
    'prashant': 'प्रशांत',
    'vidya': 'विद्या',
    'kamla': 'कमला',
    'shanti': 'शांति',
    'munni': 'मुन्नी',
    'mamta': 'ममता',
    'kavita': 'कविता'
};

function cleanQuery(text) {
    if (!text) return { query: '', ward: null };
    let t = text.trim();
    
    // Extract Ward if present (e.g. "ward 1" or "w1" or "वार्ड 1")
    let ward = null;
    const wardMatch = t.match(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/i);
    if (wardMatch) {
        ward = parseInt(wardMatch[1]);
        t = t.replace(wardMatch[0], '');
    }

    // Remove common fillers
    const fillers = [
        'mera', 'naam', 'name', 'h', 'hai', 'he', 'ji', 'bhai', 'bhaiya', 'ka', 'ki', 'ke', 'ko',
        'parchi', 'check', 'karo', 'bhejo', 'kardo', 'dekhna', 'batao', 'voter', 'epic',
        'number', 'no', 'sir', 'plz', 'please', 'baba', 'sihali', 'khurd', 'bolna', 'na', 'naa', 'kie',
        'acha', 'accha', 'achha', 'are', 'arey', 'm', 'main', 'mai', 'dhund', 'dhundo', 'cha', 'chahta',
        'raha', 'rahi', 'rahe', 'hu', 'hoon', 'hun', 'hindi', 'nahi', 'aati', 'tum', 'samaj', 'samajh', 'jaao', 'jaa',
        'मेरा', 'नाम', 'है', 'जी', 'भाई', 'पर्ची', 'भेजो', 'करो', 'बताओ', 'वोटर', 'कार्ड', 'दिखाओ'
    ];

    const words = t.split(/[\s,.:;!?-]+/).filter(w => w.length > 0);
    const cleanedWords = words.filter(w => !fillers.includes(w.toLowerCase()));
    
    return {
        query: cleanedWords.join(' ').trim() || t,
        ward: ward
    };
}

function extractNameFromQuery(text) {
    if (!text) return '';
    let t = text.trim();
    // remove ward
    t = t.replace(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/ig, '');
    // remove common conversational prefixes and suffixes
    t = t.replace(/(?:mera\s*naam\s*(?:h|hai|he)?|naam\s*mera\s*(?:h|hai|he)?|bolna\s*na|batao\s*na|dekhna\s*(?:hai|h)|parchi\s*bhejo|voter\s*slip)/ig, '');
    t = t.replace(/\b(?:h|hai|he|ji|bhai|bhaiya|ka|ki|ke|ko|par|se|mein|me|plz|please|sir)\b/ig, '');
    t = t.replace(/[^a-zA-Z\u0900-\u097F\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return t || text.trim();
}

const CONVERSATIONAL_INQUIRY_WORDS = [
    'kab', 'kya', 'kaise', 'kahan', 'kyu', 'kyun', 'kon', 'kaun', 'kiska', 'kiske', 'kiski',
    'kasa', 'kaisa', 'kese', 'haal', 'hal', 'chal', 'raha', 'rahi', 'rahe', 'baat', 'baate',
    'virodhi', 'vipaksh', 'election', 'vote', 'voting', 'daaru', 'daru', 'sharab', 'paise', 'paisa',
    'kaam', 'vikas', 'mudda', 'samashya', 'pani', 'road', 'sadak', 'slogan', 'nara', 'shayari',
    'batao', 'bolo', 'sunao', 'working', 'online', 'chalu', 'when', 'who', 'what', 'how', 'why',
    'help', 'madad'
];

function isGreeting(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim().replace(/[^a-zA-Z\u0900-\u097F\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const greetingPhrases = [
        'hi', 'hii', 'hiii', 'hiiii', 'hiuu', 'hello', 'hey',
        'ram ram', 'ram ram ji', 'ram ram bhai', 'ram ram sa',
        'jai shree ram', 'radhe radhe', 'radhe shyam',
        'namaste', 'namaste ji', 'namaskar', 'pranam', 'pranaam',
        'good morning', 'good evening', 'good night'
    ];
    if (greetingPhrases.includes(lower)) return true;
    const words = lower.split(' ').filter(w => w.length > 0);
    const gWords = ['hi', 'hii', 'hiii', 'hiuu', 'hello', 'hey', 'ram', 'radhe', 'shree', 'shyam', 'namaste', 'namaskar', 'pranam', 'ji', 'bhai', 'sa'];
    if (words.length > 0 && words.every(w => gWords.includes(w))) return true;
    return false;
}

function isConversationalInquiry(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    if (lower.includes('parchi') || lower.includes('पर्ची') || lower.includes('voter') || lower.includes('वोटर') || lower.includes('epic')) {
        return false;
    }
    const words = lower.split(/[^a-zA-Z\u0900-\u097F]+/).filter(w => w.length > 0);
    return words.some(w => CONVERSATIONAL_INQUIRY_WORDS.includes(w));
}

function isLikelyNameOrVoterQuery(text) {
    if (!text) return false;
    if (isGreeting(text)) return false;
    if (isConversationalInquiry(text)) return false;
    
    const lower = text.toLowerCase().trim();
    
    // Explicit keywords
    if (
        lower.includes('naam') || lower.includes('name') || lower.includes('नाम') ||
        lower.includes('parchi') || lower.includes('पर्ची') || lower.includes('voter') ||
        lower.includes('वोटर') || lower.includes('ward') || lower.includes('वार्ड') ||
        lower.includes('epic') || lower.includes('list') || lower.includes('लिस्ट')
    ) {
        return true;
    }
    
    // 1 to 4 words that are not conversational
    const words = lower.split(/[^a-zA-Z\u0900-\u097F]+/).filter(w => w.length > 0);
    if (words.length >= 1 && words.length <= 4) {
        return true;
    }
    
    return false;
}

function searchVoters(rawInput, limit = 3) {
    const { query, ward } = cleanQuery(rawInput);
    if (!query) return [];

    const qLower = query.toLowerCase();
    const queryWords = qLower.split(/\s+/).filter(w => w.length > 0);

    const results = [];

    for (const v of VOTERS) {
        if (ward && v.ward !== ward) continue;

        const epic = (v.epic || '').toLowerCase();
        const nameHi = (v.name_hi || '').toLowerCase();
        const relHi = (v.rel_name_hi || '').toLowerCase();
        const nameRaw = (v.name_raw || '').toLowerCase();

        // Direct EPIC exact match
        if (epic && (qLower === epic || epic.includes(qLower))) {
            return [v];
        }

        // Match against transliteration or direct words
        let isMatch = false;

        // Check full query transliteration
        const qTranslit = TRANSLIT_MAP[qLower] || '';
        if (
            (qTranslit && nameHi.includes(qTranslit)) ||
            (qTranslit && relHi.includes(qTranslit)) ||
            nameHi.includes(qLower) ||
            relHi.includes(qLower) ||
            nameRaw.includes(qLower)
        ) {
            isMatch = true;
        }

        // Check individual words if multi-word query (e.g. "satyaprakash yadav" or "satyanarayan ward 1")
        if (!isMatch && queryWords.length > 0) {
            const allWordsMatch = queryWords.every(word => {
                const wTrans = TRANSLIT_MAP[word] || '';
                return (
                    (wTrans && nameHi.includes(wTrans)) ||
                    (wTrans && relHi.includes(wTrans)) ||
                    nameHi.includes(word) ||
                    relHi.includes(word) ||
                    nameRaw.includes(word)
                );
            });
            if (allWordsMatch) isMatch = true;
        }

        if (isMatch) {
            results.push(v);
            if (results.length >= 10) break;
        }
    }

    return results.slice(0, limit);
}

function getFamilyMembers(voter) {
    if (!voter.house_no || voter.house_no === '0' || voter.house_no === '-') return [];

    const family = [];
    for (const v of VOTERS) {
        if (v.ward === voter.ward && v.house_no === voter.house_no && v.sr_no !== voter.sr_no) {
            family.push(v);
            if (family.length >= 6) break;
        }
    }
    return family;
}

function formatSlipResponse(voter) {
    const family = getFamilyMembers(voter);

    const name = voter.name_hi || voter.name_raw || 'मतदाता';
    const relType = voter.rel_type || 'पिता';
    const relName = voter.rel_name_hi || '—';
    const ward = voter.ward || '—';
    const srNo = voter.sr_no || '—';
    const epic = voter.epic || 'जल्द जारी होगा';
    const houseNo = voter.house_no || '—';
    const age = voter.age || '—';

    let slip = `🗳️ *डिजिटल मतदाता पर्ची - सिहाली खुर्द* 🏛️\n`;
    slip += `━━━━━━━━━━━━━━━━━━━\n`;
    slip += `👤 *मतदाता का नाम:* ${name}\n`;
    slip += `👨‍👦 *${relType} का नाम:* ${relName}\n`;
    slip += `📍 *वार्ड नं:* ${ward}  |  *क्रम संख्या (Sr No):* ${srNo}\n`;
    slip += `🆔 *पहचान पत्र (EPIC):* ${epic}\n`;
    slip += `🏠 *मकान नं:* ${houseNo}  |  *आयु:* ${age} वर्ष\n`;
    slip += `🏫 *मतदान केंद्र:* राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द (बूथ 95 व 96)\n`;
    slip += `🗓️ *मतदान तिथि:* सोमवार, 16 नवम्बर 2026\n`;
    slip += `⏰ *समय:* सुबह 8:00 से सायं 5:00 बजे\n`;
    slip += `━━━━━━━━━━━━━━━━━━━\n`;

    if (family.length > 0) {
        slip += `👨‍👩‍👧‍👦 *आपके परिवार के अन्य सदस्य (मकान नं. ${houseNo}):*\n`;
        family.forEach((f, idx) => {
            const fName = f.name_hi || f.name_raw;
            const fRel = f.rel_name_hi ? ` (${f.rel_type}: ${f.rel_name_hi})` : '';
            slip += `  ${idx + 1}. ${fName}${fRel} — क्र. ${f.sr_no}\n`;
        });
        slip += `━━━━━━━━━━━━━━━━━━━\n`;
    }

    slip += `🙏 *सच्चा विकास, सबका सम्मान! बाबा अभय सिंह (मोटी आंगली वाले)*\n`;
    slip += `सरपंच पद प्रत्याशी। 16 नवम्बर को अपना अमूल्य मत देकर सेवा का अवसर दें! 🚩\n\n`;
    slip += `_अगर किसी और परिवारजन का नाम चेक करना हो, तो उनका नाम लिखकर भेजें।_`;

    return slip;
}

function formatFallbackResponse() {
    return (
        `राम राम भाई जी! 🙏\n\n` +
        `ग्राम पंचायत सिहाली खुर्द चुनाव सहायता केंद्र।\n\n` +
        `कृपया अपना नाम और वार्ड नंबर सही से लिखकर भेजें (उदाहरण: *सतीश वार्ड 1* या *Satish Kumar* या अपना *EPIC नंबर*) ताकि हम तुरंत आपकी और परिवार की वोटर पर्ची निकाल सकें।\n\n` +
        `— बाबा अभय सिंह सेवा केंद्र (मोटी आंगली वाले बाबा) 🚩`
    );
}

module.exports = {
    searchVoters,
    getFamilyMembers,
    formatSlipResponse,
    formatFallbackResponse,
    isLikelyNameOrVoterQuery,
    extractNameFromQuery,
    isGreeting
};
