// =============================================
// qrscanner.js — shared camera QR scanner
// Used by scanqr.js (resident) and adminscanqr.js (admin)
//
// - Uses the browser's built-in BarcodeDetector when available
//   (Chrome / Edge / Android), otherwise falls back to jsQR (CDN).
// - Camera access needs HTTPS (or localhost).
// =============================================

const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';

let jsQRPromise = null;
function loadJsQR() {
    if (!jsQRPromise) jsQRPromise = import(JSQR_URL).then(m => m.default || m);
    return jsQRPromise;
}

/**
 * Parse what the barangay QR contains.
 * Generated format: REF:BRY-2026-12345|CODE:BRY-DOC-2026-12345|RES:Name|DOC:Type|EXP:YYYY-MM-DD
 * Also accepts a bare reference number (BRY-2026-12345) or a URL/text containing one.
 */
export function parseQRPayload(text) {
    const raw = String(text || '').trim();
    const out = { ref: null, code: null, resident: null, docType: null, exp: null, raw };

    if (raw.includes('|') || /^REF:/i.test(raw)) {
        raw.split('|').forEach(part => {
            const i = part.indexOf(':');
            if (i < 0) return;
            const k = part.slice(0, i).trim().toUpperCase();
            const v = part.slice(i + 1).trim();
            if (k === 'REF')  out.ref      = v;
            if (k === 'CODE') out.code     = v;
            if (k === 'RES')  out.resident = v;
            if (k === 'DOC')  out.docType  = v;
            if (k === 'EXP')  out.exp      = v;
        });
    }
    if (!out.ref) {
        const m = raw.match(/BRY-\d{4}-\d{4,6}/i);
        out.ref = m ? m[0].toUpperCase() : (raw.length <= 40 ? raw : null);
    }
    return out;
}

function cameraErrorMessage(err) {
    if (!window.isSecureContext) return 'Camera needs a secure connection (HTTPS or localhost).';
    switch (err?.name) {
        case 'NotAllowedError':
        case 'SecurityError':      return 'Camera permission was denied. Allow camera access in your browser and try again.';
        case 'NotFoundError':
        case 'OverconstrainedError': return 'No camera was found on this device.';
        case 'NotReadableError':   return 'The camera is being used by another app.';
        default:                   return 'Could not start the camera. Use Manual Verification instead.';
    }
}

/**
 * createQRScanner({ video, onDetect, onError, onStateChange })
 *  → { start(), stop(), isRunning() }
 * onDetect(text) fires once per scan; the scanner stops itself afterwards.
 */
export function createQRScanner({ video, onDetect, onError, onStateChange }) {
    let stream = null, running = false, rafId = null, lastTick = 0;
    let detector = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const setState = (on) => { running = on; onStateChange?.(on); };

    async function start() {
        if (running) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            onError?.(window.isSecureContext ? 'This browser does not support camera access.' : 'Camera needs a secure connection (HTTPS or localhost).');
            return;
        }
        try {
            // Prefer BarcodeDetector (fast, native); otherwise load jsQR
            if (!detector && 'BarcodeDetector' in window) {
                try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
            }
            if (!detector) await loadJsQR();

            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            video.srcObject = stream;
            video.setAttribute('playsinline', 'true');
            video.muted = true;
            await video.play();
            setState(true);
            rafId = requestAnimationFrame(tick);
        } catch (err) {
            console.error('Camera start failed:', err);
            stop();
            onError?.(cameraErrorMessage(err));
        }
    }

    function stop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = null;
        if (video) { video.pause?.(); video.srcObject = null; }
        if (running) setState(false);
    }

    async function tick(ts) {
        if (!running) return;
        rafId = requestAnimationFrame(tick);
        if (ts - lastTick < 150) return;          // ~6 scans/second is plenty
        lastTick = ts;
        if (video.readyState < 2 || !video.videoWidth) return;

        let text = null;
        try {
            if (detector) {
                const codes = await detector.detect(video);
                if (codes.length) text = codes[0].rawValue;
            } else {
                const jsQR = await loadJsQR();
                const w = video.videoWidth, h = video.videoHeight;
                const scale = Math.min(1, 640 / Math.max(w, h));
                canvas.width  = Math.round(w * scale);
                canvas.height = Math.round(h * scale);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
                if (res) text = res.data;
            }
        } catch (err) {
            console.error('QR decode error:', err);
        }

        if (text && running) {
            stop();
            navigator.vibrate?.(80);
            onDetect?.(text);
        }
    }

    // Release the camera if the tab is hidden or the page is left
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);

    return { start, stop, isRunning: () => running };
}