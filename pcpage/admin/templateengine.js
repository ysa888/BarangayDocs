// =============================================
// templateengine.js
// Shared by: templates.js (admin editor) and request.js (resident preview/print)
//
// Pure browser/DOM helpers — NO Firebase imports here, so it can be reused anywhere.
//   • Page settings (size / CUSTOM size / orientation / margins / border / header / footer / background image)
//   • REAL pagination: content is split into fixed-size pages (A4 stays A4)
//   • Field (placeholder) registry + value builder
//   • Safe template rendering (chips + {tokens} → resident data)
//   • HTML sanitizer, QR helper, print window
//   • Image layout helper (inline / left / right / center / behind text / in front)
//   • Default template that mirrors the existing hardcoded certificate
// =============================================

// ─────────────────────────────────────────────
// Page settings
// ─────────────────────────────────────────────

/** Distance (mm) between the physical paper edge and the printed border. */
export const PAPER_INSET_MM = 0;   // real paper size (Word-like): no extra shrink; print margin is 0

/** CSS pixels per millimetre. */
const MM_PX = 96 / 25.4;
/** Grey gap (px) the editor draws between sheets. The overlay-image mapping below must use the same value. */
export const EDITOR_PAGE_GAP_PX = 22;

/** Web fonts that the templates' fallback chains end in (the admin pages load the same ones). */
export const TEMPLATE_FONT_CSS = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Poppins:wght@600;700;800&display=swap';
/** A line may end this many px into the bottom margin before it is moved to the next page (absorbs font / zoom rounding). */
export const PAGE_FIT_TOLERANCE_PX = 16;
/**
 * Every page box is this much shorter than the paper (mm). It only exists so a full page can never spill a blank
 * sheet when printing (rounding). It used to be 2 mm, which left a visible white strip under a footer band.
 */
export const PAGE_SAFETY_MM = 0.4;
/**
 * A text-only tail no taller than this (px) that would start an extra page is pulled back onto the page above by
 * squeezing that page's blank spacer lines (see paginateHtml). Typical case: the e-mail line of a letterhead footer
 * that Word fits on page 1 but the browser's slightly taller text pushes onto page 2.
 */
export const TAIL_RESCUE_MAX_PX = 90;
/** The blank spacer lines may be squeezed by at most this fraction to pull such a tail back (otherwise it stays on page 2). */
export const TAIL_SQUEEZE_MAX = 0.6;

export const PAGE_SIZES = {
    A4:     { w: 210,   h: 297,   label: 'A4 (210 × 297 mm)' },
    A5:     { w: 148,   h: 210,   label: 'A5 (148 × 210 mm)' },
    A3:     { w: 297,   h: 420,   label: 'A3 (297 × 420 mm)' },
    Letter: { w: 215.9, h: 279.4, label: 'Letter (8.5 × 11 in)' },
    Legal:  { w: 215.9, h: 355.6, label: 'Legal (8.5 × 14 in)' },
    Folio:  { w: 215.9, h: 330.2, label: 'Folio (8.5 × 13 in)' },
    // size: 'Custom' uses settings.customW / settings.customH (millimetres)
    Custom: { w: 210,   h: 297,   label: 'Custom size…' }
};

export const CUSTOM_SIZE_LIMITS_MM = { min: 80, max: 1000 };

export const DEFAULT_PAGE_SETTINGS = {
    size: 'A4',
    customW: 210,                                           // mm, only used when size === 'Custom'
    customH: 297,                                           // mm
    orientation: 'portrait',
    v: 2,                                                   // settings version (2 = margins measured from the real paper edge)
    margins: { top: 20, right: 23, bottom: 20, left: 23 }, // mm, measured from the paper edge
    border: { style: 'none', width: 3, color: '#111111' },  // no page border by default
    // Header / footer: repeated on EVERY page. html may contain {page}, {pages} and field chips.
    header: { enabled: false, html: '', height: 18 },       // height in mm
    footer: { enabled: false, html: '', height: 14 },       // height in mm
    // Full-page picture behind the text (letterhead / watermark)
    background: { src: '', opacity: 0.15, fit: 'cover' }    // fit: cover | contain | center | repeat
};

const BORDER_STYLES = ['none', 'solid', 'double', 'dashed', 'dotted'];
const BG_FITS = ['cover', 'contain', 'center', 'repeat'];

/** Convert a typed length (mm / cm / in / px) into millimetres. */
export function toMm(value, unit = 'mm') {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    switch (unit) {
        case 'cm': return n * 10;
        case 'in': return n * 25.4;
        case 'px': return n / MM_PX;
        default:   return n;
    }
}

export function normalizePageSettings(s) {
    const d = DEFAULT_PAGE_SETTINGS;
    s = s && typeof s === 'object' ? s : {};
    const num = (v, fb, min, max) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
    };
    // Old templates (no v:2) had an 8mm hidden print inset and a default black border: convert them
    const legacy = s.v !== 2 && !!(s.margins || s.border);
    const add8 = (v) => { const n = Number(v); return Number.isFinite(n) ? n + 8 : v; };
    const m0 = s.margins || {};
    const m = legacy ? { top: add8(m0.top), right: add8(m0.right), bottom: add8(m0.bottom), left: add8(m0.left) } : m0;
    let b = s.border || {};
    if (legacy && b.style === 'solid' && Number(b.width) === 3 && String(b.color || '').toLowerCase() === '#111111') {
        b = { ...b, style: 'none' };
    }
    const hd = s.header || {};
    const ft = s.footer || {};
    const bg = s.background || {};
    const L = CUSTOM_SIZE_LIMITS_MM;
    const region = (r, def) => ({
        enabled: !!r.enabled,
        html: typeof r.html === 'string' ? r.html.slice(0, 60000) : '',
        height: num(r.height, def.height, 5, 80)
    });
    return {
        v: 2,
        size: PAGE_SIZES[s.size] ? s.size : d.size,
        customW: num(s.customW, d.customW, L.min, L.max),
        customH: num(s.customH, d.customH, L.min, L.max),
        orientation: s.orientation === 'landscape' ? 'landscape' : 'portrait',
        margins: {
            top:    num(m.top,    d.margins.top,    0, 60),
            right:  num(m.right,  d.margins.right,  0, 60),
            bottom: num(m.bottom, d.margins.bottom, 0, 60),
            left:   num(m.left,   d.margins.left,   0, 60)
        },
        border: {
            style: BORDER_STYLES.includes(b.style) ? b.style : d.border.style,
            width: num(b.width, d.border.width, 0, 12),
            color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : d.border.color
        },
        header: region(hd, d.header),
        footer: region(ft, d.footer),
        background: {
            src: typeof bg.src === 'string' ? bg.src.trim() : '',
            opacity: num(bg.opacity, d.background.opacity, 0.02, 1),
            fit: BG_FITS.includes(bg.fit) ? bg.fit : d.background.fit
        }
    };
}

