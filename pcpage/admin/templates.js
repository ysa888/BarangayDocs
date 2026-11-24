// =============================================
// templates.js
// Handles: admin_templates.html  (Document Template Editor)
//
// Firestore
//   documents/{docId}            (existing)  → list of document types
//   documentTemplates/{docId}    (NEW)       → one saved template per document type
//        { documentId, documentName, html, pageSettings, version,
//          createdAt, updatedAt, updatedBy }
//   residents/{uid}              (existing)  → read-only, only to discover field names
// Image hosting (Cloudinary, free) → logos / seals / signatures uploaded in the editor.
//   Only the https URLs are stored inside the template HTML. No Firebase Storage, no Base64.
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, deleteDoc, collection,
    query, where, limit, onSnapshot, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {
    PAGE_SIZES, DEFAULT_PAGE_SETTINGS, FIELD_GROUPS,
    normalizePageSettings, paperStyleObject, paperStyleString, baseCss,
    discoverResidentFields, sampleValues, renderTemplateHtml, sanitizeHtml,
    defaultTemplateHtml, makeQrDataUrl, printTemplateHtml, pageGeometry,
    applyImageLayout, EDITOR_PAGE_GAP_PX, mountPages
} from "./templateengine.js";

// =============================================
// Firebase Config & Init (same project as the rest of the app)
// =============================================
const firebaseConfig = {
    apiKey: "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain: "barangaydocs-df957.firebaseapp.com",
    projectId: "barangaydocs-df957",
    storageBucket: "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId: "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId: "G-YG0Y575BRD"
};

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);

// =============================================
// Image hosting: Cloudinary — same account and unsigned preset already used by bdlogsign.js.
// =============================================
const CLOUDINARY = {
    cloudName:    'ddizbxtdd',
    uploadPreset: 'barangaydocs_preset'
};

const el = (id) => document.getElementById(id);

// Folder that holds Icons/, request.js etc. This page lives in …/admin/, so go up one level.
const APP_ROOT = /\/admin\/[^/]*$/.test(location.pathname)
    ? new URL('../', location.href).href
    : new URL('./', location.href).href;
const resolveAsset = (p) => { try { return new URL(p, APP_ROOT).href; } catch (_) { return p; } };

// Firestore documents are capped at 1 MiB — keep a safety margin
const MAX_TEMPLATE_BYTES = 900 * 1024;

// =============================================
// Helpers
// =============================================
function showToast(msg, duration = 3200) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), duration);
}

function escHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getInitials(name) {
    if (!name) return 'A';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
}

function formatDate(val) {
    if (!val) return '';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

window.toggleSidebar = function () {
    el('sidebar')?.classList.toggle('collapsed');
    el('mainContent')?.classList.toggle('expanded');
};

// Simple promise-based confirm modal
function confirmDialog({ title, text, yesLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
        el('confirm-title').textContent = title;
        el('confirm-text').textContent = text;
        el('confirm-yes-label').textContent = yesLabel;
        el('confirm-yes').style.background = danger ? '' : 'var(--primary)';
        const overlay = el('confirm-modal');
        const done = (val) => {
            overlay.classList.remove('open');
            el('confirm-yes').onclick = null;
            el('confirm-no').onclick = null;
            resolve(val);
        };
        el('confirm-yes').onclick = () => done(true);
        el('confirm-no').onclick = () => done(false);
        overlay.classList.add('open');
    });
}

// =============================================
// Auth Guard — admin only (same rule as document.js)
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'barangaydocs_login.html';
        return;
    }
    const adminSnap = await getDoc(doc(db, 'admins', user.uid));
    if (!adminSnap.exists()) {
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
        return;
    }
    initPage(user, adminSnap.data());
});

// =============================================
// State
// =============================================
let documentTypes = [];          // [{ id, name, description, icon, status }]
let templates = {};              // docId → documentTemplates data
let residentExtraFields = [];    // discovered resident.<field> placeholders
let current = null;              // { id, name } while editing
let editor = null;               // TinyMCE instance
let pageSettings = normalizePageSettings(DEFAULT_PAGE_SETTINGS);
let dirty = false;
let loadingContent = false;      // true while we programmatically set editor content

// Original imported .docx, kept untouched so it can be edited and re-exported later
// (set by onDocxChosen via setOriginalDocx; cleared when a template is opened or closed).
let originalDocxFile = null;     // File chosen by the admin (or null)
let originalDocxBuffer = null;   // ArrayBuffer with the original file bytes (or null)
let originalDocxZip = null;      // JSZip instance of the original package (or null)

// JSZip is a classic <script> in admin_templates.html, which always runs before this module.
if (typeof JSZip === 'undefined') {
    console.warn('JSZip did not load — original .docx preservation will be unavailable.');
}

let originalDocxFresh = false;   // imported in this session and not yet uploaded to the image host
let storedOriginal = null;       // { url, name } of the original .docx already saved on the image host

// Stores a freshly imported .docx, replacing whatever was stored before.
function setOriginalDocx(file, buffer, zip) {
    originalDocxFile = file;
    originalDocxBuffer = buffer;
    originalDocxZip = zip;
    originalDocxFresh = true;
}

function clearOriginalDocx() {
    originalDocxFile = null;
    originalDocxBuffer = null;
    originalDocxZip = null;
    originalDocxFresh = false;
}

// =============================================
// Init Page
// =============================================
let pageInited = false;          // auth can fire more than once — never stack listeners/handlers
function initPage(user, adminData) {
    if (pageInited) return;
    pageInited = true;
    const fullName = adminData.name || adminData.email || 'Admin';
    const avatarEl = document.querySelector('.admin-avatar .av-ph');
    if (avatarEl) avatarEl.textContent = getInitials(fullName);

    loadSidebarBadges();

    el('sign-out-btn')?.addEventListener('click', async () => {
        if (dirty && !(await confirmDialog({
            title: 'Discard unsaved changes?',
            text: 'You have unsaved template changes. Signing out will discard them.',
            yesLabel: 'Sign out', danger: true
        }))) return;
        dirty = false;
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
    });

    // List view
    el('tpl-search')?.addEventListener('input', renderCards);
    listenDocumentTypes();
    listenTemplates();
    loadResidentFieldNames();

    // Editor view
    el('btn-back')?.addEventListener('click', closeEditor);
    el('btn-save')?.addEventListener('click', saveTemplate);
    el('btn-preview')?.addEventListener('click', openPreview);
    el('btn-reset')?.addEventListener('click', resetToStandardLayout);
    el('btn-remove')?.addEventListener('click', removeCustomTemplate);
    el('btn-import')?.addEventListener('click', () => el('docx-file')?.click());
    el('docx-file')?.addEventListener('change', onDocxChosen);
    el('btn-export')?.addEventListener('click', exportDocx);
    el('pv-close')?.addEventListener('click', () => el('preview-modal')?.classList.remove('open'));

    // Side panel
    document.querySelectorAll('.side-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.side-tab').forEach(t => t.classList.toggle('active', t === tab));
            ['pane-fields', 'pane-page', 'pane-images'].forEach(id => el(id)?.classList.toggle('hidden', id !== tab.dataset.pane));
        });
    });
    el('field-search')?.addEventListener('input', renderFieldPanel);
    renderFieldPanel();
    initPageSettingsUI();
    initImagePanel();

    window.addEventListener('beforeunload', (e) => {
        if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });
}

function loadSidebarBadges() {
    onSnapshot(
        query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (snap) => { const b = el('pending-requests-badge'); if (b) b.textContent = snap.size; }
    );
    onSnapshot(collection(db, 'residents'), (snap) => {
        const n = snap.docs.filter(d => d.data().status === 'pending').length;
        const b = el('pending-users-badge'); if (b) b.textContent = n;
    });
}

// =============================================
// VIEW 1 — pick a document type
// Document types come from the EXISTING `documents` collection — nothing hardcoded.
// =============================================
function listenDocumentTypes() {
    onSnapshot(collection(db, 'documents'), (snap) => {
        documentTypes = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        renderCards();
    }, (err) => {
        el('tpl-grid').innerHTML = `<div class="tpl-empty">Could not load document types: ${escHtml(err.message)}</div>`;
    });
}

function listenTemplates() {
    onSnapshot(collection(db, 'documentTemplates'), (snap) => {
        templates = {};
        // 'estimate' → a just-saved template shows its "Updated" date immediately instead of blank
        snap.docs.forEach(d => { templates[d.id] = d.data({ serverTimestamps: 'estimate' }); });
        renderCards();
        updateBadge();
    }, (err) => {
        // Most likely Firestore rules not yet updated — editor still works for viewing defaults
        console.warn('documentTemplates listener failed:', err);
        showToast('Could not load saved templates: ' + (err.message || err), 6000);
    });
}

function renderCards() {
    const grid = el('tpl-grid');
    if (!grid) return;
    const q = (el('tpl-search')?.value || '').trim().toLowerCase();
    const list = documentTypes.filter(d =>
        !q || (d.name || '').toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q));

    if (!list.length) {
        grid.innerHTML = `<div class="tpl-empty">${documentTypes.length ? 'No matching document types.' : 'No document types yet. Add some on the Documents page first.'}</div>`;
        return;
    }

    grid.innerHTML = list.map(d => {
        const t = templates[d.id];
        const badge = t
            ? `<span class="badge custom">Custom template</span>`
            : `<span class="badge default">Default layout</span>`;
        const inactive = d.status === 'inactive' ? `<span class="badge inactive">Inactive</span>` : '';
        const upd = t?.updatedAt ? `<span class="tpl-updated">Updated ${escHtml(formatDate(t.updatedAt))}</span>` : '';
        return `
        <div class="tpl-card">
            <div class="tpl-card-top">
                <div class="tpl-card-icon"><img src="${escHtml(resolveAsset(d.icon || 'Icons/barangayclearance.png'))}" alt="" onerror="this.style.display='none'"></div>
                <h4>${escHtml(d.name || '—')}</h4>
            </div>
            <p>${escHtml(d.description || 'No description provided.')}</p>
            <div class="tpl-card-meta">${badge}${inactive}${upd}</div>
            <button class="btn-primary-sm" data-open="${escHtml(d.id)}">Customize template</button>
        </div>`;
    }).join('');

    grid.querySelectorAll('[data-open]').forEach(btn =>
        btn.addEventListener('click', () => openEditor(btn.dataset.open)));
}

async function loadResidentFieldNames() {
    try {
        const snap = await getDocs(query(collection(db, 'residents'), limit(30)));
        residentExtraFields = discoverResidentFields(snap.docs.map(d => d.data()));
        renderFieldPanel();
    } catch (err) {
        console.warn('Could not read residents to discover fields:', err);
    }
}

// =============================================
// VIEW 2 — editor
// =============================================
const TINYMCE_FONTS = [
    'Palatino Linotype=palatino linotype,book antiqua,palatino,serif',
    'Times New Roman=times new roman,times,serif',
    'Calibri=calibri,carlito,sans-serif',
    'Georgia=georgia,serif',
    'Garamond=garamond,serif',
    'Arial=arial,helvetica,sans-serif',
    'Verdana=verdana,geneva,sans-serif',
    'Tahoma=tahoma,arial,sans-serif',
    'Trebuchet MS=trebuchet ms,sans-serif',
    'Courier New=courier new,courier,monospace'
].join(';');

function setView(name) {
    el('view-list')?.classList.toggle('hidden', name !== 'list');
    el('view-editor')?.classList.toggle('hidden', name !== 'editor');
    window.scrollTo({ top: 0 });
}

function setDirty(val) {
    dirty = !!val;
    el('dirty-dot')?.classList.toggle('show', dirty);
}

function updateBadge() {
    const b = el('editor-badge');
    if (!b || !current) return;
    const has = !!templates[current.id];
    b.textContent = has ? 'Custom template' : 'Default layout';
    b.className = 'badge ' + (has ? 'custom' : 'default');
}

async function openEditor(docId) {
    const d = documentTypes.find(x => x.id === docId);
    if (!d) return;
    current = { id: d.id, name: d.name || 'Document' };
    clearOriginalDocx();
    storedOriginal = null;

    el('editor-title').textContent = current.name;
    setView('editor');
    updateBadge();
    setDirty(false);

    // Make sure we have the freshest saved copy
    let saved = templates[docId];
    try {
        const snap = await getDoc(doc(db, 'documentTemplates', docId));
        saved = snap.exists() ? snap.data() : undefined;
    } catch (err) {
        console.warn('Could not read template:', err);
    }

    storedOriginal = saved?.originalDocx?.url ? saved.originalDocx : null;
    pageSettings = normalizePageSettings(saved?.pageSettings || DEFAULT_PAGE_SETTINGS);
    syncPageSettingsUI();

    const html = saved?.html || defaultTemplateHtml();
    await ensureEditor();
    setEditorContent(html);
    applyPageToEditor();
    setDirty(false);
}

async function closeEditor() {
    if (dirty && !(await confirmDialog({
        title: 'Discard unsaved changes?',
        text: 'You have unsaved changes to this template. If you go back they will be lost.',
        yesLabel: 'Discard', danger: true
    }))) return;
    setDirty(false);
    current = null;
    clearOriginalDocx();
    storedOriginal = null;
    setView('list');
}

/** Saves each free-position image's spot in data- attributes, which survive saving (inline position styles were being lost). */
function syncOverlayData() {
    if (!editor) return;
    editor.getBody().querySelectorAll('img[data-layout="behind"],img[data-layout="front"]').forEach(img => {
        const x = parseFloat(img.style.left), y = parseFloat(img.style.top), w = parseFloat(img.style.width);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            img.setAttribute('data-x', x.toFixed(1));
            img.setAttribute('data-y', y.toFixed(1));
        }
        if (Number.isFinite(w)) img.setAttribute('data-w', w.toFixed(1));
    });
}

