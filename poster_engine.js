const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

class PosterEngine {
    constructor() {
        this.babaFacePath = path.join(__dirname, 'media', 'baba_face.jpg');
        this.basePosterPath = path.join(__dirname, 'media', 'poster.jpg');
    }

    async generatePoster({
        name = 'ग्रामवासी',
        role = 'कर्मठ समर्थक',
        design = 'royal',
        aspect = '9:16',
        customSlogan = null,
        voterImageBase64 = null
    }) {
        let width = 1080;
        let height = 1920; // default 9:16

        if (aspect === '1:1') {
            height = 1080;
        } else if (aspect === '4:5') {
            height = 1350;
        } else {
            height = 1920;
        }

        const cleanName = (name || 'ग्रामवासी').trim().slice(0, 30);
        const cleanRole = (role || 'कर्मठ समर्थक').trim().slice(0, 30);
        const slogan = customSlogan || 'सच्चा विकास, ईमानदार नेतृत्व • सिहाली खुर्द का स्वाभिमान 🚩';

        // 1. Prepare Baba Photo
        const babaSrc = fs.existsSync(this.babaFacePath) ? this.babaFacePath : (fs.existsSync(this.basePosterPath) ? this.basePosterPath : null);
        
        // 2. Prepare Voter Photo if provided
        let voterBuffer = null;
        if (voterImageBase64) {
            try {
                const cleanedB64 = voterImageBase64.replace(/^data:image\/\w+;base64,/, '');
                voterBuffer = Buffer.from(cleanedB64, 'base64');
            } catch (e) {
                console.warn('[PosterEngine] Invalid voter photo base64:', e.message);
            }
        }

        if (design === 'youth') {
            return await this.renderYouthDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer });
        } else if (design === 'parivar') {
            return await this.renderParivarDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer });
        } else {
            // Default: royal
            return await this.renderRoyalDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer });
        }
    }

    async renderRoyalDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer }) {
        const hasVoterPhoto = !!voterBuffer;
        const photoSize = aspect === '1:1' ? 260 : (aspect === '4:5' ? 320 : 380);

        // SVG markup
        const svgMarkup = `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="royalBg" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#0b1329"/>
                    <stop offset="35%" stop-color="#1e293b"/>
                    <stop offset="70%" stop-color="#0f172a"/>
                    <stop offset="100%" stop-color="#050811"/>
                </linearGradient>
                <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#f59e0b"/>
                    <stop offset="50%" stop-color="#fbbf24"/>
                    <stop offset="100%" stop-color="#d97706"/>
                </linearGradient>
                <linearGradient id="saffron" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#ea580c"/>
                    <stop offset="50%" stop-color="#f97316"/>
                    <stop offset="100%" stop-color="#c2410c"/>
                </linearGradient>
                <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity="0.7"/>
                </filter>
            </defs>

            <!-- Background -->
            <rect width="100%" height="100%" fill="url(#royalBg)"/>

            <!-- Ornate Outer Gold Frame -->
            <rect x="25" y="25" width="${width - 50}" height="${height - 50}" fill="none" stroke="url(#gold)" stroke-width="4" rx="20"/>
            <rect x="35" y="35" width="${width - 70}" height="${height - 70}" fill="none" stroke="#ea580c" stroke-width="1.5" rx="16" opacity="0.6"/>

            <!-- Top Header Ribbon -->
            <rect x="80" y="${aspect === '1:1' ? 45 : 70}" width="${width - 160}" height="${aspect === '1:1' ? 65 : 85}" fill="url(#saffron)" rx="16" filter="url(#shadow)"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 88 : 124}" font-size="${aspect === '1:1' ? 26 : 32}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', sans-serif">
                🏛️ ग्राम पंचायत सिहाली खुर्द • पंचायत आम चुनाव 2026
            </text>

            <text x="${width / 2}" y="${aspect === '1:1' ? 145 : 205}" font-size="${aspect === '1:1' ? 20 : 26}" font-weight="800" fill="#fde68a" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', sans-serif" letter-spacing="1">
                ★ अधिकृत चुनावी संकल्प व जन समर्थन ★
            </text>

            <!-- Candidate Title Box -->
            <rect x="100" y="${aspect === '1:1' ? 170 : 250}" width="${width - 200}" height="${aspect === '1:1' ? 70 : 90}" fill="#0f172a" rx="14" stroke="url(#gold)" stroke-width="2"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 215 : 308}" font-size="${aspect === '1:1' ? 32 : 44}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', sans-serif">
                बाबा अभय सिंह
            </text>

            <!-- Subtitle & Symbol -->
            <text x="${width / 2}" y="${aspect === '1:1' ? 268 : 375}" font-size="${aspect === '1:1' ? 19 : 24}" font-weight="700" fill="#fbbf24" text-anchor="middle" font-family="'Noto Sans Devanagari', 'Lohit Devanagari', sans-serif">
                सरपंच पद प्रत्याशी  |  मतपत्र क्रम संख्या: 1  |  चुनाव चिन्ह: 卐 (स्वस्तिक)
            </text>

            ${hasVoterPhoto ? `
            <!-- Dual Portrait Frames -->
            <!-- Left: Baba Photo Frame -->
            <circle cx="${width / 4}" cy="${aspect === '1:1' ? 440 : (aspect === '4:5' ? 590 : 700)}" r="${photoSize / 2 + 8}" fill="none" stroke="url(#gold)" stroke-width="8" filter="url(#shadow)"/>
            <text x="${width / 4}" y="${aspect === '1:1' ? 600 : (aspect === '4:5' ? 790 : 930)}" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#fde68a" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                बाबा अभय सिंह
            </text>

            <!-- Center VS / Handshake Icon -->
            <circle cx="${width / 2}" cy="${aspect === '1:1' ? 440 : (aspect === '4:5' ? 590 : 700)}" r="${aspect === '1:1' ? 35 : 45}" fill="url(#saffron)" filter="url(#shadow)"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 452 : 715}" font-size="${aspect === '1:1' ? 28 : 36}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="sans-serif">🤝</text>

            <!-- Right: Voter Photo Frame -->
            <circle cx="${(width / 4) * 3}" cy="${aspect === '1:1' ? 440 : (aspect === '4:5' ? 590 : 700)}" r="${photoSize / 2 + 8}" fill="none" stroke="url(#gold)" stroke-width="8" filter="url(#shadow)"/>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 600 : (aspect === '4:5' ? 790 : 930)}" font-size="${aspect === '1:1' ? 20 : 26}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ${cleanName}
            </text>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 625 : (aspect === '4:5' ? 820 : 965)}" font-size="${aspect === '1:1' ? 15 : 20}" font-weight="700" fill="#38bdf8" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ${cleanRole}
            </text>
            ` : `
            <!-- Single Hero Baba Photo Frame -->
            <circle cx="${width / 2}" cy="${aspect === '1:1' ? 440 : (aspect === '4:5' ? 600 : 730)}" r="${photoSize / 2 + 10}" fill="none" stroke="url(#gold)" stroke-width="8" filter="url(#shadow)"/>
            
            <!-- Supporter Ribbon Banner -->
            <rect x="140" y="${aspect === '1:1' ? 610 : (aspect === '4:5' ? 830 : 980)}" width="${width - 280}" height="${aspect === '1:1' ? 70 : 85}" fill="url(#saffron)" rx="16" filter="url(#shadow)"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 655 : (aspect === '4:5' ? 885 : 1035)}" font-size="${aspect === '1:1' ? 26 : 34}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                समर्थक: ${cleanName} (${cleanRole})
            </text>
            `}

            <!-- Slogan Card -->
            <rect x="70" y="${aspect === '1:1' ? (hasVoterPhoto ? 670 : 710) : (aspect === '4:5' ? 950 : 1150)}" width="${width - 140}" height="${aspect === '1:1' ? 140 : 200}" fill="#1e293b" rx="20" stroke="#334155" stroke-width="2"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? (hasVoterPhoto ? 730 : 770) : (aspect === '4:5' ? 1025 : 1235)}" font-size="${aspect === '1:1' ? 24 : 32}" font-weight="800" fill="#fde68a" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                "${slogan}"
            </text>
            <text x="${width / 2}" y="${aspect === '1:1' ? (hasVoterPhoto ? 775 : 815) : (aspect === '4:5' ? 1085 : 1305)}" font-size="${aspect === '1:1' ? 17 : 22}" font-weight="700" fill="#94a3b8" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                40 वर्षों से निष्पक्ष सेवा, चौपाल न्याय व सबका समान विकास
            </text>

            ${aspect === '9:16' ? `
            <!-- Key Guarantees Badges (9:16 Only) -->
            <g transform="translate(70, 1420)">
                <rect x="0" y="0" width="${width - 140}" height="180" fill="#0f172a" rx="16" stroke="url(#gold)" stroke-width="1.5"/>
                <text x="40" y="55" font-size="24" font-weight="800" fill="#ffffff" font-family="'Noto Sans Devanagari', sans-serif">✅ हर घर शुद्ध पेयजल (जल जीवन मिशन का सच्चा समाधान)</text>
                <text x="40" y="105" font-size="24" font-weight="800" fill="#ffffff" font-family="'Noto Sans Devanagari', sans-serif">✅ मुख्य मार्ग व खेतों तक पक्की डामर व सीसी सड़कें</text>
                <text x="40" y="155" font-size="24" font-weight="800" fill="#ffffff" font-family="'Noto Sans Devanagari', sans-serif">✅ युवाओं के लिए लाइब्रेरी, खेल मैदान व बुजुर्ग पेंशन सेवा</text>
            </g>
            ` : ''}

            <!-- Bottom Urgent Appeal Banner -->
            <rect x="40" y="${height - (aspect === '1:1' ? 130 : 170)}" width="${width - 80}" height="${aspect === '1:1' ? 95 : 125}" fill="url(#saffron)" rx="16" filter="url(#shadow)"/>
            <text x="${width / 2}" y="${height - (aspect === '1:1' ? 75 : 100)}" font-size="${aspect === '1:1' ? 26 : 36}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ★ 16 नवम्बर को क्रम सं. 1 पर बाबा अभय सिंह के आगे मुहर लगाएं! ★
            </text>
            <text x="${width / 2}" y="${height - (aspect === '1:1' ? 45 : 62)}" font-size="${aspect === '1:1' ? 16 : 22}" font-weight="800" fill="#fef08a" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                मतदान समय: सोमवार प्रातः 7:30 बजे से सायं 5:30 बजे तक
            </text>
        </svg>
        `;

        const composites = [{ input: Buffer.from(svgMarkup), top: 0, left: 0 }];

        // Overlay Photos
        if (hasVoterPhoto) {
            // Dual photos: Baba on Left, Voter on Right
            const babaCenterY = aspect === '1:1' ? 440 : (aspect === '4:5' ? 590 : 700);
            const babaCenterX = Math.round(width / 4);
            const voterCenterX = Math.round((width / 4) * 3);

            if (babaSrc && fs.existsSync(babaSrc)) {
                const circleMask = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`);
                const photoBuf = await sharp(babaSrc)
                    .resize(photoSize, photoSize, { fit: 'cover' })
                    .composite([{ input: circleMask, blend: 'dest-in' }])
                    .png()
                    .toBuffer();
                composites.push({
                    input: photoBuf,
                    top: Math.round(babaCenterY - photoSize / 2),
                    left: Math.round(babaCenterX - photoSize / 2)
                });
            }

            // Voter Photo
            const circleMaskVoter = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`);
            const voterPhotoBuf = await sharp(voterBuffer)
                .resize(photoSize, photoSize, { fit: 'cover' })
                .composite([{ input: circleMaskVoter, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({
                input: voterPhotoBuf,
                top: Math.round(babaCenterY - photoSize / 2),
                left: Math.round(voterCenterX - photoSize / 2)
            });

        } else if (babaSrc && fs.existsSync(babaSrc)) {
            // Single Baba photo in center
            const babaCenterY = aspect === '1:1' ? 440 : (aspect === '4:5' ? 600 : 730);
            const babaCenterX = Math.round(width / 2);

            const circleMask = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`);
            const photoBuf = await sharp(babaSrc)
                .resize(photoSize, photoSize, { fit: 'cover' })
                .composite([{ input: circleMask, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({
                input: photoBuf,
                top: Math.round(babaCenterY - photoSize / 2),
                left: Math.round(babaCenterX - photoSize / 2)
            });
        }

        return await sharp({
            create: { width, height, channels: 4, background: { r: 11, g: 19, b: 41, alpha: 1 } }
        })
        .composite(composites)
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    async renderYouthDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer }) {
        const hasVoterPhoto = !!voterBuffer;
        const photoWidth = aspect === '1:1' ? 240 : (aspect === '4:5' ? 300 : 360);
        const photoHeight = photoWidth;

        const svgMarkup = `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="youthBg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#020617"/>
                    <stop offset="40%" stop-color="#0f172a"/>
                    <stop offset="80%" stop-color="#1e1b4b"/>
                    <stop offset="100%" stop-color="#020617"/>
                </linearGradient>
                <linearGradient id="neonOrange" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#f97316"/>
                    <stop offset="100%" stop-color="#fb923c"/>
                </linearGradient>
                <linearGradient id="neonCyan" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#06b6d4"/>
                    <stop offset="100%" stop-color="#38bdf8"/>
                </linearGradient>
                <filter id="glow">
                    <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#f97316" flood-opacity="0.4"/>
                </filter>
            </defs>

            <rect width="100%" height="100%" fill="url(#youthBg)"/>

            <!-- Top Header -->
            <rect x="40" y="${aspect === '1:1' ? 35 : 60}" width="${width - 80}" height="${aspect === '1:1' ? 65 : 85}" fill="#0f172a" rx="14" stroke="#334155" stroke-width="2"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 78 : 115}" font-size="${aspect === '1:1' ? 26 : 34}" font-weight="900" fill="#f8fafc" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ⚡ सिहाली खुर्द की नई सोच • युवा संकल्प 2026
            </text>

            <text x="${width / 2}" y="${aspect === '1:1' ? 145 : 205}" font-size="${aspect === '1:1' ? 32 : 44}" font-weight="900" fill="url(#neonOrange)" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                बाबा अभय सिंह
            </text>
            <text x="${width / 2}" y="${aspect === '1:1' ? 185 : 255}" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="700" fill="#94a3b8" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                सरपंच पद हेतु कर्मठ व निष्पक्ष प्रत्याशी • मतपत्र क्रम: 1 (卐 स्वस्तिक)
            </text>

            ${hasVoterPhoto ? `
            <!-- Dual Rounded Cards for Youth Theme -->
            <!-- Left Baba Card -->
            <rect x="${width / 4 - photoWidth / 2 - 8}" y="${(aspect === '1:1' ? 300 : (aspect === '4:5' ? 420 : 500)) - 8}" width="${photoWidth + 16}" height="${photoHeight + 16}" fill="none" stroke="#f59e0b" stroke-width="4" rx="28"/>
            <text x="${width / 4}" y="${aspect === '1:1' ? 470 : (aspect === '4:5' ? 640 : 780)}" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#fbbf24" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">मार्गदर्शक प्रत्याशी</text>

            <!-- Right Voter Card -->
            <rect x="${(width / 4) * 3 - photoWidth / 2 - 8}" y="${(aspect === '1:1' ? 300 : (aspect === '4:5' ? 420 : 500)) - 8}" width="${photoWidth + 16}" height="${photoHeight + 16}" fill="none" stroke="#38bdf8" stroke-width="4" rx="28"/>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 470 : (aspect === '4:5' ? 640 : 780)}" font-size="${aspect === '1:1' ? 22 : 28}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">${cleanName}</text>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 495 : (aspect === '4:5' ? 670 : 815)}" font-size="${aspect === '1:1' ? 15 : 20}" font-weight="700" fill="#38bdf8" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">${cleanRole}</text>
            ` : `
            <!-- Single Baba Card -->
            <rect x="${width / 2 - photoWidth / 2 - 8}" y="${(aspect === '1:1' ? 290 : (aspect === '4:5' ? 410 : 490)) - 8}" width="${photoWidth + 16}" height="${photoHeight + 16}" fill="none" stroke="#f59e0b" stroke-width="5" rx="30"/>
            <rect x="120" y="${aspect === '1:1' ? 480 : (aspect === '4:5' ? 660 : 800)}" width="${width - 240}" height="${aspect === '1:1' ? 65 : 80}" fill="url(#neonOrange)" rx="16"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 522 : (aspect === '4:5' ? 712 : 852)}" font-size="${aspect === '1:1' ? 24 : 32}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                युवा साथी: ${cleanName} (${cleanRole})
            </text>
            `}

            <!-- Youth Guarantee Pills Grid -->
            <g transform="translate(60, ${aspect === '1:1' ? 560 : (aspect === '4:5' ? 770 : 960)})">
                <rect x="0" y="0" width="${(width - 150) / 2}" height="80" fill="#1e293b" rx="14" stroke="#334155" stroke-width="1.5"/>
                <text x="${(width - 150) / 4}" y="50" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#38bdf8" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">📖 फ्री वाई-फाई लाइब्रेरी</text>

                <rect x="${(width - 150) / 2 + 30}" y="0" width="${(width - 150) / 2}" height="80" fill="#1e293b" rx="14" stroke="#334155" stroke-width="1.5"/>
                <text x="${(width - 150) / 2 + 30 + (width - 150) / 4}" y="50" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#f59e0b" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">🏏 खेल मैदान व जिम</text>

                <rect x="0" y="100" width="${(width - 150) / 2}" height="80" fill="#1e293b" rx="14" stroke="#334155" stroke-width="1.5"/>
                <text x="${(width - 150) / 4}" y="150" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#10b981" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">🛣️ पक्की सीसी सड़कें</text>

                <rect x="${(width - 150) / 2 + 30}" y="100" width="${(width - 150) / 2}" height="80" fill="#1e293b" rx="14" stroke="#334155" stroke-width="1.5"/>
                <text x="${(width - 150) / 2 + 30 + (width - 150) / 4}" y="150" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#e2e8f0" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">🚰 24 घंटे मीठा पानी</text>
            </g>

            <!-- Slogan Quote -->
            <rect x="60" y="${aspect === '1:1' ? 770 : (aspect === '4:5' ? 1040 : 1260)}" width="${width - 120}" height="${aspect === '1:1' ? 100 : 150}" fill="#0f172a" rx="18" stroke="#f97316" stroke-width="2"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 830 : (aspect === '4:5' ? 1125 : 1350)}" font-size="${aspect === '1:1' ? 22 : 30}" font-weight="900" fill="#fde68a" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                "${slogan}"
            </text>

            <!-- Footer Action -->
            <rect x="40" y="${height - (aspect === '1:1' ? 130 : 170)}" width="${width - 80}" height="${aspect === '1:1' ? 95 : 125}" fill="url(#neonOrange)" rx="16" filter="url(#glow)"/>
            <text x="${width / 2}" y="${height - (aspect === '1:1' ? 75 : 100)}" font-size="${aspect === '1:1' ? 26 : 36}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ★ 16 नवम्बर को क्रम सं. 1 पर बाबा अभय सिंह को विजयी बनाएं! ★
            </text>
        </svg>
        `;

        const composites = [{ input: Buffer.from(svgMarkup), top: 0, left: 0 }];

        // Overlays
        const roundedMask = Buffer.from(`<svg width="${photoWidth}" height="${photoHeight}"><rect width="${photoWidth}" height="${photoHeight}" rx="24" fill="#fff"/></svg>`);

        if (hasVoterPhoto) {
            const topY = aspect === '1:1' ? 300 : (aspect === '4:5' ? 420 : 500);
            const babaX = Math.round(width / 4 - photoWidth / 2);
            const voterX = Math.round((width / 4) * 3 - photoWidth / 2);

            if (babaSrc && fs.existsSync(babaSrc)) {
                const photoBuf = await sharp(babaSrc)
                    .resize(photoWidth, photoHeight, { fit: 'cover' })
                    .composite([{ input: roundedMask, blend: 'dest-in' }])
                    .png()
                    .toBuffer();
                composites.push({ input: photoBuf, top: topY, left: babaX });
            }

            const voterPhotoBuf = await sharp(voterBuffer)
                .resize(photoWidth, photoHeight, { fit: 'cover' })
                .composite([{ input: roundedMask, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({ input: voterPhotoBuf, top: topY, left: voterX });
        } else if (babaSrc && fs.existsSync(babaSrc)) {
            const topY = aspect === '1:1' ? 290 : (aspect === '4:5' ? 410 : 490);
            const babaX = Math.round(width / 2 - photoWidth / 2);

            const photoBuf = await sharp(babaSrc)
                .resize(photoWidth, photoHeight, { fit: 'cover' })
                .composite([{ input: roundedMask, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({ input: photoBuf, top: topY, left: babaX });
        }

        return await sharp({
            create: { width, height, channels: 4, background: { r: 2, g: 6, b: 23, alpha: 1 } }
        })
        .composite(composites)
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    async renderParivarDesign({ width, height, aspect, cleanName, cleanRole, slogan, babaSrc, voterBuffer }) {
        const hasVoterPhoto = !!voterBuffer;
        const photoSize = aspect === '1:1' ? 250 : (aspect === '4:5' ? 320 : 380);

        const svgMarkup = `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="ivoryBg" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#fffbeb"/>
                    <stop offset="60%" stop-color="#fef3c7"/>
                    <stop offset="100%" stop-color="#fde68a"/>
                </linearGradient>
                <linearGradient id="maroon" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#78350f"/>
                    <stop offset="100%" stop-color="#9a3412"/>
                </linearGradient>
                <linearGradient id="goldBorder" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#b45309"/>
                    <stop offset="50%" stop-color="#d97706"/>
                    <stop offset="100%" stop-color="#92400e"/>
                </linearGradient>
            </defs>

            <!-- Warm Ivory Background -->
            <rect width="100%" height="100%" fill="url(#ivoryBg)"/>

            <!-- Ornate Traditional Double Border -->
            <rect x="25" y="25" width="${width - 50}" height="${height - 50}" fill="none" stroke="url(#goldBorder)" stroke-width="4" rx="20"/>
            <rect x="36" y="36" width="${width - 72}" height="${height - 72}" fill="none" stroke="#78350f" stroke-width="2" rx="14"/>

            <!-- Auspicious Top Header -->
            <text x="${width / 2}" y="${aspect === '1:1' ? 75 : 105}" font-size="${aspect === '1:1' ? 24 : 32}" font-weight="900" fill="#78350f" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ॥ श्री गणेशाय नमः ॥ • राम राम सिहाली खुर्द
            </text>

            <rect x="80" y="${aspect === '1:1' ? 95 : 135}" width="${width - 160}" height="${aspect === '1:1' ? 55 : 75}" fill="url(#maroon)" rx="12"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 132 : 185}" font-size="${aspect === '1:1' ? 22 : 30}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ★ परिवार सम्मान व गाँव का स्वाभिमान ★
            </text>

            <text x="${width / 2}" y="${aspect === '1:1' ? 195 : 270}" font-size="${aspect === '1:1' ? 34 : 46}" font-weight="900" fill="#78350f" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                बाबा अभय सिंह
            </text>
            <text x="${width / 2}" y="${aspect === '1:1' ? 230 : 320}" font-size="${aspect === '1:1' ? 19 : 24}" font-weight="700" fill="#92400e" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                सरपंच पद हेतु अनुभवी व विश्वसनीय नेतृत्व • मतपत्र क्रम: 1 (卐 स्वस्तिक)
            </text>

            ${hasVoterPhoto ? `
            <!-- Left Baba Circle -->
            <circle cx="${width / 4}" cy="${aspect === '1:1' ? 390 : (aspect === '4:5' ? 530 : 640)}" r="${photoSize / 2 + 6}" fill="none" stroke="url(#goldBorder)" stroke-width="6"/>
            <text x="${width / 4}" y="${aspect === '1:1' ? 540 : (aspect === '4:5' ? 720 : 860)}" font-size="${aspect === '1:1' ? 18 : 24}" font-weight="800" fill="#78350f" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">आदरणीय बाबा जी</text>

            <!-- Right Voter Card Frame -->
            <rect x="${(width / 4) * 3 - photoSize / 2 - 6}" y="${(aspect === '1:1' ? 390 : (aspect === '4:5' ? 530 : 640)) - photoSize / 2 - 6}" width="${photoSize + 12}" height="${photoSize + 12}" fill="none" stroke="url(#goldBorder)" stroke-width="6" rx="24"/>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 540 : (aspect === '4:5' ? 720 : 860)}" font-size="${aspect === '1:1' ? 22 : 28}" font-weight="900" fill="#78350f" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">${cleanName}</text>
            <text x="${(width / 4) * 3}" y="${aspect === '1:1' ? 565 : (aspect === '4:5' ? 750 : 895)}" font-size="${aspect === '1:1' ? 15 : 20}" font-weight="700" fill="#92400e" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">एवं समस्त परिवार का आशीर्वाद</text>
            ` : `
            <!-- Single Baba Portrait -->
            <circle cx="${width / 2}" cy="${aspect === '1:1' ? 390 : (aspect === '4:5' ? 530 : 650)}" r="${photoSize / 2 + 8}" fill="none" stroke="url(#goldBorder)" stroke-width="8"/>
            <rect x="120" y="${aspect === '1:1' ? 540 : (aspect === '4:5' ? 730 : 870)}" width="${width - 240}" height="${aspect === '1:1' ? 65 : 80}" fill="url(#maroon)" rx="16"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 582 : (aspect === '4:5' ? 782 : 922)}" font-size="${aspect === '1:1' ? 24 : 32}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ${cleanName} जी एवं समस्त परिवार का समर्थन
            </text>
            `}

            <!-- Traditional Message Box -->
            <rect x="70" y="${aspect === '1:1' ? 630 : (aspect === '4:5' ? 860 : 1060)}" width="${width - 140}" height="${aspect === '1:1' ? 130 : 180}" fill="#ffffff" rx="16" stroke="#b45309" stroke-width="2"/>
            <text x="${width / 2}" y="${aspect === '1:1' ? 685 : (aspect === '4:5' ? 930 : 1145)}" font-size="${aspect === '1:1' ? 24 : 32}" font-weight="900" fill="#78350f" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                "${slogan}"
            </text>
            <text x="${width / 2}" y="${aspect === '1:1' ? 730 : (aspect === '4:5' ? 985 : 1205)}" font-size="${aspect === '1:1' ? 17 : 22}" font-weight="700" fill="#92400e" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                हर सुख-दुख में गाँव के साथ • 40 वर्षों का निष्पक्ष सेवा भाव
            </text>

            <!-- Bottom Appeal -->
            <rect x="40" y="${height - (aspect === '1:1' ? 130 : 170)}" width="${width - 80}" height="${aspect === '1:1' ? 95 : 125}" fill="url(#maroon)" rx="16"/>
            <text x="${width / 2}" y="${height - (aspect === '1:1' ? 75 : 100)}" font-size="${aspect === '1:1' ? 26 : 36}" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                ★ 16 नवम्बर 2026: क्रम सं. 1 पर बाबा अभय सिंह को अपना आशीर्वाद दें! ★
            </text>
            <text x="${width / 2}" y="${height - (aspect === '1:1' ? 45 : 62)}" font-size="${aspect === '1:1' ? 16 : 22}" font-weight="700" fill="#fef3c7" text-anchor="middle" font-family="'Noto Sans Devanagari', sans-serif">
                मतदान केंद्र: रा.उ.मा.वि. सिहाली खुर्द (बूथ 95, 96, 97, 98)
            </text>
        </svg>
        `;

        const composites = [{ input: Buffer.from(svgMarkup), top: 0, left: 0 }];

        if (hasVoterPhoto) {
            const topY = Math.round((aspect === '1:1' ? 390 : (aspect === '4:5' ? 530 : 640)) - photoSize / 2);
            const babaX = Math.round(width / 4 - photoSize / 2);
            const voterX = Math.round((width / 4) * 3 - photoSize / 2);

            if (babaSrc && fs.existsSync(babaSrc)) {
                const circleMask = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`);
                const photoBuf = await sharp(babaSrc)
                    .resize(photoSize, photoSize, { fit: 'cover' })
                    .composite([{ input: circleMask, blend: 'dest-in' }])
                    .png()
                    .toBuffer();
                composites.push({ input: photoBuf, top: topY, left: babaX });
            }

            const roundedMask = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><rect width="${photoSize}" height="${photoSize}" rx="20" fill="#fff"/></svg>`);
            const voterPhotoBuf = await sharp(voterBuffer)
                .resize(photoSize, photoSize, { fit: 'cover' })
                .composite([{ input: roundedMask, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({ input: voterPhotoBuf, top: topY, left: voterX });
        } else if (babaSrc && fs.existsSync(babaSrc)) {
            const topY = Math.round((aspect === '1:1' ? 390 : (aspect === '4:5' ? 530 : 650)) - photoSize / 2);
            const babaX = Math.round(width / 2 - photoSize / 2);

            const circleMask = Buffer.from(`<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize/2}" cy="${photoSize/2}" r="${photoSize/2}" fill="#fff"/></svg>`);
            const photoBuf = await sharp(babaSrc)
                .resize(photoSize, photoSize, { fit: 'cover' })
                .composite([{ input: circleMask, blend: 'dest-in' }])
                .png()
                .toBuffer();
            composites.push({ input: photoBuf, top: topY, left: babaX });
        }

        return await sharp({
            create: { width, height, channels: 4, background: { r: 255, g: 251, b: 235, alpha: 1 } }
        })
        .composite(composites)
        .jpeg({ quality: 92 })
        .toBuffer();
    }
}

module.exports = new PosterEngine();
