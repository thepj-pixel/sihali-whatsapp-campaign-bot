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

// Common Hinglish to Hindi transliteration mapping for local names
const TRANSLIT_MAP = {
    'satyanarayan': 'सत्यनारायण',
    'satish': 'सतीश',
    'suresh': 'सुरेश',
    'mukesh': 'मुकेश',
    'ramesh': 'रमेश',
    'rajesh': 'राजेश',
    'sunil': 'सुनील',
    'anil': 'अनिल',
    'rahul': 'राहुल',
    'deepak': 'दीपक',
    'dilip': 'दिलीप',
    'naresh': 'नरेश',
    'dharampal': 'धर्मपाल',
    'balraj': 'बलराज',
    'hemant': 'हेमंत',
    'jogendra': 'जोगेंद्र',
    'ajit': 'अजीत',
    'kamlesh': 'कमलेश',
    'manju': 'मंजू',
    'rekha': 'रेखा',
    'anita': 'अनिता',
    'babli': 'बबली',
    'santosh': 'संतोष',
    'suman': 'सुमन',
    'prashant': 'प्रशांत',
    'sheeshram': 'शीशराम',
    'sube': 'सूबे',
    'hardayal': 'हरदयाल',
    'gajraj': 'गजराज',
    'mohari': 'मोहरी',
    'moolchand': 'मूलचन्द',
    'babulal': 'बाबूलाल',
    'ramji': 'रामजीलाल',
    'ramjilal': 'रामजीलाल',
    'hanuman': 'हनुमान'
};

function cleanQuery(text) {
    if (!text) return '';
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
        'mera', 'naam', 'name', 'h', 'hai', 'he', 'ji', 'bhai', 'bhaiya', 'ka', 'ki',
        'parchi', 'check', 'karo', 'bhejo', 'kardo', 'dekhna', 'batao', 'voter', 'epic',
        'number', 'no', 'sir', 'plz', 'please', 'baba', 'sihali', 'khurd',
        'मेरा', 'नाम', 'है', 'जी', 'भाई', 'पर्ची', 'भेजो', 'करो', 'बताओ', 'वोटर', 'कार्ड'
    ];

    const words = t.split(/[\s,.:;!?-]+/).filter(w => w.length > 0);
    const cleanedWords = words.filter(w => !fillers.includes(w.toLowerCase()));
    
    return {
        query: cleanedWords.join(' ').trim() || t,
        ward: ward
    };
}

function searchVoters(rawInput, limit = 3) {
    const { query, ward } = cleanQuery(rawInput);
    if (!query) return [];

    const qLower = query.toLowerCase();
    const qTranslit = TRANSLIT_MAP[qLower] || '';

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

        // Match Hindi Name, Translit name, or Relation Name
        if (
            (qTranslit && nameHi.includes(qTranslit)) ||
            (qTranslit && relHi.includes(qTranslit)) ||
            nameHi.includes(qLower) ||
            relHi.includes(qLower) ||
            nameRaw.includes(qLower)
        ) {
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
    slip += `🏫 *मतदान केंद्र:* राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द\n`;
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
    formatFallbackResponse
};
