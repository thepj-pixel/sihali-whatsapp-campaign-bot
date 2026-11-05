const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const BABA_PHOTO_PATH = path.join(__dirname, 'media', 'baba_33_transparent.png');
const FONT_PATH = path.join(__dirname, 'media', 'NotoSansDevanagari-Bold.ttf');
const CARD_CACHE_DIR = path.join(__dirname, 'parchi_cache');

if (!fs.existsSync(CARD_CACHE_DIR)) {
    try { fs.mkdirSync(CARD_CACHE_DIR, { recursive: true }); } catch (e) {}
}

// Self-healing font installation for Linux environments (GCP VM / Debian)
function ensureFontsInstalled() {
    if (process.platform !== 'linux') return;
    try {
        const home = os.homedir();
        const fontDirs = [
            path.join(home, '.fonts'),
            path.join(home, '.local', 'share', 'fonts')
        ];
        const mediaDir = path.join(__dirname, 'media');
        const fontFiles = ['NotoSansDevanagari-Bold.ttf', 'NotoSansDevanagari-Regular.ttf'];

        let copied = false;
        for (const fDir of fontDirs) {
            if (!fs.existsSync(fDir)) {
                try { fs.mkdirSync(fDir, { recursive: true }); } catch (e) {}
            }
            for (const fName of fontFiles) {
                const src = path.join(mediaDir, fName);
                const dst = path.join(fDir, fName);
                if (fs.existsSync(src) && !fs.existsSync(dst)) {
                    fs.copyFileSync(src, dst);
                    copied = true;
                    console.log(`[VoterCardGen] Installed ${fName} to ${dst}`);
                }
            }
        }
        if (copied) {
            try {
                execSync('fc-cache -f ~/.fonts 2>/dev/null || fc-cache -f 2>/dev/null || true', { stdio: 'ignore' });
                console.log('[VoterCardGen] fc-cache updated successfully.');
            } catch (e) {}
        }
    } catch (e) {
        console.warn('[VoterCardGen] Font auto-install error:', e.message);
    }
}
ensureFontsInstalled();

function clearCardCache() {
    try {
        if (fs.existsSync(CARD_CACHE_DIR)) {
            const files = fs.readdirSync(CARD_CACHE_DIR);
            for (const f of files) {
                if (f.endsWith('.jpg') || f.endsWith('.png')) {
                    fs.unlinkSync(path.join(CARD_CACHE_DIR, f));
                }
            }
            console.log(`[VoterCardGen] Cleared ${files.length} cached cards.`);
        }
    } catch (e) {
        console.error('[VoterCardGen] Error clearing cache:', e.message);
    }
}

let FONT_B64 = '';
if (fs.existsSync(FONT_PATH)) {
    try {
        FONT_B64 = fs.readFileSync(FONT_PATH).toString('base64');
    } catch (e) {
        console.error('[VoterCardGen] Could not read font file:', e.message);
    }
}