/** Puts behind / in-front images back at their saved spot after a template is loaded. */
function restoreOverlayPositions() {
    if (!editor) return;
    editor.getBody().querySelectorAll('img[data-layout="behind"],img[data-layout="front"]').forEach(img => {
        if (img.style.position === 'absolute') return;
        const x = parseFloat(img.getAttribute('data-x')), y = parseFloat(img.getAttribute('data-y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const w = parseFloat(img.getAttribute('data-w'));
        applyImageLayout(img, img.getAttribute('data-layout'),
            { x, y, width: w > 0 ? w : undefined, repeat: img.hasAttribute('data-repeat') });
    });
    // A paragraph holding ONLY free-position images collapses to zero height once they leave the flow,
    // which pulls all the text below it upwards. Give it back its one empty line (a trailing <br> would be
    // stripped by TinyMCE, so a non-breaking space is used).
    editor.getBody().querySelectorAll('p').forEach(p => {
        if (p.textContent.length !== 0 || p.querySelector('br')) return;
        const kids = [...p.children];
        if (!kids.length) return;
        const onlyOverlays = kids.every(k => k.tagName === 'IMG' && ['behind', 'front'].includes(k.getAttribute('data-layout')));
        if (onlyOverlays) p.appendChild(p.ownerDocument.createTextNode('\u00a0'));
    });
}

function setEditorContent(html) {
    if (!editor) return;
    loadingContent = true;
    editor.setContent(html);
    restoreOverlayPositions();
    editor.undoManager?.clear();
    editor.undoManager?.add();
    loadingContent = false;
}

// ---------------------------------------------
// TinyMCE setup (created once, reused for every document type)
// ---------------------------------------------
function ensureEditor() {
    if (editor) return Promise.resolve(editor);
    if (typeof tinymce === 'undefined') {
        el('editor-loading').textContent =
            'The editor library could not be loaded. Check your internet connection and reload this page.';
        return Promise.reject(new Error('TinyMCE not loaded'));
    }

    const editorCss = [
        baseCss('body'),
        'html{background:#e6e6e6;padding:0 0 96px;position:relative}',
        'body{box-shadow:none}',
        // "Drag on page" mode: only the behind/in-front images can be grabbed
        'body.tpl-move *{pointer-events:none !important}',
        'body.tpl-move{cursor:move}',
        'body.tpl-move img[data-layout="behind"],body.tpl-move img[data-layout="front"]{pointer-events:auto !important;cursor:move;outline:2px dashed #2a5298}',
        'body.tpl-move .tpl-grip{pointer-events:auto !important}',
        // free-position images: move cursor, never the text cursor / native drag
        'img[data-layout="behind"],img[data-layout="front"]{cursor:move;-webkit-user-drag:none;user-select:none}',
        // selection frame + grips for behind / in-front images (editor-only, stripped on save)
        '#tpl-ovl{position:absolute;z-index:50;pointer-events:none;border:2px dashed #2a5298;box-sizing:border-box}',
        '#tpl-ovl .tpl-grip{position:absolute;pointer-events:auto;background:#2a5298;color:#fff;font:700 13px/20px sans-serif;text-align:center;width:22px;height:22px;border-radius:5px;user-select:none;touch-action:none}',
        '#tpl-ovl .tpl-grip.mv{left:-2px;top:-24px;cursor:move}',
        '#tpl-ovl .tpl-grip.rz{right:-8px;bottom:-8px;width:14px;height:14px;border-radius:3px;cursor:nwse-resize}',
        // placeholder chips: visible only while editing
        '.tpl-pagebreak{display:block;height:0;margin:0;padding:0;border:0;position:relative;clear:both}',
        '.tpl-pagebreak::after{content:"Page break";position:absolute;left:0;top:-8px;font:700 10px/16px sans-serif;color:#fff;background:#2a5298;padding:0 6px;border-radius:3px;pointer-events:none}',
        '.tpl-pagebreak[data-pagebreak="blank"]::after{content:"Blank page";background:#7a5b00}',
        '.ph{background:#fff3cd;border:1px dashed #d4a017;border-radius:3px;padding:0 3px;color:#7a5b00}'
    ].join('\n');

    return tinymce.init({
        target: el('tpl-editor'),
        height: Math.max(560, window.innerHeight - 190),
        menubar: 'edit insert format table',
        plugins: 'advlist lists table image link charmap searchreplace code',
        toolbar:
            'undo redo | blocks fontfamily fontsize | bold italic underline strikethrough | forecolor backcolor | ' +
            'alignleft aligncenter alignright alignjustify | lineheight | bullist numlist outdent indent | ' +
            'table image imglayout hr | textbox rectshape vline | newpage blankpage | casebtn placeholders | styles | removeformat',
        style_formats: [
            { title: 'Paragraph spacing: compact', selector: 'p', styles: { marginTop: '0', marginBottom: '2pt' } },
            { title: 'Paragraph spacing: normal', selector: 'p', styles: { marginTop: '0', marginBottom: '8pt' } },
            { title: 'Paragraph spacing: wide', selector: 'p', styles: { marginTop: '0', marginBottom: '16pt' } },
            { title: 'Letter spacing: tight', inline: 'span', styles: { letterSpacing: '-0.3px' } },
            { title: 'Letter spacing: normal', inline: 'span', styles: { letterSpacing: 'normal' } },
            { title: 'Letter spacing: wide', inline: 'span', styles: { letterSpacing: '1.5px' } },
            { title: 'Text box', block: 'div', classes: 'tpl-textbox', wrapper: true },
            { title: 'Bordered section', block: 'div', classes: 'tpl-section-box', wrapper: true }
        ],
        toolbar_mode: 'wrap',
        branding: false,
        promotion: false,
        resize: false,
        statusbar: true,
        elementpath: false,
        content_css: false,          // we supply the CSS so editor = printed result
        document_base_url: APP_ROOT, // so "Icons/…" images show inside the editor
        content_style: editorCss + '\n' + [
            '.tpl-textbox{display:block;box-sizing:border-box;min-height:42px;padding:8px 10px;border:1px solid #777;background:#fff;margin:6px 0;}',
            '.tpl-section-box{display:block;box-sizing:border-box;padding:10px;border:1px solid #777;margin:8px 0;}',
            '.tpl-shape-rect{display:inline-block;box-sizing:border-box;width:120px;height:48px;border:2px solid #16834a;background:#e9f5ee;vertical-align:middle;margin:4px;}',
            '.tpl-shape-line{display:block;border:0;border-top:1px solid #333;height:0;margin:8px 0;}',
            '.tpl-shape-vline{display:inline-block;width:0;height:80px;border-left:2px solid #16834a;vertical-align:middle;margin:0 8px;}'
        ].join('\n'),
        font_family_formats: TINYMCE_FONTS,
        font_size_formats: '8pt 9pt 10pt 11pt 12pt 13pt 14pt 16pt 18pt 20pt 22pt 24pt 28pt 32pt 36pt 48pt',
        lineheight_formats: '1 1.15 1.4 1.5 1.9 2 2.5 3',
        block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3',
        convert_urls: false,
        relative_urls: false,
        remove_script_host: false,
        image_advtab: true,
        image_caption: false,
        image_title: true,
        // free-position images are resized with their own corner grip (TinyMCE's handles misplace them)
        object_resizing: 'img:not([data-layout=behind]):not([data-layout=front]),table',
        automatic_uploads: true,
        paste_data_images: true,
        images_upload_handler: (blobInfo) =>
            uploadImageBlob(blobInfo.blob(), blobInfo.filename()),
        file_picker_types: 'image',
        file_picker_callback: pickImageFile,
        table_default_attributes: { border: '0' },
        table_default_styles: { width: '100%', 'border-collapse': 'collapse' },
        extended_valid_elements: 'span[class|style|data-field],div[class|style|contenteditable],hr[class|style],p[class|style],td[class|style|colspan|rowspan],th[class|style|colspan|rowspan]',
        setup: (ed) => {
            editor = ed;

            // Upper/lower/capitalize helper (the legacy certificate is all caps)
            ed.on('init', () => {
                ed.formatter.register('tc_upper', { inline: 'span', styles: { textTransform: 'uppercase' } });
                ed.formatter.register('tc_lower', { inline: 'span', styles: { textTransform: 'lowercase' } });
                ed.formatter.register('tc_cap',   { inline: 'span', styles: { textTransform: 'capitalize' } });
                el('editor-loading')?.classList.add('hidden');
                applyPageToEditor();
            });

            ed.ui.registry.addButton('newpage',   { text: 'New page',    tooltip: 'Start the following content on a new page', onAction: () => insertPageBreak(false) });
            ed.ui.registry.addButton('blankpage', { text: '+ Blank page', tooltip: 'Insert an empty page here',                onAction: () => insertPageBreak(true) });

            // Layout building blocks: these work directly in the editor; no Word file is required.
            ed.ui.registry.addButton('textbox', {
                text: 'Text box', tooltip: 'Insert a bordered text area',
                onAction: () => ed.insertContent('<div class=\"tpl-textbox\" contenteditable=\"true\">Type text here</div><p></p>')
            });
            ed.ui.registry.addButton('rectshape', {
                text: 'Rectangle', tooltip: 'Insert a decorative rectangle',
                onAction: () => ed.insertContent('<span class=\"tpl-shape-rect\" contenteditable=\"false\"></span>')
            });
            ed.ui.registry.addButton('vline', {
                text: 'Vertical line', tooltip: 'Insert a vertical divider',
                onAction: () => ed.insertContent('<span class=\"tpl-shape-vline\" contenteditable=\"false\"></span>')
            });

            ed.ui.registry.addMenuButton('casebtn', {
                text: 'Aa',
                tooltip: 'Letter case',
                fetch: (cb) => cb([
                    { type: 'togglemenuitem', text: 'UPPERCASE',  onAction: () => ed.formatter.toggle('tc_upper'), onSetup: (api) => { api.setActive(ed.formatter.match('tc_upper')); return () => {}; } },
                    { type: 'togglemenuitem', text: 'lowercase',  onAction: () => ed.formatter.toggle('tc_lower'), onSetup: (api) => { api.setActive(ed.formatter.match('tc_lower')); return () => {}; } },
                    { type: 'togglemenuitem', text: 'Capitalize', onAction: () => ed.formatter.toggle('tc_cap'),   onSetup: (api) => { api.setActive(ed.formatter.match('tc_cap'));   return () => {}; } }
                ])
            });

            ed.ui.registry.addMenuButton('placeholders', {
                text: '{ } Insert field',
                tooltip: 'Insert a dynamic field',
                fetch: (cb) => cb(allFieldGroups().map(g => ({
                    type: 'nestedmenuitem',
                    text: g.group,
                    getSubmenuItems: () => g.fields.map(f => ({
                        type: 'menuitem',
                        text: `${f.label}  —  {${f.key}}`,
                        onAction: () => insertField(f.key)
                    }))
                })))
            });

            // Page-by-page layout inside the editor (visual only — stripped from saved HTML)
            ed.on('GetContent', (e) => {
                if (typeof e.content === 'string' && e.content.includes('data-pg')) {
                    e.content = e.content.replace(/\sdata-pg="\d+"/g, '');
                }
            });
            ed.on('input change keyup SetContent ExecCommand undo redo ObjectResized TableModified', schedulePaginate);
            ed.on('ResizeWindow ResizeEditor', schedulePaginate);
            // Text typed next to a {field} (or after Enter) must not stay orange / inside the chip
            ed.on('input keyup', (e) => { if (!e.isComposing) normalizeChips(ed, true); });
            ed.on('SetContent', () => setTimeout(() => normalizeChips(ed, false), 0));
            ed.on('init', () => {
                ed.getBody().addEventListener('load', schedulePaginate, true);   // images finishing loading
                setTimeout(schedulePaginate, 600);
            });

            // Image layout (inline / wrap / behind text / in front) — menu on the toolbar and on the image itself
            const LAYOUTS = [
                ['inline', 'In line with text'], ['left', 'Wrap text — image left'], ['right', 'Wrap text — image right'],
                ['center', 'Centered'], ['behind', 'Behind text (free position)'], ['front', 'In front of text (free position)']
            ];
            ed.ui.registry.addMenuButton('imglayout', {
                text: 'Image layout',
                tooltip: 'Behind text, in front, wrap…',
                fetch: (cb) => cb(LAYOUTS.map(([mode, label]) => ({
                    type: 'menuitem', text: label,
                    onAction: () => {
                        const n = ed.selection.getNode();
                        if (n && n.nodeName === 'IMG') setImageLayout(n, mode);
                        else showToast('Click an image first, then choose its layout.', 3000);
                    }
                })))
            });
            ed.ui.registry.addContextToolbar('imgctx', {
                predicate: (n) => n.nodeName === 'IMG',
                items: 'imglayout',
                position: 'node',
                scope: 'node'
            });

            // Move / resize behind + in-front images. Use the ✥ handle (shown on the selected image),
// or grab the image itself. Pointer capture keeps the drag alive even outside the page.
            ed.on('init', () => {
                const b = ed.getBody();
                // Native image drag is what showed the "can't drop here" cursor — block it.
                b.addEventListener('dragstart', (e) => {
                    const im = e.target && e.target.closest ? e.target.closest('img') : null;
                    if (im && isOverlayImg(im)) e.preventDefault();
                }, true);
                const grabTarget = (e) => {
                    const t = e.target;
                    if (t && t.classList && t.classList.contains('tpl-grip') && selImg) {
                        return { img: selImg, mode: t.classList.contains('rz') ? 'resize' : 'move' };
                    }
                    const im = t && t.closest ? t.closest('img') : null;
                    return im && isOverlayImg(im) ? { img: im, mode: 'move' } : null;
                };
                b.addEventListener('mousedown', (e) => {
                    if (grabTarget(e)) { e.preventDefault(); e.stopPropagation(); }   // no text cursor / selection
                }, true);

                let drag = null;
                // Click anywhere that is not an overlay image or its grips → deselect (listens on the whole
                // document, so it also works in "Drag on page" mode and when clicking the grey area around the sheet).
                ed.getDoc().addEventListener('pointerdown', (e) => {
                    if (e.button !== 0 || !selImg) return;
                    if (grabTarget(e)) return;
                    selImg = null;
                    positionHandle();
                    refreshImagePanel();
                }, true);
                ed.on('keydown', (e) => {
                    if (e.key === 'Escape' && selImg) { selImg = null; positionHandle(); refreshImagePanel(); }
                });
                b.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    const g = grabTarget(e);
                    if (!g) return;
                    e.preventDefault(); e.stopPropagation();
                    selImg = g.img;
                    drag = {
                        img: g.img, mode: g.mode, id: e.pointerId, sx: e.clientX, sy: e.clientY,
                        ox: parseFloat(g.img.style.left) || 0, oy: parseFloat(g.img.style.top) || 0,
                        ow: g.img.getBoundingClientRect().width
                    };
                    try { b.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                    positionHandle();
                }, true);
                b.addEventListener('pointermove', (e) => {
                    if (!drag || e.pointerId !== drag.id) return;
                    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
                    const im = drag.img;
                    if (drag.mode === 'move') {
                        im.style.left = (drag.ox + dx).toFixed(1) + 'px';
                        im.style.top = (drag.oy + dy).toFixed(1) + 'px';
                    } else {
                        im.removeAttribute('width'); im.removeAttribute('height');
                        im.style.width = Math.max(20, drag.ow + dx).toFixed(1) + 'px';
                        im.style.height = 'auto';
                    }
                    positionHandle();
                });
                const endDrag = () => {
                    if (!drag) return;
                    try { b.releasePointerCapture(drag.id); } catch (_) { /* ignore */ }
                    drag = null;
                    ed.undoManager.add();
                    setDirty(true);
                    refreshImagePanel();
                    schedulePaginate();
                };
                b.addEventListener('pointerup', endDrag);
                b.addEventListener('pointercancel', endDrag);
                refreshImagePanel();
            });
            ed.on('NodeChange', (e) => {
                const n = e.element;
                if (n && n.nodeName === 'IMG') selImg = n;
                else if (selImg && !(n && n.closest && n.closest('#tpl-ovl'))) selImg = null;   // clicked text / elsewhere → deselect
                positionHandle();
                scheduleImageRefresh();
            });
            ed.on('SetContent input change ExecCommand undo redo', scheduleImageRefresh);

            const markDirty = () => { if (!loadingContent) setDirty(true); };
            ed.on('input change undo redo SetContent ExecCommand', (e) => {
                if (e.type === 'SetContent' && loadingContent) return;
                markDirty();
            });
        }
    }).then(() => editor);
}

// File picker for the image dialog (browse → blob → uploaded by images_upload_handler)
function pickImageFile(cb, _value, meta) {
    if (meta.filetype !== 'image') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const blobCache = tinymce.activeEditor.editorUpload.blobCache;
            const base64 = String(reader.result).split(',')[1];
            const blobInfo = blobCache.create('blobid' + Date.now(), file, base64);
            blobCache.add(blobInfo);
            cb(blobInfo.blobUri(), { title: file.name });
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

// ---------------------------------------------
// Image upload → Cloudinary (unsigned preset). Returns a permanent https URL.
// Nothing is ever embedded as Base64 and nothing goes to Firebase Storage.
// ---------------------------------------------
async function cloudinaryUpload(blob, filename, resourceType = 'image') {
    if (!CLOUDINARY.cloudName || CLOUDINARY.cloudName.startsWith('YOUR_') ||
        !CLOUDINARY.uploadPreset || CLOUDINARY.uploadPreset.startsWith('YOUR_')) {
        throw new Error('Image hosting is not configured. Set CLOUDINARY.cloudName and CLOUDINARY.uploadPreset at the top of templates.js.');
    }
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('upload_preset', CLOUDINARY.uploadPreset);
    fd.append('folder', `barangay-templates/${current?.id || 'misc'}`);
    let res;
    try {
        res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY.cloudName)}/${resourceType}/upload`, {
            method: 'POST', body: fd
        });
    } catch (err) {
        throw new Error('Could not reach the image host. Check your internet connection. (' + (err.message || err) + ')');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok || !data || !data.secure_url) {
        throw new Error('Image upload failed: ' + ((data && data.error && data.error.message) || res.statusText || res.status));
    }
    return data.secure_url;
}

async function uploadImageBlob(blob, filename = 'image.png') {
    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    return cloudinaryUpload(blob, safe, 'image');
}

/** Upload any leftover data: images (e.g. from a .docx import) and replace them with hosted URLs. */
async function externalizeDataImages(html) {
    const doc2 = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const imgs = [...doc2.body.querySelectorAll('img[src^="data:image/"]')];
    for (let i = 0; i < imgs.length; i++) {
        const blob = await (await fetch(imgs[i].getAttribute('src'))).blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('+xml', '');
        imgs[i].setAttribute('src', await uploadImageBlob(blob, `image_${i + 1}.${ext}`));   // throws → save is aborted
    }
    return doc2.body.innerHTML;
}

// ---------------------------------------------
// Fields (placeholders)
// ---------------------------------------------
function allFieldGroups() {
    const groups = FIELD_GROUPS.map(g => ({ group: g.group, fields: g.fields }));
    if (residentExtraFields.length) {
        groups.push({ group: 'Other resident fields', fields: residentExtraFields });
    }
    return groups;
}

function renderFieldPanel() {
    const host = el('field-list');
    if (!host) return;
    const q = (el('field-search')?.value || '').trim().toLowerCase();
    const html = allFieldGroups().map(g => {
        const fields = g.fields.filter(f =>
            !q || f.key.toLowerCase().includes(q) || f.label.toLowerCase().includes(q));
        if (!fields.length) return '';
        return `<div class="field-group-label">${escHtml(g.group)}</div>` +
            fields.map(f => `
            <button class="field-chip" data-key="${escHtml(f.key)}" type="button">
                <code>{${escHtml(f.key)}}</code><span>${escHtml(f.label)}</span>
            </button>`).join('');
    }).join('');
    host.innerHTML = html || '<p class="side-note">No fields match.</p>';
    host.querySelectorAll('.field-chip').forEach(btn =>
        btn.addEventListener('click', () => insertField(btn.dataset.key)));
}


// ---------------------------------------------
// Keep orange field chips honest: a chip is only the exact text {key}.
// Anything typed next to it (or after pressing Enter) must NOT stay orange / inside the chip.
// Pure DOM function (no editor needed) so it can be tested on its own.
//   caret: { container, offset } of a collapsed caret, or null
//   returns { changed, caretTo: { node, offset } | null }
// ---------------------------------------------
function normalizeChipsIn(body, caret) {
    const result = { changed: false, caretTo: null };
    if (!body) return result;
    const clean = (t) => String(t).replace(/[\uFEFF\u200B]/g, '');
    const doc = body.ownerDocument;
    const lastTextOf = (node) => {
        const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let last = null, n;
        while ((n = w.nextNode())) last = n;
        return last;
    };

    body.querySelectorAll('span.ph[data-field]').forEach(chip => {
        const token = '{' + chip.getAttribute('data-field') + '}';
        if (clean(chip.textContent) === token) return;            // perfect chip
        chip.normalize();

        // find the text node that holds the token
        let tNode = null;
        const w = doc.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
            if (n.nodeValue.includes(token)) { tNode = n; break; }
        }

        // No token left (e.g. empty chip carried over by Enter, or its braces were deleted):
        // it is plain text now → drop the orange chip look and the field link.
        if (!tNode) {
            chip.classList.remove('ph');
            chip.removeAttribute('data-field');
            if (!chip.getAttribute('class')) chip.removeAttribute('class');
            result.changed = true;
            return;
        }

        const idx = tNode.nodeValue.indexOf(token);
        const end = idx + token.length;

        // where is the caret relative to the token?
        let side = null;
        if (caret && chip.contains(caret.container)) {
            if (caret.container === tNode) side = caret.offset >= end ? 'after' : (caret.offset <= idx ? 'before' : 'in');
            else side = (tNode.compareDocumentPosition(caret.container) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'after' : 'before';
        }

        // move text AFTER the token out of the chip (formatting wrappers are kept by extractContents)
        let afterNode = null, beforeNode = null;
        const rAfter = doc.createRange();
        rAfter.setStart(tNode, end);
        rAfter.setEndAfter(chip.lastChild);
        if (clean(rAfter.toString()) !== '') {
            const frag = rAfter.extractContents();
            afterNode = lastTextOf(frag);
            chip.after(frag);
            result.changed = true;
        }
        // …and text BEFORE the token
        const rBefore = doc.createRange();
        rBefore.setStart(chip, 0);
        rBefore.setEnd(tNode, idx);
        if (clean(rBefore.toString()) !== '') {
            const frag = rBefore.extractContents();
            beforeNode = lastTextOf(frag);
            chip.before(frag);
            result.changed = true;
        }

        const target = side === 'after' ? afterNode : side === 'before' ? beforeNode : null;
        if (target) result.caretTo = { node: target, offset: target.nodeValue.length };
    });
    return result;
}

let normalizingChips = false;
function normalizeChips(ed, userTriggered) {
    if (!ed || normalizingChips) return;
    const body = ed.getBody && ed.getBody();
    if (!body || !body.querySelector('span.ph[data-field]')) return;
    normalizingChips = true;
    try {
        const rng = ed.selection.getRng();
        const caret = rng && rng.collapsed ? { container: rng.startContainer, offset: rng.startOffset } : null;
        let res;
        ed.undoManager.ignore(() => { res = normalizeChipsIn(body, caret); });
        if (res && res.caretTo) ed.selection.setCursorLocation(res.caretTo.node, res.caretTo.offset);
        if (res && res.changed && userTriggered) setDirty(true);
    } catch (err) {
        console.warn('Field chip cleanup failed:', err);
    } finally {
        normalizingChips = false;
    }
}

function insertField(key) {
    if (!editor) return;
    editor.focus();
    editor.insertContent(`<span class="ph" data-field="${escHtml(key)}">{${escHtml(key)}}</span>`);
    setDirty(true);
}

function insertPageBreak(blank) {
    if (!editor) return;
    editor.focus();
    editor.insertContent(`<div class="tpl-pagebreak" data-pagebreak="${blank ? 'blank' : '1'}" contenteditable="false"></div>`);
    setDirty(true);
    schedulePaginate();
}

// ---------------------------------------------
// Page settings (size / orientation / margins / border)
// ---------------------------------------------
function initPageSettingsUI() {
    const sel = el('ps-size');
    if (sel && !sel.options.length) {
        sel.innerHTML = Object.entries(PAGE_SIZES)
            .map(([k, v]) => `<option value="${k}">${escHtml(v.label)}</option>`).join('');
    }
    ['ps-size', 'ps-orient', 'ps-mt', 'ps-mb', 'ps-ml', 'ps-mr', 'ps-bstyle', 'ps-bwidth', 'ps-bcolor']
        .forEach(id => el(id)?.addEventListener('input', readPageSettingsUI));
    syncPageSettingsUI();
}

function syncPageSettingsUI() {
    const s = pageSettings;
    const set = (id, v) => { const n = el(id); if (n) n.value = v; };
    set('ps-size', s.size);
    set('ps-orient', s.orientation);
    set('ps-mt', s.margins.top);
    set('ps-mb', s.margins.bottom);
    set('ps-ml', s.margins.left);
    set('ps-mr', s.margins.right);
    set('ps-bstyle', s.border.style);
    set('ps-bwidth', s.border.width);
    set('ps-bcolor', s.border.color);
}

function readPageSettingsUI() {
    pageSettings = normalizePageSettings({
        v: 2,
        size: el('ps-size')?.value,
        orientation: el('ps-orient')?.value,
        margins: {
            top: el('ps-mt')?.value, bottom: el('ps-mb')?.value,
            left: el('ps-ml')?.value, right: el('ps-mr')?.value
        },
        border: {
            style: el('ps-bstyle')?.value,
            width: el('ps-bwidth')?.value,
            color: el('ps-bcolor')?.value
        }
    });
    applyPageToEditor();
    setDirty(true);
}

/** Make the editor's page look exactly like the printed paper. */
function applyPageToEditor() {
    if (!editor) return;
    const body = editor.getBody?.();
    if (!body) return;
    Object.entries(paperStyleObject(pageSettings)).forEach(([k, v]) => body.style.setProperty(k, v));
    body.style.setProperty('margin', '16px auto');
    body.style.setProperty('position', 'relative');
    body.style.setProperty('isolation', 'isolate');
    body.style.setProperty('z-index', '1');
    paginateEditor();
}

// ---------------------------------------------
// Editor pagination: shows real page-sized sheets with a gap between them.
// Content that would cross a page end is pushed to the next page with a temporary
// margin (rules live in an injected <style>; the data-pg marker is removed in GetContent,
// so nothing extra is ever saved, previewed, printed or exported).
// ---------------------------------------------
const PAGE_GAP_PX = EDITOR_PAGE_GAP_PX;
const MM_PX = 96 / 25.4;
let paginateTimer = null;

function schedulePaginate() {
    clearTimeout(paginateTimer);
    paginateTimer = setTimeout(paginateEditor, 150);
}

function paginateEditor() {
    if (!editor) return;
    const body = editor.getBody?.();
    const doc2 = editor.getDoc?.();
    const win = editor.getWin?.();
    if (!body || !doc2 || !win) return;

    let st = doc2.getElementById('pg-style');
    if (!st) { st = doc2.createElement('style'); st.id = 'pg-style'; doc2.head.appendChild(st); }
    body.querySelectorAll('[data-pg]').forEach(n => n.removeAttribute('data-pg'));
    st.textContent = '';

    // The sheets (white page + real border + shadow) are drawn separately, so the body itself
    // only keeps a transparent border of the same width (keeps text wrapping identical to print).
    const geo = pageGeometry(pageSettings);
    body.style.setProperty('border', geo.bw ? `${geo.bw}px solid transparent` : '0 none');
    body.style.setProperty('background', 'transparent');
    body.style.setProperty('box-shadow', 'none');

    const cs = win.getComputedStyle(body);
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bodyH = pageGeometry(pageSettings).bodyH;
    const pageH = pt + bodyH + pb;           // one sheet, in px
    const P = pageH + PAGE_GAP_PX;           // distance from one sheet's top to the next
    const originY = body.getBoundingClientRect().top + bw + pt;   // content-box top (y = 0)
    const rectY = (r) => r.top - originY;

    // 1) collect the pieces that may be moved (blocks; table rows; list items)
    const units = [];
    const flows = (n) => { const c = win.getComputedStyle(n); return c.position !== 'absolute' && c.position !== 'fixed' && c.float === 'none'; };
    let prevBottom = 0;
    for (const child of body.children) {
        const tag = child.tagName;
        if (tag === 'STYLE' || tag === 'SCRIPT') continue;
        if (child.hasAttribute('data-pagebreak')) {
            units.push({ mode: 'break', blank: child.getAttribute('data-pagebreak') === 'blank', h: 0 });
            continue;
        }
        if (!flows(child)) continue;
        const cr = child.getBoundingClientRect();
        if (tag === 'TABLE') {
            let first = true;
            for (const tr of child.rows) {
                const r = tr.getBoundingClientRect();
                units.push({ m: tr, a: tr, mode: 'row', top: rectY(r), bottom: rectY(r) + r.height, h: r.height });
                first = false;
            }
            if (first) units.push({ m: child, a: child, mode: 'block', top: rectY(cr), bottom: rectY(cr) + cr.height, h: cr.height, gap0: rectY(cr) - prevBottom });
        } else if ((tag === 'UL' || tag === 'OL') && child.children.length > 1) {
            let i = 0;
            let lastBottom = prevBottom;
            for (const li of child.children) {
                const r = li.getBoundingClientRect();
                const u = { m: li, a: i === 0 ? child : li, mode: 'block', top: rectY(r), bottom: rectY(r) + r.height, h: r.height };
                u.gap0 = i === 0 ? rectY(cr) - prevBottom : rectY(r) - lastBottom;
                units.push(u);
                lastBottom = u.bottom;
                i++;
            }
        } else {
            units.push({ m: child, a: child, mode: 'block', top: rectY(cr), bottom: rectY(cr) + cr.height, h: cr.height, gap0: rectY(cr) - prevBottom });
        }
        prevBottom = rectY(cr) + cr.height;
    }

    // 2) walk top→bottom, pushing anything that crosses a page end (or follows a page break) onto the next sheet
    let shift = 0, k = 0, lastBottomY = 0, pending = 0, basePage = 0;
    const rules = [];
    const pushUnit = (u, d) => {
        k++;
        u.a.setAttribute('data-pg', String(k));
        if (u.mode === 'row') {
            [...u.a.children].forEach((cell, i) => {
                const p0 = parseFloat(win.getComputedStyle(cell).paddingTop) || 0;
                rules.push(`[data-pg="${k}"]>:nth-child(${i + 1}){padding-top:${(p0 + d).toFixed(1)}px !important}`);
            });
        } else {
            rules.push(`[data-pg="${k}"]{margin-top:${((u.gap0 || 0) + d).toFixed(1)}px !important}`);
        }
        shift += d;
    };
    for (const u of units) {
        if (u.mode === 'break') {
            if (!pending) basePage = Math.max(0, Math.floor((lastBottomY - 0.5) / P));
            const inc = u.blank ? 2 : 1;
            pending += lastBottomY > 0 ? inc : inc - 1;
            continue;
        }
        if (u.h < 1) continue;
        if (pending) {
            const d0 = (basePage + pending) * P - (u.top + shift);
            pending = 0;
            if (d0 > 0.5) pushUnit(u, d0);
        }
        const top = u.top + shift;
        const bottom = u.bottom + shift;
        const page = Math.floor(top / P);
        const contentEnd = page * P + bodyH;
        const inMargin = top >= contentEnd - 0.5;
        const crosses = bottom > contentEnd + 0.5 && u.h <= bodyH;
        if (inMargin || crosses) {
            const d = (page + 1) * P - top;
            if (d > 0.5) pushUnit(u, d);
        }
        lastBottomY = u.bottom + shift;
    }
    if (pending > 1) lastBottomY = (basePage + pending - 1) * P + 1;   // blank page at the very end
    st.textContent = rules.join('\n');

    // 3) draw the sheets: white page, thin edge lines, grey gap in between
    const pages = Math.max(1, Math.floor((lastBottomY - 0.5) / P) + 1);
    window.__tplPages = pages;
    body.style.setProperty('min-height', `${(pages * P - PAGE_GAP_PX + 2 * bw).toFixed(1)}px`);
    drawSheets(body, doc2, pages, P, pageH, bw);
    positionHandle();
}

// One white sheet per page with its own border and shadow; the grey gap between sheets is the page break.
// The sheets live in a wrapper that is a sibling of <body> (child of <html>), NOT inside the body:
// non-editable blocks inside the body make TinyMCE draw its black "fake caret" line next to them,
// which showed up as a big black line that appeared and disappeared while typing / moving the cursor.
function drawSheets(body, doc2, pages, P, pageH, bw) {
    body.querySelectorAll('.tpl-sheet, #tpl-sheets').forEach(n => n.remove());   // clean up older versions
    const html = doc2.documentElement;
    const win = doc2.defaultView;
    let wrap = doc2.getElementById('tpl-sheets');
    if (!wrap) {
        wrap = doc2.createElement('div');
        wrap.id = 'tpl-sheets';
        wrap.setAttribute('data-mce-bogus', 'all');
        wrap.setAttribute('aria-hidden', 'true');
        html.insertBefore(wrap, body);          // before <body> so it paints underneath the text
    }
    // The wrapper spans the same width as <body>'s containing block and centres its inner box with
    // `margin:0 auto`, exactly like the body does. So the sheets keep following the body when the
    // scrollbar appears / disappears, the window or side panels resize, or the focus changes. (They used to
    // be placed with pixel coordinates measured once, which went stale and left the paper out of step
    // with the text and the images, which are body-relative.)
    const mt = parseFloat(win.getComputedStyle(body).marginTop) || 0;
    wrap.style.cssText = `position:absolute;left:0;right:0;top:${mt}px;height:0;pointer-events:none;user-select:none`;
    const b = pageSettings.border;
    const border = (b.style !== 'none' && b.width > 0) ? `${b.width}px ${b.style} ${b.color}` : 'none';
    const w = body.offsetWidth;                 // body border-box width
    let out = `<div style="position:relative;width:${w}px;margin:0 auto;pointer-events:none">`;
    for (let i = 0; i < pages; i++) {
        out += `<div class="tpl-sheet" style="position:absolute;pointer-events:none;box-sizing:border-box;background:#fff;` +
            `box-shadow:0 1px 8px rgba(0,0,0,.28);left:0;top:${(i * P).toFixed(1)}px;` +
            `width:${w}px;height:${(pageH + 2 * bw).toFixed(1)}px;border:${border}"></div>`;
    }
    wrap.innerHTML = out + '</div>';
}

