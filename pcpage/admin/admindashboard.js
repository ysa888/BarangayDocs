// =============================================
// dashboard.js
// Handles: admin_dashboard.html
// Loads live stats + recent requests from Firestore
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { mountRejectReasonPicker } from "./rejectreasons.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    onSnapshot,
    getDocs,
    doc,
    updateDoc,
    getDoc,
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

// =============================================
// Auth Guard — admins only
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    try {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
            alert('Access denied. Admins only.');
            await signOut(auth);
            window.location.href = '../barangaydocs_login.html';
            return;
        }

        // Show admin initials/name in navbar avatar if present
        const adminData = adminDoc.data();
        const initials  = ((adminData.firstName?.[0] || '') + (adminData.lastName?.[0] || '')).toUpperCase() || 'A';
        const avPh      = document.querySelector('.av-ph');
        if (avPh) avPh.textContent = initials;

        // Start loading everything
        initDashboard();

    } catch (err) {
        console.error('Auth guard error:', err);
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
    }
});

// =============================================
// Sidebar Toggle
// =============================================
let sidebarOpen = true;
window.toggleSidebar = function () {
    const sidebar = document.getElementById('sidebar');
    const main = document.getElementById('mainContent');
    const backdrop = document.getElementById('sidebarBackdrop');
    const button = document.querySelector('.hamburger-btn');

    if (window.matchMedia('(max-width: 640px)').matches) {
        sidebarOpen = sidebar.classList.toggle('open');
        backdrop?.classList.toggle('show', sidebarOpen);
        button?.setAttribute('aria-expanded', String(sidebarOpen));
        return;
    }

    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('collapsed', !sidebarOpen);
    main.classList.toggle('expanded', !sidebarOpen);
    button?.setAttribute('aria-expanded', String(sidebarOpen));
};

document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarBackdrop')?.classList.remove('show');
    document.querySelector('.hamburger-btn')?.setAttribute('aria-expanded', 'false');
    sidebarOpen = false;
});

document.querySelectorAll('#sidebar .sidebar-item[onclick]').forEach((item) => {
    item.addEventListener('click', () => {
        if (!window.matchMedia('(max-width: 640px)').matches) return;
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarBackdrop')?.classList.remove('show');
        document.querySelector('.hamburger-btn')?.setAttribute('aria-expanded', 'false');
        sidebarOpen = false;
    });
});

window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 640px)').matches) {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarBackdrop')?.classList.remove('show');
        sidebarOpen = !document.getElementById('sidebar')?.classList.contains('collapsed');
        document.querySelector('.hamburger-btn')?.setAttribute('aria-expanded', String(sidebarOpen));
    } else {
        sidebarOpen = document.getElementById('sidebar')?.classList.contains('open') || false;
        document.querySelector('.hamburger-btn')?.setAttribute('aria-expanded', String(sidebarOpen));
    }
});

// =============================================
// Sign Out
// =============================================
document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

// =============================================
// Toast
// =============================================
function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
}

// =============================================
// Helpers
// =============================================
function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getBadgeClass(status) {
    const map = {
        pending:    'pending',
        processing: 'processing',
        approved:   'processing',
        ready:      'ready',
        released:   'ready',
        rejected:   'rejected'
    };
    return map[status] || 'pending';
}

function getBadgeLabel(status) {
    const map = {
        pending:    'Pending',
        processing: 'Processing',
        approved:   'Approved',
        ready:      'Ready',
        released:   'Released',
        rejected:   'Rejected'
    };
    return map[status] || status;
}

function docIcon(name) {
    const map = {
        'Barangay Clearance':   'Icons/barangayclearance.png',
        'Cert. of Residency':   'Icons/certificateofresidency.png',
        'Cert. of Indigency':   'Icons/certificateofindigency.png',
        'Business Clearance':   'Icons/barangaybusinessclearance.png',
        'Job Seeker Cert.':     'Icons/firsttimejobseekercertificate.png',
        'Good Moral Char.':     'Icons/certificateofgoodmoralcharacter.png',
        'Solo Parent Cert.':    'Icons/soloparentcertificate.png',
        'Working Permit':       'Icons/workingpermit.png'
    };
    return '' + (map[name] || 'Icons/barangayclearance.png');
}

