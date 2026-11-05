/**
 * NLU v5 router: turns an nlu.understand() verdict into either
 *   - a direct reply (contact ask, voter-card-not-received, "who am I", political talk, concern, clarifying question), or
 *   - slip options for slip_flow.decide (self vs other person, cleaned name, father, ward), or
 *   - "let the brain answer" with the slip search blocked (votes, complaints, abuse ... never become a slip).
 * Facts: nothing here states a work, figure or date; the lines are reviewed templates. Female voice. Hindi default.
 */
const nlu = require('./nlu.js');

const NO_SLIP_INTENTS = new Set(['political_talk', 'support', 'opposition', 'contact_request', 'voter_card_issue', 'recall_self', 'complaint', 'abuse', 'question', 'thanks']);

function scriptEn(user) {
    const m = user && user.memory;
    if (m && m.scriptPref === 'hinglish') return true;
    if (m && m.scriptPref === 'hindi') return false;
    if (user && user.languagePreference === 'hinglish') return true;
    return false; // Hindi (Devanagari) by default
}
function pick(user, key, arr) {
    // simple rotation per voter so a repeated situation never gets the same line twice in a row
    if (!user) return arr[0];
    user.nluRot = user.nluRot || {};
    const i = (user.nluRot[key] = ((user.nluRot[key] || 0) + 1)) - 1;
    return arr[i % arr.length];
}
function ownName(user) {
    const m = (user && user.memory) || {};
    let n = String(m.name || (m.slip && m.slip.name) || '').trim();
    // Hindi replies show a Roman-typed name in Devanagari ("Krishan Kumar" -> "कृष्ण कुमार")
    if (n && /^[a-z\s.]+$/i.test(n) && !scriptEn(user)) {
        const words = n.split(/\s+/).filter(Boolean);
        const dv = nlu.toDevanagari(words);
        if (/^[\u0900-\u097F\s]+$/.test(dv)) n = dv;
        else n = n.replace(/\b\w/g, c => c.toUpperCase());
    }
    return n;
}
const ji = n => (n ? `${n} जी` : '');

function setTarget(user, n) {
    if (!user || !n || !n.wants_slip) return;
    const who = n.target_person || 'self';
    const nameHi = n.person_name_hi || null, nameRoman = n.person_name_roman || null;
    const prev = user.slipTarget;
    const name = nameHi || nameRoman;
    const sameName = prev && name && (prev.nameHi === nameHi || (prev.nameRoman && nameRoman && prev.nameRoman.toLowerCase() === nameRoman.toLowerCase()));
    if (name && (!prev || prev.who !== who || !sameName || prev.done)) {
        // a different person: the old pending list/candidate belongs to someone else — never answer it with this name
        if (prev && (prev.who !== who || !sameName)) { delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipPendingAt; }
        user.slipTarget = { who, name, nameHi, nameRoman, at: new Date().toISOString(), done: false };
    } else if (!name && (!prev || prev.who !== who)) {
        if (prev && prev.who !== who) { delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipPendingAt; }
        user.slipTarget = { who, name: null, nameHi: null, nameRoman: null, at: new Date().toISOString(), done: false };
    } else if (prev) prev.at = new Date().toISOString();
}

/**
 * @returns {{nlu, reply?: {text, contactCard?: boolean, intent}, slipOpts?: object, noSlip?: boolean}}
 */
