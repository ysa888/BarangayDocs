// =============================================
// Firebase Imports
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    doc,
    updateDoc,
    deleteDoc,
    getDoc,
    onSnapshot,   // ← ADDED
    query,        // ← ADDED
    where         // ← ADDED
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ← ADDED: helper used by loadSidebarBadges
const el = (id) => document.getElementById(id);

// Store all users in memory for search/filter
let allUsers = [];

// =============================================
// Auth Guard
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

    loadAllUsers();
    loadSidebarBadges(); // ← ADDED
});

// =============================================
// Sidebar Toggle
// =============================================
let sidebarOpen = true;
window.toggleSidebar = function () {
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
    document.getElementById('mainContent').classList.toggle('expanded', !sidebarOpen);
};

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

function getBadgeClass(status) {
    if (status === 'approved') return 'active';
    if (status === 'rejected') return 'inactive';
    if (status === 'pending')  return 'waiting';
    return 'waiting';
}

function getBadgeLabel(status) {
    if (status === 'approved') return 'Active';
    if (status === 'rejected') return 'Rejected';
    if (status === 'pending')  return 'Pending';
    return status;
}

function getActionButtons(uid, status) {
    if (status === 'approved') {
        return `
            <button class="btn-info info-btn" data-uid="${uid}">Info</button>
            <button class="btn-reject deactivate-btn" data-uid="${uid}">Deactivate</button>`;
    } else if (status === 'pending') {
        return `
            <button class="btn-info info-btn" data-uid="${uid}">Info</button>
            <button class="btn-approve approve-btn" data-uid="${uid}">Approve</button>
            <button class="btn-reject reject-btn" data-uid="${uid}">Reject</button>`;
    } else {
        return `
            <button class="btn-info info-btn" data-uid="${uid}">Info</button>
            <button class="btn-approve activate-btn" data-uid="${uid}">Activate</button>
            <button class="btn-reject delete-btn" data-uid="${uid}">Delete</button>`;
    }
}