async function generateVoterCard(voter) {
    const cacheKey = voter.id || voter.sr_no || voter.epic || `${voter.ward || 1}_${voter.sr_no || 1}`;
    // v3 in the name: cards rendered before 4 Nov 2026 carried a symbol and must never be served again
    const cacheFile = path.join(CARD_CACHE_DIR, `card_v6_${cacheKey}.jpg`);
    if (fs.existsSync(cacheFile)) {
        try {
            return fs.readFileSync(cacheFile);
        } catch (e) {}
    }

    const width = 1080;
    const height = 1240;

    const nameHi = voter.name_hi || voter.name || voter.n || 'ग्रामवासी';
    const nameEn = voter.name_en || voter.ne || voter.name || '';
    const relName = voter.rel_name_hi || voter.rel_name || voter.r || '';
    const rtRaw = String(voter.rt || voter.rel_type || 'F').trim();
    const relType = require('./relation_label').relLabel(voter);
    const ward = voter.ward || voter.w || 1;
    const serial = voter.sr_no || voter.s || 1;
    const epic = voter.epic || voter.e || '--';
    
    let house = String(voter.house_no || voter.h || '--').trim();
    let age = parseInt(voter.age || voter.a || 0);
    // Auto-correct any inverted age / house number (e.g. 168 years old in house 33)
    if (age > 105 && parseInt(house) > 0 && parseInt(house) < 95) {
        const temp = age;
        age = parseInt(house);
        house = String(temp);
    }
    const gRaw = String(voter.gender_hi || voter.gender || voter.g || '');
    const gender = /महिला|^f/i.test(gRaw) ? 'महिला' : (/पुरुष|^m/i.test(gRaw) ? 'पुरुष' : '');
    const booth = [voter.booth || 'बूथ 95', voter.booth_name ? 'रा.उ.मा.वि. सिहाली खुर्द' : ''].filter(Boolean).join(' • ');

    const fontStyleMarkup = FONT_B64 ? `
        <style>
          @font-face {
            font-family: 'Noto Sans Devanagari';
            src: url('data:font/truetype;charset=utf-8;base64,${FONT_B64}') format('truetype');
            font-weight: 700;
            font-style: normal;
          }
          text {
            font-family: 'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif;
          }
        </style>
    ` : `
        <style>
          text {
            font-family: 'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif;
          }
        </style>
    `;

    const svgMarkup = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${fontStyleMarkup}
        <linearGradient id="topBanner" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ea580c"/>
          <stop offset="50%" stop-color="#f97316"/>
          <stop offset="100%" stop-color="#ea580c"/>
        </linearGradient>
        <linearGradient id="candidateBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#1e293b"/>
        </linearGradient>
        <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f59e0b"/>
          <stop offset="50%" stop-color="#fbbf24"/>
          <stop offset="100%" stop-color="#d97706"/>
        </linearGradient>
      </defs>

      <!-- Canvas Background -->
      <rect width="100%" height="100%" fill="#f1f5f9"/>

      <!-- Top Orange Stripe -->
      <rect x="0" y="0" width="100%" height="16" fill="url(#topBanner)"/>

      <!-- Main Card Container -->
      <rect x="30" y="35" width="1020" height="1170" fill="#ffffff" rx="24" stroke="#cbd5e1" stroke-width="2"/>

      <!-- Top Header -->
      <rect x="30" y="35" width="1020" height="85" fill="#f8fafc" rx="24"/>
      <text x="540" y="78" font-size="28" font-weight="900" fill="#0f172a" text-anchor="middle">
        ग्राम पंचायत सिहाली खुर्द • पंचायत आम चुनाव 2026
      </text>
      <text x="540" y="108" font-size="19" font-weight="700" fill="#ea580c" text-anchor="middle" letter-spacing="1">
        ★ डिजिटल मतदाता पर्ची (DIGITAL VOTER SLIP) ★
      </text>

      <!-- Candidate Box -->
      <rect x="55" y="135" width="970" height="195" fill="url(#candidateBg)" rx="18"/>
      <circle cx="165" cy="232" r="78" fill="#1e293b" stroke="url(#gold)" stroke-width="5"/>

      <!-- Candidate Details (No Kram Sankhya 1 or 2, just Abhay Singh & Moti Angli Wale) -->
      <text x="265" y="186" font-size="21" font-weight="800" fill="#f59e0b">
        सरपंच पद प्रत्याशी
      </text>
      <text x="265" y="234" font-size="44" font-weight="900" fill="#ffffff">
        अभय सिंह
      </text>
      <text x="265" y="272" font-size="24" font-weight="800" fill="#fed7aa">
        (मोटी आंगली वाले)
      </text>
      <text x="265" y="304" font-size="16" font-weight="600" fill="#94a3b8">
        40 साल की सच्ची समाज सेवा • अटूट भाईचारा
      </text>

      <!-- Stamp badge (Prince 5 Nov: no ballot serial number, only मुहर) (the parcha leaves the election symbol blank: never print a symbol) -->
      <g transform="translate(885, 232) rotate(-8)">
        <circle cx="0" cy="0" r="58" fill="#ffffff" stroke="#6d28d9" stroke-width="3.5" stroke-dasharray="6,3"/>
        <circle cx="0" cy="0" r="50" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/>
        <text x="0" y="10" font-size="34" font-weight="900" fill="#6d28d9" text-anchor="middle">मुहर</text>
        <text x="0" y="34" font-size="15" font-weight="800" fill="#5b21b6" text-anchor="middle">लगाएं</text>
      </g>

      <!-- Voter Details Grid -->
      <rect x="55" y="348" width="970" height="730" fill="#f8fafc" rx="16" stroke="#e2e8f0" stroke-width="2"/>
      <rect x="55" y="348" width="970" height="52" fill="#e2e8f0" rx="16"/>
      <text x="80" y="383" font-size="20" font-weight="800" fill="#334155">
        मतदाता का विवरण (VOTER DETAILS)
      </text>

      <!-- Name Row -->
      <text x="85" y="445" font-size="22" font-weight="700" fill="#64748b">मतदाता का नाम:</text>
      <text x="320" y="448" font-size="36" font-weight="900" fill="#0f172a">${nameHi}</text>
      <text x="740" y="445" font-size="22" font-weight="700" fill="#475569">(${nameEn})</text>
      <line x1="85" y1="472" x2="995" y2="472" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Relative Row -->
      <text x="85" y="520" font-size="22" font-weight="700" fill="#64748b">${relType} का नाम:</text>
      <text x="320" y="520" font-size="28" font-weight="800" fill="#1e293b">${relName}</text>
      <line x1="85" y1="545" x2="995" y2="545" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Ward & Sr No Dual Box -->
      <rect x="85" y="568" width="435" height="100" fill="#eff6ff" rx="12" stroke="#bfdbfe" stroke-width="1.5"/>
      <text x="110" y="605" font-size="18" font-weight="700" fill="#1e40af">वार्ड संख्या (Ward No):</text>
      <text x="110" y="650" font-size="38" font-weight="900" fill="#1e3a8a">वार्ड नं. ${ward}</text>

      <rect x="545" y="568" width="450" height="100" fill="#fef3c7" rx="12" stroke="#fde68a" stroke-width="1.5"/>
      <text x="570" y="605" font-size="18" font-weight="700" fill="#92400e">क्रमांक संख्या (Sr No):</text>
      <text x="570" y="655" font-size="44" font-weight="900" fill="#b45309"># ${serial}</text>

      <!-- EPIC & House No -->
      <rect x="85" y="688" width="435" height="90" fill="#ffffff" rx="12" stroke="#cbd5e1" stroke-width="1.5"/>
      <text x="110" y="722" font-size="17" font-weight="700" fill="#64748b">पहचान पत्र (EPIC No):</text>
      <text x="110" y="760" font-size="26" font-weight="900" fill="#0f172a">${epic}</text>

      <rect x="545" y="688" width="450" height="90" fill="#ffffff" rx="12" stroke="#cbd5e1" stroke-width="1.5"/>
      <text x="570" y="722" font-size="17" font-weight="700" fill="#64748b">मकान संख्या (House No):</text>
      <text x="570" y="760" font-size="26" font-weight="900" fill="#0f172a">मकान नं. ${house}</text>

      <!-- Age & Gender -->
      <text x="85" y="830" font-size="22" font-weight="700" fill="#64748b">आयु एवं लिंग:</text>
      <text x="320" y="830" font-size="26" font-weight="800" fill="#1e293b">${age} वर्ष${gender ? '  |  ' + gender : ''}</text>
      <line x1="85" y1="855" x2="995" y2="855" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Polling Station -->
      <text x="85" y="905" font-size="21" font-weight="700" fill="#64748b">मतदान केंद्र:</text>
      <text x="320" y="905" font-size="23" font-weight="800" fill="#0f172a">${booth}</text>
      <line x1="85" y1="930" x2="995" y2="930" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Polling Date & Timing Box -->
      <rect x="85" y="955" width="910" height="95" fill="#f0fdf4" rx="12" stroke="#bbf7d0" stroke-width="1.5"/>
      <text x="110" y="990" font-size="17" font-weight="700" fill="#15803d">मतदान दिनांक व समय:</text>
      <text x="110" y="1025" font-size="24" font-weight="900" fill="#166534">सोमवार, 16 नवम्बर 2026  •  प्रातः 7:30 बजे से सायं 5:30 बजे तक</text>

      <!-- Footer Appeal: "थारी आंगली से मोटी आंगली वाले के आगे मुहर लगाओ!" -->
      <rect x="55" y="1098" width="970" height="80" fill="#ea580c" rx="16"/>
      <text x="540" y="1148" font-size="24" font-weight="900" fill="#ffffff" text-anchor="middle">
        ★ थारी आंगली से मोटी आंगली वाले के आगे मुहर लगाओ! ★
      </text>
    </svg>
    `;

    const composites = [];

    // 1. Base SVG card canvas goes first
    composites.push({
        input: Buffer.from(svgMarkup),
        top: 0,
        left: 0
    });

    // 2. Candidate 33 transparent cutout contained cleanly inside the gold frame (shifted down slightly for perfect vertical balance)
    if (fs.existsSync(BABA_PHOTO_PATH)) {
        const photoSize = 152;
        const circleMask = Buffer.from(
            `<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`
        );
        const targetW = 146;
        const babaMeta = await sharp(BABA_PHOTO_PATH).metadata();
        const targetH = Math.round(babaMeta.height * (targetW / babaMeta.width));
        const resizedBaba = await sharp(BABA_PHOTO_PATH)
            .resize(targetW, targetH)
            .toBuffer();

        const shiftY = 12; // Shift slightly down so safa plume has breathing room & chest anchors at bottom
        const ox = Math.round((photoSize - targetW) / 2);
        const oy = Math.round((photoSize - targetH) / 2) + shiftY;

        const containedBaba = await sharp({
            create: {
                width: photoSize,
                height: photoSize,
                channels: 4,
                background: { r: 30, g: 41, b: 59, alpha: 1 }
            }
        })
        .composite([
            { input: resizedBaba, top: oy, left: ox },
            { input: circleMask, blend: 'dest-in' }
        ])
        .png()
        .toBuffer();

        composites.push({
            input: containedBaba,
            top: 232 - Math.round(photoSize / 2),
            left: 165 - Math.round(photoSize / 2)
        });
    }

    const finalJpg = await sharp({
        create: {
            width: width,
            height: height,
            channels: 4,
            background: { r: 241, g: 245, b: 249, alpha: 1 }
        }
    })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();

    try {
        fs.writeFileSync(cacheFile, finalJpg);
    } catch (e) {}

    return finalJpg;
}


/** One card for a household (same ward + house no.): name, father/husband, age, Sr No, booth. No EPIC numbers. */
async function generateFamilyCard(head, members) {
    const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const RL = require('./relation_label');
    const list = (members && members.length ? members : [head]).slice(0, 10).sort((a, b) => Number(a.sr_no) - Number(b.sr_no));
    const width = 1080, rowH = 118, top = 360;
    const height = top + list.length * rowH + 230;
    const fontStyle = `<style>${FONT_B64 ? `@font-face{font-family:'Noto Sans Devanagari';src:url('data:font/truetype;charset=utf-8;base64,${FONT_B64}') format('truetype');font-weight:700;}` : ''} text{font-family:'Noto Sans Devanagari','Lohit Devanagari','Gargi','Nirmala UI','Mangal',sans-serif;}</style>`;
    const rows = list.map((v, i) => {
        const y = top + i * rowH;
        const age = parseInt(v.age || v.a || 0) || '';
        const booth = String(v.booth || '').replace(/^रा\.उ\.मा\.वि\.\s*सिहाली खुर्द\s*/, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
        return `<rect x="55" y="${y}" width="970" height="${rowH - 12}" rx="14" fill="${i % 2 ? '#ffffff' : '#f8fafc'}" stroke="#e2e8f0" stroke-width="1.5"/>
      <circle cx="105" cy="${y + 53}" r="30" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>
      <text x="105" y="${y + 63}" font-size="28" font-weight="900" fill="#b45309" text-anchor="middle">${i + 1}</text>
      <text x="155" y="${y + 46}" font-size="32" font-weight="900" fill="#0f172a">${esc(v.name_hi || v.name)}</text>
      <text x="155" y="${y + 86}" font-size="21" font-weight="700" fill="#475569">${esc(RL.relLabel(v))}: ${esc(v.rel_name_hi || '')}${age ? '  •  आयु ' + age : ''}</text>
      <text x="1000" y="${y + 46}" font-size="26" font-weight="900" fill="#1e3a8a" text-anchor="end">क्रमांक ${esc(v.sr_no)}</text>
      <text x="1000" y="${y + 86}" font-size="19" font-weight="700" fill="#15803d" text-anchor="end">${esc(booth)}</text>`;
    }).join('\n');
    const yEnd = top + list.length * rowH;
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>${fontStyle}<linearGradient id="cb" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="#f1f5f9"/>
      <rect x="0" y="0" width="100%" height="16" fill="#ea580c"/>
      <rect x="30" y="35" width="1020" height="${height - 65}" fill="#ffffff" rx="24" stroke="#cbd5e1" stroke-width="2"/>
      <text x="540" y="80" font-size="28" font-weight="900" fill="#0f172a" text-anchor="middle">ग्राम पंचायत सिहाली खुर्द • पंचायत आम चुनाव 2026</text>
      <text x="540" y="112" font-size="20" font-weight="800" fill="#ea580c" text-anchor="middle">★ परिवार की मतदाता पर्ची (FAMILY VOTER SLIP) ★</text>
      <rect x="55" y="135" width="970" height="150" fill="url(#cb)" rx="18"/>
      <circle cx="140" cy="210" r="60" fill="#1e293b" stroke="#f59e0b" stroke-width="4"/>
      <text x="225" y="180" font-size="20" font-weight="800" fill="#f59e0b">सरपंच पद प्रत्याशी</text>
      <text x="225" y="226" font-size="40" font-weight="900" fill="#ffffff">अभय सिंह <tspan font-size="24" fill="#fed7aa">(मोटी आंगली वाले)</tspan></text>
      <text x="225" y="262" font-size="16" font-weight="600" fill="#94a3b8">40 साल की सच्ची समाज सेवा • अटूट भाईचारा</text>
      <text x="60" y="335" font-size="24" font-weight="900" fill="#334155">वार्ड नं. ${esc(head.ward)}  •  मकान नं. ${esc(head.house_no || head.h)}  •  ${list.length} मतदाता</text>
      ${rows}
      <rect x="55" y="${yEnd + 12}" width="970" height="80" fill="#f0fdf4" rx="12" stroke="#bbf7d0" stroke-width="1.5"/>
      <text x="540" y="${yEnd + 62}" font-size="24" font-weight="900" fill="#166534" text-anchor="middle">मतदान: सोमवार, 16 नवम्बर 2026 • प्रातः 7:30 से सायं 5:30 बजे तक</text>
      <rect x="55" y="${yEnd + 108}" width="970" height="76" fill="#ea580c" rx="16"/>
      <text x="540" y="${yEnd + 156}" font-size="24" font-weight="900" fill="#ffffff" text-anchor="middle">★ थारी आंगली से मोटी आंगली वाले के आगे मुहर लगाओ! ★</text>
    </svg>`;
    const comps = [{ input: Buffer.from(svg), top: 0, left: 0 }];
    if (fs.existsSync(BABA_PHOTO_PATH)) {
        const size = 116, tw = 110;
        const meta = await sharp(BABA_PHOTO_PATH).metadata();
        const th = Math.round(meta.height * (tw / meta.width));
        const baba = await sharp(BABA_PHOTO_PATH).resize(tw, th).toBuffer();
        const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
        const round = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 30, g: 41, b: 59, alpha: 1 } } })
            .composite([{ input: baba, top: Math.round((size - th) / 2) + 9, left: Math.round((size - tw) / 2) }, { input: mask, blend: 'dest-in' }]).png().toBuffer();
        comps.push({ input: round, top: 210 - size / 2, left: 140 - size / 2 });
    }
    return sharp({ create: { width, height, channels: 4, background: { r: 241, g: 245, b: 249, alpha: 1 } } }).composite(comps).jpeg({ quality: 90 }).toBuffer();
}

module.exports = { generateFamilyCard, generateVoterCard, clearCardCache, CARD_CACHE_DIR };