function plan(n, user, ctx = {}) {
    const out = { nlu: n };
    if (!n) return out;
    if (user) user.nluTurnIntent = n.intent; // read by reply_brain: no slip clarifier on campaign talk / complaints
    // v6: "mere baare me kya pata hai?" / "kisne bataya?" is a privacy probe for the brain (never recall_self / a name recital)
    try { if (require('./operator_control.js').isPrivacyProbe(ctx.text || '')) { if (user) user.nluTurnIntent = 'privacy_probe'; return { nlu: n, noSlip: true }; } } catch (e) {}
    const en = scriptEn(user);
    const name = ownName(user);
    const S = (hi, ro) => (en ? ro : hi);

    switch (n.intent) {
        case 'contact_request': {
            // v7 (live): "baba se milna h" / "ghar pe aa jayenge kya" were read as a contact ask and got the number twice.
            // A meeting / visit ask goes to the brain's mulaqat flow; the number card only for a real number/contact ask.
            if (n.rules_intent && n.rules_intent !== 'contact_request') {
                let bc = null; try { bc = require('./reply_brain.js').classify(ctx.text || '', user || {}); } catch (e) {}
                if ((bc && bc.intent === 'meeting') || !/(number|nambar|नंबर|contact|kontact|संपर्क|कॉन्टैक्ट|phone|fone|mobile|मोबाइल|फ़ोन|फोन)/i.test(ctx.text || '')) return { nlu: n, noSlip: true };
            }
            const disp = ctx.lineDisplay || '';
            out.reply = { intent: 'contact_request', contactCard: true, text: S(
                `जी ज़रूर 🙏 अभय सिंह जी की टीम का यही WhatsApp नंबर है${disp ? ': ' + disp : ''}। संपर्क कार्ड भेज रही हूँ—सेव कर लीजिए, कोई भी काम हो तो यहीं लिखिए।`,
                `Ji zaroor 🙏 Abhay Singh ji ki team ka yahi WhatsApp number hai${disp ? ': ' + disp : ''}. Contact card bhej rahi hoon—save kar lijiye, koi bhi kaam ho to yahin likhiye.`) };
            out.noSlip = true;
            return out;
        }
        case 'voter_card_issue': {
            const other = n.target_person === 'other';
            const slipDone = user && user.memory && user.memory.slip && user.memory.slip.name;
            let t = '';
            if (!other && name) t += S(`आप ${ji(name)} हैं न—आपने बताया था 🙏 `, `Aap ${name} ji hain na—aapne bataya tha 🙏 `);
            t += S('वोटर कार्ड अभी तक नहीं आया, ये बात नोट कर ली है; कार्ड के बारे में टीम से पता करके आपको बताएँगे।',
                'Voter card abhi tak nahi aaya, ye baat note kar li hai; card ke baare me team se pata karke aapko batayenge.');
            if (!other && slipDone) t += S(' वोट डालने के लिए आपकी वोटर पर्ची ऊपर इसी चैट में है।', ' Vote daalne ke liye aapki voter parchi upar isi chat me hai.');
            else if (other) t += S(' तब तक उनकी वोटर पर्ची निकाल सकती हूँ—उनका पूरा नाम और पिता/पति का नाम बता दीजिए।', ' Tab tak unki voter parchi nikaal sakti hoon—unka poora naam aur pita/pati ka naam bata dijiye.');
            else if (name) t += S(' तब तक आपकी वोटर पर्ची निकाल सकती हूँ—अपने पिता/पति का नाम बता दीजिए, मिलान करके भेज दूँगी।', ' Tab tak aapki voter parchi nikaal sakti hoon—apne pita/pati ka naam bata dijiye, milaan karke bhej dungi.');
            else t += S(' तब तक आपकी वोटर पर्ची निकाल सकती हूँ—अपना पूरा नाम और पिता/पति का नाम बता दीजिए।', ' Tab tak aapki voter parchi nikaal sakti hoon—apna poora naam aur pita/pati ka naam bata dijiye.');
            if (user) {
                if (!slipDone) user.slipTarget = { who: other ? 'other' : 'self', name: other ? null : (name || null), nameHi: other ? null : (name || null), nameRoman: null, at: new Date().toISOString(), done: false, viaCardIssue: true };
                user.voterCardIssue = { at: new Date().toISOString(), who: other ? 'other' : 'self' };
                // v6: log it as a samasya (once per voter per 24h) so the team actually follows up
                try {
                    const prevId = user.voterCardIssueSamasya;
                    const ss = require('./samasya_store.js');
                    const recent = prevId && ss.get(prevId) && Date.now() - Date.parse(ss.get(prevId).createdAt || 0) < 86400e3;
                    if (!recent) {
                        const m = user.memory || {};
                        const rec = ss.create({ phone: user.phone, name: name || user.name || null, village: m.village || null, ward: m.ward || user.ward || null, category: 'other', topic: null,
                            description: ('वोटर कार्ड नहीं मिला' + (other ? ' (परिवार/दूसरे व्यक्ति का)' : '') + ': ' + String(ctx.text || '').slice(0, 200)).slice(0, 300), location: null, since: null, line: ctx.line || user.assignedLine || null, test: !!(ctx.test || user.selfTest), source: 'whatsapp', notes: 'voter card not received' });
                        if (rec && rec.id) { user.voterCardIssueSamasya = rec.id; m.samasyaIds = (m.samasyaIds || []).concat([rec.id]).slice(-20); out.samasyaId = rec.id; }
                    }
                } catch (e) { console.warn('[NLU router] voter-card samasya failed:', e.message); }
            }
            out.reply = { intent: 'voter_card_issue', text: t };
            out.noSlip = true;
            return out;
        }
        case 'recall_self': {
            const st = user && user.slipTarget && !user.slipTarget.done ? user.slipTarget : null;
            let t = name ? S(`आप ${ji(name)} हैं—आपने बताया था 🙏`, `Aap ${name} ji hain—aapne bataya tha 🙏`)
                : S('आपने अभी तक अपना नाम नहीं बताया 🙏 बता दीजिए, याद रखूँगी।', 'Aapne abhi tak apna naam nahi bataya 🙏 Bata dijiye, yaad rakhungi.');
            if (st && st.who === 'other' && st.name) t += S(` और ${st.nameHi || st.name} जी की पर्ची ढूँढ रहे थे—उनके पिता/पति का नाम या वार्ड बता दीजिए।`, ` Aur ${st.nameRoman || st.name} ji ki parchi dhoondh rahe the—unke pita/pati ka naam ya ward bata dijiye.`);
            else if (name) t += S(' बताइए, क्या मदद करूँ?', ' Bataiye, kya madad karun?');
            out.reply = { intent: 'recall_self', text: t };
            out.noSlip = true;
            return out;
        }
        case 'political_talk':
        case 'support':
        case 'opposition': {
            // brain v7 (5 Nov live): these canned lines fired on anything with "vote/jeet/saath" — a bribe ask ("vote ke kitne
            // paise doge") got "हर एक वोट कीमती है", "jeet ke koi nahi aata" and "vote pakka" got "मुँह में घी-शक्कर", an opponent
            // remark got "दोस्तों से बात करेंगे?". The reply brain has a specific answer for those (bribe, opponent, commit,
            // grievance, works...), so it answers them; the lines below are only for plain talk about the contest.
            let bc = null;
            try { bc = require('./reply_brain.js').classify(ctx.text || '', user || {}); } catch (e) { bc = null; }
            const GENERIC = new Set(['unclear', 'short_reply', 'positive', 'greeting', 'thanks', 'topic_mention', 'daily_life', 'emoji', 'wellbeing_reply']);
            const tx = String(ctx.text || '');
            const voteCount = /(\d+\s*(vote|vot|वोट)|(vote|वोट)[^?]{0,15}(kam|कम|kat|ghat|घट|jyada|zyada|ज़्यादा|ज्यादा)|\b(haar|harenge|हार)\b|takkar|टक्कर|mahaul|mahol|माहौल)/i.test(tx);
            const winWish = /(jeet|jit|जीत|jitenge|jeetenge|jitega|jeetega|jitwa|जिताएँगे|जिताएंगे)/i.test(tx) && !/(nahi|nhi|नहीं|koi|कोई|baad|बाद)/i.test(tx);
            const negSupport0 = /(nahi|nhi|nhai|नहीं|nahin)/i.test(tx) && /(saath|sath|साथ)/i.test(tx);
            if (bc && !GENERIC.has(bc.intent) && !(negSupport0 && bc.intent === 'opposed')) return { nlu: n, noSlip: true };
            if (!voteCount && !winWish && !negSupport0 && n.intent !== 'opposition') return { nlu: n, noSlip: true };
            const concerned = n.sentiment === 'concerned' || n.sentiment === 'angry' || n.intent === 'opposition';
            const negSupport = /(nahi|nhi|nhai|नहीं|nahin)/i.test(ctx.text || '') && /(saath|sath|साथ)/i.test(ctx.text || '');
            if (negSupport || n.intent === 'opposition') {
                out.reply = { intent: 'political_concern', text: pick(user, 'oppo', [
                    S('राम राम जी 🙏 आपकी बात सिर आँखों पर। कोई नाराज़गी या दिक्कत है तो खुलकर बताइए—मैं आपकी बात सीधे अभय सिंह जी तक पहुँचाऊँगी।', 'Ram Ram ji 🙏 Aapki baat sir aankhon par. Koi naraazgi ya dikkat hai to khulkar bataiye—main aapki baat seedhe Abhay Singh ji tak pahunchaungi.'),
                    S('आपकी राय का पूरा सम्मान है जी 🙏 बताइए, किस बात से मन खट्टा है? आपकी बात अभय सिंह जी तक ज़रूर पहुँचेगी।', 'Aapki raay ka poora samman hai ji 🙏 Bataiye, kis baat se man khatta hai? Aapki baat Abhay Singh ji tak zaroor pahunchegi.')]) };
            } else if (concerned) {
                out.reply = { intent: 'political_talk', text: pick(user, 'pol', [
                    S('आपने खुलकर बताया, बहुत धन्यवाद जी 🙏 सच है, हर एक वोट कीमती है। क्या आप अपने परिवार और दोस्तों से अभय सिंह जी के लिए बात करेंगे?', 'Aapne khulkar bataya, bahut dhanyavaad ji 🙏 Sach hai, har ek vote keemti hai. Kya aap apne parivar aur doston se Abhay Singh ji ke liye baat karenge?'),
                    S('आपकी फ़िक्र जायज़ है जी 🙏 हर एक वोट मायने रखता है। आपके हिसाब से किन लोगों से बात करनी चाहिए—आप साथ देंगे तो बात आगे बढ़ेगी।', 'Aapki fikr jaayaz hai ji 🙏 Har ek vote maayne rakhta hai. Aapke hisaab se kin logon se baat karni chahiye—aap saath denge to baat aage badhegi.')]) };
            } else if (winWish) {
                out.reply = { intent: 'political_positive', text: pick(user, 'polpos', [
                    S('आपके मुँह में घी-शक्कर जी 🙏 आपका साथ और आशीर्वाद ही असली ताकत है—अपने परिवार और पड़ोस में भी बात कीजिएगा।', 'Aapke munh me ghee-shakkar ji 🙏 Aapka saath aur aashirwad hi asli taakat hai—apne parivar aur pados me bhi baat kijiyega.'),
                    S('बहुत धन्यवाद जी 🙏 आप जैसे लोगों के भरोसे से ही हौसला है। घर-परिवार के वोट भी साथ रहें, बस यही गुज़ारिश है।', 'Bahut dhanyavaad ji 🙏 Aap jaise logon ke bharose se hi hausla hai. Ghar-parivar ke vote bhi saath rahein, bas yahi guzarish hai.')]) };
            } else {
                return { nlu: n, noSlip: true }; // other campaign talk: the brain answers, never a slip
            }
            out.noSlip = true;
            return out;
        }
        default: break;
    }

    if (n.wants_slip && (n.intent === 'slip_request' || n.intent === 'slip_answer')) {
        // a name that is the FATHER of someone in the open list/candidate ("bhawani ram") answers that list
        try {
            const sf = require('./slip_flow.js');
            const pend = [].concat(user && Array.isArray(user.disambiguationMatches) ? user.disambiguationMatches : [], user && user.pendingParchiCandidate ? [user.pendingParchiCandidate] : []);
            const nm = [n.person_name_hi, n.person_name_roman].filter(Boolean);
            if (pend.length && nm.length && pend.some(v => nm.some(x => sf.fatherGiven(`pita ${x}`, v) || sf.fatherGiven(x, v)))) {
                if (!n.father_name) n.father_name = n.person_name_roman || n.person_name_hi;
                n.person_name_hi = null; n.person_name_roman = null;
                if (user.slipTarget) n.target_person = user.slipTarget.who;
            }
        } catch (e) {}
        setTarget(user, n);
        const st = user && user.slipTarget;
        const who = (st && st.who) || n.target_person || 'self';
        let nameText = n.person_name_hi || n.person_name_roman || '';
        if (!nameText && st && !st.done && st.who === who) nameText = st.nameHi || st.nameRoman || st.name || '';
        const searchText = [nameText, n.ward ? `ward ${n.ward}` : ''].filter(Boolean).join(' ');
        out.slipOpts = { slipIntent: true, nlu: true, target: who, searchText: searchText || undefined, father: n.father_name || null, displayName: (st && st.nameHi) || nameText || null };
        return out;
    }
    if (NO_SLIP_INTENTS.has(n.intent)) out.noSlip = true;
    // brain v7 (5 Nov live): "kab hai vote dalna" (LLM: other) fell through to the name search and answered
    // "*dalna* नाम से … नहीं मिला". When the model read the message as something other than a slip and the rules agree,
    // the slip search stays out of it — except a short answer while our own list / yes-no question is open ("2", "हाँ").
    const pendingOpen = user && ((Array.isArray(user.disambiguationMatches) && user.disambiguationMatches.length) || user.pendingParchiCandidate);
    const shortTxt = String(ctx.text || '').trim().split(/\s+/).length <= 4;
    if (n.source === 'llm' && !['slip_request', 'slip_answer', 'unclear'].includes(n.intent) && !['slip_request', 'slip_answer'].includes(n.rules_intent) && !(pendingOpen && shortTxt)) out.noSlip = true;
    if (n.intent === 'question' && !(pendingOpen && shortTxt)) out.noSlip = true;
    return out;
}

/** One specific clarifying question that names what is open (used instead of a generic "sab theek?" fallback). */
function clarify(user) {
    if (user && user.nluTurnIntent && NO_SLIP_INTENTS.has(user.nluTurnIntent)) return null;
    if (user && ['greeting', 'thanks', 'support'].includes(user.nluTurnIntent)) return null;
    const en = scriptEn(user);
    const st = user && user.slipTarget && !user.slipTarget.done ? user.slipTarget : null;
    if (st && st.who === 'other' && st.name) return en ? `${st.nameRoman || st.name} ji ki parchi chahiye? Unke pita/pati ka naam ya ward bata dijiye 🙏` : `${st.nameHi || st.name} जी की पर्ची चाहिए? उनके पिता/पति का नाम या वार्ड बता दीजिए 🙏`;
    if (st && st.who === 'self') return en ? 'Aapki parchi nikaal doon? Apna poora naam aur pita/pati ka naam likh dijiye 🙏' : 'आपकी पर्ची निकाल दूँ? अपना पूरा नाम और पिता/पति का नाम लिख दीजिए 🙏';
    return null;
}

module.exports = { plan, clarify, setTarget, NO_SLIP_INTENTS, scriptEn };