// =============================================
// Build Row
// =============================================
function buildRow(uid, data) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.uid = uid;
    row.dataset.status = data.status;
    row.dataset.name = `${data.firstName} ${data.lastName}`.toLowerCase();

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
        <div class="col-status">
            <span class="badge ${getBadgeClass(data.status)}">${getBadgeLabel(data.status)}</span>
        </div>
        <div class="col-action">
            <div class="action-row">${getActionButtons(uid, data.status)}</div>
        </div>
    `;

    // Wire up action buttons
    row.querySelector('.info-btn')?.addEventListener('click',       () => viewUser(uid, data));
    row.querySelector('.approve-btn')?.addEventListener('click',    () => updateStatus(uid, 'approved', row));
    row.querySelector('.reject-btn')?.addEventListener('click',     () => updateStatus(uid, 'rejected', row));
    row.querySelector('.deactivate-btn')?.addEventListener('click', () => updateStatus(uid, 'rejected', row));
    row.querySelector('.activate-btn')?.addEventListener('click',   () => updateStatus(uid, 'approved', row));
    row.querySelector('.delete-btn')?.addEventListener('click',     () => openDeleteModal(uid));

    return row;
}

// =============================================
// Update Status in Firestore
// =============================================
async function updateStatus(uid, newStatus, row) {
    try {
        await updateDoc(doc(db, 'residents', uid), {
            status: newStatus,
            updatedAt: new Date().toISOString()
        });

        // Update in-memory record
        const user = allUsers.find(u => u.uid === uid);
        if (user) user.status = newStatus;

        // Update row UI
        row.dataset.status = newStatus;
        row.querySelector('.badge').className = `badge ${getBadgeClass(newStatus)}`;
        row.querySelector('.badge').textContent = getBadgeLabel(newStatus);
        row.querySelector('.action-row').innerHTML = getActionButtons(uid, newStatus);

        // Re-wire buttons
        row.querySelector('.info-btn')?.addEventListener('click',       () => viewUser(uid, allUsers.find(u => u.uid === uid)));
        row.querySelector('.approve-btn')?.addEventListener('click',    () => updateStatus(uid, 'approved', row));
        row.querySelector('.reject-btn')?.addEventListener('click',     () => updateStatus(uid, 'rejected', row));
        row.querySelector('.deactivate-btn')?.addEventListener('click', () => updateStatus(uid, 'rejected', row));
        row.querySelector('.activate-btn')?.addEventListener('click',   () => updateStatus(uid, 'approved', row));
        row.querySelector('.delete-btn')?.addEventListener('click',     () => openDeleteModal(uid));

        const messages = {
            approved: '✓ User activated successfully',
            rejected: 'User deactivated/rejected'
        };
        showToast(messages[newStatus] || 'Status updated');

    } catch (err) {
        console.error('Update error:', err);
        showToast('Failed to update user. Check Firestore rules.');
    }
}

// =============================================
// Verification images (ID + face) with click-to-enlarge
// =============================================
function renderVerifyImage(wrapId, openBtnId, url, altText, emptyText) {
    const wrap    = document.getElementById(wrapId);
    const openBtn = document.getElementById(openBtnId);
    wrap.innerHTML = '';

    const showMessage = (text) => {
        wrap.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'valid-id-no-img';
        msg.textContent = text;
        wrap.appendChild(msg);
        openBtn.style.display = 'none';
    };

    if (!url) {
        showMessage(emptyText);
        return;
    }

    const img = document.createElement('img');
    img.alt = altText;
    img.src = url;
    img.addEventListener('error', () => showMessage('Image failed to load'));
    img.addEventListener('click', () => openLightbox(url));
    wrap.appendChild(img);

    openBtn.href = url;
    openBtn.style.display = 'inline-block';
}

function openLightbox(url) {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox').classList.add('open');
}

document.getElementById('lightbox').addEventListener('click', () => {
    document.getElementById('lightbox').classList.remove('open');
    document.getElementById('lightbox-img').src = '';
});

// =============================================
// View User Modal
// =============================================
function viewUser(uid, data) {
    document.getElementById('modal-name').textContent     = `${data.firstName} ${data.middleName ? data.middleName + ' ' : ''}${data.lastName}`;
    document.getElementById('modal-email').textContent    = data.email || '—';
    document.getElementById('modal-contact').textContent  = data.contactNumber || '—';
    document.getElementById('modal-birthday').textContent = data.birthday || '—';
    document.getElementById('modal-sex').textContent      = data.sex || '—';
    document.getElementById('modal-civil').textContent    = data.civilStatus || '—';
    document.getElementById('modal-address').textContent  = `${data.houseNumber}, ${data.barangay}, ${data.city}, ${data.province}`;
    document.getElementById('modal-years').textContent    = data.yearsResidency ? `${data.yearsResidency} year(s)` : '—';
    document.getElementById('modal-joined').textContent   = formatDate(data.createdAt);
    document.getElementById('modal-status').textContent   = getBadgeLabel(data.status);
    document.getElementById('modal-status').className     = `badge ${getBadgeClass(data.status)}`;
    document.getElementById('modal-initials').textContent = getInitials(data.firstName, data.lastName);

    // Valid ID image + Face photo (shown side by side for comparison)
    renderVerifyImage('modal-valid-id-wrap', 'modal-open-id-btn', data.validIdUrl, 'Valid ID', 'No ID uploaded');
    renderVerifyImage('modal-face-wrap',     'modal-open-face-btn', data.faceUrl,  'Face photo', 'No face photo uploaded');

    document.getElementById('user-modal').classList.add('open');
}

document.getElementById('close-modal').addEventListener('click', () => {
    document.getElementById('user-modal').classList.remove('open');
});
document.getElementById('user-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('user-modal').classList.remove('open');
});

// =============================================
// Delete User (rejected / deactivated only, admin password required)
// =============================================
let pendingDeleteUid = null;

function openDeleteModal(uid) {
    const user = allUsers.find(u => u.uid === uid);
    if (!user) return;

    // Safety: only rejected / deactivated accounts can be deleted
    if (user.status !== 'rejected') {
        showToast('Only rejected or deactivated users can be deleted.');
        return;
    }

    pendingDeleteUid = uid;
    document.getElementById('delete-user-name').textContent = `${user.firstName} ${user.lastName}`;
    document.getElementById('delete-password').value = '';
    setDeleteError('');
    setDeleteBusy(false);
    document.getElementById('delete-modal').classList.add('open');
    document.getElementById('delete-password').focus();
}

function closeDeleteModal() {
    pendingDeleteUid = null;
    document.getElementById('delete-password').value = '';
    document.getElementById('delete-modal').classList.remove('open');
}

function setDeleteError(msg) {
    const e = document.getElementById('delete-error');
    e.textContent = msg;
    e.style.display = msg ? 'block' : 'none';
}

function setDeleteBusy(busy) {
    const btn = document.getElementById('delete-confirm-btn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Deleting...' : 'Delete Permanently';
    document.getElementById('delete-cancel-btn').disabled = busy;
}

async function confirmDelete() {
    const uid      = pendingDeleteUid;
    const password = document.getElementById('delete-password').value;
    const admin    = auth.currentUser;

    if (!uid) return;
    if (!password) return setDeleteError('Please enter your admin password.');
    if (!admin || !admin.email) return setDeleteError('Could not verify your admin account. Please sign in again.');

    const user = allUsers.find(u => u.uid === uid);
    if (!user || user.status !== 'rejected') return setDeleteError('Only rejected or deactivated users can be deleted.');

    setDeleteBusy(true);
    setDeleteError('');

    // Step 1: re-check the admin's password
    try {
        const credential = EmailAuthProvider.credential(admin.email, password);
        await reauthenticateWithCredential(admin, credential);
    } catch (err) {
        console.error('Re-auth error:', err);
        setDeleteBusy(false);
        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
            setDeleteError('Incorrect password. The user was not deleted.');
        } else if (err.code === 'auth/too-many-requests') {
            setDeleteError('Too many attempts. Please wait a few minutes and try again.');
        } else {
            setDeleteError('Could not verify your password. Please try again.');
        }
        return;
    }

    // Step 2: delete the resident record
    try {
        await deleteDoc(doc(db, 'residents', uid));

        allUsers = allUsers.filter(u => u.uid !== uid);
        closeDeleteModal();
        applyFilters();
        showToast('User deleted permanently');
    } catch (err) {
        console.error('Delete error:', err);
        setDeleteBusy(false);
        setDeleteError('Failed to delete user. Check your Firestore rules allow admins to delete residents.');
    }
}

document.getElementById('delete-confirm-btn').addEventListener('click', confirmDelete);
document.getElementById('delete-cancel-btn').addEventListener('click', closeDeleteModal);
document.getElementById('delete-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !document.getElementById('delete-confirm-btn').disabled) closeDeleteModal();
});
document.getElementById('delete-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmDelete();
});

// =============================================
// Search & Filter
// =============================================
function applyFilters() {
    const search       = document.getElementById('search-input').value.toLowerCase();
    const statusFilter = document.getElementById('status-filter').value;
    const tbody        = document.getElementById('all-users-body');

    tbody.innerHTML = '';
    let count = 0;

    allUsers.forEach(user => {
        const nameMatch   = user.name.includes(search) || user.email?.toLowerCase().includes(search);
        const statusMatch = statusFilter === 'all' || user.status === statusFilter;

        if (nameMatch && statusMatch) {
            const row = buildRow(user.uid, user);
            tbody.appendChild(row);
            count++;
        }
    });

    if (count === 0) {
        tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No users found.</div>';
    }
}

document.getElementById('search-input').addEventListener('input', applyFilters);
document.getElementById('status-filter').addEventListener('change', applyFilters);

// =============================================
// Load All Users from Firestore
// =============================================
async function loadAllUsers() {
    const tbody = document.getElementById('all-users-body');
    tbody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-sub);font-size:13px;">Loading...</div>';

    try {
        const snapshot = await getDocs(collection(db, 'residents'));

        if (snapshot.empty) {
            tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No users registered yet.</div>';
            return;
        }

        allUsers = [];
        snapshot.forEach(docSnap => {
            allUsers.push({
                uid: docSnap.id,
                name: `${docSnap.data().firstName} ${docSnap.data().lastName}`.toLowerCase(),
                ...docSnap.data()
            });
        });

        // Sort by newest first
        allUsers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        tbody.innerHTML = '';
        allUsers.forEach(user => {
            tbody.appendChild(buildRow(user.uid, user));
        });

    } catch (err) {
        console.error('Load error:', err);
        tbody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--red);font-size:13px;">Failed to load users. Check Firestore rules.</div>';
    }
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