// ---------------------------------------------
// Images: layout (behind / in front / wrap), exact position, drag, size, opacity
// Positions are stored on the image itself (style + data-layout), so they are saved with the
// template and drawn on the matching page in Preview / Print — including inside the margins.
// ---------------------------------------------
let selImg = null;
let imgRefreshTimer = null;
const isOverlayImg = (img) => ['behind', 'front'].includes(img.getAttribute('data-layout'));
const LAYOUT_LABEL = { inline: 'In line', left: 'Wrap left', right: 'Wrap right', center: 'Centered', behind: 'Behind text', front: 'In front' };

function sheetPitch() {
    const body = editor.getBody();
    const cs = editor.getWin().getComputedStyle(body);
    const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    return pt + pageGeometry(pageSettings).bodyH + pb + PAGE_GAP_PX;
}

// Selection frame with a move (✥) and resize grip, drawn over the selected behind / in-front image.
// It is a bogus element: TinyMCE never saves it.
function positionHandle() {
    if (!editor || !editor.getBody) return;
    const body = editor.getBody();
    if (!body) return;
    let h = body.querySelector('#tpl-ovl');
    if (!selImg || !body.contains(selImg) || !isOverlayImg(selImg)) { if (h) h.remove(); return; }
    if (!h) {
        h = editor.getDoc().createElement('div');
        h.id = 'tpl-ovl';
        h.setAttribute('data-mce-bogus', 'all');
        h.setAttribute('contenteditable', 'false');
        h.innerHTML = '<div class="tpl-grip mv" data-mce-bogus="all" title="Drag to move">\u2725</div>' +
                      '<div class="tpl-grip rz" data-mce-bogus="all" title="Drag to resize"></div>';
        body.appendChild(h);
    }
    const cs = editor.getWin().getComputedStyle(body);
    const r = selImg.getBoundingClientRect(), br = body.getBoundingClientRect();
    h.style.left = (r.left - br.left - (parseFloat(cs.borderLeftWidth) || 0)).toFixed(1) + 'px';
    h.style.top = (r.top - br.top - (parseFloat(cs.borderTopWidth) || 0)).toFixed(1) + 'px';
    h.style.width = r.width.toFixed(1) + 'px';
    h.style.height = r.height.toFixed(1) + 'px';
}

/** Stretch the selected image across the page at the very top (header) or bottom (footer), repeated on every page. */
function placeImageBand(where) {
    if (!selImg || !editor) return;
    const cur = selImg.getAttribute('data-layout');
    const mode = (cur === 'behind' || cur === 'front') ? cur : 'front';
    const P = sheetPitch();
    const pageH = P - PAGE_GAP_PX;
    const topNow = parseFloat(selImg.style.top);
    const k = Number.isFinite(topNow) ? Math.max(0, Math.floor(topNow / P)) : 0;
    const fullW = editor.getBody().clientWidth;
    setImageLayout(selImg, mode, { x: 0, y: k * P, width: fullW, repeat: true });
    if (where === 'footer') {
        const h = selImg.getBoundingClientRect().height;
        selImg.style.top = (k * P + pageH - h).toFixed(1) + 'px';
        afterImageChange();
    }
    showToast((where === 'footer' ? 'Footer' : 'Header') + ' image placed and set to repeat on every page. Drag the \u2725 handle to fine-tune.', 4500);
}

function scheduleImageRefresh() {
    clearTimeout(imgRefreshTimer);
    imgRefreshTimer = setTimeout(refreshImagePanel, 200);
}

function afterImageChange() {
    editor.undoManager.add();
    setDirty(true);
    schedulePaginate();
    refreshImagePanel();
}

function setImageLayout(img, mode, pos = {}) {
    if (!img || !editor) return;
    editor.undoManager.transact(() => applyImageLayout(img, mode, pos));
    selImg = img;
    afterImageChange();
}

function refreshImagePanel() {
    const host = el('img-list');
    if (!host || !editor || !editor.getBody) return;
    const body = editor.getBody();
    if (!body) return;
    const imgs = [...body.querySelectorAll('img')];
    if (selImg && !body.contains(selImg)) selImg = null;
    host.innerHTML = '';
    if (!imgs.length) {
        const n = document.createElement('p');
        n.className = 'side-note';
        n.textContent = 'No images yet. Use Insert ▸ Image (or import a .docx), then choose how it sits here.';
        host.appendChild(n);
    }
    imgs.forEach((img, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'field-chip' + (img === selImg ? ' sel' : '');
        const c = document.createElement('code');
        c.textContent = 'Image ' + (i + 1);
        const s = document.createElement('span');
        s.textContent = LAYOUT_LABEL[img.getAttribute('data-layout') || 'inline'] || 'In line';
        b.append(c, s);
        b.addEventListener('click', () => {
            selImg = img;
            editor.selection.select(img);
            editor.focus();
            try { img.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ }
            refreshImagePanel();
        });
        host.appendChild(b);
    });
    syncImageProps();
}

function syncImageProps() {
    positionHandle();
    const box = el('img-props');
    if (!box) return;
    if (!selImg || !editor || !editor.getBody().contains(selImg)) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const mode = selImg.getAttribute('data-layout') || 'inline';
    const free = mode === 'behind' || mode === 'front';
    const set = (id, v) => { const n = el(id); if (n) n.value = v; };
    set('img-layout', mode);
    const P = sheetPitch();
    const left = parseFloat(selImg.style.left), top = parseFloat(selImg.style.top);
    const k = Number.isFinite(top) ? Math.max(0, Math.floor(top / P)) : 0;
    set('img-page', k + 1);
    set('img-x', Number.isFinite(left) ? (left / MM_PX).toFixed(1) : '0');
    set('img-y', Number.isFinite(top) ? ((top - k * P) / MM_PX).toFixed(1) : '0');
    set('img-w', (selImg.getBoundingClientRect().width / MM_PX).toFixed(1));
    set('img-opacity', Math.round((parseFloat(selImg.style.opacity) || 1) * 100));
    const rep = el('img-repeat');
    if (rep) rep.checked = selImg.getAttribute('data-repeat') === '1';
    ['img-page', 'img-x', 'img-y', 'img-opacity', 'img-repeat', 'btn-img-drag', 'btn-img-full'].forEach(id => { const n = el(id); if (n) n.disabled = !free; });
}

function readImageProps() {
    if (!selImg || !editor) return;
    const mode = el('img-layout')?.value || 'inline';
    const free = mode === 'behind' || mode === 'front';
    const num = (id, d) => { const v = parseFloat(el(id)?.value); return Number.isFinite(v) ? v : d; };
    const pos = {};
    const w = num('img-w', 0);
    if (w > 5) pos.width = w * MM_PX;
    if (free) {
        const P = sheetPitch();
        const page = Math.max(1, Math.round(num('img-page', 1)));
        pos.x = num('img-x', 0) * MM_PX;
        pos.y = (page - 1) * P + num('img-y', 0) * MM_PX;
        pos.opacity = Math.min(100, Math.max(5, num('img-opacity', 100))) / 100;
        pos.repeat = !!el('img-repeat')?.checked;
    }
    setImageLayout(selImg, mode, pos);
}

function initImagePanel() {
    ['img-layout', 'img-page', 'img-x', 'img-y', 'img-w', 'img-opacity', 'img-repeat']
        .forEach(id => el(id)?.addEventListener('change', readImageProps));

    el('btn-img-drag')?.addEventListener('click', () => {
        if (!editor) return;
        const b = editor.getBody();
        const on = !b.classList.contains('tpl-move');
        b.classList.toggle('tpl-move', on);
        el('btn-img-drag').classList.toggle('on', on);
        el('btn-img-drag').textContent = on ? 'Done moving' : 'Drag on page';
        if (on) showToast('Drag the highlighted image anywhere — even into the margins. Click "Done moving" when finished.', 4500);
    });

    el('btn-img-full')?.addEventListener('click', () => {
        if (!selImg || !editor) return;
        const mode = selImg.getAttribute('data-layout') || 'inline';
        const P = sheetPitch();
        const top = parseFloat(selImg.style.top) || 0;
        const k = Math.max(0, Math.floor(top / P));
        const innerW = editor.getBody().clientWidth;
        setImageLayout(selImg, mode, { x: 0, y: top, width: innerW });
        syncImageProps();
        void k;
    });

    el('btn-img-header')?.addEventListener('click', () => placeImageBand('header'));
    el('btn-img-footer')?.addEventListener('click', () => placeImageBand('footer'));

    el('btn-img-del')?.addEventListener('click', () => {
        if (!selImg || !editor) return;
        editor.undoManager.transact(() => selImg.remove());
        selImg = null;
        afterImageChange();
    });
}

// ---------------------------------------------
// Save / Reset / Remove
// ---------------------------------------------
function setSaving(on) {
    const btn = el('btn-save');
    const label = el('save-tpl-label');
    if (!btn || !label) return;
    btn.disabled = on;
    label.innerHTML = on ? '<div class="spinner"></div> Saving…' : 'Save Template';
}

async function saveTemplate() {
    if (!editor || !current) return;
    setSaving(true);
    try {
        await editor.uploadImages();                    // push pasted / picked images to the image host
        syncOverlayData();
        let html = editor.getContent();
        html = await externalizeDataImages(html);       // e.g. images that came from a .docx
        html = sanitizeHtml(html);

        if (/<img[^>]+src=["']?\s*(data:|blob:)/i.test(html)) {
            throw new Error('An image could not be uploaded to the image host, so the template was not saved.');
        }
        if (!html.replace(/<[^>]*>/g, '').trim() && !/<img/i.test(html)) {
            throw new Error('The template is empty.');
        }
        const bytes = new Blob([html]).size;
        if (bytes > MAX_TEMPLATE_BYTES) {
            throw new Error(`Template is too large (${Math.round(bytes / 1024)} KB). Remove inline images or simplify it.`);
        }

        const refDoc = doc(db, 'documentTemplates', current.id);
        const prev = await getDoc(refDoc);
        const base = prev.exists() ? prev.data() : null;

        // Keep the original .docx (with its real headers / footers) so it survives a reload.
        // Best effort, hosted on Cloudinary (raw file) — a failure never blocks saving the template.
        if (originalDocxBuffer && originalDocxFresh) {
            try {
                const name = (originalDocxFile && originalDocxFile.name) || 'original.docx';
                const url = await cloudinaryUpload(new Blob([originalDocxBuffer]), name, 'raw');
                storedOriginal = { url, name };
                originalDocxFresh = false;
            } catch (err) {
                console.warn('Could not store original .docx:', err);
                showToast('Template saved, but the original Word file could not be stored for later export.', 5000);
            }
        }

        await setDoc(refDoc, {
            originalDocx: storedOriginal || null,
            documentId: current.id,
            documentName: current.name,
            html,
            pageSettings: normalizePageSettings(pageSettings),
            version: ((base && base.version) || 0) + 1,
            createdAt: (base && base.createdAt) || serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || null
        });

        setDirty(false);
        showToast(`"${current.name}" template saved ✓`);
    } catch (err) {
        console.error('Save template failed:', err);
        showToast('Save failed: ' + (err.message || err), 5000);
    } finally {
        setSaving(false);
    }
}

async function resetToStandardLayout() {
    if (!editor || !current) return;
    if (!(await confirmDialog({
        title: 'Load the standard layout?',
        text: 'This replaces everything in the editor with the standard barangay certificate layout. Nothing is saved until you click Save Template.',
        yesLabel: 'Load layout', danger: true
    }))) return;
    pageSettings = normalizePageSettings(DEFAULT_PAGE_SETTINGS);
    syncPageSettingsUI();
    clearOriginalDocx();
    storedOriginal = null;
    setEditorContent(defaultTemplateHtml());
    applyPageToEditor();
    setDirty(true);
}

async function removeCustomTemplate() {
    if (!current) return;
    if (!templates[current.id]) {
        showToast('This document type has no saved custom template.');
        return;
    }
    if (!(await confirmDialog({
        title: 'Remove custom template?',
        text: `"${current.name}" will go back to the built-in certificate layout for all future requests. Other document types are not affected.`,
        yesLabel: 'Remove', danger: true
    }))) return;
    try {
        await deleteDoc(doc(db, 'documentTemplates', current.id));
        clearOriginalDocx();
        storedOriginal = null;
        pageSettings = normalizePageSettings(DEFAULT_PAGE_SETTINGS);
        syncPageSettingsUI();
        setEditorContent(defaultTemplateHtml());
        applyPageToEditor();
        setDirty(false);
        showToast('Custom template removed.');
    } catch (err) {
        showToast('Could not remove template: ' + err.message, 5000);
    }
}

// ---------------------------------------------
// Preview (uses the CURRENT editor content, even if unsaved)
// ---------------------------------------------
let lastPreviewHtml = '';

function ensureBaseCssTag() {
    if (document.getElementById('tpl-base-css')) return;
    const s = document.createElement('style');
    s.id = 'tpl-base-css';
    s.textContent = baseCss('.tpl-paper');
    document.head.appendChild(s);
}

async function openPreview() {
    if (!editor) return;
    await editor.uploadImages().catch(() => {});
    ensureBaseCssTag();
    const values = sampleValues(residentExtraFields);
    const qr = makeQrDataUrl('BRY-2026-12345', 100);
    lastPreviewHtml = renderTemplateHtml(editor.getContent(), values, {
        qrDataUrl: qr, baseUrl: APP_ROOT
    });
    const paper = el('preview-paper');
    paper.removeAttribute('style');
    paper.innerHTML = '<div style="text-align:center;color:#666;padding:24px">Preparing preview…</div>';
    el('preview-modal').classList.add('open');
    const popts = { values, qrDataUrl: qr, baseUrl: APP_ROOT };
    await mountPages(paper, lastPreviewHtml, pageSettings, popts);   // real fixed-size pages, same as print
    el('pv-print').onclick = () => printTemplateHtml(lastPreviewHtml, pageSettings, 'Template test print', popts);
}

// ---------------------------------------------
// .docx import / export
// ---------------------------------------------

// Mammoth cannot output inline styles, so paragraph alignment is carried through a temporary
// style name (see docxTransformDocument) → class "tpl-al-<x>" → turned into text-align afterwards.
const DOCX_ALIGN_MAP = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const DOCX_ALIGN_TAG = '__tplAlign_';
const DOCX_ALIGN_HEADINGS = [
    ['Heading 1', 'h1'], ['Heading 2', 'h2'], ['Heading 3', 'h3'],
    ['Heading 4', 'h4'], ['Heading 5', 'h5'], ['Heading 6', 'h6'],
    ['Title', 'h1'], ['Subtitle', 'h2']
];

function docxStyleMap() {
    const map = [
        'u => u',
        'strike => s',
        "br[type='page'] => hr.tpl-pagebreak",
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh"
    ];
    for (const a of new Set(Object.values(DOCX_ALIGN_MAP))) {
        for (const [style, tag] of DOCX_ALIGN_HEADINGS) {
            map.push(`p[style-name='${style}${DOCX_ALIGN_TAG}${a}'] => ${tag}.tpl-al-${a}:fresh`);
        }
        map.push(`p[style-name='${DOCX_ALIGN_TAG}${a}'] => p.tpl-al-${a}:fresh`);
    }
    return map;
}

// Tags centred / right / justified paragraphs so docxStyleMap() can turn them into classes.
function docxTransformDocument() {
    return mammoth.transforms.paragraph((p) => {
        const a = DOCX_ALIGN_MAP[p.alignment];
        if (!a || p.numbering) return p;                       // left-aligned (default) or list item
        const isHeading = DOCX_ALIGN_HEADINGS.some(([s]) => s.toLowerCase() === String(p.styleName || '').toLowerCase());
        const base = isHeading ? DOCX_ALIGN_HEADINGS.find(([s]) => s.toLowerCase() === p.styleName.toLowerCase())[0] : '';
        return { ...p, styleName: base + DOCX_ALIGN_TAG + a };
    });
}

// Mammoth HTML → HTML for TinyMCE: alignment classes → inline text-align, page breaks → editor page breaks.
function docxHtmlForEditor(html, textBoxes) {
    const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    docxRestoreTextBoxes(d, textBoxes);
    d.body.querySelectorAll('[class*="tpl-al-"]').forEach((node) => {
        const m = /\btpl-al-(center|right|justify)\b/.exec(node.className);
        if (!m) return;
        node.style.textAlign = m[1];
        node.classList.remove('tpl-al-' + m[1]);
        if (!node.classList.length) node.removeAttribute('class');
    });
    d.body.querySelectorAll('hr.tpl-pagebreak').forEach((hr) => {
        const brk = d.createElement('div');
        brk.className = 'tpl-pagebreak';
        brk.setAttribute('data-pagebreak', '1');
        brk.setAttribute('contenteditable', 'false');
        // A Word page break sits inside a <p>, and <hr> cannot, so the HTML parser has already closed
        // that paragraph and left one empty <p> behind after the <hr>: drop it.
        const next = hr.nextElementSibling;
        if (next && next.tagName === 'P' && !next.textContent.trim() && !next.querySelector('img')) next.remove();
        hr.replaceWith(brk);
    });
    return d.body.innerHTML;
}

// `state` (optional) = { infos, i }: infos come from docxImageInfos(); each converted image gets the
// info of the picture at the same position in the Word file as a temporary data-dx attribute.
function docxMammothOptions(state) {
    return {
        styleMap: docxStyleMap(),
        transformDocument: docxTransformDocument(),
        ignoreEmptyParagraphs: false,
        convertImage: mammoth.images.imgElement((image) => {
            const idx = state ? state.i++ : -1;          // counted synchronously = document order
            const info = state && state.infos ? state.infos[idx] : null;
            return image.read('base64').then((b64) => {
                const attrs = { src: `data:${image.contentType};base64,${b64}` };
                if (info) attrs['data-dx'] = JSON.stringify(info);
                return attrs;
            });
        })
    };
}

// ---------------------------------------------
// Word picture layout (behind text / in front / wrapped / in line) and position
// Mammoth only returns the picture itself, so the layout is read from the DrawingML in the .docx
// (wp:inline / wp:anchor) and re-applied to the editor images afterwards (applyDocxImageLayouts).
// ---------------------------------------------
const DX_NS = {
    w:  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    a:  'http://schemas.openxmlformats.org/drawingml/2006/main',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006'
};
const DX_EMU_PX = 9525;   // EMU per CSS px

/** True for a DrawingML group (wpg) or a single shape (wps) – drawn by docxVectorsToPng(), not a plain picture. */
function dxIsVector(drawing) {
    const gd = drawing.getElementsByTagNameNS(DX_NS.a, 'graphicData')[0];
    const uri = (gd && gd.getAttribute('uri')) || '';
    return /wordprocessingGroup|wordprocessingShape/.test(uri);
}

/** One entry per picture, in document order (same order Mammoth converts them). null = not tracked. */
function docxImageInfos(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    const out = [];
    const kid = (n, ns, name) => [...n.childNodes].find(c => c.nodeType === 1 && c.namespaceURI === ns && c.localName === name) || null;
    const emu = (n) => { const v = n && parseFloat(n.textContent); return Number.isFinite(v) ? v / DX_EMU_PX : 0; };

    const readDrawing = (drawing) => {
        const anchor = kid(drawing, DX_NS.wp, 'anchor');
        const inline = kid(drawing, DX_NS.wp, 'inline');
        const host = anchor || inline;
        if (!host) return;
        const blips = [...drawing.getElementsByTagNameNS(DX_NS.a, 'blip')]
            .filter(b => b.getAttribute('r:embed') || b.getAttribute('r:link'));
        // Grouped / vector drawings (shapes, lines, pictures in one group) become ONE picture (see docxVectorsToPng)
        const isVec = dxIsVector(drawing);
        let info = { t: 'i' };
        if (anchor) {
            const ext = kid(anchor, DX_NS.wp, 'extent');
            const wrapEl = [...anchor.childNodes].find(c => c.nodeType === 1 && c.namespaceURI === DX_NS.wp && /^wrap/.test(c.localName));
            const ph = kid(anchor, DX_NS.wp, 'positionH'), pv = kid(anchor, DX_NS.wp, 'positionV');
            const pos = (p) => p ? {
                rel: p.getAttribute('relativeFrom') || '',
                off: emu(kid(p, DX_NS.wp, 'posOffset')),
                align: (kid(p, DX_NS.wp, 'align')?.textContent || '').trim()
            } : { rel: '', off: 0, align: '' };
            const H = pos(ph), V = pos(pv);
            info = {
                t: 'a',
                behind: anchor.getAttribute('behindDoc') === '1',
                wrap: wrapEl ? wrapEl.localName : 'wrapNone',
                w: ext ? Math.round(parseFloat(ext.getAttribute('cx')) / DX_EMU_PX) || 0 : 0,
                h: ext ? Math.round(parseFloat(ext.getAttribute('cy')) / DX_EMU_PX) || 0 : 0,
                hrel: H.rel, hoff: H.off, halign: H.align,
                vrel: V.rel, voff: V.off, valign: V.align
            };
        }
        if (isVec) out.push(info);
        else blips.forEach(() => out.push(info));
    };

    const walk = (n) => {
        for (const c of n.childNodes) {
            if (c.nodeType !== 1) continue;
            if (c.namespaceURI === DX_NS.mc && c.localName === 'Fallback') continue;   // Word's duplicate copy
            if (c.namespaceURI === DX_NS.w && c.localName === 'drawing') { readDrawing(c); continue; }
            if (c.namespaceURI === DX_NS.w && c.localName === 'pict') {                  // old VML picture
                [...c.getElementsByTagName('*')].filter(e => e.localName === 'imagedata').forEach(() => out.push(null));
                continue;
            }
            walk(c);
        }
    };
    walk(doc.documentElement);
    return out;
}

// ---------------------------------------------
// Word fidelity pre-pass (runs on a COPY of the package before Mammoth; the original is never touched)
//   1) Alignment that comes from a Word *style* (or the document defaults) is written onto the
//      paragraph as a direct <w:jc>, because Mammoth only sees direct alignment.
//   2) Text boxes (Mammoth drops them) become one-cell tables, so each box stays a separate section
//      with its own border / fill / width / alignment / inner text alignment.
// ---------------------------------------------
const DXT_NS = Object.assign({}, DX_NS, {
    wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
    v:   'urn:schemas-microsoft-com:vml'
});
const dxKids = (n, ns, name) => [...n.childNodes].filter(c => c.nodeType === 1 && c.namespaceURI === ns && c.localName === name);
const dxKid = (n, ns, name) => dxKids(n, ns, name)[0] || null;
const dxUp = (n, ns, name) => {
    for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) {
        if (p.namespaceURI === ns && p.localName === name) return p;
    }
    return null;
};

