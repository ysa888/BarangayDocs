// =============================================
// Firebase Imports
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    doc,
    updateDoc,
    getDoc,
    onSnapshot,
    query,
    where
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
// Auth Guard — admins only
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    const adminDoc = await getDoc(doc(db, 'admins', user.uid));
    if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    loadPendingUsers();
    loadSidebarBadges();
});

// =============================================
// Sidebar Toggle
// =============================================
let sidebarOpen = true;
window.toggleSidebar = function () {
    sidebarOpen = !sidebarOpen;
    el('sidebar').classList.toggle('collapsed', !sidebarOpen);
    el('mainContent').classList.toggle('expanded', !sidebarOpen);
};

// =============================================
// Sign Out
// =============================================
el('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

// =============================================
// Toast
// =============================================
function showToast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
}

// =============================================
// Helpers
// =============================================
function getInitials(firstName, lastName) {
    return ((firstName?.[0] || '') + (lastName?.[0] || '')).toUpperCase();
}

function formatDate(isoString) {
    if (!isoString) return '—';
    return new Date(isoString).toLocaleDateString('en-PH', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
}

// =============================================
// View User — INFO Modal
// =============================================
function viewUser(uid, data) {
    el('modal-initials').textContent = getInitials(data.firstName, data.lastName);
    el('modal-name').textContent     = `${data.firstName} ${data.middleName ? data.middleName + ' ' : ''}${data.lastName}`;
    el('modal-email').textContent    = data.email || '—';
    el('modal-contact').textContent  = data.contactNumber || '—';
    el('modal-birthday').textContent = data.birthday || '—';
    el('modal-sex').textContent      = data.sex || '—';
    el('modal-civil').textContent    = data.civilStatus || '—';
    el('modal-address').textContent  = [data.houseNumber, data.barangay, data.city, data.province].filter(Boolean).join(', ') || '—';
    el('modal-years').textContent    = data.yearsResidency ? `${data.yearsResidency} year(s)` : '—';
    el('modal-joined').textContent   = formatDate(data.createdAt);

    // Status badge
    const statusBadge = el('modal-status');
    const statusMap   = { approved: ['active','Active'], rejected: ['inactive','Rejected'], pending: ['waiting','Waiting'] };
    const [cls, lbl]  = statusMap[data.status] || ['waiting','Waiting'];
    statusBadge.className   = `badge ${cls}`;
    statusBadge.textContent = lbl;

    // Valid ID image
    const wrap    = el('modal-valid-id-wrap');
    const openBtn = el('modal-open-id-btn');
    if (data.validIdUrl) {
        wrap.innerHTML = `<img src="${data.validIdUrl}" alt="Valid ID" onerror="this.parentElement.innerHTML='<div class=\\'valid-id-no-img\\'>Image failed to load</div>'" />`;
        openBtn.href   = data.validIdUrl;
        openBtn.style.display = 'inline-block';
    } else {
        wrap.innerHTML        = '<div class="valid-id-no-img">No ID uploaded</div>';
        openBtn.style.display = 'none';
    }

    el('user-modal').classList.add('open');
}

el('close-modal')?.addEventListener('click', () => el('user-modal').classList.remove('open'));
el('user-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) el('user-modal').classList.remove('open');
});

// =============================================
// Approve User
// =============================================
async function approveUser(uid, row) {
    try {
        await updateDoc(doc(db, 'residents', uid), {
            status:     'approved',
            role:       'resident',
            approvedAt: new Date().toISOString()
        });

        row._userData = { ...row._userData, status: 'approved' };
        row.querySelector('.badge').className   = 'badge active';
        row.querySelector('.badge').textContent = 'Active';
        row.querySelector('.col-action').innerHTML =
            '<div class="action-row"><button class="btn-info">Info</button></div>';
        row.querySelector('.btn-info').addEventListener('click', () => viewUser(uid, row._userData));

        showToast('✓ User approved successfully');
    } catch (err) {
        console.error('Approve error:', err);
        showToast('Failed to approve user.');
    }
}

// =============================================
// Reject User
// =============================================
async function rejectUser(uid, row) {
    try {
        await updateDoc(doc(db, 'residents', uid), {
            status:     'rejected',
            rejectedAt: new Date().toISOString()
        });

        row._userData = { ...row._userData, status: 'rejected' };
        row.querySelector('.badge').className   = 'badge inactive';
        row.querySelector('.badge').textContent = 'Rejected';
        row.querySelector('.col-action').innerHTML =
            '<div class="action-row"><button class="btn-info">Info</button></div>';
        row.querySelector('.btn-info').addEventListener('click', () => viewUser(uid, row._userData));

        showToast('User rejected');
    } catch (err) {
        console.error('Reject error:', err);
        showToast('Failed to reject user.');
    }
}

// =============================================
// Build Row
// =============================================
function buildRow(uid, data) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.id = 'row-' + uid;

    row.innerHTML = `
        <div style="width:38px;flex-shrink:0;">
            <div class="user-avatar-sm">${getInitials(data.firstName, data.lastName)}</div>
        </div>
        <div class="col-uname">
            <div>
                <h4>${data.firstName} ${data.lastName}</h4>
                <p>${data.email}</p>
            </div>
        </div>
        <div class="col-contact"><span>${data.contactNumber || '—'}</span></div>
        <div class="col-date"><span>${formatDate(data.createdAt)}</span></div>
        <div class="col-brgy"><span>${data.houseNumber || '—'}</span></div>
        <div class="col-status"><span class="badge waiting">Waiting</span></div>
        <div class="col-action">
            <div class="action-row">
                <button class="btn-info">Info</button>
                <button class="btn-approve">Approve</button>
                <button class="btn-reject">Reject</button>
            </div>
        </div>
    `;

    // Store data on row for re-use after approve/reject
    row._userData = data;

    row.querySelector('.btn-info').addEventListener('click',    () => viewUser(uid, row._userData));
    row.querySelector('.btn-approve').addEventListener('click', () => approveUser(uid, row));
    row.querySelector('.btn-reject').addEventListener('click',  () => rejectUser(uid, row));

    return row;
}

// =============================================
// Load Pending Users — same getDocs pattern as allusers.js
// =============================================
async function loadPendingUsers() {
    const tbody = el('pending-table-body');
    tbody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-sub);font-size:13px;">Loading...</div>';

    try {
        // Read full collection (same as allusers.js), filter pending client-side
        const snapshot = await getDocs(collection(db, 'residents'));

        const pending = snapshot.docs.filter(d => d.data().status === 'pending');

        if (pending.length === 0) {
            tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No pending users at the moment.</div>';
            return;
        }

        tbody.innerHTML = '';
        pending.forEach(docSnap => {
            tbody.appendChild(buildRow(docSnap.id, docSnap.data()));
        });

    } catch (err) {
        console.error('Load error:', err);
        tbody.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:13px;">Error: ${err.message}</div>`;
    }
}

// =============================================
// Sidebar Badges — real-time
// =============================================
function loadSidebarBadges() {
    // Red badge — pending requests only
    onSnapshot(
        query(collection(db, 'requests'), where('status', '==', 'pending')),
        (snap) => {
            const badge = el('pending-requests-badge');
            if (badge) badge.textContent = snap.size;
        }
    );

    // Yellow badge — pending users only
    onSnapshot(
        query(collection(db, 'residents'), where('status', '==', 'pending')),
        (snap) => {
            const badge = el('pending-users-badge');
            if (badge) badge.textContent = snap.size;
        }
    );
}