export function paperDimensionsMm(settings) {
    const s = normalizePageSettings(settings);
    const base = s.size === 'Custom' ? { w: s.customW, h: s.customH } : PAGE_SIZES[s.size];
    const { w, h } = base;
    return s.orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

/**
 * LEGACY: CSS for a single, auto-growing "paper" element (it does NOT break into pages).
 * Kept so old callers don't crash — use mountPages() for real fixed-size pages.
 */
export function paperStyleObject(settings) {
    const s = normalizePageSettings(settings);
    const { w, h } = paperDimensionsMm(s);
    const innerW = +(w - 2 * PAPER_INSET_MM).toFixed(2);
    const innerH = +(h - 2 * PAPER_INSET_MM - PAGE_SAFETY_MM).toFixed(2); // a hair shorter than the paper so a full page never spills to page 2
    const m = s.margins;
    const hasBorder = s.border.style !== 'none' && s.border.width > 0;
    return {
        'box-sizing': 'border-box',
        'width': `${innerW}mm`,
        'min-height': `${innerH}mm`,
        'padding': `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`,
        'border': hasBorder ? `${s.border.width}px ${s.border.style} ${s.border.color}` : 'none',
        'background': '#ffffff',
        'margin': '0 auto'
    };
}

export function paperStyleString(settings) {
    return Object.entries(paperStyleObject(settings)).map(([k, v]) => `${k}:${v}`).join(';');
}

/** @page rule used when printing. */
export function pageAtRule(settings) {
    const { w, h } = paperDimensionsMm(settings);
    return `@page{size:${w}mm ${h}mm;margin:${PAPER_INSET_MM}mm}`;
}

/**
 * Base typography shared by the editor iframe (selector "body") and the
 * rendered paper (selector ".tpl-page") so what the admin sees is what prints.
 */
export function baseCss(sel = '.tpl-paper') {
    return [
        `${sel}{font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:1.15;color:#111;word-wrap:break-word}`,
        `${sel} p{margin:0 0 8pt}`,
        `${sel} table{border-collapse:collapse}`,
        `${sel} td,${sel} th{padding:4px 6px;vertical-align:top}`,
        `${sel} img{max-width:100%;height:auto}`,
        `${sel} hr{border:0;border-top:1px solid #111}`
    ].join('\n');
}

// ─────────────────────────────────────────────
// Field (placeholder) registry
// Keys map to REAL data already in the system:
//   requests/{id}  → residentName, documentType, purpose, notes, referenceNo,
//                    docCode, readyAt, expiresAt, barangay, city
//   residents/{uid}→ firstName, middleName, lastName, birthday, occupation|work|jobTitle|job,
//                    civilStatus (+ any other field found on resident records, see
//                    discoverResidentFields → "resident.<fieldName>")
// ─────────────────────────────────────────────
export const FIELD_GROUPS = [
    {
        group: 'Resident',
        fields: [
            { key: 'resident_name', label: 'Full name',          sample: 'Juan A. Dela Cruz' },
            { key: 'first_name',    label: 'First name',         sample: 'Juan' },
            { key: 'middle_name',   label: 'Middle name',        sample: 'Alonzo' },
            { key: 'last_name',     label: 'Last name',          sample: 'Dela Cruz' },
            { key: 'age',           label: 'Age',                sample: '32' },
            { key: 'birthdate',     label: 'Birthdate',          sample: 'January 5, 1994' },
            { key: 'occupation',    label: 'Occupation',         sample: 'Employee' },
            { key: 'civil_status',  label: 'Civil status',       sample: 'Single' },
            { key: 'address',       label: 'Address',            sample: 'Barangay Banicain, Olongapo City' }
        ]
    },
    {
        group: 'Request',
        fields: [
            { key: 'document_type', label: 'Document type',      sample: 'Barangay Clearance' },
            { key: 'purpose',       label: 'Purpose',            sample: 'Employment' },
            { key: 'notes',         label: 'Notes',              sample: 'Needed before Friday' },
            { key: 'reference_no',  label: 'Reference no.',      sample: 'BRY-2026-12345' },
            { key: 'document_code', label: 'Document code',      sample: 'DOC-000123' }
        ]
    },
    {
        group: 'Dates',
        fields: [
            { key: 'issue_date',      label: 'Issue date (full)',  sample: 'May 11, 2026' },
            { key: 'issue_day',       label: 'Issue day (11th)',   sample: '11th' },
            { key: 'issue_month',     label: 'Issue month',        sample: 'May' },
            { key: 'issue_year',      label: 'Issue year',         sample: '2026' },
            { key: 'expiration_date', label: 'Expiration date',    sample: 'November 11, 2026' }
        ]
    },
    {
        group: 'Location',
        fields: [
            { key: 'barangay', label: 'Barangay', sample: 'Barangay Banicain' },
            { key: 'city',     label: 'City',     sample: 'Olongapo City' }
        ]
    },
    {
        group: 'Special',
        fields: [
            { key: 'qr_code', label: 'QR code (image)', sample: '[QR]' }
        ]
    }
];

// Resident fields already exposed above (not repeated in the "other" list)
const MAPPED_RESIDENT_KEYS = new Set([
    'firstName', 'middleName', 'lastName', 'birthday',
    'occupation', 'work', 'jobTitle', 'job', 'civilStatus', 'barangay', 'city'
]);

// Never offered as placeholders (internal / sensitive / not printable)
const EXCLUDED_RESIDENT_KEY_RE =
    /pass|token|secret|uid$|^id$|photo|image|selfie|url|status|created|updated|approved|rejected|reason|role|fcm/i;

function humanize(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^./, c => c.toUpperCase());
}

function isPrintablePrimitive(v) {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ||
        (v && typeof v.toDate === 'function');
}

/**
 * Looks at real resident records and returns extra placeholders, so fields such as
 * contact number or sex appear automatically IF they exist in the resident collection.
 * @param {object[]} residents  plain objects from residents/{uid}.data()
 */
export function discoverResidentFields(residents) {
    const keys = new Set();
    (residents || []).forEach(r => {
        Object.entries(r || {}).forEach(([k, v]) => {
            if (MAPPED_RESIDENT_KEYS.has(k)) return;
            if (EXCLUDED_RESIDENT_KEY_RE.test(k)) return;
            if (!isPrintablePrimitive(v)) return;
            keys.add(k);
        });
    });
    return [...keys].sort().map(k => ({
        key: 'resident.' + k,
        label: humanize(k),
        sample: '(resident record)'
    }));
}

/** key → sample value, used for the admin "Preview" button. */
export function sampleValues(extraFields = []) {
    const out = {};
    FIELD_GROUPS.forEach(g => g.fields.forEach(f => { out[f.key] = f.sample; }));
    extraFields.forEach(f => { out[f.key] = f.sample; });
    return out;
}

// ─────────────────────────────────────────────
// Value building (real request + resident data → strings)
// ─────────────────────────────────────────────
function toDate(v) {
    if (!v) return null;
    const d = typeof v.toDate === 'function' ? v.toDate() : (v instanceof Date ? v : new Date(v));
    return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
    return d ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
}

