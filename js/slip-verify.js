// Created by Aye Chan Aung Thwin
// Slip Verification (Method 2): decode the mini QR code on a Thai payment slip
// and verify the transaction against the bank network via SlipVerify.
// The API only receives the slip's QR payload / slip image — nothing is stored by this site.

const SLIP_VERIFY_API_BASE = 'https://api.nearbyshop.xyz';
// Get a free community token from the SlipVerify Discord (https://discord.gg/VMr2pqukDX).
// Paste it into the token field on the page, or set it here:
const SLIP_VERIFY_TOKEN_DEFAULT = '';
const SLIP_VERIFY_TOKEN_KEY = 'slipVerifyToken';

const slip = {};
let slipFile = null;
let slipPayload = null;

document.addEventListener('DOMContentLoaded', initSlipVerify);

function initSlipVerify() {
    slip.file = document.getElementById('slipFile');
    slip.dropZone = document.getElementById('slipDropZone');
    slip.dropZoneText = document.getElementById('slipDropZoneText');
    slip.amount = document.getElementById('slipAmount');
    slip.token = document.getElementById('slipToken');
    slip.button = document.getElementById('verifySlipBtn');
    slip.result = document.getElementById('slipResult');
    slip.status = document.getElementById('slipStatus');
    slip.info = document.getElementById('slipInfo');
    slip.preview = document.getElementById('slipPreview');
    slip.previewWrap = document.getElementById('slipPreviewWrap');

    slip.token.value = localStorage.getItem(SLIP_VERIFY_TOKEN_KEY) || SLIP_VERIFY_TOKEN_DEFAULT;

    slip.dropZone.addEventListener('click', () => slip.file.click());
    slip.dropZone.addEventListener('dragover', event => {
        event.preventDefault();
        slip.dropZone.classList.add('drop-active');
    });
    slip.dropZone.addEventListener('dragleave', () => slip.dropZone.classList.remove('drop-active'));
    slip.dropZone.addEventListener('drop', event => {
        event.preventDefault();
        slip.dropZone.classList.remove('drop-active');
        const file = event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) setSlipFile(file);
    });
    slip.file.addEventListener('change', () => {
        if (slip.file.files[0]) setSlipFile(slip.file.files[0]);
    });
    slip.token.addEventListener('input', () => {
        localStorage.setItem(SLIP_VERIFY_TOKEN_KEY, slip.token.value.trim());
    });

    // A slip dropped anywhere outside the drop zone must not trigger the
    // browser's default "open the dropped file" — it replaces the whole page.
    ['dragover', 'drop'].forEach(eventType => {
        window.addEventListener(eventType, event => {
            if (!slip.dropZone.contains(event.target)) event.preventDefault();
        });
    });
}

function setSlipFile(file) {
    slipFile = file;
    slipPayload = null;
    slip.dropZoneText.textContent = file.name;
    slip.preview.src = URL.createObjectURL(file);
    slip.previewWrap.hidden = false;
    slip.button.disabled = false;
    showStatus('pending', 'Scanning slip QR code...');
    slip.info.innerHTML = '';
    slip.result.hidden = false;
}

function verifySlip() {
    if (!slipFile) {
        alert('Please choose a payment slip image first');
        return;
    }
    showStatus('pending', 'Scanning slip QR code...');

    decodeSlipQR(slipFile).then(payload => {
        if (!payload) {
            showStatus('fail', '<strong>No QR code found in the image.</strong><br>Make sure the whole slip is in the frame and the mini QR code is sharp enough.');
            return;
        }
        slipPayload = payload;
        const info = parseSlipPayload(payload);
        renderDecodedInfo(info, payload);
        verifyAndRender(info);
    }).catch(error => {
        showStatus('fail', '<strong>Failed to read the image.</strong><br>' + escapeHtml(error.message));
    });
}

/* ---------- QR decoding ---------- */

async function decodeSlipQR(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Unsupported or corrupted image file'));
            image.src = url;
        });
        return tryDecodeRegions(img);
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The mini QR usually sits in the lower part of the slip, so we retry with
// progressively targeted crops if the full-frame scan fails.
function tryDecodeRegions(img) {
    const regions = [
        { left: 0, top: 0, width: 1, height: 1, maxDim: 1600 },
        { left: 0, top: 0, width: 1, height: 1, maxDim: 3200 },
        { left: 0, top: 0.5, width: 1, height: 0.5, maxDim: 1600 },
        { left: 0.4, top: 0.55, width: 0.6, height: 0.45, maxDim: 1200 },
        { left: 0.15, top: 0.15, width: 0.7, height: 0.7, maxDim: 1200 },
    ];
    for (const region of regions) {
        const frame = drawToCanvas(img, region);
        const data = jsQR(new Uint8ClampedArray(frame.data), frame.width, frame.height, {
            inversionAttempts: 'attemptBoth'
        });
        if (data && data.data) return data.data;
    }
    return null;
}

