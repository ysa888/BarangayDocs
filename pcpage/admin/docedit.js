// =============================================
// docedit.js
// Handles: Admin document preview editing
// Loaded by: admin_pending_requests.html, admin_all_requests.html
//
// What it does
//   • Adds an "Edit Document" button + edit panel to the EXISTING
//     #doc-preview-modal (no second modal, no new design language).
//   • Live-previews corrections on the certificate while typing.
//   • Saves corrections to requests/{id}.docOverrides ONLY.
//     residents/{uid} is read, never written.
//
// How it gets the request
//   1. Preferred – call once from populateAndShowDocModal():
//        window.BarangayDocEditor?.attach(requestId, requestData);
//   2. Fallback – with no changes to adminrequests.js, it watches the
//      modal opening and finds the request by its reference number.
// =============================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, getDocs, collection, query, where, limit,
    updateDoc, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

import {
    DEFAULT_ADDRESS, FIELD_EL, baseValues, effectiveValues, buildOverrides,
    paintDocument, profileAddress, setTemplatePainter, setBoxPainter,
    FIELD_ALIASES, normKey, keyForAlias, INLINE_KEYS
} from "./docoverrides.js";
import { applyEdits, resetEdits, readRun } from "./doctextedit.js";
import * as paper from "./docpaper.js";

// ---------------------------------------------
// Firebase (reuses the existing default app if adminrequests.js
// already created it; identical config otherwise)
// ---------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain: "barangaydocs-df957.firebaseapp.com",
    projectId: "barangaydocs-df957",
    storageBucket: "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId: "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId: "G-YG0Y575BRD"
};
const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Statuses in which the document may still be corrected.
// ready / released documents already carry an issued QR + code, so they are locked.
const EDITABLE_STATUSES = ['pending', 'processing', 'approved'];
const LOCKED_STATUSES   = ['ready', 'released'];

const $ = (id) => document.getElementById(id);

const S = {
    active: false,
    requestId: null,
    request: null,
    resident: {},
    base: null,
    saved: {},          // overrides currently stored in Firestore
    editing: false,
    edits: new Map(),   // free-text edits made on the paper (run number → {i, from, to})
    snapshot: '',       // JSON of overrides when edit mode started (dirty check)
    usedKeys: null,     // FIELDS keys the saved template uses (null = no template → show all)
    zoom: 1,
    prevMaxWidth: ''
};

// ---------------------------------------------
// UI injection
// ---------------------------------------------
const FIELDS = [
    { key: 'residentName',  label: 'Full Name',      type: 'text', max: 120 },
    { key: 'age',           label: 'Age',            type: 'text', max: 3 },
    { key: 'occupation',    label: 'Occupation',     type: 'text', max: 80 },
    { key: 'address',       label: 'Address',        type: 'text', max: 200, wide: true },
    { key: 'birthday',      label: 'Date of Birth',  type: 'date', toggle: 'showBirthday' },
    { key: 'contactNumber', label: 'Contact Number', type: 'text', max: 30, toggle: 'showContact' }
];