function docxMaterializeAlignment(doc, stylesDoc) {
    const W = DXT_NS.w;
    const val = (el) => (el ? el.getAttributeNS(W, 'val') : '');
    const jcOf = (pPr) => val(pPr && dxKid(pPr, W, 'jc'));
    const styles = {};
    let defaultPara = '', docDefault = '';
    if (stylesDoc) {
        const dd = stylesDoc.getElementsByTagNameNS(W, 'docDefaults')[0];
        const ppd = dd && dxKid(dd, W, 'pPrDefault');
        docDefault = jcOf(ppd && dxKid(ppd, W, 'pPr'));
        for (const st of stylesDoc.getElementsByTagNameNS(W, 'style')) {
            if (st.getAttributeNS(W, 'type') !== 'paragraph') continue;
            const id = st.getAttributeNS(W, 'styleId');
            styles[id] = { jc: jcOf(dxKid(st, W, 'pPr')), based: val(dxKid(st, W, 'basedOn')) };
            if (st.getAttributeNS(W, 'default') === '1') defaultPara = id;
        }
    }
    const fromStyle = (id) => {
        const seen = new Set();
        while (id && styles[id] && !seen.has(id)) {
            seen.add(id);
            if (styles[id].jc) return styles[id].jc;
            id = styles[id].based;
        }
        return '';
    };
    let changed = 0;
    for (const p of [...doc.getElementsByTagNameNS(W, 'p')]) {
        let pPr = dxKid(p, W, 'pPr');
        if (pPr && dxKid(pPr, W, 'jc')) continue;                       // direct alignment wins
        const ps = pPr && dxKid(pPr, W, 'pStyle');
        const eff = fromStyle(ps ? val(ps) : defaultPara) || docDefault;
        if (!eff || eff === 'left' || eff === 'start') continue;
        const jc = doc.createElementNS(W, 'w:jc');
        jc.setAttributeNS(W, 'w:val', eff);
        if (!pPr) { pPr = doc.createElementNS(W, 'w:pPr'); p.insertBefore(pPr, p.firstChild); }
        pPr.insertBefore(jc, dxKid(pPr, W, 'rPr'));                     // null → appended
        changed++;
    }
    return changed;
}

// shape look / size / position of one text box (DrawingML text box or old VML one)
function docxReadTextBox(unit, T) {
    const { wp: WP, a: A, wps: WPS, v: V } = DXT_NS;
    const info = { w: 0, h: 0, halign: '', hrel: '', hoff: 0, border: 'none', fill: '', pad: [4.8, 9.6, 4.8, 9.6], valign: '' };
    const clr = (fill) => {
        const c = fill && dxKid(fill, A, 'srgbClr');
        return c && /^[0-9a-f]{6}$/i.test(c.getAttribute('val') || '') ? '#' + c.getAttribute('val') : '';
    };
    const wsp = dxUp(T, WPS, 'wsp');
    if (wsp) {
        const spPr = dxKid(wsp, WPS, 'spPr');
        const ext = spPr && dxKid(spPr, A, 'xfrm') && dxKid(dxKid(spPr, A, 'xfrm'), A, 'ext');
        if (ext) { info.w = Math.round(parseFloat(ext.getAttribute('cx')) / DX_EMU_PX) || 0; info.h = Math.round(parseFloat(ext.getAttribute('cy')) / DX_EMU_PX) || 0; }
        const ln = spPr && dxKid(spPr, A, 'ln');
        if (ln) {
            if (!dxKid(ln, A, 'noFill')) {
                const wpx = Math.max(1, Math.round((parseFloat(ln.getAttribute('w')) || 9525) / DX_EMU_PX));
                info.border = `${wpx}px solid ${clr(dxKid(ln, A, 'solidFill')) || '#000'}`;
            }
        } else if (dxKid(wsp, WPS, 'style')) info.border = '1px solid #000';
        info.fill = clr(spPr && dxKid(spPr, A, 'solidFill'));
        const bp = dxKid(wsp, WPS, 'bodyPr');
        if (bp) {
            ['tIns', 'rIns', 'bIns', 'lIns'].forEach((k, i) => {
                const n = parseFloat(bp.getAttribute(k));
                if (Number.isFinite(n)) info.pad[i] = Math.round(n / DX_EMU_PX * 10) / 10;
            });
            info.valign = { t: 'top', ctr: 'middle', b: 'bottom' }[bp.getAttribute('anchor')] || '';
        }
    }
    const drawing = unit.localName === 'drawing' ? unit : unit.getElementsByTagNameNS(DXT_NS.w, 'drawing')[0];
    const host = drawing && (dxKid(drawing, WP, 'anchor') || dxKid(drawing, WP, 'inline'));
    if (host && !dxUp(T, DXT_NS.wps, 'wgp') && !(wsp && dxUp(wsp, 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup', 'wgp'))) {
        const ext = dxKid(host, WP, 'extent');
        if (ext && !info.w) { info.w = Math.round(parseFloat(ext.getAttribute('cx')) / DX_EMU_PX) || 0; info.h = Math.round(parseFloat(ext.getAttribute('cy')) / DX_EMU_PX) || 0; }
        const ph = dxKid(host, WP, 'positionH');
        if (ph) {
            info.hrel = ph.getAttribute('relativeFrom') || '';
            info.hoff = (parseFloat((dxKid(ph, WP, 'posOffset') || {}).textContent) || 0) / DX_EMU_PX;
            info.halign = ((dxKid(ph, WP, 'align') || {}).textContent || '').trim();
        }
    }
    // old VML text box: <v:shape style="width:..;height:.." stroked="f" ...><v:textbox>
    const tb = dxUp(T, V, 'textbox');
    if (tb && tb.parentNode && tb.parentNode.nodeType === 1) {
        const sh = tb.parentNode, st = sh.getAttribute('style') || '';
        const len = (k) => { const m = new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([\\d.]+)(pt|px|in|cm|mm)?', 'i').exec(st); if (!m) return 0; const f = { pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[(m[2] || 'px').toLowerCase()]; return Math.round(parseFloat(m[1]) * f); };
        info.w = info.w || len('width'); info.h = info.h || len('height');
        const stroked = (sh.getAttribute('stroked') || '').toLowerCase();
        if (stroked === 'f' || stroked === 'false') info.border = 'none';
        else {
            const sw = /([\d.]+)pt/.exec(sh.getAttribute('strokeweight') || '');
            const sc = sh.getAttribute('strokecolor') || '';
            info.border = `${Math.max(1, Math.round((sw ? parseFloat(sw[1]) : 0.75) * 96 / 72))}px solid ${/^#[0-9a-f]{6}$/i.test(sc) ? sc : '#000'}`;
        }
        const fc = sh.getAttribute('fillcolor') || '';
        if (/^#[0-9a-f]{6}$/i.test(fc)) info.fill = fc;
        const mh = /mso-position-horizontal\s*:\s*(\w+)/i.exec(st);
        if (mh) info.halign = mh[1];
    }
    return info;
}

const DX_PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const DX_WPG_NS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';

/** True when `unit` is a drawing group that contains something besides text boxes (a shape, line or picture). */
function dxGroupHasArt(unit) {
    if (!unit.getElementsByTagNameNS(DX_WPG_NS, 'wgp').length) return false;
    if (unit.getElementsByTagNameNS(DX_PIC_NS, 'pic').length) return true;
    return [...unit.getElementsByTagNameNS(DXT_NS.wps, 'wsp')].some(s => !dxKid(s, DXT_NS.wps, 'txbx') && !s.hasAttribute('data-tpl-tb'));
}

/** Does the text of this text box already appear as normal text in the page body? (PDF→Word files often do that.) */
function dxTextInBody(doc, T) {
    const W = DXT_NS.w, MC = DXT_NS.mc;
    const flat = (s) => s.replace(/\s+/g, '').toLowerCase();
    const mine = flat([...T.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join(''));
    if (!mine) return true;                                                      // nothing to keep
    let body = '';
    for (const p of doc.getElementsByTagNameNS(W, 'p')) {
        if (dxUp(p, W, 'txbxContent') || dxUp(p, MC, 'Fallback')) continue;
        body += [...p.getElementsByTagNameNS(W, 't')].filter(t => !dxUp(t, W, 'txbxContent')).map(t => t.textContent).join('');
    }
    return flat(body).includes(mine);
}

// text boxes → one-cell tables (document order = infos order; a visible marker links table ↔ info)
function docxTextBoxesToTables(doc) {
    const { w: W, mc: MC } = DXT_NS;
    const infos = [];
    const mk = (n) => doc.createElementNS(W, 'w:' + n);
    const isEl = (n) => n.nodeType === 1;
    for (let pass = 0; pass < 6; pass++) {
        const list = [...doc.getElementsByTagNameNS(W, 'txbxContent')]
            .filter(t => !dxUp(t, MC, 'Fallback') && !dxUp(t, W, 'txbxContent'));
        if (!list.length) break;
        const units = new Map();                                        // shape → its text boxes (groups hold several)
        for (const T of list) {
            const unit = dxUp(T, MC, 'AlternateContent') || dxUp(T, W, 'pict') || dxUp(T, W, 'drawing');
            if (!unit || !dxUp(unit, W, 'p')) continue;                 // can't place it → leave as is
            if (!units.has(unit)) units.set(unit, []);
            units.get(unit).push(T);
        }
        if (!units.size) break;
        for (const [unit, boxes] of units) {
            const host = dxUp(unit, W, 'p');
            // A group that also holds shapes / pictures (letterhead art, footer band...) is kept and drawn as ONE picture;
            // only its text boxes are taken out (and skipped when the same text is already in the page body).
            const keepUnit = dxGroupHasArt(unit);
            let after = host;
            for (const T of boxes) {
                if (keepUnit) {
                    // Text boxes inside a drawing group stay in the group and are drawn into its picture
                    // (vxTextBox) – unless the same text is already normal body text, then they are dropped.
                    const tx = T.parentNode;                                  // <wps:txbx>
                    const wsp = tx && tx.parentNode;                          // <wps:wsp>
                    if (dxTextInBody(doc, T) && tx && wsp) {
                        wsp.setAttribute('data-tpl-tb', '1');
                        wsp.removeChild(tx);
                    }
                    continue;
                }
                const info = docxReadTextBox(unit, T);
                const tbl = mk('tbl'), tblPr = mk('tblPr'), tblW = mk('tblW'), grid = mk('tblGrid'), gc = mk('gridCol');
                tblW.setAttributeNS(W, 'w:w', '0'); tblW.setAttributeNS(W, 'w:type', 'auto'); tblPr.appendChild(tblW);
                gc.setAttributeNS(W, 'w:w', String(Math.round((info.w || 400) * 15))); grid.appendChild(gc);
                const tr = mk('tr'), tc = mk('tc');
                while (T.firstChild) tc.appendChild(T.firstChild);
                const els = [...tc.childNodes].filter(isEl);
                if (!els.length || els[els.length - 1].localName !== 'p') tc.appendChild(mk('p'));
                // marker in the first paragraph of the box
                const marker = mk('r'), t = mk('t');
                t.textContent = `[[TPLTB:${infos.length}]]`; marker.appendChild(t);
                const first = [...tc.childNodes].filter(isEl)[0];
                if (first.localName === 'p') {
                    const pPr = dxKid(first, W, 'pPr');
                    first.insertBefore(marker, pPr ? pPr.nextSibling : first.firstChild);
                } else {
                    const np = mk('p'); np.appendChild(marker); tc.insertBefore(np, first);
                }
                infos.push(info);
                tr.appendChild(tc); tbl.appendChild(tblPr); tbl.appendChild(grid); tbl.appendChild(tr);
                after.parentNode.insertBefore(tbl, after.nextSibling);
                after = tbl;
            }
            if (!keepUnit) unit.parentNode.removeChild(unit);           // incl. Word's duplicate VML copy
            // host paragraph left with nothing in it → drop it (not inside a table cell)
            const hasStuff = ['t', 'drawing', 'pict', 'br', 'tab', 'sym', 'fldChar', 'instrText', 'object', 'sectPr']
                .some(n => host.getElementsByTagNameNS(W, n).length);
            if (!hasStuff && host.parentNode && host.parentNode.localName !== 'tc') host.parentNode.removeChild(host);
        }
    }
    return infos;
}

// Prepares a copy of the package. Returns { buf, xml, textBoxes }; on any trouble the caller keeps the original.
async function docxPrepare(buf) {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('no document.xml');
    const parse = (s) => {
        const d = new DOMParser().parseFromString(s, 'application/xml');
        if (d.getElementsByTagName('parsererror').length) throw new Error('XML parse error');
        return d;
    };
    const doc = parse(await f.async('string'));
    const sf = zip.file('word/styles.xml');
    const stylesDoc = sf ? parse(await sf.async('string')) : null;
    const nAlign = docxMaterializeAlignment(doc, stylesDoc);
    const textBoxes = docxTextBoxesToTables(doc);
    // Some browsers already put an XML declaration in front of the serialised document; two of them are invalid XML
    // (that used to make the full-fidelity converter fail and silently fall back to the basic one).
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^>]*\?>\s*/, '');
    if (!nAlign && !textBoxes.length) return { buf, xml, textBoxes };
    zip.file('word/document.xml', xml);
    return { buf: await zip.generateAsync({ type: 'arraybuffer' }), xml, textBoxes };
}

// Gives each converted text-box table its Word look (border, fill, width, position, padding).
function docxRestoreTextBoxes(d, textBoxes) {
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('[[TPLTB:')) nodes.push(n);
    const leftPx = (typeof pageSettings !== 'undefined' && pageSettings?.margins?.left) ? pageSettings.margins.left * 96 / 25.4 : 0;
    for (const node of nodes) {
        const m = /\[\[TPLTB:(\d+)\]\]/.exec(node.nodeValue);
        if (!m) continue;
        node.nodeValue = node.nodeValue.replace(m[0], '');
        const tbl = node.parentElement && node.parentElement.closest('table');
        const info = textBoxes && textBoxes[+m[1]];
        if (!tbl || !info) continue;
        tbl.classList.add('tpl-textbox');
        tbl.setAttribute('data-textbox', '1');
        tbl.setAttribute('border', '0');
        const s = tbl.style;
        s.borderCollapse = 'collapse';
        s.width = info.w ? info.w + 'px' : '100%';
        s.maxWidth = '100%';
        const gap = '6px';
        if (info.halign === 'center') s.margin = `${gap} auto`;
        else if (info.halign === 'right' || info.halign === 'outside') s.margin = `${gap} 0 ${gap} auto`;
        else {
            let off = info.hoff || 0;
            if (info.hrel === 'page') off -= leftPx;
            s.margin = `${gap} 0 ${gap} ${Math.min(700, Math.max(0, Math.round(off)))}px`;
        }
        const td = tbl.querySelector('td');
        if (td) {
            td.style.border = info.border;
            if (info.fill) td.style.backgroundColor = info.fill;
            td.style.padding = info.pad.map(v => v + 'px').join(' ');
            if (info.h) td.style.height = info.h + 'px';
            td.style.verticalAlign = info.valign || 'top';
        }
    }
}

// ---------------------------------------------
// Full-fidelity Word -> HTML converter
// Mammoth only produces *semantic* HTML (paragraphs, bold, headings) and throws away fonts, sizes,
// colours, spacing, indents, borders and shading. This converter reads word/document.xml directly,
// resolves the Word style chain (docDefaults -> table style -> paragraph style -> character style ->
// direct formatting) and writes the result as inline CSS, so the editor shows what the Word file shows.
//   - paragraphs: alignment, indents, spacing before/after, line spacing, borders, shading
//   - runs: font, size, colour, bold/italic/underline/strike, highlight, caps, super/subscript
//   - lists: real <ul>/<ol> with the right marker + level indent (odd marker formats become manual labels)
//   - tables: grid widths, merged cells, borders, shading, cell padding, vertical alignment, row height
//   - pictures: embedded as data: URLs with their Word size (layout info is attached via data-dx)
// docxConvert() falls back to Mammoth if anything in here throws.
// ---------------------------------------------
const CXW = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CXR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CXWP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const CXA = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CXMC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const CX_BREAK = { pageBreak: true };

const cxKids = (n) => (n ? [...n.childNodes].filter(c => c.nodeType === 1) : []);
const cxKid = (n, name, ns = CXW) => cxKids(n).find(c => c.localName === name && c.namespaceURI === ns) || null;
const cxAttr = (n, name, ns = CXW) => (n && (n.getAttributeNS(ns, name) || n.getAttribute((ns === CXW ? 'w:' : ns === CXR ? 'r:' : '') + name))) || '';
const cxVal = (n) => cxAttr(n, 'val');
const cxNum = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : undefined; };
const cxOn = (n) => { if (!n) return undefined; const v = cxVal(n).toLowerCase(); return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); };
const cxEsc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cxPx = (tw) => Math.round((tw / 15) * 100) / 100;            // twips -> CSS px
const cxMerge = (...objs) => {
    const out = {};
    for (const o of objs) if (o) for (const k in o) if (o[k] !== undefined) out[k] = o[k];
    return out;
};