function drawToCanvas(img, region) {
    const scale = Math.min(1, region.maxDim / Math.max(img.width, img.height));
    const sx = region.left * img.width, sy = region.top * img.height;
    const sWidth = Math.max(1, Math.round(region.width * img.width));
    const sHeight = Math.max(1, Math.round(region.height * img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sWidth * scale));
    canvas.height = Math.max(1, Math.round(sHeight * scale));
    canvas.getContext('2d').drawImage(img, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

/* ---------- Payload parsing ---------- */

// Slip mini QR format (verified against an LH Bank slip):
// TLV with 2-digit decimal tags and 2-digit decimal lengths, e.g.
// 0043000600000101030730222UTPR2611110216591894975102TH9104480B
//   tag 00 -> nested: tag 00 network id "000001", tag 01 type "073",
//                     tag 02 transaction reference "UTPR261111021659189497"
//   tag 51 -> country "TH"
//   tag 91 -> CRC16-CCITT over the payload minus the final CRC value
function parseSlipTLV(payload) {
    const tags = [];
    let i = 0;
    while (i < payload.length) {
        if (i + 4 > payload.length || !/^\d{4}$/.test(payload.slice(i, i + 4))) return null;
        const tag = payload.slice(i, i + 2);
        const len = parseInt(payload.slice(i + 2, i + 4), 10);
        if (i + 4 + len > payload.length) return null;
        tags.push({ tag: tag, length: len, value: payload.slice(i + 4, i + 4 + len) });
        i += 4 + len;
    }
    return tags;
}

function parseSlipPayload(payload) {
    if (/^000201/.test(payload) || payload.includes('A000000677010111')) {
        return parsePaymentQR(payload);
    }
    const flat = parseSlipTLV(payload);
    if (!flat) return null;
    const header = flat.find(t => t.tag === '00');
    if (!header) return null;
    const nested = parseSlipTLV(header.value);
    if (!nested) return null;
    const refTag = nested.find(t => t.tag !== '00' && t.tag !== '01' && /^[A-Z]{1,4}\d{10,}$/.test(t.value));
    const crcTag = flat.find(t => t.tag === '91');
    const countryTag = flat.find(t => t.tag === '51');
    const ref = refTag ? refTag.value : null;
    return {
        type: 'slip',
        reference: ref,
        referenceDate: ref ? slipDateFromRef(ref) : null,
        country: countryTag ? countryTag.value : null,
        crc: crcTag ? crcTag.value : null,
        crcValid: crcTag
            ? crc16(payload.slice(0, payload.length - crcTag.value.length)) === crcTag.value
            : null
    };
}

// Some banks print a regular payment (merchant-presented) QR instead of the
// short slip QR — flag it so it is not mistaken for a transaction reference.
function parsePaymentQR(payload) {
    const tags = parseSlipTLV(payload);
    const find = tag => (tags && tags.find(t => t.tag === tag) || {}).value || null;
    return {
        type: 'payment-qr',
        amount: find('54'),
        country: find('58'),
        reference: null,
        referenceDate: null,
        crc: null,
        crcValid: null
    };
}

// The reference embeds the transfer date as its first 6 digits (yyMMdd).
function slipDateFromRef(ref) {
    const digits = ref.replace(/[^0-9]/g, '').slice(0, 6);
    if (digits.length !== 6) return null;
    if (!/^\d{6}$/.test(digits)) return null;
    const year = parseInt(digits.slice(0, 2), 10) < 70 ? '20' + digits.slice(0, 2) : '19' + digits.slice(0, 2);
    return digits.slice(4, 6) + '/' + digits.slice(2, 4) + '/' + year;
}

function crc16(text) {
    let crc = 0xffff;
    for (let i = 0; i < text.length; i++) {
        crc ^= text.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/* ---------- Network verification ---------- */

function verifyAndRender(info) {
    const token = slip.token.value.trim();
    if (info.type === 'payment-qr') {
        showStatus('warn',
            '<strong>This is a payment QR code, not a payment slip.</strong><br>It contains no transaction record to verify. Upload the slip you receive <em>after</em> the payment completes.');
        return;
    }
    if (!token) {
        showStatus('decode-only',
            '<strong>QR decoded successfully (local check only).</strong><br>No API token provided, so this has <em>not</em> been checked against the bank network. Paste a free SlipVerify token above to enable network verification.');
        return;
    }
    const amount = slip.amount.value.trim();
    showStatus('pending', 'Verifying with SlipVerify network...');
    callSlipVerify(slipPayload, amount, token).then(apiResult => {
        renderApiResult(apiResult, info);
    }).catch(noSlipError => {
        // Fall back to sending the slip image, in case the service rejects
        // the raw payload (unsupported bank scheme etc.)
        callSlipVerifyImage(slipFile, amount, token).then(apiResult => {
            renderApiResult(apiResult, info);
        }).catch(() => {
            const corsHint = 'api.nearbyshop.xyz may block direct browser calls (CORS) — try again from this page or check the token';
            showStatus('decode-only',
                '<strong>Network verification unavailable.</strong> ' + escapeHtml(noSlipError.message || String(noSlipError)) +
                '<br>' + escapeHtml(corsHint) + '. Showing locally decoded data below.');
        });
    });
}

async function callSlipVerify(payload, amount, token) {
    const form = new FormData();
    form.append('qr_payload', payload);
    if (amount) form.append('amount', amount);
    return requestSlipVerify('/slipVerify/noSlip', form, token);
}

async function callSlipVerifyImage(file, amount, token) {
    const form = new FormData();
    form.append('slip', file, file.name || 'slip.jpg');
    if (amount) form.append('amount', amount);
    return requestSlipVerify('/slipVerify/v2', form, token);
}

async function requestSlipVerify(path, form, token) {
    const response = await fetch(SLIP_VERIFY_API_BASE + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: form
    });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('Invalid or expired API token');
        }
        throw new Error('HTTP ' + response.status);
    }
    return response.json();
}

/* ---------- Rendering ---------- */

function renderDecodedInfo(info, payload) {
    if (!info) {
        slip.info.innerHTML =
            '<div class="slip-row"><span class="slip-label">QR type</span>' +
            '<span class="slip-value">Unknown format</span></div>' +
            '<div class="slip-row"><span class="slip-label">Raw payload</span>' +
            '<span class="slip-value slip-raw">' + escapeHtml(payload) + '</span></div>';
        return;
    }
    const rows = [
        ['QR type', info.type === 'payment-qr' ? 'Payment QR (not a slip)' : 'Payment slip QR'],
        ['Raw payload', payload]
    ];
    if (info.reference) rows.push(['Reference number', formatReference(info.reference)]);
    if (info.referenceDate) rows.push(['Transaction date', info.referenceDate]);
    if (info.amount) rows.push(['Amount', info.amount + ' THB']);
    if (info.country) rows.push(['Country', info.country]);
    if (info.crc) rows.push(['CRC check', info.crcValid ? 'Valid (' + info.crc + ')' : 'Invalid (' + info.crc + ')']);
    slip.info.innerHTML = rows.map(row =>
        '<div class="slip-row"><span class="slip-label">' + escapeHtml(row[0]) + '</span>' +
        '<span class="slip-value">' + escapeHtml(row[1]) + '</span></div>'
    ).join('');
}

function renderApiResult(apiResult, info) {
    const data = apiResult && apiResult.data ? apiResult.data : apiResult;
    const ok = data && (
        data.status === true || data.success === true ||
        data.verified === true || String(data.status).toLowerCase() === 'true'
    );
    const detail = typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);
    showStatus(ok ? 'success' : 'fail', ok
        ? '<strong>Payment verified against the bank network</strong>' + prettyJson(detail)
        : '<strong>Not verified against the bank network</strong>' + prettyJson(detail));
}

function showStatus(state, html) {
    slip.result.hidden = false;
    slip.result.className = 'slip-result';
    if (state) slip.result.classList.add('slip-' + state);
    if (state === 'pending') {
        slip.status.innerHTML = '<p class="slip-pending">' + html + '</p>';
    } else {
        slip.status.innerHTML = html;
    }
}

function prettyJson(text) {
    if (!text || text === '{}' || text === 'null') return '';
    return '<pre class="slip-json">' + escapeHtml(text) + '</pre>';
}

// Reference numbers print as U-TPR-261111-021659-189497 on the slip itself.
function formatReference(ref) {
    const match = ref.match(/^([A-Z])([A-Z]{0,3})(\d{6})(\d{6})(\d{4,6})$/);
    if (match && match[2]) return match.slice(1).filter(Boolean).join('-');
    return ref;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}