// =============================================
// Stat Cards — live real-time listeners
// =============================================
function initStats() {
    // --- Pending Requests (pending + processing + approved) ---
    onSnapshot(
        query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (snap) => {
            const el = document.getElementById('dash-pending');
            if (el) el.textContent = snap.size;

            // Update sidebar badge for Pending Requests
            const badge = document.getElementById('pending-requests-badge');
            if (badge) badge.textContent = snap.size;
        }
    );

    // --- Ready for Pickup ---
    onSnapshot(
        query(collection(db, 'requests'), where('status', '==', 'ready')),
        (snap) => {
            const el = document.getElementById('dash-ready');
            if (el) el.textContent = snap.size;
        }
    );

    // --- Rejected this month ---
    onSnapshot(
        query(collection(db, 'requests'), where('status', '==', 'rejected')),
        (snap) => {
            // Filter client-side to current month
            const now   = new Date();
            const count = snap.docs.filter(d => {
                const val = d.data().updatedAt;
                if (!val) return false;
                const date = val?.toDate ? val.toDate() : new Date(val);
                return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
            }).length;

            const el = document.getElementById('dash-rejected');
            if (el) el.textContent = count;
        }
    );

    // --- Registered Users + pending sub-label ---
    onSnapshot(
        collection(db, 'residents'),
        (snap) => {
            const el = document.getElementById('dash-users');
            if (el) el.textContent = snap.size;

            const pendingCount = snap.docs.filter(d => d.data().status === 'pending').length;
            const sub = document.getElementById('dash-users-sub');
            if (sub) sub.textContent = pendingCount > 0 ? `${pendingCount} awaiting approval` : 'All users verified';

            // Update sidebar badge for Pending Users
            const badge = document.getElementById('pending-users-badge');
            if (badge) badge.textContent = pendingCount;
        }
    );
}

// =============================================
// Recent Requests Table — live, latest 10
// =============================================
function initRecentRequests() {
    const tbody = document.getElementById('recent-requests-body');
    if (!tbody) return;

    tbody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-sub);font-size:13px;">Loading...</div>';

    let knownIds = null;   // null until the first snapshot has loaded

    onSnapshot(query(collection(db, 'requests')), (snapshot) => {
        tbody.innerHTML = '';

        if (snapshot.empty) {
            tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No requests yet.</div>';
            return;
        }

        // Sort newest first, take top 10
        const sorted = snapshot.docs.slice().sort((a, b) => {
            const aTime = a.data().createdAt?.toMillis?.() || 0;
            const bTime = b.data().createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        }).slice(0, 10);

        sorted.forEach(docSnap => {
            const row = buildRow(docSnap.id, docSnap.data());
            if (knownIds && !knownIds.has(docSnap.id)) row.classList.add('row-new');   // just arrived
            tbody.appendChild(row);
        });
        knownIds = new Set(snapshot.docs.map(d => d.id));
    });
}

// =============================================
// Build a recent-request table row
// =============================================
function buildRow(docId, data) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.id     = docId;
    row.dataset.status = data.status;

    row.innerHTML = `
        <div class="col-icon">
            <div class="doc-icon-sm">
                <img src="${docIcon(data.documentType)}" alt="" onerror="this.style.display='none'">
            </div>
        </div>
        <div class="col-name">
            <h4>${data.documentType || '—'}</h4>
            <p>${data.referenceNo || '—'}</p>
        </div>
        <div class="col-user"><span>${data.residentName || '—'}</span></div>
        <div class="col-date"><span>${formatDate(data.createdAt)}</span></div>
        <div class="col-status">
            <span class="badge ${getBadgeClass(data.status)}">${getBadgeLabel(data.status)}</span>
        </div>
        <div class="col-action">
            <div class="action-row">${getActionButtons(docId, data.status)}</div>
        </div>
    `;

    wireRowButtons(row, docId, data);
    return row;
}

