/**
 * Typo / spelling normaliser for voter messages (6 Nov live: "vooterr slip rajeshh devi kie", "parivaar", "parchii",
 * "slipp"). Applied at the entry of slip_flow (preempt/decide) and nlu.understand so the rules, the name search and the
 * family-card path all see one spelling. Roman words only; Devanagari is left as it is.
 */
const MAP = [
    [/\bv+o+t+(?:e+|a+)?r+s?\b/gi, 'voter'],                      // vooter, vooterr, votar, votr
    [/\bp(?:a+)?r(?:a+)?c+h+(?:i+|e+|y+|ee+|ie)\b/gi, 'parchi'],  // parchii, parchee, prchi, parchie, parchhi
    [/\bp(?:a+)?r(?:a+)?c+h+(?:i+|e+)y+a+n?\b/gi, 'parchiyan'],   // parchiyaan, parchiya
    [/\bs+l+i+p+s?\b/gi, 'slip'],                                  // slipp, slips
    [/\bp+a+r+i+(?:v+|w+)a+r+\b/gi, 'parivar'],                   // parivaar, pariwaar, parivaaar
    [/\bp+a+r+(?:v+|w+)a+r+\b/gi, 'parivar'],                     // parwar, parvaar
    [/\bf+a+m+(?:i+|e+)?l+(?:y+|i+|ee+)\b/gi, 'family'],          // famly, familly, familyy, famili
    [/\bfmly\b/gi, 'family'],
    [/\bk(?:ie+|ii+|iee)\b/gi, 'ki'],                              // kie, kii, kiee
    [/\bgh?ar+\s*(?:w|v)a+l+(?:o+n?|e+|on)\b/gi, m => /o/i.test(m.slice(-2)) ? 'ghar walo' : 'ghar wale'], // gharwalo, ghar waalon
];
const KEEP_FINAL = /(ee|oo|aa)$/i; // shree, jee, dhoo: Roman Hindi long vowels stay
function normalizeMsg(text) {
    let t = String(text == null ? '' : text);
    if (!/[a-z]/i.test(t)) return t;
    for (const [rx, to] of MAP) t = t.replace(rx, to);
    // a doubled last letter on a longer Roman word is a typo ("rajeshh" -> "rajesh", "devii" -> "devi", "manojj")
    t = t.replace(/\b([a-z]{3,})([a-z])\2+\b/gi, (m, a, b) => (KEEP_FINAL.test(m) ? m : a + b));
    return t;
}
module.exports = { normalizeMsg };