export function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function computeAge(birthday) {
    let y, m, d;
    if (typeof birthday === 'string') {
        [y, m, d] = birthday.split('-').map(Number); // "YYYY-MM-DD", parsed without timezone shift
    } else {
        const dt = toDate(birthday);
        if (!dt) return '—';
        y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
    }
    if (!y || !m || !d) return '—';
    const today = new Date();
    let age = today.getFullYear() - y;
    const md = today.getMonth() + 1 - m;
    if (md < 0 || (md === 0 && today.getDate() < d)) age--;
    return String(age);
}

function fmtBirthdate(birthday) {
    if (!birthday) return '—';
    if (typeof birthday === 'string') {
        const [y, m, d] = birthday.split('-').map(Number);
        if (!y || !m || !d) return birthday;
        return fmtDate(new Date(y, m - 1, d));
    }
    return fmtDate(toDate(birthday));
}

function str(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (v && typeof v.toDate === 'function') return fmtDate(toDate(v));
    return String(v);
}

/**
 * Build the placeholder → text map for one request.
 * @param {object} request   requests/{id} data
 * @param {object} resident  residents/{uid} data
 */
export function buildValues(request, resident) {
    const r = request || {};
    const res = resident || {};
    const issue = toDate(r.readyAt) || new Date();

    const fullName = r.residentName ||
        [res.firstName, res.middleName ? res.middleName.charAt(0) + '.' : '', res.lastName]
            .filter(Boolean).join(' ');

    const barangay = r.barangay || res.barangay || 'Barangay Banicain';
    const city = r.city || res.city || 'Olongapo City';
    const occupation = res.occupation || res.work || res.jobTitle || res.job || '';
    const address = (typeof res.address === 'string' && res.address.trim())
        ? res.address.trim()
        : `${barangay}, ${city}`;

    const v = {
        resident_name: fullName,
        first_name: res.firstName,
        middle_name: res.middleName,
        last_name: res.lastName,
        age: computeAge(res.birthday),
        birthdate: fmtBirthdate(res.birthday),
        occupation,
        civil_status: res.civilStatus,
        address,

        document_type: r.documentType,
        purpose: r.purpose,
        notes: r.notes,
        reference_no: r.referenceNo,
        document_code: r.docCode,

        issue_date: fmtDate(issue),
        issue_day: ordinal(issue.getDate()),
        issue_month: issue.toLocaleString('en-PH', { month: 'long' }),
        issue_year: String(issue.getFullYear()),
        expiration_date: fmtDate(toDate(r.expiresAt)),

        barangay,
        city
    };

    // resident.<field> for every printable resident field
    Object.entries(res).forEach(([k, val]) => {
        if (EXCLUDED_RESIDENT_KEY_RE.test(k) || !isPrintablePrimitive(val)) return;
        v['resident.' + k] = val;
    });

    const out = {};
    Object.entries(v).forEach(([k, val]) => { out[k] = str(val); });
    return out;
}

// ─────────────────────────────────────────────
// Sanitizer (templates are admin-authored HTML shown to residents)
// ─────────────────────────────────────────────
const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'frame', 'frameset', 'applet'];
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster'];

export function sanitizeHtml(html) {
    html = String(html || '');
    const dp = typeof globalThis !== 'undefined' ? globalThis.DOMPurify : undefined;
    if (dp && typeof dp.sanitize === 'function') {
        return dp.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'] });
    }
    // Fallback sanitizer (used when DOMPurify isn't on the page)
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    DANGEROUS_TAGS.forEach(t => doc.body.querySelectorAll(t).forEach(n => n.remove()));
    doc.body.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(a => {
            const name = a.name.toLowerCase();
            const val = (a.value || '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
            if (name.startsWith('on')) { el.removeAttribute(a.name); return; }
            if (URL_ATTRS.includes(name) &&
                (val.startsWith('javascript:') || val.startsWith('vbscript:') ||
                 (val.startsWith('data:') && !val.startsWith('data:image/')))) {
                el.removeAttribute(a.name);
            }
            if (name === 'style' && /expression\(|javascript:|url\(\s*['"]?\s*javascript/i.test(a.value)) {
                el.removeAttribute(a.name);
            }
        });
    });
    return doc.body.innerHTML;
}

// ─────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────
const MISSING = '—';

function textNodesOf(root) {
    const doc = root.ownerDocument;
    const w = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const out = [];
    while (w.nextNode()) out.push(w.currentNode);
    return out;
}

function fillChip(chip, key, value) {
    const token = '{' + key + '}';
    const nodes = textNodesOf(chip);
    let replaced = false;
    nodes.forEach(n => {
        if (n.nodeValue.includes(token)) {
            n.nodeValue = n.nodeValue.split(token).join(value);
            replaced = true;
        }
    });
    if (!replaced) {
        // token was edited away: keep any formatting wrapper, show the value once
        if (nodes.length) {
            nodes[0].nodeValue = value;
            for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = '';
        } else {
            chip.textContent = value;
        }
    }
}

function stripUnderline(node) {
    if (!node || node.nodeType !== 1) return;
    const st = node.getAttribute('style');
    if (st && /underline/i.test(st)) {
        const n = st.replace(/text-decoration(?:-line)?\s*:[^;]*;?/gi, '').trim();
        if (n) node.setAttribute('style', n); else node.removeAttribute('style');
    }
}
function unwrap(el) {
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.remove();
}
function removeFieldUnderline(chip, root) {
    stripUnderline(chip);
    chip.querySelectorAll('u').forEach(unwrap);
    chip.querySelectorAll('[style]').forEach(stripUnderline);
    // wrappers such as <u><span class="ph">…</span></u> or <span style="text-decoration:underline">
    let p = chip.parentElement;
    const txt = chip.textContent.trim();
    while (p && p !== root && (p.tagName === 'U' || p.tagName === 'SPAN') && p.textContent.trim() === txt) {
        const next = p.parentElement;
        if (p.tagName === 'U') unwrap(p); else stripUnderline(p);
        p = next;
    }
}

/**
 * Word files use empty paragraphs as blank lines. An empty <p> has ZERO height in a browser, but the editor
 * (TinyMCE) draws a temporary placeholder inside it, so it looked right while editing and then collapsed in
 * the preview / print / after saving, pulling everything below it upwards. This gives every such paragraph a
 * real (non-breaking space) line again. Paragraphs that hold only free-position images get the same line.
 */
export function fillEmptyParagraphs(root) {
    if (!root || !root.querySelectorAll) return;
    const doc = root.ownerDocument;
    const isOverlay = (k) => k.tagName === 'IMG' &&
        (['behind', 'front'].includes(k.getAttribute('data-layout')) || k.classList.contains('img-behind') || k.classList.contains('img-front'));
    root.querySelectorAll('p').forEach(p => {
        if (p.textContent.replace(/[ \t\r\n]/g, '').length !== 0) return;      // has text (a non-breaking space counts as text)
        const kids = [...p.children];
        const onlyEmpty = kids.every(k =>
            isOverlay(k) ||
            (k.tagName === 'BR' && k.hasAttribute('data-mce-bogus')) ||
            (k.tagName === 'SPAN' && k.textContent.length === 0 && !k.querySelector('img,br')));
        if (!onlyEmpty) return;
        kids.filter(k => k.tagName === 'BR').forEach(k => k.remove());
        p.appendChild(doc.createTextNode('\u00a0'));
    });
}

/**
 * Turn saved template HTML into final HTML for ONE resident.
 *  - <span class="ph" data-field="key">  → replaced with the value (formatting kept)
 *  - literal {key} tokens in text        → replaced when key is known
 * Values are inserted as text nodes, so resident-entered text can never inject markup.
 *
 * @param {string} html
 * @param {Object<string,string>} values  from buildValues()
 * @param {{qrDataUrl?:string, baseUrl?:string, missing?:string}} opts
 */
export function renderTemplateHtml(html, values, opts = {}) {
    const missing = opts.missing ?? MISSING;
    const vals = values || {};
    const clean = sanitizeHtml(html);
    const doc = new DOMParser().parseFromString(`<body><div id="__root">${clean}</div></body>`, 'text/html');
    const root = doc.getElementById('__root');

    const valueFor = (key) => {
        const val = vals[key];
        return (val === undefined || val === null || String(val).trim() === '') ? missing : String(val);
    };

    // 1) literal {tokens} outside chips (single pass; inserted values are not re-scanned)
    textNodesOf(root).forEach(n => {
        if (n.parentElement && n.parentElement.closest('.ph[data-field]')) return;
        if (!n.nodeValue.includes('{')) return;
        n.nodeValue = n.nodeValue.replace(/\{([A-Za-z0-9_.]+)\}/g, (m, key) =>
            (key !== 'qr_code' && key in vals) ? valueFor(key) : m);
    });

    // 2) placeholder chips
    root.querySelectorAll('.ph[data-field]').forEach(chip => {
        const key = chip.getAttribute('data-field');
        if (key === 'qr_code') {
            if (opts.qrDataUrl) {
                const img = doc.createElement('img');
                img.setAttribute('src', opts.qrDataUrl);
                img.setAttribute('alt', 'QR Code');
                img.setAttribute('width', '100');
                img.setAttribute('height', '100');
                img.setAttribute('style', 'display:inline-block;vertical-align:middle;width:100px;height:100px;');
                chip.replaceWith(img);
            } else {
                chip.textContent = valueFor('reference_no');
                chip.classList.remove('ph');
                chip.removeAttribute('data-field');
            }
            return;
        }
        fillChip(chip, key, valueFor(key));
        removeFieldUnderline(chip, root);
        chip.classList.remove('ph');
        chip.removeAttribute('data-field');
        if (!chip.getAttribute('class')) chip.removeAttribute('class');
    });

    // 2b) blank Word lines (empty paragraphs) must keep their height
    fillEmptyParagraphs(root);

    // 3) relative image URLs → absolute (so they also resolve in the print window)
    if (opts.baseUrl) {
        root.querySelectorAll('img[src]').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (/^(https?:|data:|blob:)/i.test(src)) return;
            try { img.setAttribute('src', new URL(src, opts.baseUrl).href); } catch (_) { /* leave as is */ }
        });
    }

    return root.innerHTML;
}

