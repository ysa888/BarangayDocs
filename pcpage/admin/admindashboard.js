// =============================================
// dashboard.js
// Handles: admin_dashboard.html
// Loads live stats + recent requests from Firestore
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { openLightbox } from "./imageviewer.js";
import { formatBirthDate, resolveAge, resolveAddress, findIdImages, isImgSrc } from "./residentinfo.js";
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
            tbody.appendChild(buildRow(docSnap.id, docSnap.data()));
        });
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
    const go = (cls, label) => `<button class="${cls}" data-id="${docId}" data-action="go">${label}</button>`;
    if (status === 'pending')    return `<button class="btn-process" data-id="${docId}" data-action="viewrequest">View Request</button>`;
    if (status === 'processing') return go('btn-approve', 'Preview &amp; Approve');
    if (status === 'approved')   return go('btn-approve', 'Mark as Ready');
    if (status === 'ready')      return go('btn-approve', 'Mark as Released');
    if (status === 'released')   return go('btn-view-doc', 'View Document');
    if (status === 'rejected')   return `<span style="font-size:11px;color:var(--red-text);">Rejected</span>`;
    return '';
}

// Steps after "View Request" live on the Requests pages (Preview & Approve, QR, signing...).
// The dashboard opens that same popup there instead of having its own copy.
function requestsPageFor(status) {
    return ['pending', 'processing', 'approved'].includes(status) ? 'admin_pending_requests.html' : 'admin_all_requests.html';
}
function goToRequest(docId, status, action) {
    window.location.href = requestsPageFor(status) + '?open=' + encodeURIComponent(docId) + (action ? '&action=' + action : '');
}

// =============================================
// Wire row action buttons
// =============================================
function wireRowButtons(row, docId, data) {
    row.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'viewrequest') openRequestModal(docId, data, row);
            else goToRequest(docId, data.status);
        });
    });
}

// =============================================
// View Request modal — details + valid ID (zoomable) + Process / Reject
// Built in JS so the HTML needs no change. Same popup as the Requests page.
// =============================================
async function openRequestModal(docId, data, row) {
    let r = data, rd = {};
    try {
        const snap = await getDoc(doc(db, 'requests', docId));
        if (snap.exists()) r = snap.data();
        if (r.uid) {
            const rs = await getDoc(doc(db, 'residents', r.uid));
            if (rs.exists()) rd = rs.data();
        }
    } catch (err) { console.error(err); }

    document.getElementById('request-detail-modal')?.remove();
    const esc = v => String(v ?? '—').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const field = (label, val) => `<div class="modal-field"><label>${label}</label><p>${esc(val || '—')}</p></div>`;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.id = 'request-detail-modal';
    const faceSrc = [rd.faceUrl, rd.photoUrl, rd.profilePhoto, rd.profileUrl, rd.photo, rd.avatar].find(isImgSrc) || '';
    const idImgs  = findIdImages(rd, r);
    const initial = String(r.residentName || '?').trim().charAt(0).toUpperCase();
    const imgBox  = (src, label) =>
        `<img class="rd-zoom" src="${src}" alt="${label}" style="display:block;width:100%;max-height:200px;object-fit:contain;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;cursor:zoom-in;">`;
    const birthTxt = formatBirthDate(rd, r);
    const sexTxt   = rd.sex || rd.gender;

    if (!document.getElementById('rd-compare-style')) {
        const st = document.createElement('style');
        st.id = 'rd-compare-style';
        st.textContent = `
          #request-detail-modal .modal-box { max-height:92vh; overflow-y:auto; }
          .rd-compare { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:20px; align-items:start; }
          .rd-col-title { font-size:11px; font-weight:800; color:var(--text-sub); text-transform:uppercase; letter-spacing:.5px; margin:0 0 10px; }
          .rd-info-grid { display:grid; grid-template-columns: 1fr 1fr; gap:0 14px; }
          .rd-info-grid .modal-field.rd-wide { grid-column: 1 / -1; }
          .rd-pic-col { position:sticky; top:0; }
          .rd-pic-col img.rd-id { display:block; width:100%; max-height:70vh; object-fit:contain; background:var(--bg); border:1.5px solid var(--border); border-radius:10px; cursor:zoom-in; }
          .rd-pic-col .rd-id + .rd-id { margin-top:10px; }
          @media (max-width: 760px) {
            .rd-compare { grid-template-columns: 1fr; }
            .rd-pic-col { position:static; order:-1; }   /* picture on top, info underneath */
          }
        `;
        document.head.appendChild(st);
    }

    const wide = (label, val) => `<div class="modal-field rd-wide"><label>${label}</label><p>${esc(val || '—')}</p></div>`;

    overlay.innerHTML = `
        <div class="modal-box" style="max-width:980px;width:96%;">
            <div class="modal-header">
                <h3>Request Details</h3>
                <button class="modal-close" type="button" data-rd="close">✕</button>
            </div>
            <div class="rd-compare">
                <!-- LEFT: resident information -->
                <div class="rd-info-col">
                    <p class="rd-col-title">Resident Information</p>
                    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
                        ${faceSrc
                            ? `<img class="rd-zoom" src="${faceSrc}" alt="Profile" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--border);flex-shrink:0;cursor:zoom-in;">`
                            : `<div style="width:64px;height:64px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;flex-shrink:0;">${esc(initial)}</div>`}
                        <div style="min-width:0;">
                            <div style="font-size:16px;font-weight:800;color:var(--text-main);overflow-wrap:anywhere;">${esc(r.residentName)}</div>
                            <div style="font-size:12px;color:var(--text-sub);">${esc(rd.civilStatus || '')}${rd.civilStatus && sexTxt ? ' · ' : ''}${esc(sexTxt || '')}</div>
                        </div>
                    </div>
                    <div class="rd-info-grid">
                        ${wide('Document', r.documentType)}
                        ${field('Reference No.', r.referenceNo)}
                        ${field('Submitted', formatDate(r.createdAt))}
                        ${wide('Purpose', r.purpose)}
                        ${field('Birthday', birthTxt)}
                        ${field('Age', resolveAge(rd, r))}
                        ${wide('Contact', rd.contactNumber || rd.phone || rd.mobile || r.contactNumber)}
                        ${wide('Address', resolveAddress(rd, r))}
                    </div>
                </div>
                <!-- RIGHT: valid ID picture, beside the details for easy comparison -->
                <div class="rd-pic-col">
                    <p class="rd-col-title">Valid ID (click to zoom, drag to move)</p>
                    ${idImgs.length
                        ? idImgs.map((s, i) => `<img class="rd-zoom rd-id" src="${s}" alt="ID ${i + 1}">`).join('')
                        : `<div class="modal-field"><p>No ID image found on this resident</p></div>`}
                </div>
            </div>
            <div class="modal-btn-row" id="rd-buttons" style="margin-top:16px;"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.rd-zoom').forEach(img => img.addEventListener('click', () => openLightbox(img.src)));

    const close = () => overlay.remove();
    overlay.querySelector('[data-rd="close"]').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const btns = overlay.querySelector('#rd-buttons');
    const mk = (text, cls, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn;
        btns.appendChild(b);
    };
    mk('Close', 'modal-btn-cancel', close);
    if (r.status === 'pending' || r.status === 'processing') {
        mk('Reject', 'modal-btn-cancel', () => goToRequest(docId, r.status, 'reject'));
    }
    if (r.status === 'pending') {
        mk('Process', 'modal-btn-save', () => goToRequest(docId, r.status, 'process'));
    }
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
// Init Dashboard
// =============================================
function initDashboard() {
    initStats();
    initRecentRequests();
}