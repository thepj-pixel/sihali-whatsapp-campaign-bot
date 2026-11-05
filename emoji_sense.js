/**
 * Emoji understanding for incoming WhatsApp messages (5 Nov 2026).
 *
 *   analyze('👍👍') -> { emojiOnly: true, kind: 'agree', emojis: ['👍','👍'] }
 *
 * Kinds: agree (👍 ✅ 👌 💯 🤝 👏 ☑️ ✔️), pray (🙏 — thanks/respect/agreement), love (❤️ 😍 🥰 🌹 💐 😊 🚩),
 * upset (😡 🤬 😠 😤 👎 💩 🖕), sad (😢 😭 💔 😔 😞), laugh (😂 🤣 😄 😆 😁 😅), think (🤔 😕 🙄 🤨 ❓ 😐),
 * wow (😮 😲 🔥 💪 🎉), other.
 * Mixed messages pick the strongest signal: upset > sad > agree/pray > love > laugh > think > wow.
 */
const EMOJI_ONLY_RX = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}\u200d\ufe0f\u20e3❤♥✔☑]+$/u;
const EMOJI_RX = /(\p{Extended_Pictographic}(\p{Emoji_Modifier}|\ufe0f|\u200d\p{Extended_Pictographic})*|[✔☑]\ufe0f?)/gu;

const GROUPS = {
    upset: ['😡', '🤬', '😠', '😤', '👎', '💩', '🖕', '😾', '👿'],
    sad: ['😢', '😭', '💔', '😔', '😞', '😟', '🥺', '😥', '😓'],
    agree: ['👍', '✅', '👌', '💯', '🤝', '👏', '☑', '✔', '🆗', '✌'],
    pray: ['🙏'],
    love: ['❤', '😍', '🥰', '🌹', '💐', '😊', '🚩', '♥', '💖', '💕', '💗', '💓', '😘', '☺', '🤗', '🙂', '💚', '🧡', '💛', '💙', '💜', '🌺', '🌸'],
    laugh: ['😂', '🤣', '😄', '😆', '😁', '😅', '😃', '😀', '😹', '😜', '😝'],
    think: ['🤔', '😕', '🙄', '🤨', '❓', '❔', '😐', '😶', '🤷'],
    wow: ['😮', '😲', '🔥', '💪', '🎉', '👑', '🎊', '😎', '⭐', '🌟']
};
const ORDER = ['upset', 'sad', 'agree', 'pray', 'love', 'laugh', 'think', 'wow'];

function base(e) { return String(e).replace(/[\ufe0f\u200d]|\p{Emoji_Modifier}/gu, '').slice(0, 2); }

function kindOf(e) {
    const b = base(e);
    for (const k of ORDER) if (GROUPS[k].some(g => b.startsWith(g) || g.startsWith(b) && b.length)) return k;
    return 'other';
}

function analyze(text) {
    const t = String(text || '').trim();
    if (!t) return { emojiOnly: false, kind: null, emojis: [] };
    const emojis = t.match(EMOJI_RX) || [];
    const emojiOnly = emojis.length > 0 && EMOJI_ONLY_RX.test(t) && !/[0-9#*]/.test(t.replace(/\u20e3/g, '').replace(/[^\x00-\x7f]/g, ''));
    if (!emojis.length) return { emojiOnly: false, kind: null, emojis };
    const kinds = new Set(emojis.map(kindOf));
    const kind = ORDER.find(k => kinds.has(k)) || 'other';
    return { emojiOnly, kind, emojis };
}

module.exports = { analyze, kindOf, GROUPS };