// ─────────────────────────────────────────────
// QR + print
// ─────────────────────────────────────────────
/** Returns a PNG data URL, or '' if QRious isn't loaded. */
export function makeQrDataUrl(value, size = 100) {
    try {
        const Q = globalThis.QRious;
        if (!Q) return '';
        const canvas = document.createElement('canvas');
        new Q({
            element: canvas, value: String(value || 'NO-QR'), size,
            backgroundAlpha: 1, foreground: '#1B3A6B', background: '#ffffff', level: 'H'
        });
        return canvas.toDataURL('image/png');
    } catch (_) {
        return '';
    }
}

// ─────────────────────────────────────────────
// PAGE GEOMETRY + REAL PAGINATION
// Every page is a fixed-size box (e.g. A4). Long content is split across
// as many pages as needed instead of stretching one page.
// ─────────────────────────────────────────────

/** All sizes (mm and px) derived from the settings. Shared by editor, preview and print. */
export function pageGeometry(settings) {
    const s = normalizePageSettings(settings);
    const { w, h } = paperDimensionsMm(s);
    const innerW = +(w - 2 * PAPER_INSET_MM).toFixed(2);
    const innerH = +(h - 2 * PAPER_INSET_MM - PAGE_SAFETY_MM).toFixed(2);
    const m = s.margins;
    const hasBorder = s.border.style !== 'none' && s.border.width > 0;
    const bw = hasBorder ? s.border.width : 0;
    const hh = s.header.enabled ? s.header.height : 0;
    const fh = s.footer.enabled ? s.footer.height : 0;
    const bodyW = Math.max(40, (innerW - m.left - m.right) * MM_PX - 2 * bw);
    const bodyH = Math.max(60, (innerH - m.top - m.bottom - hh - fh) * MM_PX - 2 * bw);
    return { s, w, h, innerW, innerH, bw, hh, fh, bodyW, bodyH };
}

function pageBorderCss(s) {
    const has = s.border.style !== 'none' && s.border.width > 0;
    return has ? `${s.border.width}px ${s.border.style} ${s.border.color}` : 'none';
}

