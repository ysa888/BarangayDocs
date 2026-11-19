// =============================================
// doctemplate.js   (pcpage/admin/doctemplate.js)
// Shared by: adminrequests.js (admin preview / print) and request.js (resident preview / print)
//
// Shows an admin-made template (documentTemplates/{docId}, built in admin_templates.html)
// for one request, using the SAME engine the template editor uses (templateengine.js):
// fixed-size pages, header/footer, placeholder chips, QR, print.
//
// Admin corrections (requests/{id}.docOverrides, see docoverrides.js) are applied on top of the
// values the engine derives from the request + resident profile. The resident profile is never
// modified. Live edits made in docedit.js reach this view through setTemplatePainter(), so the
// template re-renders while the admin types and again after "Save Changes".
//
// Exports (all used by existing callers):
//   loadTemplateForType(db, documentType) → template | null   (never throws)
//   createTemplateView(container)         → { container, active, show, hide, print, refresh }
// Also exported for reuse/testing:
//   applyOverridesToValues(values, overrides), overridesFromPaintValues(values, base)
// =============================================

import {
    getDocs, query, collection, where, limit
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {
    DEFAULT_PAGE_SETTINGS, normalizePageSettings, buildValues, renderTemplateHtml,
    buildPages, printTemplateHtml, makeQrDataUrl
} from "./templateengine.js";
import { TEXT_KEYS, baseValues, formatDob, setTemplatePainter } from "./docoverrides.js";

// ---------------------------------------------
// Loading
// ---------------------------------------------
const hasContent = (html) => typeof html === 'string' && html.replace(/<[^>]*>/g, '').trim() !== ''
    || (typeof html === 'string' && /<img/i.test(html));

/** Latest saved template for a document type (matched on documentName), or null. Never throws. */
export async function loadTemplateForType(db, documentType) {
    if (!db || !documentType) return null;
    try {
        const snap = await getDocs(query(
            collection(db, 'documentTemplates'),
            where('documentName', '==', documentType),
            limit(1)
        ));
        if (snap.empty) return null;
        const d = snap.docs[0];
        const data = d.data();
        return hasContent(data.html) ? { id: d.id, ...data } : null;
    } catch (err) {
        console.warn('doctemplate: could not load template for', documentType, err);
        return null;
    }
}

// ---------------------------------------------
// Values
// ---------------------------------------------
const pickStr = (obj, keys) => {
    for (const k of keys) {
        const v = obj?.[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
};

// The engine reads resident.birthday / resident.address only. Profiles in this project also use
// other keys (the built-in certificate already copes with them), so map them to the engine's names.
function normalizeResident(resident) {
    const res = { ...(resident || {}) };
    if (!res.birthday) {
        const b = res.birthDate ?? res.dateOfBirth ?? res.dob ?? res.birthdate;
        if (b) res.birthday = b;
    }
    if (!(typeof res.address === 'string' && res.address.trim())) {
        const a = pickStr(res, ['homeAddress', 'fullAddress', 'streetAddress']);
        if (a) res.address = a;
    }
    return res;
}

const CONTACT_ALIASES = ['resident.contact', 'resident.phone', 'resident.phoneNumber',
                         'resident.mobile', 'resident.mobileNumber'];

/**
 * engine values + admin corrections → values used to fill the template.
 * `overrides` is a docOverrides-shaped object (only the corrected fields).
 */
export function applyOverridesToValues(values, overrides) {
    const out = { ...(values || {}) };
    const o = overrides || {};
    const text = (k) => (typeof o[k] === 'string' && o[k].trim() !== '') ? o[k].trim() : '';
    const setIfPresent = (k, v) => { if (k in out) out[k] = v; };

    const name = text('residentName');
    if (name) out.resident_name = name;

    const age = text('age');
    if (age) { out.age = age; setIfPresent('resident.age', age); }

    const occ = text('occupation');
    if (occ) { out.occupation = occ; setIfPresent('resident.occupation', occ); }

    const addr = text('address');
    if (addr) { out.address = addr; setIfPresent('resident.address', addr); }

    const bday = text('birthday');
    if (bday) { out.birthdate = formatDob(bday) || bday; setIfPresent('resident.birthday', bday); }

    const contact = text('contactNumber');
    if (contact) {
        out['resident.contactNumber'] = contact;
        CONTACT_ALIASES.forEach(k => setIfPresent(k, contact));
    }
    return out;
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usesField = (html, key) =>
    new RegExp(`data-field=["']${key.replace('.', '\\.')}["']|\\{${key.replace('.', '\\.')}\\}`).test(html || '');

/**
 * The built-in certificate can print an optional "Date of Birth / Contact No." line and an
 * "Additional Remarks" paragraph. A template has no spot for those, so they are appended after the
 * template content — only when the admin switched them on / wrote them, and the template doesn't
 * already show that field through its own placeholder.
 */
function buildExtraHtml(overrides, vals, templateHtml) {
    const o = overrides || {};
    const parts = [];
    if (o.showBirthday === true && !usesField(templateHtml, 'birthdate')) {
        const dob = (typeof o.birthday === 'string' && o.birthday.trim()) ? (formatDob(o.birthday.trim()) || o.birthday.trim())
                  : (vals.birthdate && vals.birthdate !== '—' ? vals.birthdate : '');
        if (dob) parts.push(`Date of Birth: ${dob}`);
    }
    if (o.showContact === true &&
        !['resident.contactNumber', ...CONTACT_ALIASES].some(k => usesField(templateHtml, k))) {
        const c = vals['resident.contactNumber']
            || CONTACT_ALIASES.map(k => vals[k]).find(Boolean) || '';
        if (c) parts.push(`Contact No.: ${c}`);
    }
    const remarks = (typeof o.remarks === 'string') ? o.remarks.trim() : '';

    let html = '';
    if (parts.length) html += `<p style="text-align:center;margin:12px 0 0;">${escHtml(parts.join('  •  '))}</p>`;
    if (remarks)      html += `<p style="text-align:center;margin:8px 0 0;">${escHtml(remarks)}</p>`;
    return html;
}

/**
 * paintDocument() hands the painter the *effective* values (base + overrides). Turn them back into
 * an overrides object by keeping only what differs from docoverrides' own base values — so fields the
 * admin did not touch keep the template engine's natural value instead of docoverrides' simpler base.
 */
export function overridesFromPaintValues(values, base) {
    const v = values || {};
    const ov = {};
    TEXT_KEYS.forEach(k => {
        const s = String(v[k] ?? '').trim();
        if (s && s !== '—' && s !== String(base?.[k] ?? '')) ov[k] = s;
    });
    if (v.showBirthday) ov.showBirthday = true;
    if (v.showContact)  ov.showContact = true;
    const r = String(v.remarks ?? '').trim();
    if (r) ov.remarks = r;
    return ov;
}

// ---------------------------------------------
// The view
// ---------------------------------------------
let registeredPainter = null;   // the painter this module last registered (so hide() never clears another)

/**
 * @param {HTMLElement} container  element that receives the pages (callers may reassign view.container)
 */
export function createTemplateView(container) {
    const view = { container, active: false, show, hide, print, refresh };
    let st = null;              // state of the request currently shown
    let seq = 0;                // newest render wins
    let timer = null;           // debounce for live edits
    let pendingOv = null;       // overrides waiting in the debounce
    let myPainter = null;

    // Synchronous part of a render: values + final HTML for the given overrides
    function compose(ov) {
        const vals = applyOverridesToValues(st.baseVals, ov);
        const opts = { qrDataUrl: st.qr, baseUrl: document.baseURI };
        const html = renderTemplateHtml(st.template.html, vals, opts) + buildExtraHtml(ov, vals, st.template.html);
        return { vals, html, opts: { ...opts, values: vals } };
    }

    async function render(ov) {
        const mine = st, my = ++seq;
        const c = compose(ov);
        const built = await buildPages(c.html, mine.settings, c.opts);
        if (my !== seq || st !== mine || !view.active) return false;     // superseded or hidden meanwhile
        view.container.innerHTML = `<style>${built.css}</style>${built.html}`;
        mine.vals = c.vals;
        mine.renderedHtml = c.html;
        mine.opts = c.opts;
        return true;
    }

    function registerPainter() {
        myPainter = (values) => {
            if (!view.active || !st) return;
            pendingOv = overridesFromPaintValues(values, st.docBase);
            clearTimeout(timer);
            timer = setTimeout(() => {
                const ov = pendingOv; pendingOv = null;
                if (ov && view.active && st) render(ov).catch(e => console.warn('doctemplate: live repaint failed', e));
            }, 120);
        };
        registeredPainter = myPainter;
        setTemplatePainter(myPainter);
    }

    /**
     * @param {{template:object, request:object, resident?:object, overrides?:object}} p
     * Resolves true when painted. Throws if the template can't be rendered — callers then fall back
     * to the built-in certificate (adminrequests.js does this).
     */
    async function show({ template, request, resident, overrides } = {}) {
        if (!template || !hasContent(template.html)) throw new Error('Template has no content');
        clearTimeout(timer); pendingOv = null;

        const req = request || {};
        const res = normalizeResident(resident);
        const mine = st = {
            template,
            request: req,
            settings: normalizePageSettings(template.pageSettings || DEFAULT_PAGE_SETTINGS),
            // approvedAt is only a fallback for the issue date while readyAt isn't set yet
            baseVals: buildValues({ ...req, readyAt: req.readyAt || req.approvedAt || null }, res),
            docBase: baseValues(req, res),
            qr: makeQrDataUrl(req.qrContent || req.referenceNo || 'NO-QR', 100)
        };
        view.active = true;
        view.container.style.display = '';
        registerPainter();

        try {
            await render(overrides || {});
        } catch (err) {
            if (st === mine) hide();
            throw err;
        }
        return true;
    }

    /** Re-render the current request with different overrides (optional helper). */
    async function refresh(overrides) {
        if (!view.active || !st) return false;
        clearTimeout(timer); pendingOv = null;
        return render(overrides || {});
    }

    function hide() {
        view.active = false;
        seq++;
        clearTimeout(timer); pendingOv = null;
        st = null;
        if (myPainter && registeredPainter === myPainter) { setTemplatePainter(null); registeredPainter = null; }
        myPainter = null;
        const c = view.container;
        if (c) { c.style.display = 'none'; c.innerHTML = ''; }
    }

    /** Prints exactly the pages shown (including saved corrections). Call straight from a click. */
    function print(title = 'Barangay Document') {
        if (!view.active || !st) return;
        let html = st.renderedHtml, opts = st.opts;
        if (pendingOv) {                       // an edit is still in the debounce: print that, not the older page
            const c = compose(pendingOv);
            html = c.html; opts = c.opts;
        }
        return printTemplateHtml(html, st.settings, title, opts);
    }

    return view;
}