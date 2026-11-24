// =============================================
// document.js
// Handles: admin_document.html
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    collection,
    addDoc,
    deleteDoc,
    updateDoc,
    query,
    where,
    onSnapshot,
    getDocs,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// =============================================
// Firebase Config & Init
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

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const el = (id) => document.getElementById(id);

// =============================================
// Helpers
// =============================================
function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function getInitials(name) {
    if (!name) return 'A';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
}

function showToast(msg, duration = 3000) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
}

function escHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// =============================================
// Sidebar Toggle (global — used by HTML onclick)
// =============================================
window.toggleSidebar = function () {
    el('sidebar')?.classList.toggle('collapsed');
    el('mainContent')?.classList.toggle('expanded');
};

// =============================================
// Auth Guard — admin only
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
let allDocs          = []; // cached list of { id, ...docData, requestCount }
let pendingDeleteId  = null;
let pendingDeleteName = '';
let editingId        = null; // null = adding, otherwise the doc being edited
let selectedIcon     = '';
let sessionIcons     = []; // custom icons uploaded in this modal session

const DEFAULT_ICON = 'Icons/barangayclearance.png';
const BUILTIN_ICONS = [
    { path: 'Icons/barangayclearance.png',               label: 'Barangay Clearance' },
    { path: 'Icons/certificateofresidency.png',          label: 'Certificate of Residency' },
    { path: 'Icons/certificateofindigency.png',          label: 'Certificate of Indigency' },
    { path: 'Icons/barangaybusinessclearance.png',       label: 'Business Clearance' },
    { path: 'Icons/firsttimejobseekercertificate.png',   label: 'Job Seeker Certificate' },
    { path: 'Icons/certificateofgoodmoralcharacter.png', label: 'Good Moral Character' },
    { path: 'Icons/soloparentcertificate.png',           label: 'Solo Parent Certificate' },
    { path: 'Icons/workingpermit.png',                   label: 'Working Permit' }
];

// =============================================
// Init Page
// =============================================
function initPage(user, adminData) {
    // Populate avatar initials
    const fullName = adminData.name || adminData.email || 'Admin';
    const avatarEl = document.querySelector('.admin-avatar .av-ph');
    if (avatarEl) avatarEl.textContent = getInitials(fullName);

    // Sidebar badges
    loadSidebarBadges();

    // Sign out
    el('sign-out-btn')?.addEventListener('click', async () => {
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
    });

    // Add document
    el('addDocBtn')?.addEventListener('click', openAddModal);
    el('close-add-modal')?.addEventListener('click', closeAddModal);
    el('cancel-add-modal')?.addEventListener('click', closeAddModal);
    el('add-doc-modal')?.addEventListener('click', (e) => {
        if (e.target === el('add-doc-modal')) closeAddModal();
    });
    el('save-doc-btn')?.addEventListener('click', saveDocument);
    el('icon-file')?.addEventListener('change', handleIconUpload);

    // Delete confirm
    el('cancel-delete')?.addEventListener('click', closeDeleteModal);
    el('confirm-delete')?.addEventListener('click', executeDelete);

    // Search & status filter
    el('search-input')?.addEventListener('input', applyFilter);
    el('status-filter')?.addEventListener('change', applyFilter);

    // Start real-time listener
    listenDocuments();
}

// =============================================
// Sidebar Badges (real-time)
// =============================================
function loadSidebarBadges() {
    onSnapshot(
        query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (snap) => {
            const badge = el('pending-requests-badge');
            if (badge) badge.textContent = snap.size;
        }
    );

    onSnapshot(
        collection(db, 'residents'),
        (snap) => {
            const pendingCount = snap.docs.filter(d => d.data().status === 'pending').length;
            const badge = el('pending-users-badge');
            if (badge) badge.textContent = pendingCount;
        }
    );
}

// =============================================
// Real-time listener for the documents collection
// =============================================
function listenDocuments() {
    onSnapshot(collection(db, 'documents'), async (snapshot) => {
        const reqCounts = await fetchRequestCounts();

        allDocs = snapshot.docs
            .map(d => ({
                id: d.id,
                ...d.data(),
                requestCount: reqCounts[d.data().name] || 0
            }))
            .sort((a, b) => {
                // Newest first
                const at = a.createdAt?.toMillis?.() || 0;
                const bt = b.createdAt?.toMillis?.() || 0;
                return bt - at;
            });

        applyFilter();
    });
}

// =============================================
// Count how many requests exist per document type
// =============================================
async function fetchRequestCounts() {
    const map = {};
    try {
        const snap = await getDocs(collection(db, 'requests'));
        snap.forEach(d => {
            const type = d.data().documentType;
            if (type) map[type] = (map[type] || 0) + 1;
        });
    } catch (_) {
        // Non-fatal: admin may not have read access yet
    }
    return map;
}

