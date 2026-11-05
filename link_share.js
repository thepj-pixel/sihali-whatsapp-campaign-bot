/**
 * Website links in voter replies (owner, 6 Nov 03:04 IST).
 *  - works / vikas / sankalp / "poori list" / more info -> short answer, then
 *      "पूरी लिस्ट और सारे काम वेबसाइट पे देख लो जी 👇"
 *      https://abhaysinghsihali.in
 *  - voter list / own name / parchi -> https://abhaysinghsihali.in/voter-directory
 *  - at most one link message per voter per 6 h, unless the voter explicitly asks for a link / website / list;
 *    shared at least once in a conversation (first relevant or friendly reply)
 *  - never with STOP / opt-out, abuse, grief or complaint replies
 *  - always full https, alone on its own line, and the first URL in the message
 */
const SITE = 'https://abhaysinghsihali.in';
const VOTER_DIR = 'https://abhaysinghsihali.in/voter-directory';
const WORKS_LINE = 'पूरी लिस्ट और सारे काम वेबसाइट पे देख लो जी 👇';
const VOTER_LINE = 'अपना नाम वोटर लिस्ट में यहाँ भी खोज सकते हैं 👇';
const GAP_MS = 6 * 3600 * 1000;

const EXPLICIT_RX = /(\blink\b|\bwebsite\b|\bweb\s*site\b|\bsite\b|वेबसाइट|लिंक|साइट|\blist\b|\blisht\b|लिस्ट|सूची|\bsoochi\b|\bsuchi\b)/i;
const WORKS_RX = /(\bkaam\b|\bkam\s+(kiye|kya|batao|bataiye)|\bkaary|\bkarya|\bvikas\b|\bsankalp|\bsankalpa?\b|\bpoori\b|\bpuri\b|\bjankari|\bjaankari|\bdetails?\b|more\s*info|\bkya\s+kiya|\bkya\s+kiye|\bparcha\b|manifesto|\bworks?\b|काम|कार्य|विकास|संकल्प|पूरी|जानकारी|घोषणा)/i;
const VOTER_RX = /(voter\s*(list|directory|slip)|vote\s*list|naam\s*(list|dekh|check|khoj)|mera\s*naam|apna\s*naam|\bparchi|\bslip\b|वोटर\s*(लिस्ट|सूची|पर्ची)|मतदाता\s*सूची|पर्ची|मेरा\s*नाम|अपना\s*नाम)/i;
// never: opt-out, abuse, grief, complaint / problem reports
const BLOCK_RX = /(^\s*(stop|band\s*karo|unsubscribe)\b|mat\s*bhejo|message\s*mat|स्टॉप|बंद\s*करो|मत\s*भेजो|kutt|kamin|harami|bsdk|bhosd|madarc|chutiy|nalayak|कुत्त|कमीन|हरामी|नालायक|nidhan|dehant|guzar\s*gay|gujar\s*gay|mar\s*gay|maut|death|shok|shraddh|tervi|निधन|देहांत|गुज़र|गुजर\s*गए|मृत्यु|मौत|शोक|श्रद्धांजलि|तेरहवीं|naali|nali\b|sadak\s*(toot|kharab)|paani\s*nahi|bijli\s*nahi|kichad|keechad|gandagi|shikayat|samasya|dikkat|naraz|naraaz|नाली|कीचड़|गंदगी|शिकायत|समस्या|दिक्कत|नाराज़|नाराज)/i;
const BLOCK_INTENTS = new Set(['abuse', 'complaint', 'grievance', 'condolence', 'samasya_explicit', 'health_concern', 'taunt', 'wrong_number',
    'privacy_probe', 'no_politics', 'opposed', 'opponent', 'stop', 'opt_out', 'optout', 'bribe', 'money_ask', 'political_concern', 'apology']);
const WORKS_INTENTS = new Set(['works', 'about_baba', 'future', 'women_works', 'vikas_menu', 'vikas_category', 'education', 'road', 'water', 'youth', 'jobs', 'housing', 'pension']);
const VOTER_INTENTS = new Set(['voter_slip', 'slip_help', 'slip', 'deliver', 'family', 'not_found', 'choose']);
// friendly turns where the one-per-conversation link may ride along when nothing was shared yet
const FRIENDLY_INTENTS = new Set(['thanks', 'positive', 'commit', 'committed', 'agree', 'leaning', 'support', 'political_positive', 'love', 'pray']);

const URL_RX = /https?:\/\/\S+/i;
const BLOCK_STRIP_RX = new RegExp('\\n*(?:' + [WORKS_LINE, VOTER_LINE].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*\\n' + 'https://abhaysinghsihali\\.in\\S*\\s*$', 'u');

/** Remove our link block from a stored bot text (so slip/NLU "last bot message" checks and LLM history never see it). */
function strip(text) { return String(text == null ? '' : text).replace(BLOCK_STRIP_RX, '').replace(/\n+https:\/\/abhaysinghsihali\.in\S*\s*$/u, '').trimEnd(); }

function kindFor(msg, intent, hint) {
    if (hint === 'voter' || hint === 'works') return hint;
    if (VOTER_INTENTS.has(intent) || VOTER_RX.test(msg)) return 'voter';
    if (WORKS_INTENTS.has(intent) || WORKS_RX.test(msg) || /\b(link|website|site)\b|वेबसाइट|लिंक/i.test(msg)) return 'works';
    return null;
}

/**
 * Append the website block to a voter reply when it is due.
 * @param {string} reply
 * @param {object} user  user_memory record (linkSharedAt is stored on it)
 * @param {{msg?:string, intent?:string, kind?:'works'|'voter', now?:number}} o
 * @returns {string} the reply (unchanged when no link is due)
 */
function addLink(reply, user, o = {}) {
    const text = String(reply || '');
    if (!text.trim() || !user) return text;
    if (process.env.LINK_SHARE === 'off') return text;
    const msg = String(o.msg || '');
    const intent = String(o.intent || '');
    if (BLOCK_INTENTS.has(intent) || BLOCK_RX.test(msg)) return text;
    if (user.broadcastOptOut || user.optedOut || user.consentStatus === 'REJECTED') return text;
    if (URL_RX.test(text)) return text; // a reply that already carries a URL is left alone (ours must be the first URL)
    const now = o.now || Date.now();
    const explicit = EXPLICIT_RX.test(msg);
    let kind = kindFor(msg, intent, o.kind);
    const last = user.linkSharedAt ? Date.parse(user.linkSharedAt) : 0;
    const due = !last || now - last >= GAP_MS;
    if (!kind) {
        // once per conversation: a friendly turn carries the works link if nothing was shared yet
        if (!last && FRIENDLY_INTENTS.has(intent)) kind = 'works'; else return text;
    }
    if (!explicit && !due) return text;
    const url = kind === 'voter' ? VOTER_DIR : SITE;
    const line = kind === 'voter' ? VOTER_LINE : WORKS_LINE;
    user.linkSharedAt = new Date(now).toISOString();
    user.linkSharedN = (user.linkSharedN || 0) + 1;
    user.linkSharedLast = kind;
    return `${text.trimEnd()}\n\n${line}\n${url}`;
}

module.exports = { addLink, strip, kindFor, SITE, VOTER_DIR, WORKS_LINE, VOTER_LINE, GAP_MS };
