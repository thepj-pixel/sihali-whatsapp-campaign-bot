const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

class PosterEngine {
    constructor() {
        this.basePosterPath = path.join(__dirname, 'media', 'poster.jpg');
    }

    async generatePoster({ name = 'ग्रामवासी', aspect = '1:1', customSlogan = null }) {
        let width = 1080;
        let height = 1080;

        if (aspect === '9:16') {
            width = 1080;
            height = 1920;
        } else if (aspect === '3:4') {
            width = 1080;
            height = 1440;
        }

        const cleanName = (name || 'ग्रामवासी').trim().slice(0, 30);
        const slogan = customSlogan || 'सच्चा विकास, ईमानदार नेतृत्व 🚩';

        // Load and resize Baba's photo if present
        let babaImageBuffer = null;
        const photoWidth = aspect === '9:16' ? 520 : (aspect === '3:4' ? 480 : 420);
        const photoHeight = photoWidth;

        if (fs.existsSync(this.basePosterPath)) {
            try {
                babaImageBuffer = await sharp(this.basePosterPath)
                    .resize(photoWidth, photoHeight, { fit: 'cover' })
                    .toBuffer();
            } catch (e) {
                console.error('Error resizing baba photo for poster:', e.message);
            }
        }

        // Calculate layout coordinates
        const photoX = Math.round((width - photoWidth) / 2);
        const photoY = aspect === '9:16' ? 480 : (aspect === '3:4' ? 360 : 250);

        // Build SVG overlay
        const headerY = aspect === '9:16' ? 240 : (aspect === '3:4' ? 180 : 130);
        const subHeaderY = headerY + 70;
        const nameBadgeY = photoY + photoHeight + 110;
        const candidateY = nameBadgeY + 95;
        const sloganY = candidateY + 80;
        const footerY = height - 90;

        const svgMarkup = `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#0f172a"/>
                    <stop offset="45%" stop-color="#1e293b"/>
                    <stop offset="100%" stop-color="#090d16"/>
                </linearGradient>
                <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#f59e0b"/>
                    <stop offset="50%" stop-color="#fbbf24"/>
                    <stop offset="100%" stop-color="#d97706"/>
                </linearGradient>
                <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.6"/>
                </filter>
            </defs>

            <!-- Background -->
            <rect width="100%" height="100%" fill="url(#bg)"/>

            <!-- Decorative Borders & Badges -->
            <rect x="25" y="25" width="${width - 50}" height="${height - 50}" fill="none" stroke="#f59e0b" stroke-width="4" rx="20" opacity="0.8"/>
            <rect x="35" y="35" width="${width - 70}" height="${height - 70}" fill="none" stroke="#334155" stroke-width="2" rx="16"/>

            <!-- Top Header -->
            <text x="${width / 2}" y="${headerY}" font-size="46" font-weight="900" fill="#f8fafc" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif" letter-spacing="2">
                🏛️ ग्राम पंचायत सिहाली खुर्द
            </text>
            <text x="${width / 2}" y="${subHeaderY}" font-size="30" font-weight="700" fill="#f59e0b" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                सरपंच पद हेतु चुनाव 2026
            </text>

            <!-- Photo Frame Ring (if photo placed) -->
            <circle cx="${width / 2}" cy="${photoY + photoHeight / 2}" r="${photoWidth / 2 + 10}" fill="none" stroke="url(#gold)" stroke-width="8" filter="url(#shadow)"/>

            <!-- Supporter Name Box -->
            <rect x="${width / 2 - 380}" y="${nameBadgeY - 60}" width="760" height="85" fill="#ea580c" rx="42" filter="url(#shadow)"/>
            <text x="${width / 2}" y="${nameBadgeY - 5}" font-size="40" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                ★ कर्मठ समर्थक: ${cleanName} ★
            </text>

            <!-- Candidate Identity -->
            <text x="${width / 2}" y="${candidateY}" font-size="52" font-weight="900" fill="#f8fafc" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                बाबा अभय सिंह
            </text>
            <text x="${width / 2}" y="${candidateY + 50}" font-size="30" font-weight="600" fill="#fb923c" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                (मोटी आंगली वाले बाबा)
            </text>

            <!-- Campaign Slogan -->
            <text x="${width / 2}" y="${sloganY + 30}" font-size="34" font-weight="700" fill="url(#gold)" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                "${slogan}"
            </text>

            <!-- Polling Reminder Footer -->
            <rect x="70" y="${footerY - 45}" width="${width - 140}" height="70" fill="#1e293b" rx="12" stroke="#334155" stroke-width="2"/>
            <text x="${width / 2}" y="${footerY}" font-size="26" font-weight="700" fill="#94a3b8" text-anchor="middle" font-family="'Segoe UI', Roboto, sans-serif">
                🗓️ मतदान: सोमवार, 16 नवम्बर 2026 • बूथ नं. 95 व 96
            </text>
        </svg>
        `;

        // Compose SVG and Baba's photo together
        const composites = [];

        if (babaImageBuffer) {
            // Cut photo into circle
            const circleMask = Buffer.from(
                `<svg width="${photoWidth}" height="${photoHeight}"><circle cx="${photoWidth/2}" cy="${photoHeight/2}" r="${photoWidth/2}" fill="#fff"/></svg>`
            );
            const circularPhoto = await sharp(babaImageBuffer)
                .composite([{ input: circleMask, blend: 'dest-in' }])
                .png()
                .toBuffer();

            composites.push({
                input: circularPhoto,
                top: photoY,
                left: photoX
            });
        }

        composites.push({
            input: Buffer.from(svgMarkup),
            top: 0,
            left: 0
        });

        const finalPoster = await sharp({
            create: {
                width: width,
                height: height,
                channels: 4,
                background: { r: 15, g: 23, b: 42, alpha: 1 }
            }
        })
        .composite(composites)
        .jpeg({ quality: 90 })
        .toBuffer();

        return finalPoster;
    }
}

module.exports = new PosterEngine();