/** CSS for the paged view (screen preview + print window). */
export function pagedCss(settings) {
    const g = pageGeometry(settings);
    return [
        // The pages are drawn straight into the host page (no iframe). Host pages often have a global reset such as
        // `* {margin:0;padding:0;box-sizing:border-box}` (the admin pages do). That silently changes row heights, list
        // indents and widths of the imported Word layout, so the preview no longer matches the template editor (which
        // is an isolated iframe). Give everything inside a page its browser defaults back. :where() keeps this at zero
        // specificity, so every rule below and every inline style still wins.
        `:where(.tpl-page *){all:revert}`,
        baseCss('.tpl-page'),
        baseCss('.tpl-measure'),
        `.tpl-pages{display:flex;flex-direction:column;align-items:center;gap:16px}`,
        `.tpl-page{box-sizing:border-box;position:relative;isolation:isolate;overflow:hidden;flex:none;display:flex;flex-direction:column;background:#ffffff;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
        `.tpl-hdr,.tpl-ftr{flex:none;overflow:hidden;box-sizing:border-box}`,
        `.tpl-ftr{margin-top:auto}`,
        `.tpl-body{flex:none;overflow:visible;display:flow-root;box-sizing:border-box}`,
        `.tpl-measure{box-sizing:border-box;display:flow-root;position:absolute;left:0;top:0;width:${g.bodyW}px}`,
        `.tpl-body img,.tpl-measure img{max-height:${Math.floor(g.bodyH)}px;object-fit:contain}`,
        `.tpl-hdr p,.tpl-ftr p{margin:0}`,
        `@media screen{.tpl-page{box-shadow:0 1px 8px rgba(0,0,0,.28)}}`,
        `@media print{.tpl-pages{display:block}.tpl-page{box-shadow:none;break-after:page;page-break-after:always}.tpl-page:last-child{break-after:auto;page-break-after:auto}}`
    ].join('\n');
}

/** Turns a user-supplied image location into a safe CSS url(...) or ''. */
function safeCssUrl(src, baseUrl) {
    let u = String(src || '').trim();
    if (!u) return '';
    if (!/^(https?:|data:image\/|blob:)/i.test(u)) {
        try {
            u = new URL(u, baseUrl || (typeof document !== 'undefined' ? document.baseURI : undefined)).href;
        } catch (_) { return ''; }
    }
    if (/["'()\\\s<>]/.test(u)) return '';
    return `url(${u})`;
}

function bgFitCss(fit) {
    return ({
        cover:   'background-size:cover;background-position:center;background-repeat:no-repeat',
        contain: 'background-size:contain;background-position:center;background-repeat:no-repeat',
        center:  'background-position:center;background-repeat:no-repeat',
        repeat:  'background-repeat:repeat'
    })[fit] || '';
}

function backgroundHtml(s, opts) {
    const url = safeCssUrl(s.background.src, opts.baseUrl);
    if (!url) return '';
    return `<div class="tpl-bg" style="position:absolute;left:0;top:0;right:0;bottom:0;z-index:-1;pointer-events:none;background-image:${url};${bgFitCss(s.background.fit)};opacity:${s.background.opacity}"></div>`;
}

const SPLITTABLE = new Set([
    'P', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'FONT', 'SMALL', 'SUB', 'SUP',
    'BLOCKQUOTE', 'PRE', 'CENTER', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT'
]);
const OVERLAY_IMG_SEL = 'img[data-layout="behind"],img[data-layout="front"],img.img-behind,img.img-front';

/**
 * Splits HTML into page-sized chunks by measuring it in a hidden iframe that
 * uses the same CSS as the real page. Paragraphs split between lines, tables
 * split between rows (header row repeats), images/headings/list items stay whole.
 * Images set to "behind text" / "in front" are pulled out and pinned to a page.
 */
async function paginateHtml(html, g) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.ceil(g.bodyW + 60)}px;height:800px;border:0;visibility:hidden;pointer-events:none`;
    document.body.appendChild(frame);
    try {
        const d = frame.contentDocument;
        d.open();
        d.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="${TEMPLATE_FONT_CSS}"><style>html,body{margin:0;padding:0}\n${pagedCss(g.s)}</style></head><body></body></html>`);
        d.close();
        // measure with the SAME web fonts the page is shown with, otherwise lines wrap differently
        await new Promise(res => {
            const l = d.querySelector('link');
            if (!l) return res();
            l.addEventListener('load', res, { once: true });
            l.addEventListener('error', res, { once: true });
            setTimeout(res, 2500);
        });

        const stage = d.createElement('div');
        stage.className = 'tpl-measure';
        stage.innerHTML = html;
        d.body.appendChild(stage);
        const cur = d.createElement('div');
        cur.className = 'tpl-measure';
        d.body.appendChild(cur);

        // wait for images so their real height is known before measuring
        const imgs = [...stage.querySelectorAll('img')];
        await Promise.all(imgs.map(img => img.complete ? null : new Promise(res => {
            img.addEventListener('load', res, { once: true });
            img.addEventListener('error', res, { once: true });
            setTimeout(res, 5000);
        })));

        stage.getBoundingClientRect();   // lay the text out so the web fonts it uses start loading
        try { await Promise.race([d.fonts.ready, new Promise(r => setTimeout(r, 2000))]); } catch (_) { /* ignore */ }

        const overlayImgs = [...stage.querySelectorAll(OVERLAY_IMG_SEL)];
        // Editor sheets are drawn P px apart (sheet height + gap), so an image's editor `top`
        // tells us its page (k) and its position on that page (top - k*P).
        const P = g.s.margins.top * MM_PX + g.bodyH + g.s.margins.bottom * MM_PX + EDITOR_PAGE_GAP_PX;
        // A picture that ends at (or just above) the bottom of its sheet is anchored to the bottom edge of the page:
        //  - a wide, short one is a footer band;
        //  - a (nearly) full-page one is letterhead art whose lower part is the footer band. Word places it with a small
        //    offset from the page top (e.g. 4.95 mm); when that offset is lost on import the art ends that far above the
        //    paper edge and a white strip shows under the bar.
        // Its saved `top` was measured in the editor and also drifts when the page height differs by a few px.
        const pageHpx = g.innerH * MM_PX, pageWpx = g.innerW * MM_PX;
        overlayImgs.forEach(img => {
            // Measure the picture at its real size: inside the measuring box it is capped to the text area
            // (max-width:100% / max-height), which made full-page letterhead art look too small to be recognised
            // as a footer band, so it was never anchored to the bottom edge and a white strip showed under it.
            img.style.maxWidth = 'none';
            img.style.maxHeight = 'none';
            const r = img.getBoundingClientRect();
            const top = parseFloat(img.style.top);
            img.__snap = false;
            if (!(r.height > 0) || !Number.isFinite(top)) return;
            const k = Math.max(0, Math.floor(top / P));
            const gapBelow = pageHpx - ((top - k * P) + r.height);
            const band = r.width >= pageWpx * 0.7 && r.height <= pageHpx * 0.3;
            const fullPage = r.width >= pageWpx * 0.9 && r.height >= pageHpx * 0.6;
            img.__snap = (band || fullPage) && gapBelow >= -8 && gapBelow <= pageHpx * 0.07;
        });
        overlayImgs.forEach(img => img.remove());

        const limit = g.bodyH + PAGE_FIT_TOLERANCE_PX;
        const fits = () => cur.getBoundingClientRect().height <= limit;
        const hasReal = el => el.textContent.trim() !== '' || !!el.querySelector('img,hr,br,tr,li');

        function fillText(container, tn) {
            const parts = tn.nodeValue.split(/(\s+)/);
            const probe = d.createTextNode('');
            container.appendChild(probe);
            let lo = 0, hi = parts.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                probe.nodeValue = parts.slice(0, mid).join('');
                if (fits()) lo = mid; else hi = mid - 1;
            }
            if (lo === 0) { container.removeChild(probe); return tn; }
            probe.nodeValue = parts.slice(0, lo).join('');
            const rest = parts.slice(lo).join('').replace(/^\s+/, '');
            return rest ? d.createTextNode(rest) : null;
        }

        // Puts `node` into `container` (inside cur). Returns null when fully placed,
        // the SAME node (untouched) when nothing fit, or a new node holding the remainder.
        function fill(container, node) {
            container.appendChild(node);
            if (fits()) return null;
            container.removeChild(node);
            if (node.nodeType === 3) return fillText(container, node);
            if (node.nodeType !== 1 || !SPLITTABLE.has(node.tagName)) return node;
            const kids = [...node.childNodes];
            if (!kids.length) return node;

            const shell = node.cloneNode(false);
            container.appendChild(shell);
            for (let i = 0; i < kids.length; i++) {
                const rem = fill(shell, kids[i]);
                if (rem === null) continue;
                if (!(shell.firstChild && hasReal(shell))) {
                    // nothing useful fit here → undo and let the caller move the whole node
                    container.removeChild(shell);
                    for (let j = i; j >= 0; j--) node.insertBefore(kids[j], node.firstChild);
                    return node;
                }
                const remainder = node.cloneNode(false);
                remainder.removeAttribute('id');
                [rem, ...kids.slice(i + 1)].forEach(k => remainder.appendChild(k));
                if (node.tagName === 'OL') {
                    const base = parseInt(node.getAttribute('start') || '1', 10) || 1;
                    remainder.setAttribute('start', String(base + shell.children.length));
                }
                if (node.tagName === 'TABLE') {
                    const th = [...shell.children].find(c => c.tagName === 'THEAD');
                    if (th) remainder.insertBefore(th.cloneNode(true), remainder.firstChild);
                }
                return remainder;
            }
            return null;
        }

        const pages = [];
        const heights = [];            // measured content height of every page (px)
        const hardBreaks = new Set();  // page indexes that start after an explicit page break
        const flush = () => {
            heights.push(cur.getBoundingClientRect().height);
            pages.push(cur.innerHTML);
            while (cur.firstChild) cur.removeChild(cur.firstChild);
        };
        const queue = [...stage.childNodes];
        let guard = 0;
        while (queue.length && guard++ < 50000) {
            const node = queue.shift();
            if (node.nodeType === 8) continue;
            if (node.nodeType === 3 && !node.nodeValue.trim() && !cur.firstChild) continue;
            if (node.nodeType === 1 && node.hasAttribute('data-pagebreak')) {
                const blank = node.getAttribute('data-pagebreak') === 'blank';
                if (cur.firstChild) flush();
                if (blank) { hardBreaks.add(pages.length); pages.push(''); heights.push(0); }
                hardBreaks.add(pages.length);
                continue;
            }
            const rem = fill(cur, node);
            if (rem === null) continue;
            if (rem === node) {
                if (cur.firstChild) { flush(); queue.unshift(node); }
                else { cur.appendChild(node); flush(); }      // taller than a whole page: keep it, clipped
            } else {
                flush();
                queue.unshift(rem);
            }
        }
        if (cur.firstChild || !pages.length) flush();

        // A last page that shows nothing (only blank Word lines) is never wanted.
        const hasVisible = (html) => {
            const t = d.createElement('div');
            t.innerHTML = html;
            return t.textContent.trim() !== '' || !!t.querySelector('img,hr,table');
        };
        while (pages.length > 1 && !hardBreaks.has(pages.length - 1) && !hasVisible(pages[pages.length - 1])) {
            pages.pop(); heights.pop();
        }
        // A few lines of plain text that spilled onto an extra page (e.g. the e-mail line under a letterhead footer band)
        // are pulled back onto the page above. Word fits them there; the browser's text is a touch taller. Room is made by
        // squeezing that page's blank spacer lines a little — nothing overlaps and the text keeps its place in the flow.
        // Not done after an explicit page break, for tails with pictures / tables, or when the spacers can't cover it.
        if (pages.length > 1) {
            const li = pages.length - 1;
            if (!hardBreaks.has(li) && heights[li] <= TAIL_RESCUE_MAX_PX && !/<(img|table|hr)\b/i.test(pages[li])) {
                const tail = d.createElement('div');
                tail.innerHTML = pages[li];
                while (tail.lastElementChild && !tail.lastElementChild.textContent.trim() && !tail.lastElementChild.querySelector('img')) {
                    tail.removeChild(tail.lastElementChild);   // trailing blank lines need no room
                }
                if (tail.textContent.trim()) {
                    cur.innerHTML = pages[li - 1] + tail.innerHTML;
                    const win = d.defaultView;
                    const isBlank = el => /^(P|DIV)$/.test(el.tagName) && !el.textContent.trim() && !el.querySelector('img,hr,table');
                    const slot = el => {
                        const cs = win.getComputedStyle(el);
                        return el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
                    };
                    const blanks = [...cur.children].filter(isBlank);
                    const slots = blanks.map(slot);
                    const total = slots.reduce((a, b) => a + b, 0);
                    const over = cur.getBoundingClientRect().height - (g.bodyH + PAGE_FIT_TOLERANCE_PX);
                    let ok = over <= 0;
                    if (!ok && total > 0 && over / total <= TAIL_SQUEEZE_MAX) {
                        for (const extra of [0.02, 0.12, 0.25]) {
                            const f = Math.min(TAIL_SQUEEZE_MAX, over / total + extra);
                            blanks.forEach((el, i) => {
                                el.style.margin = '0';
                                el.style.minHeight = '0';
                                el.style.display = 'block';
                                el.style.overflow = 'hidden';
                                el.style.height = Math.max(0, slots[i] * (1 - f)).toFixed(1) + 'px';
                            });
                            if (cur.getBoundingClientRect().height <= g.bodyH + PAGE_FIT_TOLERANCE_PX) { ok = true; break; }
                        }
                    }
                    if (ok) { pages[li - 1] = cur.innerHTML; pages.pop(); heights.pop(); }
                    while (cur.firstChild) cur.removeChild(cur.firstChild);
                }
            }
        }

        // pin "behind text" / "in front" images to the page their position falls on
        const overlays = [];
        overlayImgs.forEach(img => {
            const top = parseFloat(img.style.top);
            let k = 0, t = top;
            if (Number.isFinite(top)) {
                k = Math.min(pages.length - 1, Math.max(0, Math.floor(top / P)));
                t = top - k * P;
            }
            img.style.position = 'absolute';
            if (!img.style.zIndex) img.style.zIndex = (img.getAttribute('data-layout') === 'front' || img.classList.contains('img-front')) ? '5' : '-1';
            if (img.__snap) { img.style.top = 'auto'; img.style.bottom = '0px'; }
            else if (Number.isFinite(t)) img.style.top = t.toFixed(1) + 'px';
            const html = img.outerHTML;
            if (img.getAttribute('data-repeat') === '1') {
                // header / footer picture: shown at the same spot on EVERY page
                pages.forEach((_, i) => { (overlays[i] = overlays[i] || []).push(html); });
            } else {
                (overlays[k] = overlays[k] || []).push(html);
            }
        });

        return { chunks: pages, overlays: pages.map((_, i) => (overlays[i] || []).join('')) };
    } finally {
        frame.remove();
    }
}

/**
 * Builds the fixed-size pages for already-rendered HTML.
 * @param {string} renderedHtml  output of renderTemplateHtml()
 * @param {object} settings
 * @param {{values?:object, qrDataUrl?:string, baseUrl?:string}} opts
 *        values/qrDataUrl are used for chips inside header/footer.
 * @returns {Promise<{html:string, css:string, count:number}>}
 */
export async function buildPages(renderedHtml, settings, opts = {}) {
    const g = pageGeometry(settings);
    const s = g.s;
    const { chunks, overlays } = await paginateHtml(sanitizeHtml(renderedHtml), g);
    const total = chunks.length;
    const m = s.margins;

    const region = (r) => {
        if (!r.enabled) return null;
        const h = (r.html || '').trim();
        if (!h) return '';
        return renderTemplateHtml(h, opts.values || {}, { qrDataUrl: opts.qrDataUrl, baseUrl: opts.baseUrl });
    };
    const hdr = region(s.header);
    const ftr = region(s.footer);
    const pageNo = (str, n) => str.replace(/\{pages\}/g, String(total)).replace(/\{page\}/g, String(n));

    const pageStyle =
        `width:${g.innerW}mm;height:${g.innerH}mm;padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;` +
        `border:${pageBorderCss(s)};`;
    const bg = backgroundHtml(s, opts);

    const pages = chunks.map((c, i) => {
        const head = hdr === null ? '' : `<div class="tpl-hdr" style="height:${s.header.height}mm">${pageNo(hdr, i + 1)}</div>`;
        const foot = ftr === null ? '' : `<div class="tpl-ftr" style="height:${s.footer.height}mm">${pageNo(ftr, i + 1)}</div>`;
        return `<div class="tpl-page" style="${pageStyle}">${bg}${overlays[i] || ''}${head}` +
               `<div class="tpl-body" style="width:${g.bodyW.toFixed(1)}px;height:${g.bodyH.toFixed(1)}px">${c}</div>${foot}</div>`;
    });

    return { html: `<div class="tpl-pages">${pages.join('')}</div>`, css: `@import url("${TEMPLATE_FONT_CSS}");\n` + pagedCss(s), count: total };
}

/**
 * Looks at the pages as they are really laid out and pins wide letterhead / footer pictures that end a little above
 * the paper edge to the bottom edge, so no white strip shows under a footer band. Works on real geometry (not on
 * positions saved by the editor), so it also covers art whose saved position drifted. Safe to call repeatedly.
 * @param {ParentNode} root  element holding .tpl-page boxes (live preview or print window body)
 * @param {number} maxGapPx  largest gap (page px) that counts as "meant to touch the bottom"
 */
export async function snapBottomArt(root, maxGapPx = 40) {
    if (!root || !root.querySelectorAll) return;
    const pages = [...root.querySelectorAll('.tpl-page')];
    const imgs = pages.flatMap(pg => [...pg.children].filter(k => k.tagName === 'IMG'));
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(res => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
        setTimeout(res, 4000);
    })));
    pages.forEach(pg => {
        const win = pg.ownerDocument.defaultView;
        const pr = pg.getBoundingClientRect();
        if (!win || !(pr.height > 0) || !(pg.offsetHeight > 0)) return;
        const sc = pr.height / pg.offsetHeight || 1;          // the editing view may be zoomed
        [...pg.children].forEach(img => {
            if (img.tagName !== 'IMG' || win.getComputedStyle(img).position !== 'absolute') return;
            const r = img.getBoundingClientRect();
            const gap = (pr.bottom - r.bottom) / sc;
            if (r.width / sc >= pg.offsetWidth * 0.7 && gap > 0.5 && gap <= maxGapPx) {
                img.style.top = 'auto';
                img.style.bottom = '0px';
            }
        });
    });
}

/**
 * One-liner for previews: fills `container` with the fixed-size pages.
 * Resolves to the number of pages.
 */
export async function mountPages(container, renderedHtml, settings, opts = {}) {
    const { html, css, count } = await buildPages(renderedHtml, settings, opts);
    container.innerHTML = `<style>${css}</style>${html}`;
    await snapBottomArt(container);
    return count;
}

// ─────────────────────────────────────────────
// Editor iframe CSS (white page, page-end guides)
// ─────────────────────────────────────────────
/**
 * Complete CSS for the contenteditable iframe. White paper, exact paper width,
 * and a faint line where each page ends (approximate — final split is at line/row boundaries).
 */
export function editorCss(settings, opts = {}) {
    const g = pageGeometry(settings);
    const s = g.s;
    const m = s.margins;
    const mtPx = (m.top * MM_PX).toFixed(1);
    const guide = 'rgba(220,60,60,.9)';
    const url = safeCssUrl(s.background.src, opts.baseUrl);
    return [
        `html{background:#e6e6e6;padding:0}`,
        baseCss('body'),
        `body{box-sizing:border-box;position:relative;isolation:isolate;` +
            `width:${g.innerW}mm;min-height:${g.innerH}mm;margin:16px auto;` +
            `padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;` +
            `border:${pageBorderCss(s)};background-color:#ffffff;` +
            `background-image:linear-gradient(to bottom,transparent calc(100% - 3px),${guide} calc(100% - 3px)),` +
            `linear-gradient(to bottom,transparent 50%,rgba(27,58,107,.045) 50%);` +
            `background-size:100% ${g.bodyH.toFixed(1)}px,100% ${(g.bodyH * 2).toFixed(1)}px;` +
            `background-position:0 ${mtPx}px,0 ${mtPx}px;background-repeat:repeat-y;` +
            `box-shadow:0 1px 8px rgba(0,0,0,.28);overflow-wrap:break-word}`,
        url ? `body::before{content:'';position:absolute;left:0;top:0;right:0;bottom:0;z-index:-1;pointer-events:none;` +
              `background-image:${url};${bgFitCss(s.background.fit)};opacity:${s.background.opacity}}` : '',
        `img{max-width:100%}`
    ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────
// Images: inline / wrap left / wrap right / centered / behind text / in front of text
// ─────────────────────────────────────────────
export const IMAGE_LAYOUTS = ['inline', 'left', 'right', 'center', 'behind', 'front'];

/**
 * Sets how an <img> sits relative to the text. Works inside the editor iframe
 * (the editor <body> is positioned, see editorCss) — everything is stored as
 * inline style + data-layout so it survives saving, preview and print.
 * @param {HTMLImageElement} img
 * @param {'inline'|'left'|'right'|'center'|'behind'|'front'} mode
 * @param {{x?:number,y?:number,width?:number,opacity?:number}} pos  px, used by behind/front
 */
export function applyImageLayout(img, mode, pos = {}) {
    if (!img || !IMAGE_LAYOUTS.includes(mode)) return;
    const x = Number.isFinite(pos.x) ? pos.x : img.offsetLeft;
    const y = Number.isFinite(pos.y) ? pos.y : img.offsetTop;
    const st = img.style;
    ['position', 'left', 'top', 'right', 'bottom', 'float', 'display', 'margin', 'zIndex'].forEach(p => { st[p] = ''; });
    IMAGE_LAYOUTS.forEach(m => img.classList.remove('img-' + m));
    img.classList.add('img-' + mode);
    img.setAttribute('data-layout', mode);
    if (mode !== 'behind' && mode !== 'front') img.removeAttribute('data-repeat');
    if (pos.repeat === true) img.setAttribute('data-repeat', '1');
    else if (pos.repeat === false) img.removeAttribute('data-repeat');

    if (Number.isFinite(pos.width) && pos.width > 0) {
        img.removeAttribute('width');
        img.removeAttribute('height');
        st.width = Math.round(pos.width) + 'px';
        st.height = 'auto';
    }
    if (Number.isFinite(pos.opacity)) st.opacity = String(Math.min(1, Math.max(0.05, pos.opacity)));

    switch (mode) {
        case 'left':   st.float = 'left';  st.margin = '0 12px 6px 0'; break;
        case 'right':  st.float = 'right'; st.margin = '0 0 6px 12px'; break;
        case 'center': st.display = 'block'; st.margin = '6px auto'; break;
        case 'behind':
        case 'front':
            st.position = 'absolute';
            st.left = Math.round(x) + 'px';
            st.top = Math.round(y) + 'px';
            st.margin = '0';
            st.zIndex = mode === 'behind' ? '-1' : '5';
            break;
        default: break; // inline
    }
}

// ─────────────────────────────────────────────
// Show / hide panels (give the editor more room)
// ─────────────────────────────────────────────
/**
 * Makes a side panel collapsible with a button.
 * setupPanelToggle(sidebarEl, toggleBtn, { storageKey:'fields', onToggle: hidden => {...} })
 */
export function setupPanelToggle(panel, button, opts = {}) {
    if (!panel || !button) return null;
    const key = opts.storageKey ? 'tplpanel:' + opts.storageKey : null;
    const shownDisplay = opts.display || '';
    const apply = (hidden) => {
        panel.style.display = hidden ? 'none' : shownDisplay;
        button.setAttribute('aria-expanded', String(!hidden));
        button.textContent = hidden ? (opts.showLabel || 'Show panel') : (opts.hideLabel || 'Hide panel');
        try { if (key) localStorage.setItem(key, hidden ? '1' : '0'); } catch (_) { /* ignore */ }
        if (typeof opts.onToggle === 'function') opts.onToggle(hidden);
    };
    let hidden = false;
    try { hidden = !!key && localStorage.getItem(key) === '1'; } catch (_) { /* ignore */ }
    apply(hidden);
    button.addEventListener('click', () => apply(panel.style.display !== 'none'));
    return { apply };
}

/**
 * Opens a clean window containing ONLY the fixed-size pages (header/footer/background
 * included), with exact page size/margins, and prints.
 * @param {string} renderedHtml  from renderTemplateHtml()
 * @param {object} settings
 * @param {string} title
 * @param {{values?:object, qrDataUrl?:string, baseUrl?:string}} opts  needed for chips in header/footer
 */
export async function printTemplateHtml(renderedHtml, settings, title = 'Barangay Document', opts = {}) {
    const s = normalizePageSettings(settings);
    const win = window.open('', '_blank', 'width=900,height=750');   // opened synchronously → not popup-blocked
    if (!win) {
        alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
        return;
    }
    win.document.open();
    win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preparing…</title></head><body style="font-family:sans-serif;padding:24px;color:#444">Preparing document…</body></html>');
    win.document.close();

    let built;
    try {
        built = await buildPages(renderedHtml, s, { baseUrl: document.baseURI, ...opts });
    } catch (err) {
        console.error('Pagination failed', err);
        win.close();
        alert('Could not prepare the document for printing.');
        return;
    }

    win.document.open();
    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${TEMPLATE_FONT_CSS}">
<title>${String(title).replace(/[<>&]/g, '')}</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
${built.css}
${pageAtRule(s)}
@media screen { body { padding: 16px; background: #e6e6e6; } }
</style>
</head>
<body>${built.html}</body>
</html>`);
    win.document.close();

    const snapped = snapBottomArt(win.document.body).catch(() => {});
    let printed = false;
    const go = () => {
        if (printed) return;
        printed = true;
        snapped.then(() => setTimeout(() => {
            win.focus();
            win.print();
            setTimeout(() => win.close(), 1000);
        }, 400));
    };
    win.addEventListener('load', go);
    setTimeout(go, 1500); // safety net if 'load' already fired
}

// ─────────────────────────────────────────────
// Default template — mirrors the existing hardcoded certificate
// (barangaydocs_request.html → #doc-preview-content) so admins start from the
// current look and then customise.
// ─────────────────────────────────────────────
export function defaultTemplateHtml() {
    const ph = (key, extraStyle = '') =>
        `<span class="ph" data-field="${key}"${extraStyle ? ` style="${extraStyle}"` : ''}>{${key}}</span>`;
    const u = '';

    return `
<table style="width:100%;border-collapse:collapse;border:none;" border="0">
<tbody>
<tr>
<td style="width:90px;border:none;vertical-align:middle;"><img src="Icons/barangay_seal.png" alt="Barangay Seal" width="84" height="84"></td>
<td style="border:none;text-align:center;vertical-align:middle;">
<p style="text-align:center;font-size:12pt;line-height:1.7;margin:0;">Republic of the Philippines<br>Province of Zambales<br>Municipality of Olongapo City</p>
<p style="text-align:center;font-size:24pt;font-weight:bold;margin:4px 0 0;">Barangay Banicain</p>
</td>
<td style="width:90px;border:none;">&nbsp;</td>
</tr>
</tbody>
</table>
<hr style="border:0;border-top:4px solid #111;margin:12px 0 18px;">
<p style="text-align:center;font-size:11pt;letter-spacing:2px;">OFFICE OF THE BARANGAY CAPTAIN</p>
<p style="text-align:center;font-size:22pt;font-weight:bold;text-decoration:underline;text-transform:uppercase;margin-bottom:18px;">${ph('document_type')}</p>
<p style="font-size:11pt;font-weight:bold;letter-spacing:1px;">TO WHOM IT MAY CONCERN:</p>
<p style="text-align:center;font-size:12pt;line-height:1.9;text-transform:uppercase;">This is to certify that ${ph('resident_name', u)}, ${ph('age', u)} years old, ${ph('occupation', u)} and a resident of ${ph('address')}.</p>
<p style="text-align:center;font-size:12pt;line-height:1.9;text-transform:uppercase;">Issued this ${ph('issue_day', u)} day of ${ph('issue_month', u)}, ${ph('issue_year', u)} at Barangay Banicain, Olongapo City, Zambales upon request of the interested party for whatever legal purposes it may serve.</p>
<p>&nbsp;</p>
<table style="width:100%;border-collapse:collapse;border:none;" border="0">
<tbody>
<tr>
<td style="width:55%;border:none;vertical-align:top;">
<p style="font-size:9pt;line-height:2;margin:0 0 8px;">DOCUMENT CODE &nbsp;- ${ph('document_code')}<br>REFERENCE NO &nbsp;&nbsp;- ${ph('reference_no')}<br>ISSUED IN &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- ${ph('issue_date')}<br>EXPIRATION IN &nbsp;- ${ph('expiration_date')}</p>
<p style="margin:0;">${ph('qr_code')}</p>
<p style="font-size:8pt;font-weight:bold;letter-spacing:1px;margin:2px 0 0;">QR CODE</p>
</td>
<td style="border:none;text-align:center;vertical-align:top;">
<p style="text-align:center;margin:0;"><strong style="font-size:13pt;">HON. VIVENCIO VIRAY</strong><br><span style="font-size:9pt;letter-spacing:1px;">BARANGAY CAPTAIN</span></p>
<p style="text-align:center;margin:14px 0 0;"><strong style="font-size:12pt;letter-spacing:1px;">BARANGAYDOCS</strong><br><span style="font-size:8pt;letter-spacing:1px;">ISSUED IN ${ph('issue_date')}</span></p>
</td>
</tr>
</tbody>
</table>`.trim();
}