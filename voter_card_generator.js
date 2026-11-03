const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const BABA_PHOTO_PATH = path.join(__dirname, 'media', 'baba_face.jpg');
const FONT_PATH = path.join(__dirname, 'media', 'NotoSansDevanagari-Bold.ttf');
const CARD_CACHE_DIR = path.join(__dirname, 'parchi_cache');

if (!fs.existsSync(CARD_CACHE_DIR)) {
    try { fs.mkdirSync(CARD_CACHE_DIR, { recursive: true }); } catch (e) {}
}

// On Linux, automatically copy our bundled NotoSansDevanagari-Bold.ttf into user's font directories
// so Fontconfig and librsvg pick it up without manual intervention
let fontsInstalled = false;
function ensureLinuxFonts() {
    if (fontsInstalled || process.platform !== 'linux') return;
    try {
        const home = os.homedir();
        const userFonts = path.join(home, '.local', 'share', 'fonts');
        const legacyFonts = path.join(home, '.fonts');
        [userFonts, legacyFonts].forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });

        if (fs.existsSync(FONT_PATH)) {
            const dest1 = path.join(userFonts, 'NotoSansDevanagari-Bold.ttf');
            const dest2 = path.join(legacyFonts, 'NotoSansDevanagari-Bold.ttf');
            if (!fs.existsSync(dest1)) fs.copyFileSync(FONT_PATH, dest1);
            if (!fs.existsSync(dest2)) fs.copyFileSync(FONT_PATH, dest2);
            try {
                execSync('fc-cache -f ' + userFonts + ' ' + legacyFonts, { stdio: 'ignore', timeout: 5000 });
                console.log('[VoterCardGen] Installed NotoSansDevanagari-Bold into user font directories & ran fc-cache');
            } catch (e) {}
        }
        fontsInstalled = true;
    } catch (e) {
        console.warn('[VoterCardGen] Note on auto-font install:', e.message);
    }
}
ensureLinuxFonts();

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
    const cacheFile = path.join(CARD_CACHE_DIR, `card_${cacheKey}.jpg`);
    if (fs.existsSync(cacheFile)) {
        try {
            return fs.readFileSync(cacheFile);
        } catch (e) {}
    }

    const width = 1080;
    const height = 1240;

    const nameHi = voter.name_hi || voter.name || 'ग्रामवासी';
    const nameEn = voter.name_en || voter.name || '';
    const relName = voter.rel_name_hi || voter.rel_name || '';
    const relType = voter.rel_type === 'H' ? 'पति' : 'पिता';
    const ward = voter.ward || voter.w || 1;
    const serial = voter.sr_no || voter.s || 1;
    const epic = voter.epic || voter.e || '--';
    const house = voter.house_no || voter.h || '--';
    const age = voter.age || voter.a || '--';
    const gender = voter.gender_hi || (voter.gender === 'F' ? 'महिला' : 'पुरुष');
    const booth = voter.booth || `बूथ 95 (कमरा नं 1)`;

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
      <text x="540" y="78" font-size="28" font-weight="900" fill="#0f172a" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        🏛️ ग्राम पंचायत सिहाली खुर्द • पंचायत आम चुनाव 2026
      </text>
      <text x="540" y="108" font-size="19" font-weight="700" fill="#ea580c" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif" letter-spacing="1">
        ★ अधिकृत डिजिटल मतदाता पर्ची (DIGITAL VOTER SLIP) ★
      </text>

      <!-- Candidate Box -->
      <rect x="55" y="135" width="970" height="195" fill="url(#candidateBg)" rx="18"/>
      <circle cx="165" cy="232" r="76" fill="none" stroke="url(#gold)" stroke-width="6"/>

      <!-- Candidate Details -->
      <text x="265" y="188" font-size="20" font-weight="700" fill="#f59e0b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        सरपंच पद प्रत्याशी • मतपत्र क्रम संख्या: 1
      </text>
      <text x="265" y="232" font-size="38" font-weight="900" fill="#ffffff" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        बाबा अभय सिंह
      </text>
      <text x="265" y="268" font-size="22" font-weight="700" fill="#fed7aa" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        (मोटी आंगली वाले बाबा)  |  प्रतीक: 卐 (स्वस्तिक)
      </text>
      <text x="265" y="302" font-size="17" font-weight="600" fill="#94a3b8" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        40 वर्षों से निष्पक्ष सेवा, विकास व जन-कल्याण को समर्पित
      </text>

      <!-- Voter Details Grid -->
      <rect x="55" y="348" width="970" height="730" fill="#f8fafc" rx="16" stroke="#e2e8f0" stroke-width="2"/>
      <rect x="55" y="348" width="970" height="52" fill="#e2e8f0" rx="16"/>
      <text x="80" y="383" font-size="20" font-weight="800" fill="#334155" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        📋 मतदाता का विवरण (VOTER DETAILS)
      </text>

      <!-- Name Row -->
      <text x="85" y="445" font-size="22" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">मतदाता का नाम:</text>
      <text x="320" y="448" font-size="36" font-weight="900" fill="#0f172a" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">${nameHi}</text>
      <text x="740" y="445" font-size="22" font-weight="700" fill="#475569" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">(${nameEn})</text>
      <line x1="85" y1="472" x2="995" y2="472" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Relative Row -->
      <text x="85" y="520" font-size="22" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">${relType} का नाम:</text>
      <text x="320" y="520" font-size="28" font-weight="800" fill="#1e293b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">${relName}</text>
      <line x1="85" y1="545" x2="995" y2="545" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Ward & Sr No Dual Box -->
      <rect x="85" y="568" width="435" height="100" fill="#eff6ff" rx="12" stroke="#bfdbfe" stroke-width="1.5"/>
      <text x="110" y="605" font-size="18" font-weight="700" fill="#1e40af" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">वार्ड संख्या (Ward No):</text>
      <text x="110" y="650" font-size="38" font-weight="900" fill="#1e3a8a" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">वार्ड नं. ${ward}</text>

      <rect x="545" y="568" width="450" height="100" fill="#fef3c7" rx="12" stroke="#fde68a" stroke-width="1.5"/>
      <text x="570" y="605" font-size="18" font-weight="700" fill="#92400e" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">क्रमांक संख्या (Sr No):</text>
      <text x="570" y="655" font-size="44" font-weight="900" fill="#b45309" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif"># ${serial}</text>

      <!-- EPIC & House No -->
      <rect x="85" y="688" width="435" height="90" fill="#ffffff" rx="12" stroke="#cbd5e1" stroke-width="1.5"/>
      <text x="110" y="722" font-size="17" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">पहचान पत्र (EPIC No):</text>
      <text x="110" y="760" font-size="26" font-weight="900" fill="#0f172a" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">${epic}</text>

      <rect x="545" y="688" width="450" height="90" fill="#ffffff" rx="12" stroke="#cbd5e1" stroke-width="1.5"/>
      <text x="570" y="722" font-size="17" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">मकान संख्या (House No):</text>
      <text x="570" y="760" font-size="26" font-weight="900" fill="#0f172a" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">मकान नं. ${house}</text>

      <!-- Age & Gender -->
      <text x="85" y="830" font-size="22" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">आयु एवं लिंग:</text>
      <text x="320" y="830" font-size="26" font-weight="800" fill="#1e293b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">${age} वर्ष  |  ${gender}</text>
      <line x1="85" y1="855" x2="995" y2="855" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Polling Station -->
      <text x="85" y="905" font-size="21" font-weight="700" fill="#64748b" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">मतदान केंद्र:</text>
      <text x="320" y="905" font-size="23" font-weight="800" fill="#0f172a" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">रा.उ.मा.वि. सिहाली खुर्द (${booth})</text>
      <line x1="85" y1="930" x2="995" y2="930" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Date Banner -->
      <rect x="85" y="955" width="910" height="85" fill="#f0fdf4" rx="12" stroke="#bbf7d0" stroke-width="1.5"/>
      <text x="110" y="990" font-size="18" font-weight="700" fill="#166534" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">🗓️ मतदान दिनांक व समय:</text>
      <text x="110" y="1022" font-size="22" font-weight="900" fill="#15803d" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">सोमवार, 16 नवम्बर 2026  •  प्रातः 7:30 बजे से सायं 5:30 बजे तक</text>

      <!-- Footer Appeal -->
      <rect x="55" y="1098" width="970" height="80" fill="#ea580c" rx="16"/>
      <text x="540" y="1148" font-size="24" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'Nirmala UI', 'Mangal', sans-serif">
        ★ 16 नवम्बर को क्रम सं. 1 पर बाबा अभय सिंह के आगे मुहर लगाएं! ★
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

    // 2. Circular candidate photo overlaid on top inside the gold frame
    if (fs.existsSync(BABA_PHOTO_PATH)) {
        const photoSize = 144;
        const circleMask = Buffer.from(
            `<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`
        );
        const circularPhoto = await sharp(BABA_PHOTO_PATH)
            .resize(photoSize, photoSize, { fit: 'cover' })
            .composite([{ input: circleMask, blend: 'dest-in' }])
            .png()
            .toBuffer();

        composites.push({
            input: circularPhoto,
            top: 160,
            left: 93
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

module.exports = { generateVoterCard };
