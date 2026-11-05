// Click-to-WhatsApp ad FAQ guard (owner 6 Nov). Meta's ad can auto-answer its FAQ questions itself.
// When a voter taps one, we wait a few seconds: if an answer that the bot did not send shows up in that chat
// (Meta's automated response or the operator's phone), the bot stays quiet for that one message and takes over
// from the next. If nothing shows up, the bot answers as usual, so nobody is ever left without a reply.
const QUESTIONS = [
    'बाबा अभय सिंह जी के बारे में बताइए',
    'मेरी वोटर पर्ची कैसे मिलेगी?',
    'मतदान कब है और मुहर कैसे लगानी है?',
    'सिहाली खुर्द पंचायत के विकास कार्य बताइए',
    'सिहली खुर्द पंचायत के विकास कार्य बताइए',
    // older drafts, in case they were saved in the ad
    'मेरी डिजिटल वोटर पर्ची भेज दीजिए',
    'बाबा के विकास कार्य बताइए',
    'मतदान कब है और मेरा बूथ कौन सा है?',
    'मुझे अपनी समस्या बतानी है',
];
const norm = (s) => String(s || '').normalize('NFC').replace(/[\s\u200b-\u200d?।!.,🙏]+/g, '').toLowerCase();
const SET = new Set(QUESTIONS.map(norm));
function isAdFaq(text) { const n = norm(text); return !!n && SET.has(n); }

// chatKey -> last time a message from our number appeared that the bot did not send
const foreign = new Map();
// the bot's own sends can echo back before their id is stored, so a chat the bot just sent to is not "foreign"
const botSent = new Map();
function noteBotSend(chatKey, ts = Date.now()) { if (chatKey) botSent.set(chatKey, ts); if (botSent.size > 2000) botSent.delete(botSent.keys().next().value); }
function noteForeignOutgoing(chatKey, ts = Date.now()) { const b = botSent.get(chatKey); if (b && ts - b < 6000) return; if (chatKey) foreign.set(chatKey, ts); if (foreign.size > 2000) foreign.delete(foreign.keys().next().value); }
async function answeredElsewhere(chatKey, sinceTs, waitMs = 8000, stepMs = 500) {
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
        const t = foreign.get(chatKey);
        if (t && t >= sinceTs - 1500) return true;
        await new Promise(r => setTimeout(r, stepMs));
    }
    const t = foreign.get(chatKey);
    return !!(t && t >= sinceTs - 1500);
}
module.exports = { QUESTIONS, isAdFaq, noteBotSend, noteForeignOutgoing, answeredElsewhere, _norm: norm };
