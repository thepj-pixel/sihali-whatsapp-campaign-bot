/**
 * Photo understanding for incoming WhatsApp images (5 Nov 2026).
 *
 * replyForPhoto({ user, analysis, caption, meta }) -> { text, kind, samasyaId }
 *   - civic_issue (broken road / naali / water / bijli): logs a samasya ("photo received", category) and asks the
 *     place if it is not known. No date or fix is promised.
 *   - campaign_material (Abhay Singh ji's poster/photo): warm thanks.
 *   - voter_id: handled by the caller (slip search), this only gives the safe text when nothing matched.
 *   - personal_photo / other: polite, short.
 *   - fallback (no vision available): warm acknowledgement + one line asking what the photo is about; sets
 *     memory.photoOpenAt so the voter's next problem-like answer is logged as a samasya (reply_brain hook).
 * Never throws: a failure returns the fallback text.
 */
const voterMemory = require('./voter_memory.js');

const CIVIC_TOPIC = [
    [/(सड़क|रास्त|गड्ढ|road|sadak|gaddh|pothole)/i, 'road', 'सड़क/रास्ता'],
    [/(नाल|कीचड़|गंद|सफ़ाई|सफाई|drain|naali|nali|kichad|sewer|कचरा|garbage)/i, 'drainage', 'नाली/सफ़ाई'],
    [/(पानी|हैंडपंप|नल|टंकी|water|pani|handpump|tap|tank)/i, 'water', 'पानी'],
    [/(बिजली|खंभ|तार|लाइट|bijli|pole|wire|light|electric)/i, 'electricity', 'बिजली'],
    [/(स्कूल|school|अस्पताल|hospital)/i, 'other', 'सार्वजनिक भवन']
];

function civicTopic(text) {
    const t = String(text || '');
    for (const [rx, topic, label] of CIVIC_TOPIC) if (rx.test(t)) return { topic, label };
    return { topic: 'other', label: 'गाँव की समस्या' };
}

function honorificFor(user) {
    const g = user && (user.genderDetected || user.genderGuess || (user.memory && user.memory.gender));
    return g === 'F' ? ' बहन जी' : (g === 'M' ? ' भाई साहब' : '');
}

function replyForPhoto({ user = {}, analysis = null, caption = '', meta = {} } = {}) {
    const H = honorificFor(user);
    const mem = voterMemory.ensure(user);
    try {
        if (!analysis || analysis.fallback) {
            mem.photoOpenAt = new Date().toISOString();
            return { kind: 'fallback', text: `फोटो मिल गई${H}, धन्यवाद 🙏 ये किस बारे में है—कोई समस्या हो तो जगह और दिक्कत एक लाइन में लिख दीजिए, मैं रजिस्टर में दर्ज कर दूँगी।` };
        }
        const summary = String(analysis.summaryHindi || '').replace(/["“”]/g, '').slice(0, 120).trim();
        const cat = analysis.category;
        if (cat === 'civic_issue') {
            const { topic, label } = civicTopic([summary, analysis.details && analysis.details.issueType, caption].join(' '));
            let rec = null;
            try {
                const ss = require('./samasya_store.js');
                rec = ss.create({
                    phone: meta.phone, name: user.name || (mem && mem.name) || null, village: mem.village || null, ward: mem.ward || user.ward || null,
                    category: label, topic, description: ('📷 फोटो प्राप्त: ' + (summary || label) + (caption ? ' — ' + caption : '')).slice(0, 300),
                    location: null, since: null, line: meta.line || null, test: !!meta.test, source: 'whatsapp_photo', notes: 'photo received' + (meta.localUrl ? ' ' + meta.localUrl : '')
                });
            } catch (e) { rec = null; }
            mem.concerns = (mem.concerns || []).concat([{ topic, ward: mem.ward || null, at: new Date().toISOString(), status: 'open', count: 1, text: ('📷 ' + (summary || label)).slice(0, 80), via: 'photo' }]).slice(-8);
            mem.photoOpenAt = null;
            const where = (mem.ward || user.ward) ? '' : ' ये किस गली/वार्ड की है, बता देंगे?';
            return { kind: 'civic_issue', samasyaId: rec ? rec.id : null, text: `फोटो मिल गई${H} 🙏 ${label} की यह दिक्कत${summary ? ' (' + summary + ')' : ''} रजिस्टर में दर्ज कर ली है${rec ? ' (क्रमांक ' + rec.id + ')' : ''} और अभय सिंह जी तक पहुँचा दी है।${where}` };
        }
        if (cat === 'campaign_material') {
            return { kind: 'campaign_material', text: `वाह${H}! 🙏🚩 अभय सिंह जी की तस्वीर भेजने के लिए दिल से धन्यवाद—आपका यह साथ ही हमारी असली ताकत है।` };
        }
        if (cat === 'voter_id') {
            return { kind: 'voter_id', text: `फोटो मिल गई${H} 🙏 पर्ची निकालने के लिए अपना पूरा नाम और पिता/पति का नाम लिखकर भेज दीजिए—मैं वोटर लिस्ट में देखकर भेज दूँगी।` };
        }
        if (cat === 'personal_photo') {
            return { kind: 'personal_photo', text: `बहुत सुंदर तस्वीर${H} 😊🙏 भेजने के लिए धन्यवाद। घर-परिवार में सब कुशल-मंगल?` };
        }
        mem.photoOpenAt = new Date().toISOString();
        return { kind: 'other', text: `फोटो मिल गई${H}, धन्यवाद 🙏 इसके बारे में कुछ बताना हो या कोई समस्या हो तो एक लाइन में लिख दीजिए।` };
    } catch (e) {
        return { kind: 'fallback', text: `फोटो मिल गई, धन्यवाद 🙏 ये किस बारे में है—एक लाइन में लिख दीजिए।` };
    }
}

module.exports = { replyForPhoto, civicTopic };
