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
                    <img src="${escHtml(d.icon || 'Icons/barangayclearance.png')}" alt=""
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
// Add Document Modal
// =============================================
function openAddModal() {
    el('input-name').value = '';
    el('input-desc').value = '';
    el('input-icon').selectedIndex = 0;
    el('save-label').textContent   = 'Save Document';
    el('save-doc-btn').disabled    = false;
    el('add-doc-modal')?.classList.add('open');
    setTimeout(() => el('input-name')?.focus(), 80);
}

function closeAddModal() {
    el('add-doc-modal')?.classList.remove('open');
}

async function saveDocument() {
    const name = el('input-name')?.value.trim();
    if (!name) {
        showToast('Please enter a document name.');
        el('input-name')?.focus();
        return;
    }

    // Prevent duplicate names (case-insensitive)
    const isDuplicate = allDocs.some(
        d => d.name.toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
        showToast(`"${name}" already exists in the list.`);
        el('input-name')?.focus();
        return;
    }

    const desc = el('input-desc')?.value.trim() || '';
    const icon = el('input-icon')?.value        || 'Icons/barangayclearance.png';

    const btn   = el('save-doc-btn');
    const label = el('save-label');
    btn.disabled     = true;
    label.innerHTML  = '<div class="spinner"></div> Saving…';

    try {
        await addDoc(collection(db, 'documents'), {
            name,
            description: desc,
            icon,
            status:    'active',
            createdAt: serverTimestamp()
        });

        closeAddModal();
        showToast(`"${name}" added successfully ✓`);
    } catch (err) {
        showToast('Failed to add document: ' + err.message);
        btn.disabled    = false;
        label.textContent = 'Save Document';
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