// =============================================
// Filter + Render
// =============================================
function applyFilter() {
    const search = el('search-input')?.value.trim().toLowerCase() || '';
    const status = el('status-filter')?.value || 'all';

    const filtered = allDocs.filter(d => {
        const matchSearch =
            !search ||
            d.name?.toLowerCase().includes(search) ||
            d.description?.toLowerCase().includes(search);
        const matchStatus = status === 'all' || d.status === status;
        return matchSearch && matchStatus;
    });

    renderTable(filtered);
}

// =============================================
// Render Table Rows
// =============================================
function renderTable(docs) {
    const body = el('docs-body');
    if (!body) return;

    if (docs.length === 0) {
        body.innerHTML = '<div class="empty-row">No documents found.</div>';
        return;
    }

    body.innerHTML = docs.map(buildRow).join('');

    // Wire buttons after DOM is updated
    docs.forEach(d => {
        el(`edit-${d.id}`)?.addEventListener('click', () => openEditModal(d.id));
        el(`toggle-${d.id}`)?.addEventListener('click', () => toggleStatus(d.id, d.status));
        el(`delete-${d.id}`)?.addEventListener('click', () => openDeleteModal(d.id, d.name));
    });
}

// =============================================
// Build a Single Table Row
// =============================================
function buildRow(d) {
    const isActive    = d.status !== 'inactive';
    const badgeClass  = isActive ? 'active'   : 'inactive';
    const badgeLabel  = isActive ? 'Active'   : 'Inactive';
    const toggleLabel = isActive ? 'Disable'  : 'Enable';
    const toggleClass = isActive ? 'btn-toggle' : 'btn-toggle enable';

    return `
        <div class="table-row">
            <div class="col-icon-sm">
                <div class="doc-icon-sm">
                    <img src="${escHtml(d.icon || DEFAULT_ICON)}" alt=""
                         onerror="this.style.display='none'">
                </div>
            </div>
            <div class="col-doc-name">
                <h4>${escHtml(d.name || '—')}</h4>
                <p>${escHtml(d.description || 'No description provided.')}</p>
            </div>
            <div class="col-added">
                <span>${formatDate(d.createdAt)}</span>
            </div>
            <div class="col-requests">
                <span>${d.requestCount}</span>
            </div>
            <div class="col-status">
                <span class="badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="col-action">
                <div class="action-row">
                    <button class="btn-edit" id="edit-${d.id}">Edit</button>
                    <button class="${toggleClass}" id="toggle-${d.id}">${toggleLabel}</button>
                    <button class="btn-delete" id="delete-${d.id}">Delete</button>
                </div>
            </div>
        </div>
    `;
}

// =============================================
// Toggle Active / Inactive
// =============================================
async function toggleStatus(docId, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    try {
        await updateDoc(doc(db, 'documents', docId), { status: newStatus });
        showToast(`Document ${newStatus === 'active' ? 'enabled ✓' : 'disabled'}.`);
    } catch (err) {
        showToast('Failed to update status: ' + err.message);
    }
}

// =============================================
// Icon Picker
// =============================================
function customIconsFromDocs() {
    // Custom (uploaded) icons already used by saved documents, de-duplicated
    const builtins = new Set(BUILTIN_ICONS.map(i => i.path));
    const seen = new Set();
    allDocs.forEach(d => {
        if (d.icon && !builtins.has(d.icon)) seen.add(d.icon);
    });
    return [...seen];
}

function renderIconPicker() {
    const grid = el('icon-grid');
    if (!grid) return;

    const tiles = BUILTIN_ICONS.map(i => ({ path: i.path, label: i.label }));
    const customs = [...new Set([...customIconsFromDocs(), ...sessionIcons])];
    customs.forEach(p => tiles.push({ path: p, label: 'Custom icon' }));

    // Keep an icon that is selected but not in the list (e.g. editing an old doc)
    if (selectedIcon && !tiles.some(t => t.path === selectedIcon)) {
        tiles.push({ path: selectedIcon, label: 'Current icon' });
    }

    grid.innerHTML = tiles.map(t => `
        <button type="button" class="icon-tile${t.path === selectedIcon ? ' selected' : ''}"
                data-icon="${escHtml(t.path)}" title="${escHtml(t.label)}">
            <img src="${escHtml(t.path)}" alt="">
        </button>
    `).join('') + `
        <button type="button" class="icon-tile add-tile" id="icon-add-btn" title="Upload custom icon">
            <span class="material-symbols-outlined">add</span>
        </button>
    `;

    grid.querySelectorAll('.icon-tile[data-icon]').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedIcon = btn.dataset.icon;
            renderIconPicker();
        });
    });
    el('icon-add-btn')?.addEventListener('click', () => el('icon-file')?.click());
}

