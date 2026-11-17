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
// Image hosting: Cloudinary (free plan, no credit card) — replaces Firebase Storage.
// One-time setup (2 minutes):
//   1. Sign up at https://cloudinary.com (free, no card) and copy your "Cloud name" from the dashboard.
//   2. Settings ▸ Upload ▸ Upload presets ▸ Add upload preset ▸ Signing mode: **Unsigned** ▸ Save.
//      Copy the preset's name.
//   3. Paste both values below.
// =============================================
const CLOUDINARY = {
    cloudName:    'YOUR_CLOUD_NAME',
    uploadPreset: 'YOUR_UNSIGNED_UPLOAD_PRESET'
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
function initPage(user, adminData) {
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
        snap.docs.forEach(d => { templates[d.id] = d.data(); });
        renderCards();
        updateBadge();
    }, (err) => {
        // Most likely Firestore rules not yet updated — editor still works for viewing defaults
        console.warn('documentTemplates listener failed:', err);
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

function setEditorContent(html) {
    if (!editor) return;
    loadingContent = true;
    editor.setContent(html);
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
            'table image imglayout hr | newpage blankpage | casebtn placeholders | removeformat',
        toolbar_mode: 'wrap',
        branding: false,
        promotion: false,
        resize: false,
        statusbar: true,
        elementpath: false,
        content_css: false,          // we supply the CSS so editor = printed result
        document_base_url: APP_ROOT, // so "Icons/…" images show inside the editor
        content_style: editorCss,
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
        extended_valid_elements: 'span[class|style|data-field]',
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
                if (e.element && e.element.nodeName === 'IMG') selImg = e.element;
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
}

// One white sheet per page with its own border and shadow; the grey gap between sheets is the page break.
// The sheets live in a wrapper that is a sibling of <body> (child of <html>), NOT inside the body:
// non-editable blocks inside the body make TinyMCE draw its black "fake caret" line next to them,
// which showed up as a big black line that appeared and disappeared while typing / moving the cursor.
function drawSheets(body, doc2, pages, P, pageH, bw) {
    body.querySelectorAll('.tpl-sheet, #tpl-sheets').forEach(n => n.remove());   // clean up older versions
    const html = doc2.documentElement;
    let wrap = doc2.getElementById('tpl-sheets');
    if (!wrap) {
        wrap = doc2.createElement('div');
        wrap.id = 'tpl-sheets';
        wrap.setAttribute('data-mce-bogus', 'all');
        wrap.setAttribute('aria-hidden', 'true');
        wrap.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;user-select:none';
        html.insertBefore(wrap, body);          // before <body> so it paints underneath the text
    }
    const b = pageSettings.border;
    const border = (b.style !== 'none' && b.width > 0) ? `${b.width}px ${b.style} ${b.color}` : 'none';
    const win = doc2.defaultView;
    const br = body.getBoundingClientRect();
    const x0 = br.left + (win.scrollX || 0);     // body border-box, in document coordinates
    const y0 = br.top + (win.scrollY || 0);
    const w = body.clientWidth;
    let out = '';
    for (let i = 0; i < pages; i++) {
        out += `<div class="tpl-sheet" style="position:absolute;pointer-events:none;box-sizing:border-box;background:#fff;` +
            `box-shadow:0 1px 8px rgba(0,0,0,.28);left:${x0.toFixed(1)}px;top:${(y0 + i * P).toFixed(1)}px;` +
            `width:${w + 2 * bw}px;height:${(pageH + 2 * bw).toFixed(1)}px;border:${border}"></div>`;
    }
    wrap.innerHTML = out;
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
function docxHtmlForEditor(html) {
    const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
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

function docxMammothOptions() {
    return {
        styleMap: docxStyleMap(),
        transformDocument: docxTransformDocument(),
        ignoreEmptyParagraphs: false,
        convertImage: mammoth.images.imgElement((image) =>
            image.read('base64').then((b64) => ({ src: `data:${image.contentType};base64,${b64}` })))
    };
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
    const sect = sects[sects.length - 1];

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

            const res = await mammoth.convertToHtml(
                { arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }) },
                docxMammothOptions());
            const html = docxHtmlForEditor(res.value);
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
    const sect = sects[sects.length - 1];
    const attr = (node, name) => { const v = node && parseFloat(node.getAttributeNS(W, name)); return Number.isFinite(v) ? v : null; };
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
    if (typeof mammoth === 'undefined') {
        showToast('The .docx import library could not be loaded.', 5000);
        return;
    }
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
        const result = await mammoth.convertToHtml({ arrayBuffer: buf }, docxMammothOptions());
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
            docxHtmlForEditor(result.value) +
            (hf.footer ? `<div class="tpl-hf" data-hf="footer">${hf.footer}</div>` : ''));
        applyPageToEditor();
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

    // Original saved earlier → reload it from the image host so its headers / footers survive a page reload.
    if (!originalDocxBuffer && storedOriginal?.url) {
        try {
            const r = await fetch(storedOriginal.url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            originalDocxBuffer = await r.arrayBuffer();
            originalDocxFile = { name: storedOriginal.name };
        } catch (err) {
            console.warn('Could not load stored original .docx:', err);
        }
    }

    // An original .docx is available (imported now, or restored from the image host) → export that file as-is.
    if (originalDocxBuffer) {
        try {
            await exportOriginalDocx();
        } catch (err) {
            console.error(err);
            showToast('Export failed: ' + (err.message || err), 5000);
        }
        return;
    }

    // No imported original → keep the previous behaviour (editor content → .docx via html-docx-js)
    if (typeof htmlDocx === 'undefined') {
        showToast('The .docx export library could not be loaded.', 5000);
        return;
    }
    try {
        await editor.uploadImages().catch(() => {});
        const { html, failed } = await remoteImagesToDataUrls(editor.getContent());

        const mm = (v) => Math.round(v * 56.7); // mm → twips
        const m = pageSettings.margins;
        const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss('body')}</style></head><body>${html}</body></html>`;
        const blob = htmlDocx.asBlob(full, {
            orientation: pageSettings.orientation,
            margins: { top: mm(m.top), right: mm(m.right), bottom: mm(m.bottom), left: mm(m.left) }
        });

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${current.name.replace(/[^a-zA-Z0-9._-]+/g, '_')}_template.docx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);

        showToast(failed
            ? `Exported. ${failed} image(s) could not be embedded (browser blocked access).`
            : 'Template exported as .docx', 4500);
    } catch (err) {
        console.error(err);
        showToast('Export failed: ' + (err.message || err), 5000);
    }
}
//a