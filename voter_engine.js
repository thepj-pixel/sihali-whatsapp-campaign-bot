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
    'kumari': 'कुमारी',
    'kmari': 'कुमारी',
    'reena': 'रीना',
    'rina': 'रीना',
    'rinku': 'रिंकू',
    'mnoj': 'मनोज',
    'gurjar': 'गुर्जर',
    'meena': 'मीणा',
    'jat': 'जाट',
    'saini': 'सैनी',
    'balai': 'बलाई',
    'meghwal': 'मेघवाल',
    'ahir': 'अहीर',
    'rao': 'राव',
        'prince': 'प्रिंस',
    'pirnce': 'प्रिंस',
    'princ': 'प्रिंस',
    'abhay': 'अभय',
    'abay': 'अभय',
    'abhe': 'अभय',
    'baba': 'अभय',
    'shambhu': 'शम्भूदयाल',
    'shambhudayal': 'शम्भूदयाल',
    'shyodan': 'श्योदान',
    'mohit': 'मोहित',
    'archana': 'अर्चना',
    'sahil': 'साहिल',
    'rohitash': 'रोहिताश',
    'virendra': 'वीरेंद्र',
    'veerendra': 'वीरेंद्र',
    'tara': 'तारा',
    'tarachand': 'ताराचन्द',
    'moolchand': 'मूलचन्द',
    'subhash': 'सुभाष',
    'kailash': 'कैलाश',
    'krishna': 'कृष्ण',
    'krishan': 'कृष्ण',
    'kishan': 'किशन',
    'pooja': 'पूजा',
    'puja': 'पूजा',
    'poonam': 'पूनम',
    'mamta': 'ममता',
    'kavita': 'कविता',
    'savita': 'सविता',
    'sunita': 'सुनीता',
    'anita': 'अनीता',
    'rekha': 'रेखा',
    'bhoop': 'भूप',
    'bhoora': 'भूरा',
    'chaman': 'चमन',
    'arvind': 'अरविन्द',
    'sheela': 'शीला',

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


function normalizePhonetic(str) {
    if (!str) return '';
    let s = str.toLowerCase().trim();
    s = s.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/v/g, 'w');
    s = s.replace(/sh/g, 's').replace(/ch/g, 'c').replace(/z/g, 'j');
    s = s.replace(/(.)\1+/g, '$1');
    s = s.replace(/ी/g, 'ि').replace(/ू/g, 'ु').replace(/श|ष/g, 'स');
    s = s.replace(/ण/g, 'न').replace(/ब/g, 'व').replace(/ँ/g, 'ं');
    return s;
}

function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

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
    const words = lower.split(/[^a-zA-Z0-9\u0900-\u097F/]+/).filter(w => w.length > 0);
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

const SURNAMES = new Set(['yadav', 'यादव', 'singh', 'सिंह', 'kumar', 'कुमार', 'devi', 'देवी', 'sharma', 'शर्मा', 'gurjar', 'गुर्जर', 'meena', 'मीणा', 'jat', 'जाट', 'saini', 'सैनी', 'balai', 'बलाई']);

const FILLERS_SET = new Set([
    'are', 'arey', 'dhund', 'dhundo', 'na', 'naa', 'h', 'hai', 'he', 'papa', 'pitaji', 'pita',
    'ka', 'ki', 'ke', 'ko', 'naam', 'name', 'syad', 'shayad', 'se', 'cha', 'raha', 'rahi', 'hu', 'hoon',
    'bhai', 'apna', 'apni', 'aur', 'tum', 'lo', 'khud', 'mera', 'meri', 'mere', 'check', 'karo', 'kardo',
    'batao', 'parchi', 'voter', 'slip', 'card', 'epic', 'plz', 'please', 'sir', 'ji', 'bhaiya',
    'ward', 'w', 'bhej', 'bhejo', 'do', 'dedo', 'de', 'dekhna', 'acha', 'accha', 'achha', 'm', 'main'
]);