// =============================================
// Action buttons (matches adminrequests.js flow)
// =============================================
function getActionButtons(docId, status) {
    if (status === 'pending') {
        return `
            <button class="btn-process" data-id="${docId}" data-action="processing">Process</button>
            <button class="btn-reject"  data-id="${docId}" data-action="reject">Reject</button>`;
    }
    if (status === 'processing') {
        return `
            <button class="btn-approve" data-id="${docId}" data-action="approved">Approve</button>
            <button class="btn-reject"  data-id="${docId}" data-action="reject">Reject</button>`;
    }
    if (status === 'approved') {
        return `<button class="btn-approve" data-id="${docId}" data-action="ready">Mark Ready</button>`;
    }
    if (status === 'ready') {
        return `<button class="btn-approve" data-id="${docId}" data-action="released">Mark Released</button>`;
    }
    if (status === 'released') {
        return `<span style="font-size:11px;color:var(--green-text);">Released</span>`;
    }
    if (status === 'rejected') {
        return `<span style="font-size:11px;color:var(--red-text);">Rejected</span>`;
    }
    return '';
}

// =============================================
// Wire row action buttons
// =============================================
function wireRowButtons(row, docId, data) {
    row.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'reject') {
                openRejectModal(docId, row);
            } else {
                updateRequestStatus(docId, action, row, data);
            }
        });
    });
}

