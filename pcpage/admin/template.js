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
// Storage
//   templates/{docId}/…          (NEW)       → logos / seals / signatures uploaded in the editor
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, deleteDoc, collection,
    query, where, limit, onSnapshot, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {
    getStorage, ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

import {
    PAGE_SIZES, DEFAULT_PAGE_SETTINGS, FIELD_GROUPS,
    normalizePageSettings, paperStyleObject, paperStyleString, baseCss,
    discoverResidentFields, sampleValues, renderTemplateHtml, sanitizeHtml,
    defaultTemplateHtml, makeQrDataUrl, printTemplateHtml
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
const storage = getStorage(app);

const el = (id) => document.getElementById(id);

// Folder that holds Icons/, request.js etc. This page lives in …/admin/, so go up one level.
const APP_ROOT = /\/admin\/[^/]*$/.test(location.pathname)
    ? new URL('../', location.href).href
    : new URL('./', location.href).href;
const resolveAsset = (p) => { try { return new URL(p, APP_ROOT).href; } catch (_) { return p; } };

// Firestore documents are capped at 1 MiB — keep a safety margin
const MAX_TEMPLATE_BYTES = 900 * 1024;
// If Storage is unavailable, small images may be embedded instead
const MAX_INLINE_IMAGE_BYTES = 150 * 1024;

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
let warnedInlineImages = false;

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
            ['pane-fields', 'pane-page'].forEach(id => el(id)?.classList.toggle('hidden', id !== tab.dataset.pane));
        });
    });
    el('field-search')?.addEventListener('input', renderFieldPanel);
    renderFieldPanel();
    initPageSettingsUI();

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
        'html{background:#dfe5f0;padding:0 0 24px}',
        'body{box-shadow:0 6px 24px rgba(27,58,107,.18)}',
        // placeholder chips: visible only while editing
        '.ph{background:#fff3cd;border:1px dashed #d4a017;border-radius:3px;padding:0 3px;color:#7a5b00}'
    ].join('\n');

    return tinymce.init({
        target: el('tpl-editor'),
        height: Math.max(560, window.innerHeight - 190),
        menubar: 'edit insert format table',
        plugins: 'advlist lists table image link charmap searchreplace pagebreak code',
        toolbar:
            'undo redo | blocks fontfamily fontsize | bold italic underline strikethrough | forecolor backcolor | ' +
            'alignleft aligncenter alignright alignjustify | lineheight | bullist numlist outdent indent | ' +
            'table image hr pagebreak | casebtn placeholders | removeformat',
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
        object_resizing: true,
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
// Image upload → Firebase Storage (fallback: small inline image)
// ---------------------------------------------
async function uploadImageBlob(blob, filename = 'image.png') {
    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `templates/${current?.id || 'misc'}/${Date.now()}_${safe}`;
    try {
        const r = sRef(storage, path);
        await uploadBytes(r, blob, { contentType: blob.type || 'image/png' });
        return await getDownloadURL(r);
    } catch (err) {
        console.warn('Storage upload failed:', err);
        if (blob.size <= MAX_INLINE_IMAGE_BYTES) {
            if (!warnedInlineImages) {
                warnedInlineImages = true;
                showToast('Storage upload failed — small image embedded instead. Check Storage rules.', 5000);
            }
            return await blobToDataUrl(blob);
        }
        throw new Error('Image upload failed. Make sure Firebase Storage is enabled and admins are allowed to write to templates/. (' + (err.message || err) + ')');
    }
}

/** Upload any leftover data: images (e.g. from .docx import) so the template stays small. */
async function externalizeDataImages(html) {
    const doc2 = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const imgs = [...doc2.body.querySelectorAll('img[src^="data:image/"]')];
    let failed = 0;
    for (let i = 0; i < imgs.length; i++) {
        try {
            const blob = await (await fetch(imgs[i].getAttribute('src'))).blob();
            const ext = (blob.type.split('/')[1] || 'png').replace('+xml', '');
            imgs[i].setAttribute('src', await uploadImageBlob(blob, `image_${i + 1}.${ext}`));
        } catch (err) {
            failed++;
            console.warn('Could not upload embedded image:', err);
        }
    }
    if (failed) showToast(`${failed} embedded image(s) could not be uploaded and were kept inline.`, 5000);
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
        await editor.uploadImages();                    // push pasted / picked images to Storage
        let html = editor.getContent();
        html = await externalizeDataImages(html);       // e.g. images that came from a .docx
        html = sanitizeHtml(html);

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

        await setDoc(refDoc, {
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
    paper.setAttribute('style', paperStyleString(pageSettings));
    paper.innerHTML = lastPreviewHtml;
    el('pv-print').onclick = () => printTemplateHtml(lastPreviewHtml, pageSettings, 'Template test print');
    el('preview-modal').classList.add('open');
}

// ---------------------------------------------
// .docx import / export
// ---------------------------------------------
async function onDocxChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !editor) return;
    if (typeof mammoth === 'undefined') {
        showToast('The .docx import library could not be loaded.', 5000);
        return;
    }
    if (!(await confirmDialog({
        title: 'Import this Word file?',
        text: 'The editor content will be replaced with the contents of the .docx. Fonts, alignment and some layout may need re-applying. Nothing is saved until you click Save Template.',
        yesLabel: 'Import', danger: true
    }))) return;

    try {
        const buf = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer: buf }, {
            convertImage: mammoth.images.imgElement((image) =>
                image.read('base64').then((b64) => ({ src: `data:${image.contentType};base64,${b64}` })))
        });
        setEditorContent(result.value);
        applyPageToEditor();
        setDirty(true);
        const n = (result.messages || []).length;
        showToast(n
            ? `Imported with ${n} formatting note(s) — please review the layout.`
            : 'Word file imported. Review the layout, then save.', 4500);
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

async function exportDocx() {
    if (!editor || !current) return;
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