function searchVoters(rawInput, limit = 5, fallbackWard = null) {
    if (!rawInput) return [];
    let trimmed = rawInput.trim();
    let lower = trimmed.toLowerCase();

    // Check direct ID or EPIC match anywhere in query
    const idPatternMatch = trimmed.match(/\b([Ww]\d{1,2}-\d{1,4}|IED\d+|CYN\d+|RJ\/\d+\/\d+\/\d+)\b/i);
    if (idPatternMatch) {
        const directMatch = getVoterById(idPatternMatch[1]);
        if (directMatch) {
            return [directMatch];
        }
    }
    
    // Check ward
    let ward = fallbackWard;
    const wardMatch = lower.match(/(?:ward|वार्ड|w)[\s:]*([0-9]{1,2})/i);
    if (wardMatch) ward = parseInt(wardMatch[1]);

    const rawTokens = lower.split(/[^a-zA-Z\u0900-\u097F]+/).filter(w => w.length >= 2 && !FILLERS_SET.has(w));
    if (rawTokens.length === 0) return [];

    const scored = [];
    for (const v of VOTERS) {
        if (ward && v.ward !== ward) continue;

        let score = 0;
        let matchedDistinctName = false;
        const nameHi = (v.name_hi || '').toLowerCase();
        const relHi = (v.rel_name_hi || '').toLowerCase();
        const nameRaw = (v.name_raw || '').toLowerCase();
        const nameEn = (v.name || '').toLowerCase();
        const relEn = (v.rel_name || '').toLowerCase();
        const searchText = (v.search_text || '').toLowerCase();
        const epic = (v.epic || '').toLowerCase();
        const vId = (v.id || '').toLowerCase();

        for (const rawT of rawTokens) {
            const hindiT = (TRANSLIT_MAP[rawT] || rawT).toLowerCase();
            const isSurname = SURNAMES.has(rawT) || SURNAMES.has(hindiT);

            // Exact EPIC match
            if (epic && (epic === rawT || epic.includes(rawT))) {
                score += 150;
                matchedDistinctName = true;
            }

            // ID or Sr No match
            if (vId === rawT || String(v.sr_no) === rawT || String(v.s) === rawT) {
                score += 150;
                matchedDistinctName = true;
            }

            // Name match (Hindi or English transliteration)
            if (nameHi.includes(hindiT) || nameHi.includes(rawT) || nameEn.includes(rawT) || searchText.includes(rawT)) {
                if (isSurname) {
                    score += 5;
                } else {
                    score += 40;
                    matchedDistinctName = true;
                }
            }

            // Relative / Father / Husband match (Hindi or English)
            if (relHi.includes(hindiT) || relHi.includes(rawT) || relEn.includes(rawT)) {
                if (isSurname) {
                    score += 5;
                } else {
                    score += 35;
                    matchedDistinctName = true;
                }
            }

            // Raw OCR match
            if (nameRaw.includes(hindiT) || nameRaw.includes(rawT)) {
                if (!isSurname) score += 15;
            }

            // Phonetic & Fuzzy match for typos (e.g. 'reena' vs 'rina', 'mnoj' vs 'manoj')
            if (rawT.length >= 3 && !isSurname) {
                const normT = normalizePhonetic(rawT);
                const allWords = (nameHi + ' ' + nameEn + ' ' + relHi + ' ' + relEn).split(/[\s,.:;!?-]+/).filter(w => w.length >= 3);
                for (const w of allWords) {
                    const normW = normalizePhonetic(w);
                    if (normW === normT || normW.includes(normT) || normT.includes(normW)) {
                        score += 30;
                        matchedDistinctName = true;
                        break;
                    } else if (normT.length >= 4 && Math.abs(normT.length - normW.length) <= 1) {
                        if (levenshteinDistance(normT, normW) <= 1) {
                            score += 25;
                            matchedDistinctName = true;
                            break;
                        }
                    }
                }
            }
        }

        if (matchedDistinctName || score >= 40) {
            scored.push({ voter: v, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.voter);
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

function getBoothDetails(ward) {
    const w = parseInt(ward);
    if (w <= 3) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 95 - कमरा नं 1)';
    if (w <= 6) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 96 - कमरा नं 2)';
    if (w <= 8) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 97 - कमरा नं 3)';
    return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 98 - कमरा नं 4)';
}

