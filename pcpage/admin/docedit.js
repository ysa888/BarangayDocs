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
    paintDocument, profileAddress, setTemplatePainter
} from "./docoverrides.js";

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
    snapshot: '',       // JSON of overrides when edit mode started (dirty check)
    usedKeys: null      // FIELDS keys the saved template uses (null = no template → show all)
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
    .dpe-split > .dpe-panel { flex:0 0 340px; width:340px; max-height:none; border-bottom:0; border-right:1.5px solid var(--border,#D0DCF0); }
    .dpe-split .dpe-grid { grid-template-columns:1fr; }
    .dpe-field[hidden] { display:none; }
    .dpe-panel[hidden] { display:none; }
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
        <div class="dpe-note">Changes apply to this document only. The resident's profile is not modified.<div id="dpe-usednote" style="font-weight:600;margin-top:3px;"></div></div>
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
const FIELD_ALIASES = {
    residentName:  ['residentname', 'fullname', 'name', 'resident.name', 'resident.fullname', 'resident'],
    age:           ['age', 'resident.age'],
    occupation:    ['occupation', 'work', 'job', 'jobtitle', 'resident.occupation'],
    address:       ['address', 'resident.address', 'residentaddress'],
    birthday:      ['birthday', 'birthdate', 'dateofbirth', 'dob', 'resident.birthday', 'resident.birthdate', 'resident.dateofbirth'],
    contactNumber: ['contactnumber', 'contact', 'phone', 'mobile', 'resident.contactnumber', 'resident.contact', 'resident.phone'],
    remarks:       ['remarks', 'additionalremarks', 'note', 'notes']
};
const normKey = (k) => String(k || '').toLowerCase().replace(/[\s_\-]/g, '');

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
        n.hidden = !!used && k !== 'remarks' && !used.has(k);
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
}

function readForm() {
    const f = {};
    FIELDS.forEach(x => { f[x.key] = $(`dpe-${x.key}`).value; });
    f.showBirthday = $('dpe-showBirthday').checked;
    f.showContact  = $('dpe-showContact').checked;
    f.remarks      = $('dpe-remarks').value;
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
    refreshPreview();
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
}
function exitSplit() {
    const split = document.getElementById('dpe-split');
    if (!split) return;
    const panel = $('dp-edit-panel');
    const scroll = split.querySelector('.doc-preview-scroll');
    split.parentNode.insertBefore(panel, split);
    if (scroll) split.parentNode.insertBefore(scroll, split);
    split.remove();
}

function exitEditUI() {
    exitSplit();
    S.editing = false;
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
    fillForm({ ...S.base, showBirthday: false, showContact: false, remarks: '' });
    onFormInput();
}

function onFormInput() { refreshPreview(); }

function refreshPreview() {
    const overrides = readOverrides();
    const eff = effectiveValues(S.base, overrides);
    paintDocument(eff);

    // highlight corrected values + show the original under each changed field
    Object.entries(FIELD_EL).forEach(([key, elId]) => {
        $(elId)?.classList.toggle('dp-changed', String(eff[key]) !== String(S.base[key]));
    });
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

// ---------------------------------------------
// Boot
// ---------------------------------------------
injectUI();
window.BarangayDocEditor = { attach };