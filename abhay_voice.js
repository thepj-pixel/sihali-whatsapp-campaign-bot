'use strict';
// Voter-facing replies speak as अभय सिंह himself (first person, male) — Prince, 9 Nov 2026.
// Name is always "अभय सिंह": never "बाबा" / "बाबा जी". "मेरी टीम" is fine sometimes.
// Applied to bot replies at send time; bulk/scheduled texts are written in this voice already.

const NAME = '(?:अभय सिंह)(?:\\s*जी)?(?:\\s*\\(मोटी आंगली वाले\\))?';
const RULES = [
    // "I'm from Abhay Singh's team" -> "I'm Abhay Singh"
    [/मैं\s+(?:बाबा\s+)?अभय\s+सिंह(?:\s*जी)?(?:\s*\(मोटी आंगली वाले(?: बाबा)?\))?\s+की\s+टीम\s+से(?:\s+(?:हूँ|हूं))?/g, 'मैं अभय सिंह (मोटी आंगली वाला) बोल रहा हूँ'],
    [/Main\s+(?:Baba\s+)?Abhay\s+Singh(?:\s+ji)?\s+ki\s+team\s+se(?:\s+(?:hoon|hun|hu))?/gi, 'Main Abhay Singh bol raha hoon'],
    [/मोटी आंगली वाले बाबा/g, 'मोटी आंगली वाले'],
    // drop "बाबा"
    [/बाबा\s+अभय\s+सिंह/g, 'अभय सिंह'],
    [/बाबा\s*जी|बाबाजी/g, 'अभय सिंह'],
    [/Baba\s+Abhay\s+Singh/gi, 'Abhay Singh'],
    // stamp line in first person
    [new RegExp(NAME + '\\s+का नाम देखकर (?:उनके|उसके) आगे', 'g'), 'मेरा नाम अभय सिंह (मोटी आंगली वाले) देखकर उसके आगे'],
    [new RegExp(NAME + '\\s+के आगे मुहर', 'g'), 'मेरे नाम के आगे मुहर'],
    // "I will pass it on to Abhay Singh" -> "I'll look at it myself"
    [new RegExp(NAME + '\\s+तक\\s+(?:पहुँचा|पहुंचा)(?:ती|ता|ऊँगी|ऊँगा|ऊंगी|ऊंगा)(?:\\s+हूँ|\\s+हूं)?', 'g'), 'मैं खुद देखूँगा'],
    [new RegExp(NAME + '\\s+की\\s+तरफ़\\s+से', 'g'), 'मेरी तरफ़ से'],
    [new RegExp(NAME + '\\s+की\\s+तरफ\\s+से', 'g'), 'मेरी तरफ से'],
    [new RegExp(NAME + '\\s+की(?=[\\s,।!?])', 'g'), 'मेरी'],
    [new RegExp(NAME + '\\s+का(?=[\\s,।!?])', 'g'), 'मेरा'],
    [new RegExp(NAME + '\\s+के(?=[\\s,।!?])', 'g'), 'मेरे'],
    [new RegExp(NAME + '\\s+को(?=[\\s,।!?])', 'g'), 'मुझे'],
    [new RegExp(NAME + '\\s+से(?=[\\s,।!?])', 'g'), 'मुझसे'],
    [new RegExp(NAME + '\\s+ने(?=[\\s,।!?])', 'g'), 'मैंने'],
    [/अभय सिंह\s+जी/g, 'अभय सिंह'],
    // Hinglish
    [/Abhay Singh(?:\s+ji)?\s+ki\s+team/gi, 'meri team'],
    [/Abhay Singh(?:\s+ji)?\s+ki\s+taraf\s+se/gi, 'meri taraf se'],
    [/Abhay Singh\s+ji/gi, 'Abhay Singh'],
    // female first person -> male
    [/ती हूँ/g, 'ता हूँ'], [/ती हूं/g, 'ता हूं'],
    [/रही हूँ/g, 'रहा हूँ'], [/रही हूं/g, 'रहा हूं'],
    [/गई हूँ/g, 'गया हूँ'], [/गई हूं/g, 'गया हूं'],
    [/ूँगी(?=[\s,।!?—\-]|$)/g, 'ूँगा'], [/ूंगी(?=[\s,।!?—\-]|$)/g, 'ूंगा'],
    [/(सुन|देख|पढ़|समझ|खोल)\s+पाती/g, '$1 पाता'],
    [/सेवा सहायिका|सहायिका/g, 'साथी'],
    [/\b(kar|sak|rah|de|le|bata|bhej|dekh|sun|samajh|pahucha|pahuncha)ti\s+(hoon|hun|hu)\b/gi, '$1ta $2'],
    [/\brahi\s+(hoon|hun|hu)\b/gi, 'raha $1'],
    [/\b(karungi|bataungi|bhejungi|dekhungi)\b/gi, (m) => m.slice(0, -1) + 'a'],
];

function toAbhayVoice(text) {
    if (typeof text !== 'string' || !text) return text;
    let t = text;
    for (const [rx, rep] of RULES) t = t.replace(rx, rep);
    return t;
}

function applyToContent(content) {
    if (!content || typeof content !== 'object') return content;
    const out = { ...content };
    if (typeof out.text === 'string') out.text = toAbhayVoice(out.text);
    if (typeof out.caption === 'string') out.caption = toAbhayVoice(out.caption);
    return out;
}

module.exports = { toAbhayVoice, applyToContent };
