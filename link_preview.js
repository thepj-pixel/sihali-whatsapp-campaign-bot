/**
 * Big WhatsApp link-preview card for our own site links (vendored; does not depend on link-preview-js).
 * Builds Baileys' `linkPreview` object ourselves: og:title / og:description / og:image of the page + the jpeg,
 * a small inline jpegThumbnail and the uploaded high-quality thumbnail (mediaTypeOverride 'thumbnail-link').
 *  - each fetch is capped at 4 s overall; a failure gives `null` (the text still goes, without a card)
 *  - cached per URL for 6 h; warmed in the background when a line connects, so a reply never waits on the network
 *    (a send waits at most `waitMs` for an in-flight build)
 */
const CACHE_MS = 6 * 3600 * 1000;
const FETCH_CAP_MS = 4000;
const OUR_URL_RX = /https:\/\/abhaysinghsihali\.in(?:\/[^\s]*)?/i;
const cache = new Map(); // url -> { at, info|null, building: Promise|null }
const stats = { built: 0, failed: 0, uploads: 0, uploadFailed: 0, lastError: null, lastOkAt: null };

function withTimeout(p, ms, label) {
    let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
}
function metaOf(html, prop) {
    const rx1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    const rx2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    const m = html.match(rx1) || html.match(rx2);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
}
async function fetchBuf(url, signal) {
    const res = await fetch(url, { signal, redirect: 'follow', headers: { 'user-agent': 'WhatsApp/2.23 (link preview)', accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { buf: Buffer.from(await res.arrayBuffer()), finalUrl: res.url || url };
}

/** og tags + image buffer within 4 s total. */
async function fetchOg(url, fetchImpl) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_CAP_MS);
    try {
        const get = fetchImpl || fetchBuf;
        const page = await get(url, ctl.signal);
        const html = page.buf.toString('utf8');
        const title = metaOf(html, 'og:title') || ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
        const description = metaOf(html, 'og:description') || metaOf(html, 'description');
        let image = metaOf(html, 'og:image');
        const canonical = metaOf(html, 'og:url') || url;
        if (image && !/^https?:/i.test(image)) image = new URL(image, url).toString();
        let imageBuf = null;
        if (image) imageBuf = (await get(image, ctl.signal)).buf;
        return { title, description, image, canonical, imageBuf };
    } finally { clearTimeout(timer); }
}

async function build(url, sock, opts = {}) {
    const og = await withTimeout(fetchOg(url, opts.fetchImpl), FETCH_CAP_MS + 200, 'og fetch');
    if (!og.title) throw new Error('no og:title');
    const info = { 'canonical-url': og.canonical, 'matched-text': url, title: og.title, description: og.description || '', originalThumbnailUrl: og.image || undefined };
    if (og.imageBuf) {
        try {
            const sharp = require('sharp');
            info.jpegThumbnail = await sharp(og.imageBuf).resize(320, null, { withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
        } catch (e) { info.jpegThumbnail = undefined; }
        // high-quality (big) card: upload the image as a link thumbnail through this line's media connection
        const upload = opts.upload || (sock && sock.waUploadToServer);
        if (upload) {
            try {
                const { prepareWAMessageMedia } = opts.baileys || require('@whiskeysockets/baileys');
                const big = await require('sharp')(og.imageBuf).resize(1200, null, { withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
                const { imageMessage } = await withTimeout(prepareWAMessageMedia({ image: big }, { upload, mediaTypeOverride: 'thumbnail-link' }), FETCH_CAP_MS, 'thumbnail upload');
                if (imageMessage) { info.highQualityThumbnail = imageMessage; if (imageMessage.jpegThumbnail && !info.jpegThumbnail) info.jpegThumbnail = Buffer.from(imageMessage.jpegThumbnail); stats.uploads++; console.log(`[LinkPreview] ✅ HQ thumbnail uploaded for ${url} (${imageMessage.width || '?'}x${imageMessage.height || '?'})`); }
            } catch (e) { stats.uploadFailed++; console.warn(`[LinkPreview] HQ thumbnail upload failed for ${url}: ${e.message}`); }
        }
    }
    return info;
}

/** Start (or reuse) a build for url. Never throws. */
function warm(url, sock, opts = {}) {
    const c = cache.get(url);
    if (c && c.building) return c.building;
    if (c && c.info && Date.now() - c.at < CACHE_MS && (c.info.highQualityThumbnail || !(sock && sock.waUploadToServer))) return Promise.resolve(c.info);
    const p = build(url, sock, opts).then(info => { cache.set(url, { at: Date.now(), info, building: null }); stats.built++; stats.lastOkAt = new Date().toISOString(); console.log(`[LinkPreview] preview ready for ${url} (title "${String(info.title).slice(0, 40)}", big=${!!info.highQualityThumbnail})`); return info; })
        .catch(e => { stats.failed++; stats.lastError = String(e.message || e).slice(0, 140); console.warn(`[LinkPreview] build failed for ${url}: ${stats.lastError}`);
            const old = cache.get(url); cache.set(url, { at: old && old.info ? old.at : Date.now() - CACHE_MS + 10 * 60e3, info: old && old.info ? old.info : null, building: null }); return old && old.info ? old.info : null; });
    cache.set(url, { at: c ? c.at : 0, info: c ? c.info : null, building: p });
    return p;
}

/** linkPreview for a text that contains one of our URLs: cached info, or wait ≤ waitMs for a build; else null. */
async function forText(text, sock, opts = {}) {
    const m = String(text || '').match(OUR_URL_RX);
    if (!m) return undefined;
    const url = m[0].replace(/[).,!?]+$/, '');
    const c = cache.get(url);
    const fresh = c && c.info && Date.now() - c.at < CACHE_MS;
    if (fresh && !c.building) return c.info;
    const p = warm(url, sock, opts);
    if (fresh) return c.info;
    try { return await withTimeout(p, opts.waitMs != null ? opts.waitMs : 1500, 'preview wait'); } catch (e) { return null; }
}

module.exports = { forText, warm, build, fetchOg, metaOf, stats, cache, OUR_URL_RX, CACHE_MS, FETCH_CAP_MS };