function injectUI() {
    const modal = $('doc-preview-modal');
    if (!modal || $('dp-edit')) return;

    // --- styles (scoped with dpe- / dp-edit prefixes) ---
    const style = document.createElement('style');
    style.id = 'dp-edit-style';
    style.textContent = `
    #dp-edit:disabled, #dp-print:disabled { opacity:.5; cursor:not-allowed; }
    .dpe-badge { display:none; margin-left:10px; padding:2px 9px; border-radius:20px; background:#FFE69C; color:#664D03;
                 font-family:'Nunito',sans-serif; font-size:10px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; vertical-align:middle; }
    .dpe-badge.show { display:inline-block; }
    .dpe-panel { background:#fff; border-bottom:1.5px solid var(--border,#D0DCF0); padding:14px 20px; flex-shrink:0; max-height:42vh; overflow-y:auto; }
    /* Side by side: form on the left, live document on the right */
    .dpe-split { display:flex; flex:1; min-height:0; align-items:stretch; }
    .dpe-split > .doc-preview-scroll { flex:1; min-width:0; }
    .dpe-split { position:relative; }
    .dpe-split > .dpe-panel { flex:0 0 min(380px,36%); width:min(380px,36%); max-height:none; border-bottom:0; border-right:1.5px solid var(--border,#D0DCF0); padding:18px 20px; }
    .dpe-split .dpe-field label { font-size:12px; margin-bottom:6px; }
    .dpe-split .dpe-field input:not([type=checkbox]), .dpe-split .dpe-field textarea { font-size:14px; padding:9px 11px; border-radius:9px; }
    .dpe-split .dpe-field textarea { min-height:72px; }
    .dpe-split .dpe-hint { font-size:12px; }
    .dpe-split .dpe-inline { font-size:13px; }
    .dpe-split .dpe-btn { height:42px; font-size:13px; }
    .dpe-split > .doc-preview-scroll { display:block; overflow:auto; }
    .dpe-split #doc-preview-template, .dpe-split #doc-preview-content { margin-left:auto; margin-right:auto; }
    .dpe-pan { cursor:grab; }
    .dpe-pan.dragging { cursor:grabbing; user-select:none; -webkit-user-select:none; }
    .dpe-zoom { position:absolute; top:10px; right:24px; z-index:6; display:flex; align-items:center; gap:4px; padding:5px; background:rgba(255,255,255,.95);
                border:1.5px solid var(--border,#D0DCF0); border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.15); font-family:'Nunito',sans-serif; }
    .dpe-zoom button { min-width:34px; height:34px; padding:0 10px; border:1.5px solid var(--border,#D0DCF0); border-radius:8px; background:#fff; color:var(--primary,#1B3A6B);
                       font-family:'Nunito',sans-serif; font-size:16px; font-weight:800; cursor:pointer; }
    .dpe-zoom button:hover { background:#EEF2F9; }
    .dpe-zoom .pct { min-width:48px; text-align:center; font-size:12px; font-weight:800; color:var(--text-sub,#5A6A85); }
    .dpe-zoom .tip { font-size:11px; font-weight:700; color:var(--text-sub,#5A6A85); padding:0 6px; white-space:nowrap; }
    @media (max-width:1100px) { .dpe-zoom .tip { display:none; } }
    .dpe-split .dpe-grid { grid-template-columns:1fr; }
    .dpe-field[hidden] { display:none; }
    .dpe-panel[hidden] { display:none; }
    /* Click-to-edit fields on the paper */
    .dpe-inline-field { outline:1px dashed #4FC3F7; background:rgba(79,195,247,.12); cursor:text; }
    .dpe-inline-field:focus { outline:2px solid #1B3A6B; background:#fff; }
    /* Any other text on the paper */
    .dpe-tn { cursor:text; }
    .dpe-tn:hover { outline:1px dashed #4FC3F7; background:rgba(79,195,247,.10); }
    .dpe-tn:focus { outline:2px solid #1B3A6B; background:#fff; }
    /* Text-box toolbar */
    .dpe-tb-tools { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px; }
    .dpe-tb-tools[hidden] { display:none; }
    #dp-edit-panel .dpe-tb-tools select { height:34px; border:1.5px solid var(--border,#D0DCF0); border-radius:8px; background:#fff; padding:0 6px; font-family:'Nunito',sans-serif; font-size:12px; font-weight:700; }
    #dp-edit-panel .dpe-tb-tools input[type=number] { width:62px; height:34px; padding:0 6px; }
    #dp-edit-panel .dpe-tb-tools input[type=color] { width:38px; height:34px; padding:2px; cursor:pointer; }
    .dpe-tb-tools button { min-width:34px; height:34px; padding:0 8px; border:1.5px solid var(--border,#D0DCF0); border-radius:8px; background:#fff; color:var(--primary,#1B3A6B); font-family:'Nunito',sans-serif; font-size:13px; font-weight:800; cursor:pointer; }
    .dpe-tb-tools button.on { background:#1B3A6B; color:#fff; border-color:#1B3A6B; }
    .dpe-tb-tools button.del { color:#DC3545; border-color:#F5C6CB; }
    .dpe-note { font-size:12px; font-weight:700; color:#664D03; background:#FFF3CD; border-radius:8px; padding:8px 12px; margin-bottom:12px; }
    .dpe-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 12px; }
    .dpe-field { display:flex; flex-direction:column; min-width:0; }
    .dpe-field.wide { grid-column:1 / -1; }
    .dpe-field label { font-size:10px; font-weight:800; color:var(--text-sub,#5A6A85); text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px; }
    .dpe-field input, .dpe-field textarea { border:1.5px solid var(--border,#D0DCF0); border-radius:8px; background:var(--bg,#F0F4FA); padding:8px 10px;
                 font-family:'Nunito',sans-serif; font-size:13px; font-weight:700; color:var(--text-main,#1B2A4A); outline:none; width:100%; }
    .dpe-field input:focus, .dpe-field textarea:focus { border-color:var(--primary,#1B3A6B); background:#fff; }
    .dpe-field textarea { resize:vertical; min-height:60px; }
    .dpe-hint { font-size:10px; font-weight:700; color:#B26A00; margin-top:3px; min-height:12px; }
    .dpe-inline { display:flex; align-items:center; gap:6px; margin-top:4px; font-size:11px; font-weight:700; color:var(--text-sub,#5A6A85); }
    .dpe-inline input { width:auto; }
    .dpe-link { background:none; border:none; padding:0; margin-top:4px; font-family:'Nunito',sans-serif; font-size:11px; font-weight:800; color:var(--primary,#1B3A6B); cursor:pointer; text-align:left; text-decoration:underline; }
    .dpe-actions { display:flex; gap:8px; margin-top:12px; align-items:center; }
    .dpe-actions .spacer { flex:1; }
    .dpe-btn { height:38px; padding:0 16px; border-radius:9px; font-family:'Nunito',sans-serif; font-size:12px; font-weight:800; cursor:pointer; border:2px solid var(--border,#D0DCF0); background:transparent; color:var(--text-sub,#5A6A85); }
    .dpe-btn.save { background:var(--green,#28A745); border-color:var(--green,#28A745); color:#fff; }
    .dpe-btn:disabled { opacity:.6; cursor:wait; }
    .dpe-msg { font-size:12px; font-weight:800; color:var(--red,#DC3545); margin-top:8px; display:none; }
    /* Highlight corrected values — scoped to the modal wrapper so it never reaches the print window */
    .dp-editing #doc-preview-content .dp-changed { background:#FFF3B0; outline:1px dashed #B26A00; }
    @media (max-width:760px) { .dpe-split { flex-direction:column; } .dpe-split > .dpe-panel { flex:0 0 auto; width:auto; max-height:42vh; border-right:0; border-bottom:1.5px solid var(--border,#D0DCF0); } }
    @media (max-width:560px) { .dpe-grid { grid-template-columns:1fr; } .dpe-actions { flex-wrap:wrap; } }
    `;
    document.head.appendChild(style);

    // --- Edit button in the existing toolbar ---
    const printBtn = $('dp-print');
    const editBtn = document.createElement('button');
    editBtn.id = 'dp-edit';
    editBtn.className = 'dp-btn dp-btn-primary';
    editBtn.textContent = '✎ Edit Document';
    editBtn.style.display = 'none';
    if (printBtn) printBtn.parentNode.insertBefore(editBtn, printBtn);

    // --- "Edited" badge next to the toolbar label ---
    const label = modal.querySelector('.doc-preview-label');
    if (label) {
        const badge = document.createElement('span');
        badge.id = 'dpe-badge';
        badge.className = 'dpe-badge';
        badge.textContent = 'Edited';
        label.appendChild(badge);
    }

    // --- Edit panel (between toolbar and certificate) ---
    const panel = document.createElement('div');
    panel.id = 'dp-edit-panel';
    panel.className = 'dpe-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <div class="dpe-note">Changes apply to this document only. The resident's profile is not modified.<div style="font-weight:700;margin-top:3px;">Tip: click any text on the paper to edit it directly.</div><div id="dpe-usednote" style="font-weight:600;margin-top:3px;"></div></div>
        <div class="dpe-grid">
            ${FIELDS.map(f => `
            <div class="dpe-field${f.wide ? ' wide' : ''}" data-key="${f.key}">
                <label for="dpe-${f.key}">${f.label}</label>
                <input id="dpe-${f.key}" type="${f.type}" ${f.max ? `maxlength="${f.max}"` : ''} autocomplete="off">
                <div class="dpe-hint" id="dpe-hint-${f.key}"></div>
                ${f.toggle ? `<label class="dpe-inline" style="text-transform:none;letter-spacing:0;">
                    <input type="checkbox" id="dpe-${f.toggle}"> Show on document</label>` : ''}
                ${f.key === 'address' ? `<button type="button" class="dpe-link" id="dpe-use-profile-address" style="display:none;">Use address from resident profile</button>` : ''}
            </div>`).join('')}
            <div class="dpe-field wide" data-key="remarks">
                <label for="dpe-remarks">Additional Remarks (printed on the document)</label>
                <textarea id="dpe-remarks" maxlength="500" placeholder="Optional"></textarea>
            </div>
            <div class="dpe-field wide" data-key="textboxes">
                <label>Text boxes</label>
                <div><button type="button" class="dpe-btn" id="dpe-tb-add">＋ Add text box</button></div>
                <div class="dpe-tb-tools" id="dpe-tb-tools" hidden>
                    <select id="dpe-tb-font">${paper.FONT_LABELS.map(f => `<option value="${f}">${f}</option>`).join('')}</select>
                    <input type="number" id="dpe-tb-size" min="6" max="96" title="Font size">
                    <button type="button" id="dpe-tb-b" data-fmt="bold" title="Bold"><b>B</b></button>
                    <button type="button" id="dpe-tb-i" data-fmt="italic" title="Italic"><i>I</i></button>
                    <button type="button" id="dpe-tb-u" data-fmt="underline" title="Underline"><u>U</u></button>
                    <button type="button" data-align="left" title="Align left">⬅</button>
                    <button type="button" data-align="center" title="Center">↔</button>
                    <button type="button" data-align="right" title="Align right">➡</button>
                    <input type="color" id="dpe-tb-color" title="Text color">
                    <button type="button" class="del" id="dpe-tb-del" title="Delete this text box">Delete</button>
                </div>
                <div class="dpe-hint" style="color:#6B7A99;">Click a box to type. Drag its “⠿ Move” bar to reposition; drag the corner to resize. Formatting applies to the whole box.</div>
            </div>
        </div>
        <div class="dpe-msg" id="dpe-msg"></div>
        <div class="dpe-actions">
            <button type="button" class="dpe-btn" id="dpe-reset">Reset to original</button>
            <span class="spacer"></span>
            <button type="button" class="dpe-btn" id="dpe-cancel">Cancel</button>
            <button type="button" class="dpe-btn save" id="dpe-save">Save Changes</button>
        </div>`;
    const scroll = modal.querySelector('.doc-preview-scroll');
    scroll.parentNode.insertBefore(panel, scroll);

    // --- wiring ---
    editBtn.addEventListener('click', enterEdit);
    panel.addEventListener('input', onFormInput);
    $('dpe-reset').addEventListener('click', resetToOriginal);
    $('dpe-cancel').addEventListener('click', () => cancelEdit(true));
    $('dpe-save').addEventListener('click', saveEdits);
    $('dpe-use-profile-address').addEventListener('click', () => {
        const a = profileAddress(S.resident);
        if (a) { $('dpe-address').value = a; onFormInput(); }
    });

    // --- text-box toolbar ---
    $('dpe-tb-add').addEventListener('click', () => paper.addBox());
    $('dpe-tb-font').addEventListener('change', (e) => paper.updateSelected({ font: e.target.value }));
    $('dpe-tb-size').addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        if (n >= 6 && n <= 96) paper.updateSelected({ size: n });
    });
    $('dpe-tb-color').addEventListener('input', (e) => paper.updateSelected({ color: e.target.value }));
    panel.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('click', () => {
        const s = paper.getSelected();
        if (s) paper.updateSelected({ [btn.dataset.fmt]: !s[btn.dataset.fmt] });
    }));
    panel.querySelectorAll('[data-align]').forEach(btn => btn.addEventListener('click', () => paper.updateSelected({ align: btn.dataset.align })));
    $('dpe-tb-del').addEventListener('click', () => paper.deleteSelected());

    // --- edit directly on the paper (works on the built-in certificate and on template fields) ---
    scroll.addEventListener('focusin', (e) => {
        const el = e.target.closest?.('[data-dpe-key]');
        if (!el || !S.editing) return;
        if ((el.textContent || '').trim() === '—') {            // empty placeholder → replace, don't append
            const r = document.createRange(); r.selectNodeContents(el);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        }
    });
    scroll.addEventListener('input', (e) => {
        const run = e.target.closest?.('.dpe-tn');
        if (run && S.editing) {                                  // free text anywhere on the paper
            const r = readRun(run);
            if (r.to === r.from) S.edits.delete(r.i); else S.edits.set(r.i, r);
            return;
        }
        const el = e.target.closest?.('[data-dpe-key]');
        if (!el || !S.editing) return;
        const key = el.dataset.dpeKey;
        const f = FIELDS.find(x => x.key === key);
        let v = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (f?.max) v = v.slice(0, f.max);
        $(`dpe-${key}`).value = v;
        syncHints();                                            // repaint happens on blur so the caret isn't lost
    });
    scroll.addEventListener('focusout', (e) => {
        if (!S.editing || !e.target.closest?.('[data-dpe-key]')) return;
        // moving straight into another editable spot: don't repaint (it would drop the click)
        if (e.relatedTarget?.closest?.('.dpe-tn, [data-dpe-key], .dpe-tb-body')) return;
        onFormInput();
    });
    scroll.addEventListener('keydown', (e) => {
        const el = e.target.closest?.('.dpe-tn, [data-dpe-key]');
        if (el && e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
    scroll.addEventListener('paste', (e) => {
        if (!e.target.closest?.('.dpe-tn, [data-dpe-key]')) return;
        e.preventDefault();
        const t = ((e.clipboardData || window.clipboardData)?.getData('text') || '').replace(/\s+/g, ' ');
        document.execCommand('insertText', false, t);
    });
    // clicking empty paper deselects the current text box
    scroll.addEventListener('pointerdown', (e) => { if (S.editing && !e.target.closest('.dpe-tb')) paper.select(null); }, true);

    // Keep the text-box layer and the click-to-edit marks in step with whatever the preview shows
    // (the template engine rewrites its container on every repaint).
    new MutationObserver((recs) => {
        if (recs.every(m => paper.contains(m.target))) return;
        syncPaper();
    }).observe(scroll, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });

    // Closing the preview with unsaved edits asks first (capture → runs before the page's own handler)
    $('dp-close')?.addEventListener('click', (e) => {
        if (S.editing && isDirty() && !window.confirm('Discard your unsaved changes to this document?')) {
            e.stopImmediatePropagation();
        }
    }, true);

    // Fallback: detect the modal opening / closing
    new MutationObserver(() => {
        const open = modal.classList.contains('show');
        if (open && !S.active) attachFromDom();
        if (!open && S.active) teardown();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
}


// ---------------------------------------------
// Which fields does the saved template use?
// Reads documentTemplates/{docId}.html and looks at its {placeholders} / data-field spans.
// Only those fields are offered in the edit form (no template → all fields, as before).
// ---------------------------------------------
// (FIELD_ALIASES / normKey / keyForAlias / INLINE_KEYS now live in docoverrides.js so doctemplate.js shares them)

function extractTemplateKeys(html) {
    const keys = new Set();
    const addAll = (re, str) => { let m; while ((m = re.exec(str))) keys.add(normKey(m[1])); };
    addAll(/data-field="([^"]+)"/g, html);
    addAll(/\{\{?\s*([A-Za-z0-9_.\-]+)\s*\}?\}/g, html.replace(/<[^>]+>/g, ''));
    return keys;
}

async function loadUsedFields(documentType) {
    try {
        const snap = await getDocs(query(collection(db, 'documentTemplates'), where('documentName', '==', documentType), limit(1)));
        if (snap.empty) return null;
        const html = snap.docs[0].data().html || '';
        if (!html) return null;
        const keys = extractTemplateKeys(html);
        const used = new Set();
        Object.entries(FIELD_ALIASES).forEach(([fieldKey, aliases]) => {
            if (aliases.some(a => keys.has(normKey(a)))) used.add(fieldKey);
        });
        // Placeholders matched nothing we can edit → don't hide everything
        const editable = [...used].filter(k => k !== 'remarks');
        return editable.length ? used : null;
    } catch (e) {
        console.warn('docedit: could not read template fields', e);
        return null;
    }
}

function applyFieldVisibility() {
    const used = S.usedKeys;
    document.querySelectorAll('#dp-edit-panel .dpe-field[data-key]').forEach(n => {
        const k = n.dataset.key;
        // remarks is always available; "show on document" toggles live inside their field
        n.hidden = !!used && k !== 'remarks' && k !== 'textboxes' && !used.has(k);
    });
    const note = document.getElementById('dpe-usednote');
    if (note) note.textContent = used ? 'Showing only the fields used by this document\\u2019s template.' : '';
}

// ---------------------------------------------
// Attach to a request
// ---------------------------------------------
async function attach(requestId, cachedData) {
    if (!requestId) return;
    S.active = true;
    S.requestId = requestId;
    S.editing = false;
    resetExtras();
    paper.setBoxes([]);
    setEditButton('hidden');

    let r = cachedData || {};
    try {
        const snap = await getDoc(doc(db, 'requests', requestId));
        if (snap.exists()) r = snap.data();
    } catch (e) { console.warn('docedit: could not refresh request', e); }

    let resident = {};
    let residentOk = false;
    if (r.uid) {
        try {
            const rs = await getDoc(doc(db, 'residents', r.uid));
            if (rs.exists()) { resident = rs.data(); residentOk = true; }
        } catch (e) { console.warn('docedit: could not read resident profile', e); }
    }

    if (S.requestId !== requestId || !S.active) return; // modal moved on while loading

    S.request  = r;
    S.resident = resident;
    S.base     = baseValues(r, resident);
    S.saved    = r.docOverrides || {};
    S.usedKeys = await loadUsedFields(r.documentType);
    if (S.requestId !== requestId || !S.active) return;

    // If the profile couldn't be read, trust what the page already painted for age/occupation
    if (!residentOk) {
        S.base.age        = $('dp-age')?.textContent        || S.base.age;
        S.base.occupation = $('dp-occupation')?.textContent || S.base.occupation;
    }

    paintDocument(effectiveValues(S.base, S.saved));
    syncPaper();
    updateBadge();

    if (EDITABLE_STATUSES.includes(r.status))      setEditButton('enabled');
    else if (LOCKED_STATUSES.includes(r.status))   setEditButton('locked');
    else                                           setEditButton('hidden');
}

// Fallback when attach() was not called by adminrequests.js
async function attachFromDom() {
    S.active = true;
    resetExtras();
    const txt = (id) => ($(id)?.textContent || '').trim();
    let ref = '';
    for (let i = 0; i < 15; i++) {            // wait up to ~1.5s for the page to fill the modal
        ref = txt('dp-ref-no');
        if (ref && ref !== '—') break;
        await new Promise(r => setTimeout(r, 100));
    }
    if (!ref || ref === '—') return;

    try {
        const snap = await getDocs(query(collection(db, 'requests'), where('referenceNo', '==', ref), limit(10)));
        // Reference numbers are random, so de-duplicate using the other values shown on the certificate
        const title = txt('dp-cert-title'), name = txt('dp-name');
        const matches = snap.docs.filter(d => d.data().documentType === title && d.data().residentName === name);
        if (matches.length !== 1) { setEditButton('hidden'); return; }
        await attach(matches[0].id, matches[0].data());
    } catch (e) {
        console.warn('docedit: could not locate request for preview', e);
    }
}

function teardown() {
    S.active = false;
    S.requestId = null;
    // Drop the template painter registered for this preview, so a later preview (or one with no
    // template) can never be repainted with an older/stale template. The next preview that shows a
    // template registers its own painter again when it renders.
    setTemplatePainter(null);
    if (S.editing) exitEditUI();
    resetExtras();
    paper.setBoxes([]);
    paper.attachTo(null);
    // put the built-in certificate's text back to normal so one request's edits never show on the next
    const legacy = $('doc-preview-content');
    if (legacy) resetEdits(legacy, legacySkip);
    $('dpe-badge')?.classList.remove('show');
    setEditButton('hidden');
}

// The page's own populate code doesn't know about the new elements, so clear them
// whenever a different request is shown (prevents one request's remarks leaking into the next)
function resetExtras() {
    const a = $('dp-address'); if (a) a.textContent = DEFAULT_ADDRESS;
    const e = $('dp-extra-line'); if (e) { e.textContent = ''; e.style.display = 'none'; }
    const r = $('dp-remarks');    if (r) { r.textContent = '';  r.style.display = 'none'; }
}

// ---------------------------------------------
// Edit mode
// ---------------------------------------------
function setEditButton(mode) {
    const b = $('dp-edit');
    if (!b) return;
    if (mode === 'hidden') { b.style.display = 'none'; return; }
    b.style.display = '';
    b.disabled = mode === 'locked';
    b.title = mode === 'locked' ? 'Issued documents already have a QR code and can no longer be edited.' : '';
}

function fillForm(values) {
    FIELDS.forEach(f => { $(`dpe-${f.key}`).value = values[f.key] ?? ''; });
    $('dpe-showBirthday').checked = !!values.showBirthday;
    $('dpe-showContact').checked  = !!values.showContact;
    $('dpe-remarks').value        = values.remarks || '';
    paper.setBoxes(values.textBoxes || []);
    S.edits = new Map((values.textEdits || []).map(e => [e.i, { ...e }]));
}

function readForm() {
    const f = {};
    FIELDS.forEach(x => { f[x.key] = $(`dpe-${x.key}`).value; });
    f.showBirthday = $('dpe-showBirthday').checked;
    f.showContact  = $('dpe-showContact').checked;
    f.remarks      = $('dpe-remarks').value;
    f.textBoxes    = paper.getBoxes();
    f.textEdits    = [...S.edits.values()].sort((a, b) => a.i - b.i);
    return f;
}

const readOverrides = () => buildOverrides(S.base, readForm());
const isDirty = () => JSON.stringify(readOverrides()) !== S.snapshot;

function enterEdit() {
    if (!S.base) return;
    fillForm(effectiveValues(S.base, S.saved));
    S.snapshot = JSON.stringify(readOverrides());
    S.editing = true;

    $('doc-preview-modal').querySelector('.doc-preview-wrapper').classList.add('dp-editing');
    applyFieldVisibility();
    enterSplit();
    $('dp-edit-panel').hidden = false;
    $('dp-edit').style.display = 'none';
    const p = $('dp-print');
    if (p) { p.disabled = true; p.title = 'Save or cancel your changes before printing.'; }
    $('dpe-use-profile-address').style.display = profileAddress(S.resident) ? '' : 'none';
    showMsg('');
    paper.setEditing(true);
    syncBoxTools(null);
    syncPaper();
    refreshPreview();
}

// ---------------------------------------------
// Text-box layer + click-to-edit marks on the paper
// ---------------------------------------------
// The element the admin is looking at: the admin-made template when shown, else the built-in certificate
function currentHost() {
    const t = $('doc-preview-template'), c = $('doc-preview-content');
    if (t && t.style.display !== 'none') return t;
    return c || null;
}

// Built-in certificate: parts that are driven by the form fields are not free-text (edited via the field)
const LEGACY_SKIP_IDS = ['dp-name', 'dp-age', 'dp-occupation', 'dp-address', 'dp-extra-line', 'dp-remarks', 'dp-qr-wrap'];
function legacySkip(n) {
    const el = n.nodeType === 3 ? n.parentElement : n;
    return LEGACY_SKIP_IDS.some(id => { const s = $(id); return !!s && s.contains(el); });
}

function legacyVisible() {
    const t = $('doc-preview-template');
    return !!$('doc-preview-content') && !(t && t.style.display !== 'none');
}

// Built-in certificate: apply the saved/typed free-text edits to the live paper
function paintLegacyText(v) {
    if (!legacyVisible()) return;
    applyEdits($('doc-preview-content'), v.textEdits || [], { tag: !!v.editTags, skipNode: legacySkip });
    if (v.editTags) markInline();
}

function setEditable(el, key) {
    if (!el) return;
    el.dataset.dpeKey = key;
    el.classList.add('dpe-inline-field');
    el.spellcheck = false;
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
}

function markInline() {
    // every other piece of text on the paper (tagged by doctextedit.js)
    document.querySelectorAll('#doc-preview-modal .dpe-tn').forEach(el => {
        el.spellcheck = false;
        el.contentEditable = 'plaintext-only';
        if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    });
    const t = $('doc-preview-template'), c = $('doc-preview-content');
    if (c && (!t || t.style.display === 'none')) {
        Object.entries(FIELD_EL).forEach(([key, id]) => setEditable($(id), key));
    }
    if (t && t.style.display !== 'none') {
        t.querySelectorAll('[data-field]').forEach(el => {
            const key = keyForAlias(el.dataset.field);
            if (key && INLINE_KEYS.includes(key)) setEditable(el, key);
        });
    }
}

function clearInline() {
    document.querySelectorAll('.dpe-tn').forEach(el => el.removeAttribute('contenteditable'));
    document.querySelectorAll('[data-dpe-key]').forEach(el => {
        el.removeAttribute('contenteditable');
        el.classList.remove('dpe-inline-field');
        delete el.dataset.dpeKey;
    });
}

function syncPaper() {
    paper.attachTo(S.active ? currentHost() : null);
    if (S.editing) markInline();
}

// Show the toolbar for the selected text box
function syncBoxTools(sel) {
    const tools = $('dpe-tb-tools');
    if (!tools) return;
    tools.hidden = !sel || !S.editing;
    if (!sel) return;
    $('dpe-tb-font').value = sel.font;
    if (document.activeElement !== $('dpe-tb-size')) $('dpe-tb-size').value = sel.size;
    $('dpe-tb-color').value = sel.color;
    tools.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('on', !!sel[b.dataset.fmt]));
    tools.querySelectorAll('[data-align]').forEach(b => b.classList.toggle('on', sel.align === b.dataset.align));
}


// ---------------------------------------------
// Zoom + hand-drag panning for the live document (edit mode only)
// ---------------------------------------------
const ZOOM_MIN = 0.25, ZOOM_MAX = 3, ZOOM_STEP = 1.2;
const docScroll   = () => $('doc-preview-modal')?.querySelector('.doc-preview-scroll');
const zoomTargets = () => ['doc-preview-template', 'doc-preview-content'].map($).filter(Boolean);

function applyZoom() {
    zoomTargets().forEach(n => { n.style.zoom = String(S.zoom); });
    const l = $('dpe-zoom-pct'); if (l) l.textContent = Math.round(S.zoom * 100) + '%';
}

function setZoom(z, cx, cy) {
    const sc = docScroll();
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const old = S.zoom;
    if (!sc || Math.abs(z - old) < 0.001) { S.zoom = z; applyZoom(); return; }
    const r  = sc.getBoundingClientRect();
    const px = (cx ?? (r.left + sc.clientWidth / 2)) - r.left;   // keep this point still while zooming
    const py = (cy ?? (r.top + sc.clientHeight / 2)) - r.top;
    const k  = z / old;
    const left = (sc.scrollLeft + px) * k - px;
    const top  = (sc.scrollTop  + py) * k - py;
    S.zoom = z; applyZoom();
    sc.scrollLeft = left; sc.scrollTop = top;
}

function fitZoom() {
    const sc = docScroll();
    const t = zoomTargets().find(n => n.style.display !== 'none' && n.offsetParent !== null);
    if (!sc || !t) return;
    t.style.zoom = '1';
    let natural = t.scrollWidth;
    Array.from(t.children).forEach(c => { natural = Math.max(natural, c.scrollWidth, c.offsetWidth); });
    const z = natural > 0 ? ((sc.clientWidth - 32) / natural) * 0.8 : 1;
    S.zoom = 1;
    setZoom(Math.min(1.25, Math.max(ZOOM_MIN, z)));
    sc.scrollLeft = 0; sc.scrollTop = 0;
}

function buildZoomBar(split) {
    const bar = document.createElement('div');
    bar.id = 'dpe-zoombar';
    bar.className = 'dpe-zoom';
    bar.innerHTML = `
        <button type="button" id="dpe-zout" title="Zoom out">−</button>
        <span class="pct" id="dpe-zoom-pct">100%</span>
        <button type="button" id="dpe-zin" title="Zoom in">+</button>
        <button type="button" id="dpe-zfit" title="Fit to width" style="font-size:12px;">Fit</button>
        <button type="button" id="dpe-z100" title="Actual size" style="font-size:12px;">100%</button>
        <span class="tip">Drag to move · Ctrl + scroll to zoom</span>`;
    split.appendChild(bar);
    $('dpe-zout').onclick = () => setZoom(S.zoom / ZOOM_STEP);
    $('dpe-zin').onclick  = () => setZoom(S.zoom * ZOOM_STEP);
    $('dpe-zfit').onclick = fitZoom;
    $('dpe-z100').onclick = () => setZoom(1);
}

let panWired = false;
function wirePan(sc) {
    if (panWired || !sc) return;
    panWired = true;
    let drag = null;
    sc.addEventListener('pointerdown', (e) => {
        if (!S.editing || e.pointerType !== 'mouse' || e.button !== 0) return;
        if (e.target.closest('input, textarea, button, select, a, .dpe-tb, [contenteditable]:not([contenteditable="false"])')) return;
        drag = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop };
        sc.classList.add('dragging');
        try { sc.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    sc.addEventListener('pointermove', (e) => {
        if (!drag) return;
        sc.scrollLeft = drag.l - (e.clientX - drag.x);
        sc.scrollTop  = drag.t - (e.clientY - drag.y);
    });
    const end = (e) => {
        if (!drag) return;
        drag = null; sc.classList.remove('dragging');
        try { sc.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    sc.addEventListener('pointerup', end);
    sc.addEventListener('pointercancel', end);
    sc.addEventListener('wheel', (e) => {
        if (!S.editing || !(e.ctrlKey || e.metaKey)) return;   // plain wheel still scrolls
        e.preventDefault();
        setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
    }, { passive: false });
}

// Put the form and the document next to each other (moved back on exit so other code is unaffected)
function enterSplit() {
    const panel = $('dp-edit-panel');
    const scroll = $('doc-preview-modal').querySelector('.doc-preview-scroll');
    if (!panel || !scroll || document.getElementById('dpe-split')) return;
    const split = document.createElement('div');
    split.id = 'dpe-split';
    split.className = 'dpe-split';
    scroll.parentNode.insertBefore(split, scroll);
    split.append(panel, scroll);
    buildZoomBar(split);
    scroll.classList.add('dpe-pan');
    wirePan(scroll);
    // give the document more room while editing
    const wrap = $('doc-preview-modal').querySelector('.doc-preview-wrapper');
    if (wrap) { S.prevMaxWidth = wrap.style.maxWidth; wrap.style.maxWidth = '1500px'; }
    S.zoom = 1;
    // fit once the layout has settled
    requestAnimationFrame(() => setTimeout(fitZoom, 60));
}
function exitSplit() {
    const split = document.getElementById('dpe-split');
    if (!split) return;
    const panel = $('dp-edit-panel');
    const scroll = split.querySelector('.doc-preview-scroll');
    split.parentNode.insertBefore(panel, split);
    if (scroll) { split.parentNode.insertBefore(scroll, split); scroll.classList.remove('dpe-pan', 'dragging'); }
    split.remove();
    zoomTargets().forEach(n => { n.style.zoom = ''; });
    S.zoom = 1;
    const wrap = $('doc-preview-modal').querySelector('.doc-preview-wrapper');
    if (wrap) wrap.style.maxWidth = S.prevMaxWidth || '';
}

function exitEditUI() {
    exitSplit();
    S.editing = false;
    paper.setEditing(false);
    clearInline();
    syncBoxTools(null);
    $('doc-preview-modal').querySelector('.doc-preview-wrapper').classList.remove('dp-editing');
    $('dp-edit-panel').hidden = true;
    const p = $('dp-print');
    if (p) { p.disabled = false; p.title = ''; }
    document.querySelectorAll('#doc-preview-content .dp-changed').forEach(n => n.classList.remove('dp-changed'));
}

function cancelEdit(confirmIfDirty) {
    if (confirmIfDirty && isDirty() && !window.confirm('Discard your unsaved changes to this document?')) return;
    exitEditUI();
    paintDocument(effectiveValues(S.base, S.saved));   // back to last saved state
    const r = S.request;
    setEditButton(EDITABLE_STATUSES.includes(r?.status) ? 'enabled' : 'hidden');
}

function resetToOriginal() {
    fillForm({ ...S.base, showBirthday: false, showContact: false, remarks: '', textBoxes: [], textEdits: [] });
    onFormInput();
}

function onFormInput() { refreshPreview(); }

function refreshPreview() {
    const overrides = readOverrides();
    const eff = effectiveValues(S.base, overrides);
    eff.editTags = S.editing;          // while editing, mark every run of text so it can be clicked
    paintDocument(eff);
    if (S.editing) applyZoom();

    // highlight corrected values + show the original under each changed field
    Object.entries(FIELD_EL).forEach(([key, elId]) => {
        $(elId)?.classList.toggle('dp-changed', String(eff[key]) !== String(S.base[key]));
    });
    syncHints();
}

function syncHints() {
    FIELDS.forEach(f => {
        const hint = $(`dpe-hint-${f.key}`);
        const cur = String($(`dpe-${f.key}`).value || '').trim();
        const orig = String(S.base[f.key] ?? '');
        hint.textContent = (cur && cur !== orig) ? `Original: ${orig || '—'}` : '';
    });
}

// ---------------------------------------------
// Save (requests/{id} only — never residents/{uid})
// ---------------------------------------------
async function saveEdits() {
    const reqId = S.requestId;
    const overrides = readOverrides();
    const btn = $('dpe-save');
    const user = auth.currentUser;
    if (!user) return showMsg('You are signed out. Please sign in again.');

    btn.disabled = true; btn.textContent = 'Saving…';
    showMsg('');
    try {
        const ref = doc(db, 'requests', reqId);
        if (Object.keys(overrides).length === 0) {
            await updateDoc(ref, {
                docOverrides: deleteField(), docEditedAt: deleteField(),
                docEditedBy: deleteField(),  docEditedByEmail: deleteField()
            });
        } else {
            await updateDoc(ref, {
                docOverrides: overrides,
                docEditedAt: serverTimestamp(),
                docEditedBy: user.uid,
                docEditedByEmail: user.email || null
            });
        }
        if (S.requestId !== reqId) return;     // modal closed mid-save; the write still succeeded
        S.saved = overrides;
        exitEditUI();
        paintDocument(effectiveValues(S.base, S.saved));
        updateBadge();
        setEditButton('enabled');
        toast(Object.keys(overrides).length ? 'Document changes saved' : 'Document restored to original');
    } catch (e) {
        console.error('docedit: save failed', e);
        showMsg('Could not save changes: ' + (e.message || e));
    } finally {
        btn.disabled = false; btn.textContent = 'Save Changes';
    }
}

// ---------------------------------------------
// Small helpers
// ---------------------------------------------
function updateBadge() {
    $('dpe-badge')?.classList.toggle('show', Object.keys(S.saved || {}).length > 0);
}

function showMsg(text) {
    const m = $('dpe-msg');
    if (!m) return;
    m.textContent = text;
    m.style.display = text ? 'block' : 'none';
}

function toast(text) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

// ----------------------------------------------
// Boot
// ----------------------------------------------
paper.init({ onChange() {}, onSelect: (sel) => syncBoxTools(sel) });
// Outside edit mode the saved boxes follow every paint; while editing, the boxes on the paper are the source of truth.
setBoxPainter((v) => {
    if (!S.editing) paper.setBoxes(v.textBoxes || []);
    paintLegacyText(v);
});
injectUI();
window.BarangayDocEditor = { attach };