// Resize to a small PNG data URL so it stays tiny inside Firestore
function fileToIconDataUrl(file, size = 96) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('That file is not a valid image.'));
            img.onload = () => {
                const scale = Math.min(size / img.width, size / img.height, 1);
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function handleIconUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please choose an image file.');
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showToast('Image is too large (max 2 MB).');
        return;
    }

    try {
        const dataUrl = await fileToIconDataUrl(file);
        sessionIcons.push(dataUrl);
        selectedIcon = dataUrl;
        renderIconPicker();
    } catch (err) {
        showToast(err.message);
    }
}

// =============================================
// Add / Edit Document Modal (one popup, two modes)
// =============================================
function openModal(doc = null) {
    editingId     = doc ? doc.id : null;
    sessionIcons  = [];
    selectedIcon  = doc?.icon || DEFAULT_ICON;

    el('modal-title').textContent        = doc ? 'Edit Document'  : 'Add New Document Type';
    el('modal-sub').textContent          = doc ? 'Update the details shown to residents' : 'This document will appear in the resident request form';
    el('modal-header-label').textContent = 'Document Details';

    el('input-name').value = doc?.name || '';
    el('input-desc').value = doc?.description || '';
    el('save-label').textContent = doc ? 'Save Changes' : 'Save Document';
    el('save-doc-btn').disabled  = false;

    renderIconPicker();
    el('add-doc-modal')?.classList.add('open');
    setTimeout(() => el('input-name')?.focus(), 80);
}

function openAddModal() {
    openModal(null);
}

function openEditModal(id) {
    const d = allDocs.find(x => x.id === id);
    if (d) openModal(d);
}

function closeAddModal() {
    el('add-doc-modal')?.classList.remove('open');
    editingId = null;
}

async function saveDocument() {
    const name = el('input-name')?.value.trim();
    if (!name) {
        showToast('Please enter a document name.');
        el('input-name')?.focus();
        return;
    }

    // Prevent duplicate names (case-insensitive), ignoring the doc being edited
    const isDuplicate = allDocs.some(
        d => d.id !== editingId && (d.name || '').toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
        showToast(`"${name}" already exists in the list.`);
        el('input-name')?.focus();
        return;
    }

    const desc = el('input-desc')?.value.trim() || '';
    const icon = selectedIcon || DEFAULT_ICON;
    const isEdit = !!editingId;
    const idleLabel = isEdit ? 'Save Changes' : 'Save Document';

    const btn   = el('save-doc-btn');
    const label = el('save-label');
    btn.disabled     = true;
    label.innerHTML  = '<div class="spinner"></div> Saving…';

    try {
        if (isEdit) {
            await updateDoc(doc(db, 'documents', editingId), {
                name,
                description: desc,
                icon
            });
            closeAddModal();
            showToast(`"${name}" updated ✓`);
        } else {
            await addDoc(collection(db, 'documents'), {
                name,
                description: desc,
                icon,
                status:    'active',
                createdAt: serverTimestamp()
            });
            closeAddModal();
            showToast(`"${name}" added successfully ✓`);
        }
    } catch (err) {
        showToast('Failed to save document: ' + err.message);
        btn.disabled      = false;
        label.textContent = idleLabel;
    }
}

// =============================================
// Delete Modal
// =============================================
function openDeleteModal(id, name) {
    pendingDeleteId   = id;
    pendingDeleteName = name;
    const nameEl = el('delete-doc-name');
    if (nameEl) nameEl.textContent = name;
    el('delete-label').textContent    = 'Delete';
    el('confirm-delete').disabled     = false;
    el('delete-confirm')?.classList.add('open');
}

function closeDeleteModal() {
    pendingDeleteId   = null;
    pendingDeleteName = '';
    el('delete-confirm')?.classList.remove('open');
}

async function executeDelete() {
    if (!pendingDeleteId) return;

    const btn   = el('confirm-delete');
    const label = el('delete-label');
    btn.disabled    = true;
    label.innerHTML = '<div class="spinner" style="border-color:rgba(255,255,255,.3);border-top-color:#fff;width:12px;height:12px;"></div> Deleting…';

    try {
        await deleteDoc(doc(db, 'documents', pendingDeleteId));
        closeDeleteModal();
        showToast(`"${pendingDeleteName}" deleted.`);
    } catch (err) {
        showToast('Delete failed: ' + err.message);
        btn.disabled      = false;
        label.textContent = 'Delete';
    }
}