function getVoterById(id) {
    if (!id) return null;
    const clean = id.trim().toUpperCase();
    return VOTERS.find(v => (v.id && v.id.toUpperCase() === clean) || (v.epic && v.epic.toUpperCase() === clean));
}

function getVoterByWardAndSr(ward, srNo) {
    return VOTERS.find(v => v.ward === parseInt(ward) && v.sr_no === parseInt(srNo));
}

function getBoothDetails(ward) {
    const w = parseInt(ward);
    if (w <= 3) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 95 - कमरा नं 1)';
    if (w <= 6) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 96 - कमरा नं 2)';
    if (w <= 8) return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 97 - कमरा नं 3)';
    return 'रा.उ.मा.वि. सिहाली खुर्द (बूथ 98 - कमरा नं 4)';
}

function getVoterById(id) {
    if (!id) return null;
    const clean = id.trim().toUpperCase();
    return VOTERS.find(v => (v.id && v.id.toUpperCase() === clean) || (v.epic && v.epic.toUpperCase() === clean));
}

function getVoterByWardAndSr(ward, srNo) {
    return VOTERS.find(v => v.ward === parseInt(ward) && v.sr_no === parseInt(srNo));
}

function formatSlipResponse(voter) {
    const family = getFamilyMembers(voter);

    const name = voter.name_hi || voter.name_raw || voter.n || 'मतदाता';
    const relType = (voter.rel_type === 'H' || voter.rt === 'पति') ? 'पति' : 'पिता';
    const relName = voter.rel_name_hi || voter.rn || '—';
    const ward = voter.ward || voter.w || '—';
    const srNo = voter.sr_no || voter.s || '—';
    const epic = voter.epic || voter.e || 'जल्द जारी होगा';
    const houseNo = voter.house_no || voter.h || '—';
    const age = voter.age || voter.a || '—';
    const boothName = getBoothDetails(ward);
    const voterId = voter.id || `W${String(ward).padStart(2, '0')}-${String(srNo).padStart(4, '0')}`;
    const digitalSlipUrl = `https://abhay-sihali.netlify.app/voter-directory.html?id=${voterId}`;

    let slip = `🗳️ *डिजिटल मतदाता पर्ची - सिहाली खुर्द* 🏛️\n`;
    slip += `━━━━━━━━━━━━━━━━━━━\n`;
    slip += `👤 *मतदाता का नाम:* ${name}\n`;
    slip += `👨‍👦 *${relType} का नाम:* ${relName}\n`;
    slip += `📍 *वार्ड नं:* ${ward}  |  *क्रमांक (Sr No):* [ ${srNo} ]\n`;
    slip += `🆔 *पहचान पत्र (EPIC):* ${epic}\n`;
    slip += `🏠 *मकान नं:* ${houseNo}  |  *आयु:* ${age} वर्ष\n`;
    slip += `🏫 *मतदान केंद्र:* ${boothName}\n`;
    slip += `🗓️ *मतदान तिथि:* सोमवार, 16 नवम्बर 2026 (प्रातः 8 से सायं 5)\n`;
    slip += `🔗 *ऑनलाइन पर्ची लिंक:* ${digitalSlipUrl}\n`;
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
    getVoterById,
    getVoterByWardAndSr,
    searchVoters,
    getFamilyMembers,
    formatSlipResponse,
    formatFallbackResponse,
    isLikelyNameOrVoterQuery,
    extractNameFromQuery,
    isGreeting
};