const CX_HIGHLIGHT = {
    yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
    darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
    darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff'
};
const CX_THEME_ALIAS = {
    text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2', dark1: 'dk1', light1: 'lt1',
    dark2: 'dk2', light2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink'
};
const CX_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

function cxFont(f) {
    const n = String(f).replace(/['"]/g, '');
    const generic = /mono|courier|consolas/i.test(n) ? 'monospace'
        : /arial|helvetica|calibri|verdana|tahoma|segoe|trebuchet|sans|candara|corbel|gill|franklin|lucida|roboto|open|gothic|gotham|montserrat|poppins|nunito|lato|futura|avenir|century gothic|myriad|geneva|optima|source|noto/i.test(n) ? 'sans-serif'
        : 'serif';
    // Fonts the viewer may not have get a look-alike before the generic family (Century Gothic is geometric, so its
    // fallback must be sans-serif, not the browser's serif default).
    const alt = /century gothic/i.test(n) ? `,'URW Gothic','Avant Garde','Questrial','Poppins','Nunito'`
        : /calibri/i.test(n) ? `,'Carlito'` : /arial narrow/i.test(n) ? `,'Liberation Sans Narrow'` : '';
    return `'${n}'${alt},${generic}`;
}

function cxHex(val, themeName, tint, shade, theme) {
    if (/^[0-9a-f]{6}$/i.test(val || '')) return '#' + val;
    if (!themeName) return '';
    let hex = theme.colors[CX_THEME_ALIAS[themeName] || themeName];
    if (!/^[0-9a-f]{6}$/i.test(hex || '')) return '';
    let c = [0, 2, 4].map(i => parseInt(hex.substr(i, 2), 16));
    const sh = tint ? null : (shade ? parseInt(shade, 16) / 255 : null);
    if (tint) { const t = parseInt(tint, 16) / 255; c = c.map(v => 255 - (255 - v) * t); }
    if (sh !== null) c = c.map(v => v * sh);
    return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function cxParseTheme(doc) {
    const t = { major: '', minor: '', colors: {} };
    if (!doc) return t;
    const font = (tag) => {
        const e = doc.getElementsByTagNameNS(CXA, tag)[0];
        const l = e && cxKid(e, 'latin', CXA);
        return l ? (l.getAttribute('typeface') || '') : '';
    };
    t.major = font('majorFont'); t.minor = font('minorFont');
    const cs = doc.getElementsByTagNameNS(CXA, 'clrScheme')[0];
    cxKids(cs).forEach(c => {
        const x = cxKids(c)[0];
        const v = x && (x.getAttribute('val') || x.getAttribute('lastClr'));
        if (v) t.colors[c.localName] = v;
    });
    return t;
}

// ---- property readers ------------------------------------------------------------------------
function cxRPr(rPr, ctx) {
    const o = {};
    for (const c of cxKids(rPr)) {
        switch (c.localName) {
            case 'rFonts': {
                let f = cxAttr(c, 'ascii') || cxAttr(c, 'hAnsi');
                const th = cxAttr(c, 'asciiTheme') || cxAttr(c, 'hAnsiTheme');
                if (!f && th) f = /major/i.test(th) ? ctx.theme.major : ctx.theme.minor;
                if (f) o.font = f;
                break;
            }
            case 'sz': { const v = cxNum(cxVal(c)); if (v) o.size = v / 2; break; }
            case 'b': o.b = cxOn(c); break;
            case 'i': o.i = cxOn(c); break;
            case 'u': o.u = !!cxVal(c) && cxVal(c) !== 'none'; break;
            case 'strike': case 'dstrike': o.strike = cxOn(c); break;
            case 'caps': o.caps = cxOn(c); break;
            case 'smallCaps': o.smallCaps = cxOn(c); break;
            case 'vanish': o.hidden = cxOn(c); break;
            case 'color': {
                const h = cxHex(cxVal(c), cxAttr(c, 'themeColor'), cxAttr(c, 'themeTint'), cxAttr(c, 'themeShade'), ctx.theme);
                if (h) o.color = h;
                break;
            }
            case 'highlight': { const h = CX_HIGHLIGHT[cxVal(c)]; if (h) o.highlight = h; break; }
            case 'shd': {
                const h = cxHex(cxAttr(c, 'fill'), cxAttr(c, 'themeFill'), cxAttr(c, 'themeFillTint'), cxAttr(c, 'themeFillShade'), ctx.theme);
                if (h) o.bg = h;
                break;
            }
            case 'vertAlign': { const v = cxVal(c); if (v === 'superscript' || v === 'subscript') o.va = v; break; }
            case 'spacing': { const v = cxNum(cxVal(c)); if (v) o.ls = v / 20; break; }
            case 'w': { const v = cxNum(cxVal(c)); if (v && v !== 100) o.scale = v; break; }          // character width %
            case 'position': { const v = cxNum(cxVal(c)); if (v) o.pos = v / 2; break; }             // raised (+) / lowered (-) in pt
        }
    }
    return o;
}

function cxBorderOf(c, ctx) {
    const val = cxVal(c);
    if (!val || val === 'nil' || val === 'none') return { none: true };
    const sz = cxNum(cxAttr(c, 'sz')) || 4;
    const color = cxHex(cxAttr(c, 'color'), cxAttr(c, 'themeColor'), cxAttr(c, 'themeTint'), cxAttr(c, 'themeShade'), ctx.theme) || '#000000';
    return { val, sz, color, space: cxNum(cxAttr(c, 'space')) || 0 };
}
function cxBorderCss(b) {
    if (!b) return '';
    if (b.none) return 'none';
    const style = /double/i.test(b.val) ? 'double' : /dotted/i.test(b.val) ? 'dotted' : /dash/i.test(b.val) ? 'dashed' : 'solid';
    let px = Math.max(1, Math.round(b.sz / 6));
    if (style === 'double') px = Math.max(3, px);
    return `${px}px ${style} ${b.color}`;
}
function cxBorders(node, ctx) {
    const o = {};
    for (const c of cxKids(node)) {
        const n = { start: 'left', end: 'right' }[c.localName] || c.localName;
        if (['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'between'].includes(n)) o[n] = cxBorderOf(c, ctx);
    }
    return o;
}
function cxMar(node) {
    const o = {};
    for (const c of cxKids(node)) {
        const n = { start: 'left', end: 'right' }[c.localName] || c.localName;
        const v = cxNum(cxAttr(c, 'w'));
        if (['top', 'left', 'bottom', 'right'].includes(n) && v !== undefined) o[n] = v;
    }
    return o;
}

function cxPPr(pPr, ctx) {
    const o = {};
    for (const c of cxKids(pPr)) {
        switch (c.localName) {
            case 'pStyle': o.style = cxVal(c); break;
            case 'jc': o.jc = cxVal(c); break;
            case 'ind': {
                const l = cxNum(cxAttr(c, 'left') || cxAttr(c, 'start')), r = cxNum(cxAttr(c, 'right') || cxAttr(c, 'end'));
                const fl = cxNum(cxAttr(c, 'firstLine')), h = cxNum(cxAttr(c, 'hanging'));
                if (l !== undefined) o.left = l;
                if (r !== undefined) o.right = r;
                if (h !== undefined) o.first = -h; else if (fl !== undefined) o.first = fl;
                break;
            }
            case 'spacing': {
                const b = cxNum(cxAttr(c, 'before')), a = cxNum(cxAttr(c, 'after')), l = cxNum(cxAttr(c, 'line'));
                if (b !== undefined) o.before = b;
                if (a !== undefined) o.after = a;
                if (cxAttr(c, 'beforeAutospacing') === '1') o.before = 280;
                if (cxAttr(c, 'afterAutospacing') === '1') o.after = 280;
                if (l !== undefined) { o.line = l; o.lineRule = cxAttr(c, 'lineRule') || 'auto'; }
                break;
            }
            case 'contextualSpacing': o.ctxSpacing = cxOn(c); break;
            case 'shd': { const h = cxHex(cxAttr(c, 'fill'), cxAttr(c, 'themeFill'), cxAttr(c, 'themeFillTint'), cxAttr(c, 'themeFillShade'), ctx.theme); if (h) o.bg = h; break; }
            case 'pBdr': o.bdr = cxBorders(c, ctx); break;
            case 'numPr': {
                const id = cxKid(c, 'numId'), lv = cxKid(c, 'ilvl');
                if (id) o.numId = cxVal(id);
                if (lv) o.ilvl = cxVal(lv);
                break;
            }
            case 'tabs': {
                const t = [];
                for (const tb of cxKids(c)) {
                    if (tb.localName !== 'tab') continue;
                    const pos = cxNum(cxAttr(tb, 'pos'));
                    if (pos === undefined) continue;
                    t.push({ pos, val: cxAttr(tb, 'val') || 'left' });
                }
                o.tabs = t;
                break;
            }
            case 'pageBreakBefore': o.pbb = cxOn(c); break;
            case 'sectPr': o.sect = c; break;
            case 'rPr': o.markR = cxRPr(c, ctx); break;
        }
    }
    return o;
}

// ---- styles / numbering ----------------------------------------------------------------------
function cxParseStyles(doc, ctx) {
    const S = { map: {}, defP: {}, defR: {}, defaultPara: '', defaultTable: '' };
    if (!doc) return S;
    const dd = doc.getElementsByTagNameNS(CXW, 'docDefaults')[0];
    if (dd) {
        const r = cxKid(dd, 'rPrDefault'), p = cxKid(dd, 'pPrDefault');
        S.defR = cxRPr(cxKid(r, 'rPr'), ctx);
        S.defP = cxPPr(cxKid(p, 'pPr'), ctx);
    }
    for (const st of doc.getElementsByTagNameNS(CXW, 'style')) {
        const id = cxAttr(st, 'styleId'), type = cxAttr(st, 'type');
        const tblPr = cxKid(st, 'tblPr');
        S.map[id] = {
            id, type,
            name: cxVal(cxKid(st, 'name')),
            basedOn: cxVal(cxKid(st, 'basedOn')),
            pPr: cxPPr(cxKid(st, 'pPr'), ctx),
            rPr: cxRPr(cxKid(st, 'rPr'), ctx),
            tbl: { borders: cxBorders(cxKid(tblPr, 'tblBorders'), ctx), mar: cxMar(cxKid(tblPr, 'tblCellMar')) }
        };
        if (cxAttr(st, 'default') === '1') {
            if (type === 'paragraph') S.defaultPara = id;
            if (type === 'table') S.defaultTable = id;
        }
    }
    return S;
}
function cxChain(S, id) {
    const chain = [], seen = new Set();
    while (id && S.map[id] && !seen.has(id)) { seen.add(id); chain.unshift(S.map[id]); id = S.map[id].basedOn; }
    return chain;
}
const cxStyleP = (S, id) => cxMerge(...cxChain(S, id).map(s => s.pPr));
const cxStyleR = (S, id) => cxMerge(...cxChain(S, id).map(s => s.rPr));

function cxParseNumbering(doc) {
    const N = { abs: {}, num: {} };
    if (!doc) return N;
    for (const a of doc.getElementsByTagNameNS(CXW, 'abstractNum')) {
        const lvls = {};
        for (const l of cxKids(a).filter(k => k.localName === 'lvl')) {
            const pPr = cxKid(l, 'pPr'), ind = cxKid(pPr, 'ind');
            const left = cxNum(cxAttr(ind, 'left') || cxAttr(ind, 'start')), h = cxNum(cxAttr(ind, 'hanging')), fl = cxNum(cxAttr(ind, 'firstLine'));
            lvls[cxAttr(l, 'ilvl')] = {
                fmt: cxVal(cxKid(l, 'numFmt')) || 'decimal',
                text: cxVal(cxKid(l, 'lvlText')),
                start: cxNum(cxVal(cxKid(l, 'start'))) ?? 1,
                left, first: h !== undefined ? -h : fl
            };
        }
        N.abs[cxAttr(a, 'abstractNumId')] = { lvls };
    }
    for (const n of doc.getElementsByTagNameNS(CXW, 'num')) {
        const ov = {};
        for (const o of cxKids(n).filter(k => k.localName === 'lvlOverride')) {
            const so = cxKid(o, 'startOverride');
            if (so) ov[cxAttr(o, 'ilvl')] = cxNum(cxVal(so));
        }
        N.num[cxAttr(n, 'numId')] = { abs: cxVal(cxKid(n, 'abstractNumId')), overrides: ov, started: false };
    }
    return N;
}

const CX_BULLET_MAP = { '\uF0B7': 'disc', '\uF0A7': 'square', '\uF0A8': 'square', '\uF076': 'square', '\u2022': 'disc', '\u25CF': 'disc', 'o': 'circle', '\u25E6': 'circle', '\u25AA': 'square', '\u25A0': 'square', '\u00A7': 'square' };
function cxFormatNumber(n, fmt) {
    const roman = (v) => { const m = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [k, r] of m) while (v >= k) { s += r; v -= k; } return s; };
    const alpha = (v) => { let s = ''; while (v > 0) { v--; s = String.fromCharCode(97 + (v % 26)) + s; v = Math.floor(v / 26); } return s; };
    switch (fmt) {
        case 'lowerLetter': return alpha(n);
        case 'upperLetter': return alpha(n).toUpperCase();
        case 'lowerRoman': return roman(n);
        case 'upperRoman': return roman(n).toUpperCase();
        case 'decimalZero': return (n < 10 ? '0' : '') + n;
        default: return String(n);
    }
}
const CX_LIST_TYPE = { decimal: 'decimal', decimalZero: 'decimal-leading-zero', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman', ordinal: 'decimal', cardinalText: 'decimal', ordinalText: 'decimal' };

/** Counter value for this list paragraph (Word counts per abstract list, restarting deeper levels). */
function cxCount(ctx, numId, ilvl) {
    const num = ctx.N.num[numId], abs = num && ctx.N.abs[num.abs];
    if (!abs) return null;
    const c = (ctx.counters[num.abs] = ctx.counters[num.abs] || []);
    if (!num.started) {
        num.started = true;
        for (const k in num.overrides) c[+k] = num.overrides[k] - 1;
    }
    const lv = +ilvl;
    const def = abs.lvls[ilvl] || abs.lvls['0'] || { start: 1 };
    c[lv] = (c[lv] === undefined ? (def.start - 1) : c[lv]) + 1;
    for (let j = lv + 1; j < c.length; j++) c[j] = undefined;
    return { n: c[lv], all: c.slice(), abs };
}

// ---- inline content --------------------------------------------------------------------------
function cxRunCss(eff, base) {
    const css = [];
    if (eff.font && eff.font !== base.font) css.push('font-family:' + cxFont(eff.font));
    if (eff.size && eff.size !== base.size) css.push(`font-size:${eff.size}pt`);
    if (eff.color && eff.color !== base.color) css.push('color:' + eff.color);
    const bg = eff.highlight || eff.bg;
    if (bg && bg !== (base.highlight || base.bg)) css.push('background-color:' + bg);
    if (!!eff.caps !== !!base.caps) css.push('text-transform:' + (eff.caps ? 'uppercase' : 'none'));
    if (!!eff.smallCaps !== !!base.smallCaps) css.push('font-variant:' + (eff.smallCaps ? 'small-caps' : 'normal'));
    // Word's "scale" stretches glyphs horizontally; CSS can't, so it is approximated by extra letter spacing
    // (an average glyph is ~0.5em wide) - close enough that lines wrap where they wrap in Word.
    let ls = eff.ls || 0;
    if (eff.scale && eff.scale !== (base.scale || 100)) ls += (eff.scale - (base.scale || 100)) / 100 * 0.5 * (eff.size || base.size || 11);
    if (ls && Math.abs(ls - (base.ls || 0)) > 0.001) css.push(`letter-spacing:${Math.round(ls * 100) / 100}pt`);
    // Raised / lowered text: Word makes the LINE taller to fit it (so the other text on that line, and everything below,
    // ends up lower than the raised text). vertical-align does the same in a browser; position:relative did not.
    if (eff.pos) css.push(`vertical-align:${eff.pos}pt`);
    return css;
}
function cxWrap(inner, eff, base) {
    let h = inner;
    if (eff.va) h = `<${eff.va === 'superscript' ? 'sup' : 'sub'}>${h}</${eff.va === 'superscript' ? 'sup' : 'sub'}>`;
    if (eff.strike) h = `<s>${h}</s>`;
    if (eff.u) h = `<u>${h}</u>`;
    const css = cxRunCss(eff, base);
    if (!!eff.i !== !!base.i) { if (eff.i) h = `<em>${h}</em>`; else css.push('font-style:normal'); }
    if (!!eff.b !== !!base.b) { if (eff.b) h = `<strong>${h}</strong>`; else css.push('font-weight:normal'); }
    if (css.length) h = `<span style="${cxEsc(css.join(';'))}">${h}</span>`;
    return h;
}
const cxText = (s) => cxEsc(s).replace(/ {2,}/g, m => ' ' + '&nbsp;'.repeat(m.length - 1));
const CX_TAB = '<span style="display:inline-block;width:48px">&nbsp;</span>';

function cxImageHtml(ctx, rid, w, h, alt, info) {
    const src = ctx.images[rid];
    if (!src) return '';
    const style = w > 0 ? ` style="width:${Math.round(w)}px;height:auto"` : '';
    const dx = info ? ` data-dx="${cxEsc(JSON.stringify(info))}"` : '';
    return `<img src="${src}" alt="${cxEsc(alt || '')}"${style}${dx}>`;
}

/** Pictures inside one run child (w:drawing / w:pict / mc:AlternateContent). One entry per picture, in document order. */
function cxMedia(ctx, node) {
    let out = '';
    const state = ctx.state;
    if (node.namespaceURI === CXMC) {
        const ch = node.localName === 'AlternateContent' ? cxKid(node, 'Choice', CXMC) : null;
        for (const k of cxKids(ch)) out += cxMedia(ctx, k);
        return out;
    }
    if (node.namespaceURI !== CXW) return out;
    if (node.localName === 'drawing') {
        const host = cxKid(node, 'inline', CXWP) || cxKid(node, 'anchor', CXWP);
        if (!host) return out;
        const ext = cxKid(host, 'extent', CXWP), pr = cxKid(host, 'docPr', CXWP);
        const w = ext ? (parseFloat(ext.getAttribute('cx')) || 0) / 9525 : 0;
        if (dxIsVector(node)) {                                     // group / shape: one picture (pre-drawn by docxVectorsToPng)
            const idx = state ? state.i++ : -1;
            const info = state && state.infos ? state.infos[idx] : null;
            const src = ctx.vec && ctx.vec.get(node);
            if (!src) return out;
            const h = ext ? (parseFloat(ext.getAttribute('cy')) || 0) / 9525 : 0;
            const pad = (ctx.vecPad && ctx.vecPad.get(node)) || { x: 0, y: 0 };
            if (info && info.t === 'a') {                           // keep the padded picture on the same spot
                info.w = (info.w || w) + 2 * pad.x; info.h = (info.h || h) + 2 * pad.y;
                info.hoff = (info.hoff || 0) - pad.x; info.voff = (info.voff || 0) - pad.y;
            }
            const dx = info ? ` data-dx="${cxEsc(JSON.stringify(info))}"` : '';
            return out + `<img src="${src}" alt="" style="width:${Math.round((w + 2 * pad.x) * 100) / 100}px;height:${Math.round((h + 2 * pad.y) * 100) / 100}px"${dx}>`;
        }
        const blips = [...node.getElementsByTagNameNS(CXA, 'blip')].filter(b => cxAttr(b, 'embed', CXR) || cxAttr(b, 'link', CXR));
        for (const b of blips) {
            const idx = state ? state.i++ : -1;
            const info = state && state.infos ? state.infos[idx] : null;
            const rid = cxAttr(b, 'embed', CXR) || cxAttr(b, 'link', CXR);
            const html = cxImageHtml(ctx, rid, blips.length === 1 ? w : 0, 0, pr ? pr.getAttribute('descr') : '', info);
            if (!html) ctx.messages.push('A picture could not be embedded (unsupported format, e.g. EMF/WMF).');
            out += html;
        }
    } else if (node.localName === 'pict') {
        for (const im of [...node.getElementsByTagName('*')].filter(e => e.localName === 'imagedata')) {
            if (state) state.i++;
            const rid = cxAttr(im, 'id', CXR);
            let w = 0;
            const shape = im.parentNode;
            const m = shape && /width:\s*([\d.]+)pt/i.exec(shape.getAttribute('style') || '');
            if (m) w = parseFloat(m[1]) * 4 / 3;
            out += cxImageHtml(ctx, rid, w, 0, '', null);
        }
    }
    return out;
}

let cxMeasureCanvas = null;
function cxRun(ctx, r, base, items) {
    const rPr = cxKid(r, 'rPr');
    const rs = cxKid(rPr, 'rStyle');
    const eff = cxMerge(base, rs ? cxStyleR(ctx.S, cxVal(rs)) : null, cxRPr(rPr, ctx));
    let inner = '';
    const flush = () => { if (inner) { items.push(cxWrap(inner, eff, base)); inner = ''; } };
    const T = ctx.tab;
    const measure = (txt) => {
        try {
            const cv = cxMeasureCanvas || (cxMeasureCanvas = document.createElement('canvas'));
            const g = cv.getContext('2d');
            g.font = `${eff.i ? 'italic ' : ''}${eff.b ? 'bold ' : ''}${(eff.size || 11) * 4 / 3}px ${cxFont(eff.font || 'Times New Roman')}`;
            const ls = ((eff.ls || 0) + (eff.scale ? (eff.scale - 100) / 100 * 0.5 * (eff.size || 11) : 0)) * 4 / 3;
            return g.measureText(txt).width + ls * txt.length;
        } catch (_) { return txt.length * (eff.size || 11) * 0.5; }
    };
    for (const c of cxKids(r)) {
        if (c.namespaceURI === CXMC || c.localName === 'drawing' || c.localName === 'pict') {
            flush();
            const m = cxMedia(ctx, c);
            if (m) items.push(m);
            continue;
        }
        if (c.namespaceURI !== CXW || eff.hidden) continue;
        switch (c.localName) {
            case 't': inner += cxText(c.textContent); if (T) T.x += measure(c.textContent); break;
            case 'tab': {
                if (!T) { inner += CX_TAB; break; }
                // next tab stop to the right of the current position (custom stops, then Word's default 0.5in grid)
                const xt = T.x * 15;
                let stop = T.stops.find(p => p > xt + 1);
                if (stop === undefined) stop = (Math.floor(xt / 720) + 1) * 720;
                const w = Math.max(4, cxPx(stop) - T.x);
                T.x += w;
                inner += `<span style="display:inline-block;width:${Math.round(w * 100) / 100}px">&nbsp;</span>`;
                break;
            }
            case 'br': {
                const t = cxAttr(c, 'type');
                if (t === 'page') { flush(); items.push(CX_BREAK); }
                else if (t !== 'column') inner += '<br>';
                break;
            }
            case 'cr': inner += '<br>'; break;
            case 'noBreakHyphen': inner += '\u2011'; break;
            case 'sym': { const ch = cxAttr(c, 'char'); if (ch) inner += cxEsc(String.fromCharCode(parseInt(ch, 16))); break; }
        }
    }
    flush();
}

function cxInline(ctx, node, base, items) {
    for (const c of cxKids(node)) {
        if (c.namespaceURI === CXMC) {
            const ch = c.localName === 'AlternateContent' ? cxKid(c, 'Choice', CXMC) : null;
            if (ch) cxInline(ctx, ch, base, items);
            continue;
        }
        if (c.namespaceURI !== CXW) continue;
        switch (c.localName) {
            case 'r': cxRun(ctx, c, base, items); break;
            case 'hyperlink': {
                const rid = cxAttr(c, 'id', CXR);
                const rel = rid && ctx.rels[rid];
                const href = rel && rel.external && /^(https?:|mailto:|tel:)/i.test(rel.target) ? rel.target : '';
                const sub = [];
                cxInline(ctx, c, base, sub);
                if (href && sub.every(s => typeof s === 'string')) items.push(`<a href="${cxEsc(href)}" target="_blank" rel="noopener">${sub.join('')}</a>`);
                else items.push(...sub);
                break;
            }
            case 'ins': case 'moveTo': case 'smartTag': case 'customXml': case 'fldSimple': case 'sdt': case 'sdtContent':
                cxInline(ctx, c.localName === 'sdt' ? (cxKid(c, 'sdtContent') || c) : c, base, items);
                break;
            // w:del / w:moveFrom (deleted text), bookmarks, proofing marks: ignored
        }
    }
}

// ---- paragraphs ------------------------------------------------------------------------------
function cxParaInfo(ctx, p, scope) {
    const direct = cxPPr(cxKid(p, 'pPr'), ctx);
    const styleId = direct.style || ctx.S.defaultPara;
    const sp = cxStyleP(ctx.S, styleId);
    const sr = cxStyleR(ctx.S, styleId);
    const numId = direct.numId !== undefined ? direct.numId : sp.numId;
    const ilvl = direct.ilvl !== undefined ? direct.ilvl : (sp.ilvl !== undefined ? sp.ilvl : '0');
    let lvl = null, num = null;
    if (numId && numId !== '0' && ctx.N.num[numId]) {
        num = ctx.N.num[numId];
        const abs = ctx.N.abs[num.abs];
        lvl = abs && (abs.lvls[ilvl] || abs.lvls['0']) || null;
    }
    const lvlInd = lvl ? { left: lvl.left, first: lvl.first } : null;
    const pr = cxMerge(ctx.S.defP, scope.tblP, sp, lvlInd, direct);
    const base = cxMerge(ctx.S.defR, scope.tblR, sr);
    const style = ctx.S.map[styleId];
    const sname = (style && style.name || '').toLowerCase();
    let tag = 'p';
    const hm = /^heading (\d)$/.exec(sname);
    if (hm) tag = 'h' + Math.min(6, +hm[1]);
    else if (sname === 'title') tag = 'h1';
    else if (sname === 'subtitle') tag = 'h2';
    return { p, direct, pr, base, styleId, tag, numId: lvl ? numId : null, ilvl, lvl, mark: direct.markR || {} };
}

function cxParaCss(info, opts) {
    const { pr, base } = info;
    const css = [];
    const jc = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[pr.jc];
    if (jc) css.push('text-align:' + jc);
    // Word also keeps the full height of a raised run above the line; browsers only grew the line by the raise itself,
    // which left text under raised numbers (phone / email rows of letterheads) a little high. Add the difference.
    let raiseExtra = 0;
    try {
        if (info.p) for (const r of cxKids(info.p)) {
            const pos = r.localName === 'r' ? cxKid(cxKid(r, 'rPr'), 'position') : null;
            const v = pos ? (cxNum(cxAttr(pos, 'val')) || 0) / 2 : 0;       // points
            if (v > 0) raiseExtra = Math.max(raiseExtra, v * 4 / 3 * 1.1);
        }
    } catch (_) { raiseExtra = 0; }
    const top = (opts.noTop ? 0 : cxPx(pr.before || 0)) + Math.round(raiseExtra * 100) / 100, bottom = opts.noBottom ? 0 : cxPx(pr.after || 0);
    if (opts.list) css.push(`margin-top:${top}px;margin-bottom:${bottom}px`);
    else css.push(`margin:${top}px ${cxPx(pr.right || 0)}px ${bottom}px ${cxPx(pr.left || 0)}px`);
    if (!opts.list && pr.first) css.push(`text-indent:${cxPx(pr.first)}px`);
    // Word sizes a line from the text on it (+ the paragraph mark). Browsers also add a "strut" from the paragraph's own
    // font, so a paragraph whose runs are ALL explicitly smaller than the paragraph default (e.g. 9pt Arial runs inside a
    // Calibri 11pt default) came out ~40% too tall. When every run carries its own size, size the line from those runs.
    let strut = 0, strutFont = '', strutFamily = '';
    if (!opts.empty && info.p) {
        try {
            const runs = cxKids(info.p).filter(r => r.localName === 'r' && r.namespaceURI === CXW && cxKid(r, 't'));
            const sizes = runs.map(r => { const sz = cxKid(cxKid(r, 'rPr'), 'sz'); return sz ? (cxNum(cxAttr(sz, 'val')) || 0) / 2 : 0; });
            if (sizes.length && sizes.every(v => v > 0)) {
                const m = Math.max(...sizes, (info.mark && info.mark.size) || 0);
                if (base.size && m < base.size && (!pr.lineRule || pr.lineRule === 'auto')) {
                    strut = m;
                    const rf = cxKid(cxKid(runs[0], 'rPr'), 'rFonts');
                    strutFont = (rf && (cxAttr(rf, 'ascii') || cxAttr(rf, 'hAnsi'))) || base.font || '';
                    // when every run names the same font, the paragraph itself takes it too, so the line box is built
                    // from one font (mixing Calibri's and Arial's ascent/descent made each line ~1px taller)
                    const fams = runs.map(r2 => { const f2 = cxKid(cxKid(r2, 'rPr'), 'rFonts'); return f2 ? (cxAttr(f2, 'ascii') || cxAttr(f2, 'hAnsi')) : ''; });
                    if (fams.every(f2 => f2 && f2 === fams[0])) strutFamily = fams[0];
                }
            }
        } catch (_) { strut = 0; }
    }
    if (strut) {
        const f = /calibri|segoe|candara|corbel/i.test(strutFont) ? 1.22 : 1.15;
        css.push(`line-height:${Math.round(strut * 4 / 3 * f * ((pr.line || 240) / 240) * 100) / 100}px`);
    } else if (pr.line) {
        if (!pr.lineRule || pr.lineRule === 'auto') {
            // "Auto" spacing is a multiple of the font's NATURAL line height, so the factor must come from the font the
            // text is actually in (first text run), not the paragraph default: Arial runs inside a Calibri-default paragraph
            // were getting 1.22 instead of 1.15, which made every multi-line block ~6% too tall.
            let lhFont = base.font || '';
            try {
                const run = cxKids(info.p).find(r => r.localName === 'r' && r.namespaceURI === CXW && cxKid(r, 't') && cxKid(cxKid(r, 'rPr') || r, 'rFonts'));
                const rf = run && cxKid(cxKid(run, 'rPr'), 'rFonts');
                lhFont = (rf && (cxAttr(rf, 'ascii') || cxAttr(rf, 'hAnsi'))) || lhFont;
            } catch (_) { /* keep paragraph font */ }
            const f = /calibri|segoe|candara|corbel/i.test(lhFont) ? 1.22 : 1.15;
            css.push(`line-height:${Math.round((pr.line / 240) * f * 1000) / 1000}`);
        } else css.push(`line-height:${cxPx(pr.line)}px`);
    }
    if (pr.bg) css.push('background-color:' + pr.bg);
    if (pr.bdr) {
        for (const side of ['top', 'bottom', 'left', 'right']) {
            const b = pr.bdr[side];
            if (b && !b.none) css.push(`border-${side}:${cxBorderCss(b)};padding-${side}:${Math.round((b.space || 1) * 4 / 3)}px`);
        }
    }
    const b = opts.empty ? cxMerge(base, info.mark) : base;
    if (strutFamily) css.push('font-family:' + cxFont(strutFamily));
    else if (b.font) css.push('font-family:' + cxFont(b.font));
    if (strut) css.push(`font-size:${strut}pt`);      // every run carries its own size, so this only shapes the line box
    else if (b.size) css.push(`font-size:${b.size}pt`);
    if (b.color) css.push('color:' + b.color);
    if (b.b) css.push('font-weight:bold'); else if (/^h\d$/.test(info.tag)) css.push('font-weight:normal');
    if (b.i) css.push('font-style:italic');
    if (b.caps) css.push('text-transform:uppercase');
    if (b.smallCaps) css.push('font-variant:small-caps');
    if (b.ls) css.push(`letter-spacing:${b.ls}pt`);
    if (/^h\d$/.test(info.tag)) css.push('font-size:' + (b.size || 12) + 'pt');
    return css.join(';');
}

function cxItemsHtml(items) {
    return items.filter(i => typeof i === 'string').join('');
}

// ---- blocks (paragraphs, lists, tables) ------------------------------------------------------
function cxBlocks(parent) {
    const out = [];
    const walk = (n) => cxKids(n).forEach(c => {
        if (c.namespaceURI === CXMC) { const ch = c.localName === 'AlternateContent' ? cxKid(c, 'Choice', CXMC) : null; if (ch) walk(ch); return; }
        if (c.namespaceURI !== CXW) return;
        if (c.localName === 'p' || c.localName === 'tbl') out.push(c);
        else if (c.localName === 'sdt') walk(cxKid(c, 'sdtContent') || c);
        else if (['sdtContent', 'ins', 'customXml', 'smartTag'].includes(c.localName)) walk(c);
    });
    walk(parent);
    return out;
}

const CX_NO_SCOPE = { tblP: null, tblR: null };

function cxBlocksHtml(ctx, blocks, scope) {
    const infos = blocks.map(b => (b.localName === 'p' ? cxParaInfo(ctx, b, scope) : null));
    let out = '';
    const stack = [];     // open lists: { level, tag, key, left }
    const closeAll = () => { while (stack.length) { out += `</li></${stack.pop().tag}>`; } };

    blocks.forEach((b, i) => {
        if (b.localName === 'tbl') { closeAll(); out += cxTable(ctx, b); return; }
        const info = infos[i];
        const prev = infos[i - 1], next = infos[i + 1];
        const cs = info.pr.ctxSpacing;
        const opts = {
            noTop: cs && prev && prev.styleId === info.styleId,
            noBottom: cs && next && next.styleId === info.styleId
        };

        const items = [];
        ctx.tab = {                                         // running x (px) of the line, for real tab stops
            x: cxPx((info.pr.left || 0) + (info.pr.first || 0)),
            stops: (info.pr.tabs || []).filter(t => t.val !== 'clear').map(t => t.pos).concat((info.pr.first || 0) < 0 ? [info.pr.left || 0] : []).sort((a, b2) => a - b2)
        };
        cxInline(ctx, b, info.base, items);
        ctx.tab = null;
        if (info.direct.pbb) items.unshift(CX_BREAK);
        const sect = info.direct.sect;
        const sectType = sect ? (cxVal(cxKid(sect, 'type')) || 'nextPage') : '';
        const hasContent = items.some(it => it !== CX_BREAK && String(it).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() !== '' || /<img/i.test(String(it)));
        const hasText = items.some(it => it !== CX_BREAK);

        // ---- list item
        if (info.numId) {
            const counter = cxCount(ctx, info.numId, info.ilvl);
            const lvl = info.lvl;
            const text = lvl.text || '';
            const placeholders = (text.match(/%\d/g) || []).length;
            const isBullet = lvl.fmt === 'bullet';
            const nativeOrdered = !isBullet && lvl.fmt !== 'none' && placeholders === 1 && /^%\d\.?$/.test(text) && /\.$/.test(text) === true;
            if (isBullet || nativeOrdered) {
                const L = +info.ilvl;
                const tag = isBullet ? 'ul' : 'ol';
                let type = isBullet ? (CX_BULLET_MAP[text.charAt(0)] || (text.trim() ? `"${text.charAt(0)}  "` : 'disc')) : (CX_LIST_TYPE[lvl.fmt] || 'decimal');
                const key = info.numId + '|' + tag + '|' + type;
                const left = Math.max(cxPx(info.pr.left || 0), 18);
                while (stack.length && (stack[stack.length - 1].level > L || (stack[stack.length - 1].level === L && stack[stack.length - 1].key !== key))) {
                    out += `</li></${stack.pop().tag}>`;
                }
                if (stack.length && stack[stack.length - 1].level === L) out += '</li>';
                else {
                    const parentLeft = stack.length ? stack[stack.length - 1].left : 0;
                    const start = (!isBullet && counter && counter.n !== 1) ? ` start="${counter.n}"` : '';
                    out += `<${tag}${start} style="margin:0;padding-left:${Math.max(left - parentLeft, 14)}px;list-style-type:${cxEsc(type)}">`;
                    stack.push({ level: L, tag, key, left });
                }
                const lcss = cxParaCss(info, Object.assign({}, opts, { list: true, empty: !hasText }));
                out += `<li style="${cxEsc(lcss)}">${hasText ? cxItemsHtml(items) : '<br>'}`;
                return;
            }
            // other marker formats: "(a)", "1.1", "a)" ... -> manual label with a hanging indent
            closeAll();
            let label = text;
            if (lvl.fmt === 'none') label = '';
            else {
                label = label.replace(/%(\d)/g, (m, d) => {
                    const k = +d - 1;
                    const lv = counter.abs.lvls[String(k)] || lvl;
                    const v = counter.all[k] === undefined ? lv.start : counter.all[k];
                    return cxFormatNumber(v, lv.fmt);
                });
            }
            const hang = Math.max(cxPx(-(info.pr.first || 0)), 18);
            const lab = label ? `<span style="display:inline-block;min-width:${hang}px;text-indent:0">${cxEsc(label)}</span>` : '';
            const css = cxParaCss(info, Object.assign({}, opts, { empty: !hasText }));
            out += `<${info.tag} style="${cxEsc(css)}">${lab}${hasText ? cxItemsHtml(items) : ''}${!hasText && !lab ? '<br>' : ''}</${info.tag}>`;
            return;
        }

        // ---- ordinary paragraph (split at page breaks)
        closeAll();
        if (sect && !hasContent && !items.some(it => it === CX_BREAK)) {          // empty paragraph that only carries a section break
            if (sectType !== 'continuous' && i < blocks.length) out += '<hr class="tpl-pagebreak">';
            return;
        }
        const chunks = [[]];
        for (const it of items) { if (it === CX_BREAK) chunks.push([]); else chunks[chunks.length - 1].push(it); }
        chunks.forEach((chunk, ci) => {
            const text = chunk.join('');
            const empty = !text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() && !/<img/i.test(text) && !chunk.length;
            if (ci > 0) out += '<hr class="tpl-pagebreak">';
            if (ci > 0 && !chunk.length) return;                                     // nothing after the break
            if (ci === 0 && !chunk.length && chunks.length > 1) return;              // paragraph was only a page break
            const css = cxParaCss(info, Object.assign({}, opts, { empty }));
            out += `<${info.tag} style="${cxEsc(css)}">${chunk.length ? text : '<br>'}</${info.tag}>`;
        });
        if (sect && sectType !== 'continuous') out += '<hr class="tpl-pagebreak">';
    });
    closeAll();
    return out;
}

// ---- tables ----------------------------------------------------------------------------------
function cxTable(ctx, tbl) {
    const tblPr = cxKid(tbl, 'tblPr');
    const styleId = cxVal(cxKid(tblPr, 'tblStyle')) || ctx.S.defaultTable;
    const chain = cxChain(ctx.S, styleId);
    const scope = { tblP: cxMerge(...chain.map(s => s.pPr)), tblR: cxMerge(...chain.map(s => s.rPr)) };
    const borders = Object.assign({}, ...chain.map(s => s.tbl.borders), cxBorders(cxKid(tblPr, 'tblBorders'), ctx));
    const mar = Object.assign({ top: 0, bottom: 0, left: 108, right: 108 }, ...chain.map(s => s.tbl.mar), cxMar(cxKid(tblPr, 'tblCellMar')));

    let grid = cxKids(cxKid(tbl, 'tblGrid')).map(g => cxNum(cxAttr(g, 'w')) || 0);
    const trs = cxKids(tbl).filter(c => c.localName === 'tr' && c.namespaceURI === CXW);

    // model: rows -> cells with their grid column
    const rows = trs.map(tr => {
        const trPr = cxKid(tr, 'trPr');
        const cells = [];
        let col = cxNum(cxVal(cxKid(trPr, 'gridBefore'))) || 0;
        const before = col;
        const collect = (parent) => cxKids(parent).forEach(c => {
            if (c.namespaceURI !== CXW) return;
            if (c.localName === 'sdt') { collect(cxKid(c, 'sdtContent') || c); return; }
            if (c.localName !== 'tc') return;
            const tcPr = cxKid(c, 'tcPr');
            const span = cxNum(cxVal(cxKid(tcPr, 'gridSpan'))) || 1;
            const vm = cxKid(tcPr, 'vMerge');
            cells.push({ tc: c, tcPr, col, span, vm: vm ? (cxVal(vm) === 'restart' ? 'restart' : 'cont') : '' , rowspan: 1 });
            col += span;
        });
        collect(tr);
        const hRow = cxKid(trPr, 'trHeight');
        return { cells, before, after: cxNum(cxVal(cxKid(trPr, 'gridAfter'))) || 0, height: hRow ? cxNum(cxAttr(hRow, 'val')) : 0, ncols: col };
    });
    const maxCols = Math.max(grid.length, ...rows.map(r => r.ncols + r.after), 1);
    if (!grid.length) {
        grid = new Array(maxCols).fill(0);
        rows.forEach(r => r.cells.forEach(c => { const w = cxNum(cxAttr(cxKid(c.tcPr, 'tcW'), 'w')); if (w && c.span === 1 && !grid[c.col]) grid[c.col] = w; }));
        grid = grid.map(w => w || 1440);
    }
    // vertical merges -> rowspan
    rows.forEach((r, ri) => r.cells.forEach(c => {
        if (c.vm !== 'restart') return;
        for (let k = ri + 1; k < rows.length; k++) {
            const below = rows[k].cells.find(x => x.col === c.col);
            if (below && below.vm === 'cont') { c.rowspan++; below.skip = true; } else break;
        }
    }));

    // table-level geometry
    const tw = cxKid(tblPr, 'tblW');
    const twType = cxAttr(tw, 'type'), twVal = cxNum(cxAttr(tw, 'w'));
    const sum = grid.reduce((a, b) => a + b, 0);
    let width = `${cxPx(sum)}px`;
    if (twType === 'pct' && twVal) width = (twVal > 100 ? twVal / 50 : twVal) + '%';
    else if (twType === 'dxa' && twVal) width = `${cxPx(twVal)}px`;
    const jc = cxVal(cxKid(tblPr, 'jc'));
    const ind = cxNum(cxAttr(cxKid(tblPr, 'tblInd'), 'w')) || 0;
    const align = jc === 'center' ? 'margin-left:auto;margin-right:auto' : (jc === 'right' || jc === 'end') ? 'margin-left:auto;margin-right:0' : `margin-left:${cxPx(ind)}px`;

    let html = `<table style="border-collapse:collapse;table-layout:fixed;width:${width};max-width:100%;${align}"><colgroup>` +
        grid.map(w => `<col style="width:${cxPx(w)}px">`).join('') + '</colgroup><tbody>';

    rows.forEach((r, ri) => {
        html += `<tr${r.height ? ` style="height:${cxPx(r.height)}px"` : ''}>`;
        if (r.before) html += `<td colspan="${r.before}" style="border:none;padding:0"></td>`;
        r.cells.forEach(c => {
            if (c.skip) return;
            const lastRow = ri + c.rowspan - 1 >= rows.length - 1;
            const lastCol = c.col + c.span >= grid.length;
            const own = cxBorders(cxKid(c.tcPr, 'tcBorders'), ctx);
            const edge = {
                top: own.top || (ri === 0 ? borders.top : borders.insideH),
                bottom: own.bottom || (lastRow ? borders.bottom : borders.insideH),
                left: own.left || (c.col === 0 ? borders.left : borders.insideV),
                right: own.right || (lastCol ? borders.right : borders.insideV)
            };
            const css = [];
            for (const side of ['top', 'right', 'bottom', 'left']) { const v = cxBorderCss(edge[side]); if (v) css.push(`border-${side}:${v}`); }
            const cm = Object.assign({}, mar, cxMar(cxKid(c.tcPr, 'tcMar')));
            css.push(`padding:${cxPx(cm.top)}px ${cxPx(cm.right)}px ${cxPx(cm.bottom)}px ${cxPx(cm.left)}px`);
            const shd = cxKid(c.tcPr, 'shd');
            const fill = shd && cxHex(cxAttr(shd, 'fill'), cxAttr(shd, 'themeFill'), cxAttr(shd, 'themeFillTint'), cxAttr(shd, 'themeFillShade'), ctx.theme);
            if (fill) css.push('background-color:' + fill);
            const va = cxVal(cxKid(c.tcPr, 'vAlign'));
            css.push('vertical-align:' + (va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : 'top'));
            const inner = cxBlocksHtml(ctx, cxBlocks(c.tc), scope);
            html += `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''} style="${cxEsc(css.join(';'))}">${inner || '<p><br></p>'}</td>`;
        });
        if (r.after) html += `<td colspan="${r.after}" style="border:none;padding:0"></td>`;
        html += '</tr>';
    });
    return html + '</tbody></table>';
}

// ---- multi-column sections -------------------------------------------------------------------
// A Word section with 2+ columns (PDF→Word files use them for "sidebar | text" layouts) becomes a borderless
// table with one cell per column, split at the Word column break. Anything else flows as before.
function cxSectionsHtml(ctx, blocks, bodySect) {
    const secs = [];
    let cur = [];
    for (const b of blocks) {
        cur.push(b);
        const pPr = b.localName === 'p' ? cxKid(b, 'pPr') : null;
        const sp = pPr && cxKid(pPr, 'sectPr');
        if (sp) { secs.push({ blocks: cur, sect: sp }); cur = []; }
    }
    if (cur.length) secs.push({ blocks: cur, sect: bodySect || null });

    let out = '';
    for (const sec of secs) {
        const cols = sec.sect && cxKid(sec.sect, 'cols');
        const n = cols ? (cxNum(cxAttr(cols, 'num')) || 1) : 1;
        const defs = cols ? cxKids(cols).filter(c => c.localName === 'col' && c.namespaceURI === CXW)
            .map(c => ({ w: cxNum(cxAttr(c, 'w')) || 0, space: cxNum(cxAttr(c, 'space')) || 0 })) : [];
        if (n >= 2 && defs.length === n && defs.every(d => d.w > 0)) {
            const parts = [[]];
            for (const b of sec.blocks) {
                const hasColBreak = b.localName === 'p' &&
                    [...b.getElementsByTagNameNS(CXW, 'br')].some(br => cxAttr(br, 'type') === 'column');
                // In Word the column break sits INSIDE its paragraph: whatever follows it (here just the paragraph mark,
                // often a big empty line with spacing-before) is the first line of the NEXT column. So a paragraph that
                // holds nothing but the break starts the next column; one with text before the break stays in this one.
                const breakOnly = hasColBreak && !(b.textContent || '').trim() &&
                    !b.getElementsByTagNameNS(CXW, 'drawing').length && !b.getElementsByTagNameNS(CXW, 'pict').length;
                if (hasColBreak && breakOnly && parts.length < n) { parts.push([b]); continue; }
                parts[parts.length - 1].push(b);
                if (hasColBreak && parts.length < n) parts.push([]);
            }
            if (parts.length === n && parts.every(p => p.length)) {
                const cells = parts.map(p => cxBlocksHtml(ctx, p, CX_NO_SCOPE).replace(/<hr class="tpl-pagebreak">/g, ''));
                let total = 0, cg = '', tds = '';
                defs.forEach((d, i) => {
                    total += d.w;
                    cg += `<col style="width:${cxPx(d.w)}px">`;
                    tds += `<td style="width:${cxPx(d.w)}px;vertical-align:top;padding:0;border:none">${cells[i] || '<p><br></p>'}</td>`;
                    if (i < n - 1 && d.space) {
                        total += d.space;
                        cg += `<col style="width:${cxPx(d.space)}px">`;
                        tds += `<td style="width:${cxPx(d.space)}px;padding:0;border:none"></td>`;
                    }
                });
                out += `<table class="tpl-cols" border="0" style="border-collapse:collapse;table-layout:fixed;width:${cxPx(total)}px;max-width:100%;margin:0"><colgroup>${cg}</colgroup><tbody><tr>${tds}</tr></tbody></table>`;
                continue;
            }
        }
        out += cxBlocksHtml(ctx, sec.blocks, CX_NO_SCOPE);
    }
    return out;
}

// ---- Word drawing groups / shapes -> one PNG each ----------------------------------------------
// Letterheads (colour bars, footer band, icons, divider lines, seal) are usually a DrawingML group. Mammoth-style
// converters only see its pictures; here the whole group (vector shapes + pictures) is drawn as SVG, rasterised
// to PNG and inserted as ONE picture that keeps the group's size and position (data-dx → applyDocxImageLayouts).
const VX_WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const VX_WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
const VX_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const VX_SCHEME = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
const vxNum = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const vxOf = (n, ns, name) => cxKids(n).find(c => c.namespaceURI === ns && c.localName === name) || null;

function vxColor(fill, ctx) {
    const c = cxKids(fill)[0];
    if (!c) return null;
    let color = '';
    if (c.localName === 'srgbClr') color = '#' + (c.getAttribute('val') || '');
    else if (c.localName === 'schemeClr') {
        const k = c.getAttribute('val') || '';
        color = cxHex('', VX_SCHEME[k] || k, '', '', ctx.theme);
    } else if (c.localName === 'sysClr') color = '#' + (c.getAttribute('lastClr') || '');
    if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
    const a = cxKids(c).find(x => x.localName === 'alpha');
    return { color, alpha: a ? Math.max(0, Math.min(1, vxNum(a.getAttribute('val'), 100000) / 100000)) : 1 };
}

function vxPaint(spPr, ctx) {
    let fill = 'none', fo = 1, stroke = 'none', so = 1, sw = 0, dash = '';
    const sf = vxOf(spPr, CXA, 'solidFill');
    const gf = vxOf(spPr, CXA, 'gradFill');
    if (sf) { const c = vxColor(sf, ctx); if (c) { fill = c.color; fo = c.alpha; } }
    else if (gf) {
        const gs = vxOf(gf, CXA, 'gsLst');
        const first = gs && cxKids(gs)[0];
        const c = first && vxColor(first, ctx);
        if (c) { fill = c.color; fo = c.alpha; }
    }
    const ln = vxOf(spPr, CXA, 'ln');
    if (ln && !vxOf(ln, CXA, 'noFill')) {
        const lf = vxOf(ln, CXA, 'solidFill');
        const c = lf && vxColor(lf, ctx);
        if (c) {
            stroke = c.color; so = c.alpha;
            sw = Math.max(vxNum(ln.getAttribute('w'), 9525), 6350);        // hairlines stay visible
            const pd = vxOf(ln, CXA, 'prstDash');
            const dv = pd ? pd.getAttribute('val') : '';
            if (/^(dash|lgDash|sysDash)/.test(dv)) dash = ` stroke-dasharray="${sw * 4} ${sw * 3}"`;
            else if (/^(dot|sysDot)/.test(dv)) dash = ` stroke-dasharray="${sw} ${sw * 2}"`;
        }
    }
    return { fill, fo, stroke, so, sw, dash };
}

function vxPathD(path, ext) {
    const pw = vxNum(path.getAttribute('w')), ph = vxNum(path.getAttribute('h'));
    const sx = pw ? ext.cx / pw : 1, sy = ph ? ext.cy / ph : 1;
    const pt = (el) => [vxNum(el.getAttribute('x')) * sx, vxNum(el.getAttribute('y')) * sy];
    let d = '', cur = [0, 0];
    for (const c of cxKids(path)) {
        const pts = cxKids(c).filter(x => x.localName === 'pt').map(pt);
        switch (c.localName) {
            case 'moveTo': if (pts[0]) { d += `M${pts[0].join(' ')} `; cur = pts[0]; } break;
            case 'lnTo': if (pts[0]) { d += `L${pts[0].join(' ')} `; cur = pts[0]; } break;
            case 'cubicBezTo': if (pts.length >= 3) { d += `C${pts.slice(0, 3).map(p => p.join(' ')).join(' ')} `; cur = pts[2]; } break;
            case 'quadBezTo': if (pts.length >= 2) { d += `Q${pts.slice(0, 2).map(p => p.join(' ')).join(' ')} `; cur = pts[1]; } break;
            case 'arcTo': {
                const wR = vxNum(c.getAttribute('wR')) * sx, hR = vxNum(c.getAttribute('hR')) * sy;
                const st = vxNum(c.getAttribute('stAng')) / 60000 * Math.PI / 180;
                const sw = vxNum(c.getAttribute('swAng')) / 60000 * Math.PI / 180;
                if (!wR || !hR) break;
                const x0 = cur[0] - wR * Math.cos(st), y0 = cur[1] - hR * Math.sin(st);
                const ex = x0 + wR * Math.cos(st + sw), ey = y0 + hR * Math.sin(st + sw);
                d += `A${wR} ${hR} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${ex} ${ey} `;
                cur = [ex, ey];
                break;
            }
            case 'close': d += 'Z '; break;
        }
    }
    return d.trim();
}

/** Text of a text box that sits inside a drawing group, laid out with canvas measuring and written as SVG <text>. */
function vxTextBox(wsp, ctx, ext) {
    const tx = vxOf(wsp, VX_WPS, 'txbx');
    const content = tx && cxKid(tx, 'txbxContent');
    if (!content) return '';
    const bp = vxOf(wsp, VX_WPS, 'bodyPr');
    const ins = (k, d) => { const v = bp && bp.getAttribute(k); return v !== null && v !== undefined && v !== '' ? vxNum(v, d) : d; };
    const L = ins('lIns', 91440), T = ins('tIns', 45720), R = ins('rIns', 91440), B = ins('bIns', 45720);
    const anchor = (bp && bp.getAttribute('anchor')) || 't';
    const m = document.createElement('canvas').getContext('2d');
    const TW = 635;                                            // EMU per twip
    const PT = 12700;                                          // EMU per pt
    const lines = [];                                          // { y, h, chunks:[{x,w,t,font,size,b,i,color}], jc }
    let cy = 0;

    for (const p of cxKids(content).filter(k => k.localName === 'p' && k.namespaceURI === CXW)) {
        const pp = cxPPr(cxKid(p, 'pPr'), ctx);
        const styleId = pp.style || ctx.S.defaultPara;
        const sp = cxStyleP(ctx.S, styleId);
        const baseR = cxMerge(ctx.S.defR, cxStyleR(ctx.S, styleId));
        const eff = cxMerge(ctx.S.defP, sp, pp);
        const segs = [];
        const addRuns = (node) => cxKids(node).forEach(c => {
            if (c.namespaceURI === CXMC) { const ch = c.localName === 'AlternateContent' ? cxKid(c, 'Choice', CXMC) : null; if (ch) addRuns(ch); return; }
            if (c.namespaceURI !== CXW) return;
            if (c.localName === 'hyperlink' || c.localName === 'smartTag' || c.localName === 'ins') { addRuns(c); return; }
            if (c.localName !== 'r') return;
            const rPr = cxKid(c, 'rPr');
            const rs = cxKid(rPr, 'rStyle');
            const f = cxMerge(baseR, rs ? cxStyleR(ctx.S, cxVal(rs)) : null, cxRPr(rPr, ctx));
            let t = '';
            for (const k of cxKids(c)) {
                if (k.namespaceURI !== CXW) continue;
                if (k.localName === 't') t += k.textContent;
                else if (k.localName === 'tab') t += '    ';
            }
            if (t && !f.hidden) segs.push({ t: f.caps ? t.toUpperCase() : t, font: f.font || ctx.theme.minor || 'Times New Roman', size: f.size || 11, b: !!f.b, i: !!f.i, color: f.color || '#000000' });
        });
        addRuns(p);

        const left = (eff.left || 0) * TW, right = (eff.right || 0) * TW, first = (eff.first || 0) * TW;
        const avail = Math.max(1, ext.cx - L - R - left - right);
        cy += (pp.before !== undefined ? pp.before : (sp.before || 0)) * TW;
        const maxSize = Math.max(11, ...segs.map(s => s.size));
        let lh = maxSize * PT * 1.2;
        if (eff.line) lh = (!eff.lineRule || eff.lineRule === 'auto') ? maxSize * PT * 1.2 * (eff.line / 240) : eff.line * TW;

        // words with their style, greedy wrap
        const words = [];
        segs.forEach(s => s.t.split(/(\s+)/).forEach(w => { if (w) words.push({ ...s, t: w }); }));
        const fontOf = (s) => `${s.i ? 'italic ' : ''}${s.b ? 'bold ' : ''}${s.size * 4 / 3}px ${cxFont(s.font)}`;
        const widthOf = (s) => { m.font = fontOf(s); return m.measureText(s.t).width * DX_EMU_PX; };
        let cur = { chunks: [], w: 0 }, rows = [], firstRow = true;
        const flush = () => { rows.push(cur); cur = { chunks: [], w: 0 }; firstRow = false; };
        for (const w of words) {
            const ww = widthOf(w);
            const room = avail - (firstRow ? first : 0);
            if (cur.w + ww > room && cur.chunks.length && !/^\s+$/.test(w.t)) flush();
            if (!cur.chunks.length && /^\s+$/.test(w.t) && rows.length) continue;     // no leading blank on wrapped lines
            cur.chunks.push({ ...w, w: ww, x: cur.w });
            cur.w += ww;
        }
        if (cur.chunks.length || !rows.length) flush();
        rows.forEach((row, ri) => {
            const startX = L + left + (ri === 0 ? first : 0);
            const free = avail - (ri === 0 ? first : 0) - row.w;
            const jc = pp.jc || ctx.S.defP.jc || '';
            const dx = (jc === 'center') ? free / 2 : (jc === 'right' || jc === 'end') ? free : 0;
            lines.push({ y: cy, h: lh, x0: startX + Math.max(0, dx), chunks: row.chunks, size: maxSize });
            cy += lh;
        });
        cy += (pp.after !== undefined ? pp.after : (sp.after || 0)) * TW;
    }
    if (!lines.length) return '';
    const room = ext.cy - T - B;
    const top = T + (anchor === 'ctr' ? Math.max(0, (room - cy) / 2) : anchor === 'b' ? Math.max(0, room - cy) : 0);
    let out = '';
    for (const ln of lines) {
        for (const c of ln.chunks) {
            if (/^\s+$/.test(c.t)) continue;
            // coordinates are in pt (scaled by PT below) – browsers misrender SVG text whose font-size is ~100000 user units
            out += `<text x="${(ln.x0 + c.x) / PT}" y="${(top + ln.y + ln.h * 0.8) / PT}" font-family="${cxEsc(cxFont(c.font))}" font-size="${c.size}" ` +
                `fill="${c.color}"${c.b ? ' font-weight="bold"' : ''}${c.i ? ' font-style="italic"' : ''} xml:space="preserve">${cxEsc(c.t)}</text>`;
        }
    }
    return out ? `<g transform="scale(${PT})">${out}</g>` : '';
}

function vxShape(wsp, ctx, frame) {
    if (wsp.hasAttribute('data-tpl-tb')) return '';                          // text box → handled as a table
    const spPr = vxOf(wsp, VX_WPS, 'spPr');
    if (!spPr) return '';
    const xf = vxOf(spPr, CXA, 'xfrm');
    const o = xf && vxOf(xf, CXA, 'off'), e = xf && vxOf(xf, CXA, 'ext');
    const x = frame ? 0 : vxNum(o && o.getAttribute('x')), y = frame ? 0 : vxNum(o && o.getAttribute('y'));
    const ext = { cx: e ? vxNum(e.getAttribute('cx')) : (frame ? frame.cx : 0), cy: e ? vxNum(e.getAttribute('cy')) : (frame ? frame.cy : 0) };
    if (frame && frame.cx) { ext.cx = frame.cx; ext.cy = frame.cy; }
    const rot = xf ? vxNum(xf.getAttribute('rot')) / 60000 : 0;
    const fh = xf && xf.getAttribute('flipH') === '1', fv = xf && xf.getAttribute('flipV') === '1';
    const p = vxPaint(spPr, ctx);
    const attr = (fillOn, strokeOn) =>
        `fill="${fillOn ? p.fill : 'none'}" fill-opacity="${p.fo}" stroke="${strokeOn ? p.stroke : 'none'}"` +
        (strokeOn && p.stroke !== 'none' ? ` stroke-width="${p.sw}" stroke-opacity="${p.so}"${p.dash}` : '');

    let g = '';
    const cg = vxOf(spPr, CXA, 'custGeom');
    if (p.fill === 'none' && p.stroke === 'none') { /* no visible outline / fill: only the text (if any) is drawn */ }
    else if (cg) {
        const pl = vxOf(cg, CXA, 'pathLst');
        for (const path of cxKids(pl).filter(k => k.localName === 'path')) {
            const d = vxPathD(path, ext);
            if (!d) continue;
            const fillOn = path.getAttribute('fill') !== 'none';
            const strokeOn = !/^(0|false)$/.test(path.getAttribute('stroke') || '');
            g += `<path d="${d}" ${attr(fillOn, strokeOn)}/>`;
        }
    } else {
        const pg = vxOf(spPr, CXA, 'prstGeom');
        const prst = (pg && pg.getAttribute('prst')) || 'rect';
        if (/line|Connector/i.test(prst)) g = `<line x1="0" y1="0" x2="${ext.cx}" y2="${ext.cy}" ${attr(false, true)}/>`;
        else if (prst === 'ellipse') g = `<ellipse cx="${ext.cx / 2}" cy="${ext.cy / 2}" rx="${ext.cx / 2}" ry="${ext.cy / 2}" ${attr(true, true)}/>`;
        else if (prst === 'triangle') g = `<polygon points="${ext.cx / 2},0 ${ext.cx},${ext.cy} 0,${ext.cy}" ${attr(true, true)}/>`;
        else g = `<rect x="0" y="0" width="${ext.cx}" height="${ext.cy}"${prst === 'roundRect' ? ` rx="${Math.min(ext.cx, ext.cy) / 6}"` : ''} ${attr(true, true)}/>`;
    }
    g += vxTextBox(wsp, ctx, ext);
    if (!g) return '';
    const tf = `translate(${x} ${y})` + (rot ? ` rotate(${rot} ${ext.cx / 2} ${ext.cy / 2})` : '') +
        (fh || fv ? ` translate(${fh ? ext.cx : 0} ${fv ? ext.cy : 0}) scale(${fh ? -1 : 1} ${fv ? -1 : 1})` : '');
    return `<g transform="${tf}">${g}</g>`;
}

function vxPic(pic, ctx) {
    const blip = pic.getElementsByTagNameNS(CXA, 'blip')[0];
    const src = blip && ctx.images[cxAttr(blip, 'embed', CXR)];
    const spPr = vxOf(pic, VX_PIC, 'spPr');
    const xf = spPr && vxOf(spPr, CXA, 'xfrm');
    const o = xf && vxOf(xf, CXA, 'off'), e = xf && vxOf(xf, CXA, 'ext');
    if (!src || !e) return '';
    return `<image href="${src}" xlink:href="${src}" x="${vxNum(o && o.getAttribute('x'))}" y="${vxNum(o && o.getAttribute('y'))}" ` +
        `width="${vxNum(e.getAttribute('cx'))}" height="${vxNum(e.getAttribute('cy'))}" preserveAspectRatio="none"/>`;
}

function vxGroup(grp, ctx, frame) {
    const sp = cxKids(grp).find(c => c.localName === 'grpSpPr');
    const xf = sp && vxOf(sp, CXA, 'xfrm');
    const num = (name, a) => { const n = xf && vxOf(xf, CXA, name); return vxNum(n && n.getAttribute(a)); };
    const off = { x: frame ? 0 : num('off', 'x'), y: frame ? 0 : num('off', 'y') };
    const ext = { cx: frame ? frame.cx : num('ext', 'cx'), cy: frame ? frame.cy : num('ext', 'cy') };
    const chOff = { x: num('chOff', 'x'), y: num('chOff', 'y') };
    const chExt = { cx: num('chExt', 'cx') || ext.cx, cy: num('chExt', 'cy') || ext.cy };
    let inner = '';
    for (const c of cxKids(grp)) {
        if (c.namespaceURI === VX_WPS && c.localName === 'wsp') inner += vxShape(c, ctx, null);
        else if (c.namespaceURI === VX_PIC && c.localName === 'pic') inner += vxPic(c, ctx);
        else if (c.localName === 'grpSp') inner += vxGroup(c, ctx, null);
    }
    if (!inner) return '';
    const sx = chExt.cx ? ext.cx / chExt.cx : 1, sy = chExt.cy ? ext.cy / chExt.cy : 1;
    return `<g transform="translate(${off.x} ${off.y}) scale(${sx} ${sy}) translate(${-chOff.x} ${-chOff.y})">${inner}</g>`;
}

async function vxRasterize(drawing, ctx) {
    const host = cxKid(drawing, 'inline', CXWP) || cxKid(drawing, 'anchor', CXWP);
    const ext = host && cxKid(host, 'extent', CXWP);
    if (!ext) return '';
    const cx = vxNum(ext.getAttribute('cx')), cy = vxNum(ext.getAttribute('cy'));
    if (cx <= 0 || cy <= 0) return '';
    const gd = drawing.getElementsByTagNameNS(CXA, 'graphicData')[0];
    const node = gd && cxKids(gd)[0];
    if (!node) return '';
    const body = node.localName === 'wgp' ? vxGroup(node, ctx, { cx, cy })
        : node.localName === 'wsp' ? vxShape(node, ctx, { cx, cy }) : '';
    if (!body) return '';
    // hairlines (a few EMU tall) get a little transparent padding so their stroke is not clipped
    const padX = cx / DX_EMU_PX < 8 ? (8 - cx / DX_EMU_PX) / 2 : 0, padY = cy / DX_EMU_PX < 8 ? (8 - cy / DX_EMU_PX) / 2 : 0;
    ctx.vecPad.set(drawing, { x: padX, y: padY });
    const wpx = cx / DX_EMU_PX + 2 * padX, hpx = cy / DX_EMU_PX + 2 * padY;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${wpx}" height="${hpx}" ` +
        `viewBox="${-padX * DX_EMU_PX} ${-padY * DX_EMU_PX} ${cx + 2 * padX * DX_EMU_PX} ${cy + 2 * padY * DX_EMU_PX}">${body}</svg>`;
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    try {
        const scale = Math.min(2, 3200 / Math.max(wpx, hpx));              // ~192 dpi, capped for very large drawings
        const w = Math.max(1, Math.round(wpx * scale)), h = Math.max(1, Math.round(hpx * scale));
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg did not load')); img.src = svgUrl; });
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        return canvas.toDataURL('image/png');
    } catch (err) {
        console.warn('Drawing could not be rasterised, keeping it as SVG:', err);
        return svgUrl;
    }
}

async function docxVectorsToPng(docXml, ctx) {
    ctx.vec = new Map();
    ctx.vecPad = new Map();
    const list = [...docXml.getElementsByTagNameNS(CXW, 'drawing')].filter(d => !dxUp(d, CXMC, 'Fallback') && dxIsVector(d));
    for (const d of list) {
        try {
            const url = await vxRasterize(d, ctx);
            if (url) ctx.vec.set(d, url);
        } catch (err) {
            console.warn('Drawing group skipped:', err);
            ctx.messages.push('A drawing (shapes / lines) could not be converted.');
        }
    }
}

// ---- entry point -----------------------------------------------------------------------------
/** @returns {Promise<{value:string, messages:Array}>} same shape Mammoth returns. */
async function docxToHtmlFull(buf, state) {
    const zip = await JSZip.loadAsync(buf);
    const read = async (path) => { const f = zip.file(path); return f ? f.async('string') : ''; };
    const parse = (s, strict) => {
        if (!s) return null;
        const d = new DOMParser().parseFromString(s, 'application/xml');
        if (d.getElementsByTagName('parsererror').length) { if (strict) throw new Error('XML parse error'); return null; }
        return d;
    };
    const docXml = parse(await read('word/document.xml'), true);
    const body = docXml.getElementsByTagNameNS(CXW, 'body')[0];
    if (!body) throw new Error('document has no body');

    const ctx = { theme: cxParseTheme(parse(await read('word/theme/theme1.xml'))), messages: [], counters: {}, images: {}, rels: {}, state };
    ctx.S = cxParseStyles(parse(await read('word/styles.xml')), ctx);
    ctx.N = cxParseNumbering(parse(await read('word/numbering.xml')));

    // relationships (images are read up-front so the conversion itself can stay synchronous)
    const relDoc = parse(await read('word/_rels/document.xml.rels'));
    if (relDoc) {
        for (const r of relDoc.getElementsByTagName('Relationship')) {
            const id = r.getAttribute('Id'), target = r.getAttribute('Target') || '';
            const external = r.getAttribute('TargetMode') === 'External';
            ctx.rels[id] = { target, external };
            if (!/\/image$/.test(r.getAttribute('Type') || '') || external) continue;
            const parts = (target.startsWith('/') ? target.slice(1) : 'word/' + target).split('/');
            const path = []; parts.forEach(p => { if (p === '..') path.pop(); else if (p !== '.') path.push(p); });
            const f = zip.file(path.join('/'));
            const mime = CX_MIME[(path[path.length - 1].split('.').pop() || '').toLowerCase()];
            if (f && mime) ctx.images[id] = `data:${mime};base64,${await f.async('base64')}`;
        }
    }
    await docxVectorsToPng(docXml, ctx);
    const value = cxSectionsHtml(ctx, cxBlocks(body), cxKid(body, 'sectPr'));
    return { value, messages: [...new Set(ctx.messages)].map(m => ({ type: 'warning', message: m })) };
}

/** Converts the Word file (full-fidelity converter, Mammoth as fallback) with picture infos attached; if the picture count doesn't match, no layout is applied. */
async function docxConvert(buf, xmlForInfos) {
    let prepared = { buf, xml: xmlForInfos, textBoxes: [] };
    try { prepared = await docxPrepare(buf); }
    catch (err) { console.warn('Alignment / text-box pre-pass skipped:', err); }
    let infos = null;
    try { infos = docxImageInfos(prepared.xml); } catch (err) { console.warn('Could not read picture layout:', err); }
    const state = { infos, i: 0 };
    let res;
    try {
        // Full-fidelity converter: keeps fonts, sizes, colours, spacing, indents, borders, shading...
        res = await docxToHtmlFull(prepared.buf, state);
    } catch (err) {
        console.warn('Full-fidelity .docx converter failed, using the basic converter instead:', err);
        state.i = 0;
        res = await mammoth.convertToHtml({ arrayBuffer: prepared.buf }, docxMammothOptions(state));
    }
    if (infos && state.i !== infos.length) {
        console.warn(`Picture layout skipped: Word has ${infos.length} pictures, ${state.i} were converted.`);
        res.value = res.value.replace(/\sdata-dx="[^"]*"/g, '');
    }
    res.textBoxes = prepared.textBoxes;
    return res;
}

/**
 * Turns the temporary data-dx info into real image layout:
 *   behind text -> "Behind text" (free position)      in front / no wrap -> "In front" (free position)
 *   wrapped (square / tight / through) -> wrap left / right / centered      top & bottom -> centered
 *   in line with text -> unchanged
 * Position (page / margin / paragraph relative, offsets or alignment) and size come from the Word file.
 */
async function applyDocxImageLayouts() {
    if (!editor || !editor.getBody) return;
    const body = editor.getBody();
    const imgs = [...body.querySelectorAll('img[data-dx]')];
    if (!imgs.length) return;

    // wait for the pictures so paragraph positions are final
    await Promise.race([
        Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
        new Promise(r => setTimeout(r, 3000))
    ]);

    const items = [];
    imgs.forEach(img => {
        let info = null;
        try { info = JSON.parse(img.getAttribute('data-dx')); } catch (_) { /* ignore */ }
        img.removeAttribute('data-dx');
        if (info && info.t === 'a') items.push({ img, info });
    });
    if (!items.length) { schedulePaginate(); return; }

    // take free-position pictures out of the text flow first, so they don't push the paragraphs down
    items.forEach(({ img, info }) => {
        if (info.behind || info.wrap === 'wrapNone') img.style.position = 'absolute';
    });
    // A paragraph that held nothing but floating pictures would collapse to zero height once they leave the flow,
    // while in Word it keeps the height of its paragraph mark (letterhead files are full of these). Without this the
    // text below slid up ~20px per such paragraph and ended up on top of the banner. A <br> restores that line.
    items.forEach(({ img }) => {
        if (img.style.position !== 'absolute') return;
        const holder = img.closest('p,h1,h2,h3,h4,h5,h6,li');
        if (!holder || holder.querySelector('br')) return;
        const inFlow = [...holder.childNodes].some(n =>
            (n.nodeType === 3 && n.textContent.trim()) ||
            (n.nodeType === 1 && !(n.tagName === 'IMG' && n.style.position === 'absolute')));
        if (!inFlow) holder.appendChild(holder.ownerDocument.createTextNode('\u00a0'));   // not <br>: TinyMCE drops a trailing <br> on save/reload
    });
    paginateEditor();

    const g = pageGeometry(pageSettings);
    const mL = g.s.margins.left * MM_PX, mR = g.s.margins.right * MM_PX;
    const mT = g.s.margins.top * MM_PX, mB = g.s.margins.bottom * MM_PX;
    const pageW = g.w * MM_PX, pageH = g.h * MM_PX;
    const P = sheetPitch();
    const cs = editor.getWin().getComputedStyle(body);
    const br = body.getBoundingClientRect();
    const originTop = br.top + (parseFloat(cs.borderTopWidth) || 0);

    // measure every anchor paragraph before anything changes
    items.forEach(it => {
        const holder = it.img.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,div') || it.img.parentElement;
        const r = holder.getBoundingClientRect();
        it.paraTop = r.top - originTop;
        it.hf = !!it.img.closest('.tpl-hf');
        it.hfKind = it.img.closest('.tpl-hf')?.getAttribute('data-hf') || '';
    });

    editor.undoManager.ignore(() => {
        items.forEach(({ img, info, paraTop, hf, hfKind }) => {
            const w = info.w > 0 ? info.w : (img.naturalWidth || 100);
            const h = info.h > 0 ? info.h : (img.naturalHeight || 100);
            const k = hf ? 0 : Math.max(0, Math.floor(paraTop / P));
            const pageTop = k * P;

            // ---- horizontal (px from the page's left edge)
            const hBase = { page: 0, margin: mL, column: mL, leftMargin: mL, insideMargin: mL, character: mL, paragraph: mL, rightMargin: pageW - mR, outsideMargin: pageW - mR };
            const hArea = { page: pageW, margin: pageW - mL - mR, column: pageW - mL - mR, leftMargin: mL, rightMargin: mR, insideMargin: mL, outsideMargin: mR };
            let x;
            const hb = hBase[info.hrel] ?? 0, ha = hArea[info.hrel] ?? (pageW - mL - mR);
            if (info.halign === 'left' || info.halign === 'inside') x = hb;
            else if (info.halign === 'center') x = hb + (ha - w) / 2;
            else if (info.halign === 'right' || info.halign === 'outside') x = hb + ha - w;
            else x = hb + info.hoff;

            // ---- vertical (px from the top of the document, page k)
            let vBase, vArea;
            switch (info.vrel) {
                case 'margin': case 'topMargin': vBase = pageTop + mT; vArea = pageH - mT - mB; break;
                case 'bottomMargin':             vBase = pageTop + pageH - mB; vArea = mB; break;
                case 'paragraph': case 'line': case 'insideMargin': case 'outsideMargin':
                    vBase = hf ? (hfKind === 'footer' ? pageTop + pageH - mB : pageTop + 12.7 * MM_PX) : paraTop;
                    vArea = h; break;
                default:                         vBase = pageTop; vArea = pageH;          // page
            }
            let y;
            if (info.valign === 'top') y = vBase;
            else if (info.valign === 'center') y = vBase + (vArea - h) / 2;
            else if (info.valign === 'bottom') y = vBase + vArea - h;
            else y = vBase + info.voff;

            // ---- layout
            let mode;
            if (info.behind) mode = 'behind';
            else if (info.wrap === 'wrapNone') mode = 'front';
            else if (info.wrap === 'wrapTopAndBottom') mode = 'center';
            else {
                const cx = x + w / 2;
                if (info.halign === 'left' || cx < mL + (pageW - mL - mR) / 3) mode = 'left';
                else if (info.halign === 'right' || cx > mL + 2 * (pageW - mL - mR) / 3) mode = 'right';
                else mode = 'center';
            }
            const free = mode === 'behind' || mode === 'front';
            applyImageLayout(img, mode, free
                ? { x, y, width: w, repeat: hf }
                : { width: w });
        });
    });

    schedulePaginate();
    refreshImagePanel();
}

// Mammoth only reads the document body, so Word headers / footers (letterhead logos, office name,
// address lines...) were silently dropped. Here each header / footer part (the "default" one of the
// last section) is rebuilt into a tiny stand-alone .docx whose body is that part, and converted too.
async function extractHeaderFooterHtml(buf) {
    const out = { header: '', footer: '' };
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');

    const zip0 = await JSZip.loadAsync(buf);
    const docXml = await zip0.file('word/document.xml').async('string');
    const relsFile = zip0.file('word/_rels/document.xml.rels');
    if (!relsFile) return out;
    const relDoc = parse(await relsFile.async('string'));
    const targets = {};
    [...relDoc.getElementsByTagName('Relationship')].forEach(r => { targets[r.getAttribute('Id')] = r.getAttribute('Target'); });

    const sects = parse(docXml).getElementsByTagNameNS(W, 'sectPr');
    if (!sects.length) return out;
    // The template is the FIRST page of the Word file, so its header / footer come from the FIRST section.
    // (A first section with no header reference simply has none; later sections often repeat the letterhead.)
    const sect = sects[0];

    for (const kind of ['header', 'footer']) {
        const refs = [...sect.getElementsByTagNameNS(W, kind + 'Reference')];
        const ref = refs.find(r => r.getAttributeNS(W, 'type') === 'default') || refs[0];
        const target = ref && targets[ref.getAttributeNS(R, 'id')];
        if (!target) continue;
        const partPath = 'word/' + target.replace(/^\/?(word\/)?/, '');
        const partFile = zip0.file(partPath);
        if (!partFile) continue;

        try {
            const zip = await JSZip.loadAsync(buf);                       // fresh copy; never touch the original
            let partXml = await partFile.async('string');
            const partXmlOriginal = partXml;
            const tag = kind === 'header' ? 'hdr' : 'ftr';
            partXml = partXml
                .replace(/r:(embed|id|link)="([^"]+)"/g, 'r:$1="hf_$2"')  // avoid rId clashes with document rels
                .replace(new RegExp(`<w:${tag}\\b([^>]*)>`), '<w:document$1><w:body>')
                .replace(new RegExp(`</w:${tag}>`), '</w:body></w:document>');
            zip.file('word/document.xml', partXml);

            let rels = await zip.file('word/_rels/document.xml.rels').async('string');
            const partName = partPath.split('/').pop();
            const pr = zip.file(`word/_rels/${partName}.rels`);
            if (pr) {
                const extra = (await pr.async('string'))
                    .replace(/<\?xml[^>]*\?>/, '')
                    .replace(/<\/?Relationships[^>]*>/g, '')
                    .replace(/\bId="([^"]+)"/g, 'Id="hf_$1"');
                rels = rels.replace('</Relationships>', extra + '</Relationships>');
                zip.file('word/_rels/document.xml.rels', rels);
            }

            const res = await docxConvert(await zip.generateAsync({ type: 'arraybuffer' }), partXmlOriginal);
            const html = docxHtmlForEditor(res.value, res.textBoxes);
            if (html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() || /<img/i.test(html)) out[kind] = html;
        } catch (err) {
            console.warn(`Could not read the Word ${kind}:`, err);
        }
    }
    return out;
}

// Reads paper size, orientation and margins from the last section of the Word file,
// so the template opens with the same page setup as the original document.
async function extractPageSettings(zip) {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    const sects = xml.getElementsByTagNameNS(W, 'sectPr');
    if (!sects.length) return null;
    const sect = sects[0];            // first section = how the first page (the template) is set up
    const attr =(node, name) => { const v = node && parseFloat(node.getAttributeNS(W, name)); return Number.isFinite(v) ? v : null; };
    const TW_MM = 56.7;   // twips per mm
    const out = {};

    const pgSz = sect.getElementsByTagNameNS(W, 'pgSz')[0];
    if (pgSz) {
        const w = attr(pgSz, 'w'), h = attr(pgSz, 'h');
        if (w && h) {
            const wmm = w / TW_MM, hmm = h / TW_MM;
            const orient = pgSz.getAttributeNS(W, 'orient');
            out.orientation = (orient === 'landscape' || wmm > hmm) ? 'landscape' : 'portrait';
            const lo = Math.min(wmm, hmm), hi = Math.max(wmm, hmm);
            for (const [key, sz] of Object.entries(PAGE_SIZES)) {
                const dims = Object.values(sz).filter(v => typeof v === 'number' && v > 50);
                if (dims.length >= 2) {
                    const a = Math.min(dims[0], dims[1]), b = Math.max(dims[0], dims[1]);
                    if (Math.abs(a - lo) < 2 && Math.abs(b - hi) < 2) { out.size = key; break; }
                }
            }
            out.sizeMm = [Math.round(lo), Math.round(hi)];
        }
    }
    const pgMar = sect.getElementsByTagNameNS(W, 'pgMar')[0];
    if (pgMar) {
        const m = {};
        for (const k of ['top', 'bottom', 'left', 'right']) {
            const v = attr(pgMar, k);
            if (v !== null) m[k] = Math.round(Math.abs(v) / TW_MM * 10) / 10;
        }
        if (Object.keys(m).length) out.margins = m;
    }
    return out;
}

async function onDocxChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !editor) return;
    if (typeof JSZip === 'undefined') {
        showToast('The .docx reader (JSZip) could not be loaded.', 5000);
        return;
    }
    if (!(await confirmDialog({
        title: 'Import this Word file?',
        text: 'The editor content (and any Word file imported earlier) will be replaced with this .docx. Some fonts and layout details may still need re-applying. Nothing is saved until you click Save Template.',
        yesLabel: 'Import', danger: true
    }))) return;

    try {
        const buf = await file.arrayBuffer();

        // 1) Open the package with JSZip and make sure it really is a Word document.
        const zip = await JSZip.loadAsync(buf);
        if (!zip.file('word/document.xml')) {
            throw new Error('this is not a valid .docx file (word/document.xml is missing).');
        }

        // 2) Convert for display in TinyMCE (images stay embedded as data: URLs; they are
        //    uploaded to the image host when the template is saved).
        const result = await docxConvert(buf, await zip.file('word/document.xml').async('string'));
        const hf = await extractHeaderFooterHtml(buf);

        // 3) Only now replace the previously stored original, so a failed import keeps the old one.
        setOriginalDocx(file, buf, zip);
        storedOriginal = null;   // the previously stored original no longer matches this import

        // Carry over the original paper size, orientation and margins
        let pageNote = '';
        try {
            const ps = await extractPageSettings(zip);
            if (ps) {
                pageSettings = normalizePageSettings({
                    ...pageSettings,
                    ...(ps.size ? { size: ps.size } : {}),
                    ...(ps.orientation ? { orientation: ps.orientation } : {}),
                    margins: { ...pageSettings.margins, ...(ps.margins || {}) }
                });
                syncPageSettingsUI();
                if (ps.sizeMm && !ps.size) pageNote = ` Paper size ${ps.sizeMm[0]}×${ps.sizeMm[1]} mm isn't in the size list — check the Page tab.`;
            }
        } catch (err) {
            console.warn('Could not read page setup from the .docx:', err);
        }

        setEditorContent(
            (hf.header ? `<div class="tpl-hf" data-hf="header">${hf.header}</div>` : '') +
            docxHtmlForEditor(result.value, result.textBoxes) +
            (hf.footer ? `<div class="tpl-hf" data-hf="footer">${hf.footer}</div>` : ''));
        applyPageToEditor();
        try { await applyDocxImageLayouts(); }
        catch (err) { console.warn('Could not apply the Word picture layout:', err); }
        setDirty(true);
        const n = (result.messages || []).length;
        const hfNote = (hf.header || hf.footer)
            ? ' ' + [hf.header && 'Header (top)', hf.footer && 'Footer (bottom)'].filter(Boolean).join(' and ') + ' content was carried over.'
            : '';
        showToast((n
            ? `Imported with ${n} formatting note(s) — please review the layout.`
            : 'Word file imported. Review the layout, then save.') + hfNote + pageNote, 6000);
    } catch (err) {
        console.error(err);
        showToast('Could not read that .docx: ' + (err.message || err), 5000);
    }
}

async function remoteImagesToDataUrls(html) {
    const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    let failed = 0;
    for (const img of d.body.querySelectorAll('img[src]')) {
        const src = img.getAttribute('src');
        if (/^data:/i.test(src)) continue;
        try {
            const abs = new URL(src, location.href).href;
            const blob = await (await fetch(abs)).blob();
            img.setAttribute('src', await blobToDataUrl(blob));
        } catch (_) {
            failed++;
        }
    }
    return { html: d.body.innerHTML, failed };
}

// Triggers a browser download for a Blob.
function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// STAGE 3 (step 1): export the ORIGINAL imported .docx untouched.
// The original bytes are re-opened with JSZip (a fresh instance, so the copy kept in memory is never
// modified) and written back out with every entry intact: word/document.xml, styles, numbering,
// header/footer parts, media, relationships (_rels), [Content_Types].xml, section settings (sectPr)...
// TinyMCE edits are deliberately NOT merged in yet.
async function exportOriginalDocx() {
    if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded.');
    const zip = await JSZip.loadAsync(originalDocxBuffer);
    if (!zip.file('word/document.xml')) throw new Error('The stored original is not a valid .docx.');

    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    const fromName = originalDocxFile && originalDocxFile.name;
    const filename = fromName
        ? fromName.replace(/\.docx$/i, '') + '_exported.docx'
        : `${current.name.replace(/[^a-zA-Z0-9._-]+/g, '_')}_template.docx`;
    downloadBlob(blob, filename);
    showToast('Original Word file exported unchanged (editor changes are not included yet).', 5000);
}

async function exportDocx() {
    if (!editor || !current) return;

    // Always export the current editor content. An imported/original DOCX is optional;
    // edits made in this template editor must never be bypassed during export.
    if (typeof htmlDocx === 'undefined') {
        showToast('The .docx export library could not be loaded.', 5000);
        return;
    }
    try {
        await editor.uploadImages().catch(() => {});
        const { html, failed } = await remoteImagesToDataUrls(editor.getContent());

        const mm = (v) => Math.round(v * 56.7); // mm → twips
        const m = pageSettings.margins;
        const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss('body')}
` +
            '.tpl-textbox{box-sizing:border-box;border:1px solid #777;padding:8px 10px;margin:6px 0;min-height:42px;} ' +
            '.tpl-section-box{box-sizing:border-box;border:1px solid #777;padding:10px;margin:8px 0;} ' +
            '.tpl-shape-rect{display:inline-block;width:120px;height:48px;border:2px solid #16834a;background:#e9f5ee;} ' +
            '.tpl-shape-vline{display:inline-block;width:0;height:80px;border-left:2px solid #16834a;} ' +
            '</style></head><body>' + html + '</body></html>';
        const blob = htmlDocx.asBlob(full, {
            orientation: pageSettings.orientation,
            margins: { top: mm(m.top), right: mm(m.right), bottom: mm(m.bottom), left: mm(m.left) }
        });

        const filename = `${current.name.replace(/[^a-zA-Z0-9._-]+/g, '_')}_template.docx`;
        downloadBlob(blob, filename);
        showToast(failed
            ? `Exported. ${failed} image(s) could not be embedded (browser blocked access).`
            : 'Current template exported as .docx.', 4500);
    } catch (err) {
        console.error(err);
        showToast('Export failed: ' + (err.message || err), 5000);
    }
}
//a