// =============================================
// Update request status in Firestore
// =============================================
async function updateRequestStatus(docId, newStatus, row, data) {
    try {
        const updateData = {
            status: newStatus,
            updatedAt: serverTimestamp()
        };
        if (newStatus === 'released') updateData.releasedAt = serverTimestamp();

        await updateDoc(doc(db, 'requests', docId), updateData);

        // Update badge
        const badge = row.querySelector('.badge');
        if (badge) {
            badge.className = `badge ${getBadgeClass(newStatus)}`;
            badge.textContent = getBadgeLabel(newStatus);
        }

        // Update action buttons
        const actionCol = row.querySelector('.col-action');
        if (actionCol) {
            actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, newStatus)}</div>`;
            wireRowButtons(row, docId, { ...data, status: newStatus });
        }

        row.dataset.status = newStatus;

        const messages = {
            processing: '✓ Request is now processing',
            approved:   '✓ Request approved',
            ready:      '✓ Document marked ready for pickup',
            released:   '✓ Document released to resident'
        };
        showToast(messages[newStatus] || 'Status updated');

    } catch (err) {
        console.error('Update error:', err);
        showToast('Failed to update. Check Firestore rules.');
    }
}

// =============================================
// Reject Modal
// =============================================
function openRejectModal(docId, row) {
    const overlay = document.getElementById('rejectModalOverlay');
    if (!overlay) {
        // Fallback: inline reject if modal not in HTML
        if (!confirm('Are you sure you want to reject this request?')) return;
        updateRequestStatus(docId, 'rejected', row, {});
        return;
    }

    const picker = mountRejectReasonPicker(document.getElementById('rejectReason'));
    picker?.reset();
    overlay.classList.add('show');

    document.getElementById('confirmRejectBtn').onclick = async () => {
        let reason = '', code = '';
        if (picker) {
            const res = picker.getResult();
            if (!res.ok) { showToast(res.error); return; }   // keep modal open
            reason = res.reason; code = res.code;
        }
        overlay.classList.remove('show');
        try {
            await updateDoc(doc(db, 'requests', docId), {
                status:           'rejected',
                rejectReason:     reason,   // was "rejectNote" — residents read rejectReason
                rejectReasonCode: code,
                updatedAt:        serverTimestamp()
            });
            picker?.reset();
            const badge = row.querySelector('.badge');
            if (badge) { badge.className = 'badge rejected'; badge.textContent = 'Rejected'; }
            const actionCol = row.querySelector('.col-action');
            if (actionCol) actionCol.innerHTML = `<div class="action-row"><span style="font-size:11px;color:var(--red-text);">Rejected</span></div>`;
            row.dataset.status = 'rejected';
            showToast('Request rejected');
        } catch (err) {
            console.error('Reject error:', err);
            showToast('Failed to reject. Check Firestore rules.');
        }
    };

    document.getElementById('cancelRejectBtn').onclick = () => { overlay.classList.remove('show'); picker?.reset(); };
}

// =============================================
// View Request Detail Modal (existing HTML modal)
// =============================================
window.viewDetail = function (ref, docType, user, status, purpose) {
    document.getElementById('modalTitle').textContent = 'Request Details';
    document.getElementById('modalBody').innerHTML = `
        <div class="modal-field"><label>Reference No.</label><p>${ref}</p></div>
        <div class="modal-field"><label>Document Type</label><p>${docType}</p></div>
        <div class="modal-field"><label>Resident</label><p>${user}</p></div>
        <div class="modal-field"><label>Purpose</label><p>${purpose || '—'}</p></div>
        <div class="modal-field"><label>Status</label>
            <select id="modal-status-select">
                <option ${status === 'Pending'    ? 'selected' : ''}>Pending</option>
                <option ${status === 'Processing' ? 'selected' : ''}>Processing</option>
                <option ${status === 'Ready'      ? 'selected' : ''}>Ready</option>
                <option ${status === 'Rejected'   ? 'selected' : ''}>Rejected</option>
            </select>
        </div>
        <div class="modal-field"><label>Admin Notes</label><textarea placeholder="Add notes here..."></textarea></div>
        <div class="modal-btn-row">
            <button class="modal-btn-cancel" id="modalCancelBtn">Close</button>
            <button class="modal-btn-save"   id="modalSaveBtn">Save Changes</button>
        </div>`;

    document.getElementById('modalOverlay').classList.add('show');
    document.getElementById('modalCancelBtn').onclick = closeModal;
    document.getElementById('modalSaveBtn').onclick   = () => { closeModal(); showToast('Changes saved'); };
};

window.closeModal = function () {
    document.getElementById('modalOverlay')?.classList.remove('show');
};

window.closeModalOutside = function (e) {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
};

// =============================================
// New-request pop-ups — a card slides in whenever a resident
// submits a document request while this page is open
// =============================================
function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.06;
        o.connect(g); g.connect(ctx.destination); o.start();
        o.stop(ctx.currentTime + 0.18);
    } catch (e) { /* browsers may block sound until the page is clicked */ }
}

function showNewRequestPopup(r) {
    const stack = document.getElementById('newReqStack');
    if (!stack) return;

    const card = document.createElement('div');
    card.className = 'nr-card';
    card.innerHTML = `
        <div class="nr-top">
            <span class="nr-tag">New Request</span>
            <button class="nr-close" aria-label="Dismiss">\u2715</button>
        </div>
        <div class="nr-doc">${escapeHtml(r.documentType || 'Document Request')}</div>
        <div class="nr-meta">${escapeHtml(r.residentName || 'A resident')}${r.referenceNo ? ' \u2022 ' + escapeHtml(r.referenceNo) : ''}</div>
        ${r.purpose ? `<div class="nr-meta">Purpose: ${escapeHtml(r.purpose)}</div>` : ''}
        <div class="nr-actions"><button class="nr-view">View request</button></div>`;

    const close = () => { card.classList.add('out'); setTimeout(() => card.remove(), 260); };
    card.querySelector('.nr-close').onclick = close;
    card.querySelector('.nr-view').onclick  = () => { window.location.href = 'admin_pending_requests.html'; };

    stack.prepend(card);
    while (stack.children.length > 4) stack.lastElementChild.remove();
    setTimeout(close, 10000);
    playBeep();
}

function initNewRequestPopups() {
    let first = true;
    onSnapshot(
        query(collection(db, 'requests'), where('status', '==', 'pending')),
        (snap) => {
            if (first) { first = false; return; }   // ignore requests that already existed on load
            snap.docChanges().forEach(ch => {
                if (ch.type === 'added') showNewRequestPopup(ch.doc.data());
            });
        },
        (err) => console.error('New-request listener failed:', err)
    );
}

// =============================================
// Init Dashboard
// =============================================
function initDashboard() {
    initStats();
    initRecentRequests();
    initNewRequestPopups();
}