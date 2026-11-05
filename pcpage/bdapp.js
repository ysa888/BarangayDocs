// =============================================
// bdapp.js — BarangayDocs App Logic
// Covers: home, account, request, scanqr pages
// Requires: bdlogsign.js handles login/register
// =============================================

import { initializeApp }      from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAnalytics }       from "https://www.gstatic.com/firebasejs/12.12.1/firebase-analytics.js";
import {
    getAuth,
    onAuthStateChanged,
    signOut,
    updatePassword,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    collection,
    addDoc,
    query,
    where,
    orderBy,
    onSnapshot,
    serverTimestamp,
    getDocs
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// =============================================
// Firebase Config & Init
// (same project as bdlogsign.js)
// =============================================
const firebaseConfig = {
    apiKey:            "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain:        "barangaydocs-df957.firebaseapp.com",
    projectId:         "barangaydocs-df957",
    storageBucket:     "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId:             "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId:     "G-YG0Y575BRD"
};

const app       = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth      = getAuth(app);
const db        = getFirestore(app);

// =============================================
// Helpers
// =============================================
const el = (id) => document.getElementById(id);

/** Format Firestore Timestamp or ISO string to readable date */
function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Relative time: "2m ago", "3h ago", "1d ago", or full date */
function formatRelativeTime(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    const diffMs   = Date.now() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHrs  = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHrs / 24);
    if (diffMins <  1)  return 'Just now';
    if (diffMins < 60)  return `${diffMins}m ago`;
    if (diffHrs  < 24)  return `${diffHrs}h ago`;
    if (diffDays <  7)  return `${diffDays}d ago`;
    return formatDate(val);
}

/** Generate a reference number: BRY-YYYY-XXXXX */
function generateRef() {
    const year = new Date().getFullYear();
    const rand = String(Math.floor(10000 + Math.random() * 90000));
    return `BRY-${year}-${rand}`;
}

/** Get initials from a name string */
function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
}

// =============================================
// PAGE DETECTION
// =============================================
const page = {
    isHome:    document.title.includes('Home'),
    isAccount: document.title.includes('Account'),
    isRequest: document.title.includes('Request'),
    isScanQR:  document.title.includes('Scan'),
};

// =============================================
// AUTH GUARD — redirect to login if not signed in
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'barangaydocs_login.html';
        return;
    }

    // Fetch resident data from Firestore
    const userDoc = await getDoc(doc(db, 'residents', user.uid));
    if (!userDoc.exists()) {
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
        return;
    }

    const userData = userDoc.data();

    // Extra safety: re-check approval status on every page load
    if (userData.status === 'pending') {
        alert('Your account is still pending admin approval.');
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
        return;
    }
    if (userData.status === 'rejected') {
        alert('Your account was rejected. Please contact the barangay office.');
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
        return;
    }

    // Admin redirect safety: admins should not use resident pages
    if (userData.role === 'admin') {
        window.location.href = 'barangaydocs_admin.html';
        return;
    }

    // ── Run page-specific logic ──
    populateSidebar(userData);

    if (page.isHome)    initHome(user, userData);
    if (page.isAccount) initAccount(user, userData);
    if (page.isRequest) initRequest(user, userData);
    if (page.isScanQR)  initScanQR(user, userData);
});

// =============================================
// SIDEBAR — populate user info on every page
// =============================================
function populateSidebar(userData) {
    const fullName = `${userData.firstName} ${userData.middleName ? userData.middleName.charAt(0) + '. ' : ''}${userData.lastName}`;

    // Avatar initials
    document.querySelectorAll('.user-avatar').forEach(av => {
        av.textContent = getInitials(fullName);
    });

    // Name & role
    document.querySelectorAll('.user-name').forEach(n => n.textContent = fullName);
    document.querySelectorAll('.user-role').forEach(r => {
        r.textContent = `Resident • Barangay Banicain`;
    });
}

// =============================================
// LOGOUT — wire up all logout buttons/modals
// =============================================
document.addEventListener('DOMContentLoaded', () => {

    // Sidebar logout button (direct click)
    document.querySelectorAll('.logout-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const modal = el('logoutModal');
            if (modal) {
                modal.classList.add('show');
            } else {
                await doLogout();
            }
        });
    });

    // Modal confirm sign-out buttons
    document.querySelectorAll('.btn-logout').forEach(btn => {
        btn.addEventListener('click', async () => {
            await doLogout();
        });
    });

    // Account page sign-out button
    const signoutBtn = document.querySelector('.signout-btn');
    if (signoutBtn) {
        signoutBtn.addEventListener('click', () => {
            const modal = el('logoutModal');
            if (modal) modal.classList.add('show');
        });
    }
});

async function doLogout() {
    await signOut(auth);
    window.location.href = 'barangaydocs_login.html';
}

// =============================================
// =============================================
// HOME PAGE
// =============================================
// =============================================
async function initHome(user, userData) {
    const fullName = `${userData.firstName} ${userData.middleName ? userData.middleName.charAt(0) + '. ' : ''}${userData.lastName}`;

    // Update user card
    const ucName = document.querySelector('.uc-name');
    const ucAddr = document.querySelector('.uc-addr');
    if (ucName) ucName.textContent = fullName;
    if (ucAddr) ucAddr.textContent = `${userData.barangay || 'Barangay Banicain'}, ${userData.city || 'Olongapo City'}`;

    // ── Notification button toggle ──
    const notifBtn      = el('notifBtn');
    const notifDropdown = el('notifDropdown');
    if (notifBtn && notifDropdown) {
        notifBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.classList.toggle('show');
        });
        document.addEventListener('click', (e) => {
            if (!notifDropdown.contains(e.target) && e.target !== notifBtn) {
                notifDropdown.classList.remove('show');
            }
        });
    }

    // Live stats from Firestore
    const reqRef = collection(db, 'requests');
    const q = query(reqRef, where('uid', '==', user.uid));

    onSnapshot(q, (snapshot) => {
        let total = 0, pending = 0, ready = 0, rejected = 0, released = 0;

        snapshot.forEach(d => {
            const status = d.data().status;
            total++;
            if (status === 'pending' || status === 'processing') pending++;
            else if (status === 'ready') ready++;
            else if (status === 'rejected') rejected++;
            else if (status === 'released') released++;
        });

        // Stat cards
        const statNums = document.querySelectorAll('.stat-num');
        if (statNums[0]) statNums[0].textContent = total;
        if (statNums[1]) statNums[1].textContent = pending;
        if (statNums[2]) statNums[2].textContent = ready;
        if (statNums[3]) statNums[3].textContent = rejected;
        if (statNums[4]) statNums[4].textContent = released;

        // User card pills
        const pills = document.querySelectorAll('.pill');
        pills.forEach(pill => {
            if (pill.classList.contains('pending'))  pill.textContent = `Pending: ${pending}`;
            if (pill.classList.contains('ready'))    pill.textContent = `Ready: ${ready}`;
            if (pill.classList.contains('rejected')) pill.textContent = `Rejected: ${rejected}`;
            if (pill.classList.contains('released')) pill.textContent = `Released: ${released}`;
        });

        // Notification dropdown — show all requests with time (sort client-side)
        const sorted = [...snapshot.docs].sort((a, b) => {
            const aT = a.data().createdAt?.toMillis?.() ?? 0;
            const bT = b.data().createdAt?.toMillis?.() ?? 0;
            return bT - aT;
        });
        renderNotifDropdown(sorted, pending + ready);
    });
}

// ── Render notification dropdown items ──
function renderNotifDropdown(docs, activeCount) {
    const listEl  = el('notifList');
    const badgeEl = el('notifBadge');
    if (!listEl) return;

    // Badge
    if (badgeEl) {
        if (activeCount > 0) {
            badgeEl.textContent = activeCount > 9 ? '9+' : activeCount;
            badgeEl.classList.add('show');
        } else {
            badgeEl.classList.remove('show');
        }
    }

    if (!docs || docs.length === 0) {
        listEl.innerHTML = '<div class="notif-empty"><p>No requests yet</p></div>';
        return;
    }

    const statusLabel = {
        pending:    'Pending',
        processing: 'Processing',
        ready:      'Ready for Pickup',
        rejected:   'Rejected',
        released:   'Released'
    };

    // Show up to 10 most recent (already ordered desc from query)
    const items = docs.slice(0, 10);
    listEl.innerHTML = items.map(docSnap => {
        const r      = docSnap.data();
        const status = r.status || 'pending';
        const label  = statusLabel[status] || 'Pending';
        const time   = formatRelativeTime(r.createdAt);
        const docType = r.documentType || 'Document Request';
        return `
            <div class="notif-item">
                <div class="notif-dot ${status}"></div>
                <div class="notif-item-body">
                    <div class="notif-item-title">${docType}</div>
                    <div class="notif-item-meta">
                        <span class="notif-item-status ${status}">${label}</span>
                        <span class="notif-item-time">· ${time}</span>
                    </div>
                </div>
            </div>`;
    }).join('');
}

// =============================================
// =============================================
// ACCOUNT PAGE
// =============================================
// =============================================
function initAccount(user, userData) {
    const fullName = `${userData.firstName} ${userData.middleName ? userData.middleName.charAt(0) + '. ' : ''}${userData.lastName}`;

    // Profile band
    const profileAvatar = document.querySelector('.profile-avatar');
    const profileName   = document.querySelector('.profile-info h2');
    const profileSub    = document.querySelector('.profile-info p');

    if (profileAvatar) profileAvatar.textContent = getInitials(fullName);
    if (profileName)   profileName.textContent   = fullName;
    if (profileSub)    profileSub.textContent     = `${userData.barangay || 'Barangay Banicain'} • ${userData.city || 'Olongapo City'}`;

    // Live request stats
    const reqRef = collection(db, 'requests');
    const q = query(reqRef, where('uid', '==', user.uid));

    onSnapshot(q, (snapshot) => {
        let total = 0, pending = 0, ready = 0, rejected = 0, released = 0;
        snapshot.forEach(d => {
            const s = d.data().status;
            total++;
            if (s === 'pending' || s === 'processing') pending++;
            else if (s === 'ready')    ready++;
            else if (s === 'rejected') rejected++;
            else if (s === 'released') released++;
        });

        const pstats = document.querySelectorAll('.pstat-num');
        if (pstats[0]) pstats[0].textContent = total;
        if (pstats[1]) pstats[1].textContent = pending;
        if (pstats[2]) pstats[2].textContent = ready;
        if (pstats[3]) pstats[3].textContent = rejected;
        if (pstats[4]) pstats[4].textContent = released;
    });

    // Personal info — fill by ID so adding/removing rows never breaks order
    const birthday = userData.birthday
        ? new Date(userData.birthday).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';

    const setInfo = (id, val) => { const e = el(id); if (e) e.textContent = val || '—'; };
    setInfo('infoFullName',    fullName);
    setInfo('infoEmail',       userData.email);
    setInfo('infoContact',     userData.contactNumber);
    setInfo('infoBirthday',    birthday);
    setInfo('infoAddress',     userData.houseNumber
        ? `${userData.houseNumber}, ${userData.barangay || 'Brgy. Banicain'}`
        : userData.barangay || 'Brgy. Banicain');
    setInfo('infoCivilStatus', userData.civilStatus    || 'Not provided');
    setInfo('infoSex',         userData.sex            || 'Not provided');
    const residencyVal = userData.yearsOfResidency
        ?? userData.yearsResidency
        ?? userData.years_of_residency
        ?? userData.residency
        ?? userData.residencyYears
        ?? null;
    setInfo('infoResidency', residencyVal !== null && residencyVal !== undefined && residencyVal !== ''
        ? `${residencyVal} year(s)`
        : 'Not provided');

    // Change Password from Settings card
    wireChangePassword(user);

    // Settings modals — About, Terms & Conditions, Privacy Policy
    wireSettingsModals();
}

/** Change Password — looks for menu item with "Change Password" text */
function wireChangePassword(user) {
    document.querySelectorAll('.menu-item').forEach(item => {
        const h4 = item.querySelector('h4');
        if (h4 && h4.textContent.trim() === 'Change Password') {
            item.style.cursor = 'pointer';
            item.addEventListener('click', () => {
                const current = prompt('Enter your current password:');
                if (!current) return;
                const newPw = prompt('Enter your new password (min. 6 characters):');
                if (!newPw || newPw.length < 6) return alert('Password must be at least 6 characters.');
                const confirm = prompt('Confirm new password:');
                if (newPw !== confirm) return alert('Passwords do not match.');

                const credential = EmailAuthProvider.credential(user.email, current);
                reauthenticateWithCredential(user, credential)
                    .then(() => updatePassword(user, newPw))
                    .then(() => alert('Password updated successfully!'))
                    .catch(err => {
                        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
                            alert('Current password is incorrect.');
                        } else {
                            alert('Failed to update password: ' + err.message);
                        }
                    });
            });
        }
    });
}

/** Wire About, Terms & Conditions, Privacy Policy modal triggers */
function wireSettingsModals() {
    const open  = (id) => { const m = el(id); if (m) m.classList.add('show'); };
    const close = (id) => { const m = el(id); if (m) m.classList.remove('show'); };

    // Open triggers — menu items by id
    el('menuAbout')?.addEventListener('click',   () => open('modalAbout'));
    el('menuTerms')?.addEventListener('click',   () => open('modalTerms'));
    el('menuPrivacy')?.addEventListener('click', () => open('modalPrivacy'));

    // Close buttons inside modals
    ['modalAbout','modalTerms','modalPrivacy'].forEach(id => {
        const modal = el(id);
        if (!modal) return;
        modal.querySelectorAll('.modal-close-btn, .modal-understand-btn').forEach(btn => {
            btn.addEventListener('click', () => close(id));
        });
        // Close on overlay click
        modal.addEventListener('click', (e) => { if (e.target === modal) close(id); });
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            ['modalAbout','modalTerms','modalPrivacy'].forEach(id => close(id));
        }
    });
}

// =============================================
// =============================================
// REQUEST PAGE
// =============================================
// =============================================
function initRequest(user, userData) {
    const fullName = `${userData.firstName} ${userData.middleName ? userData.middleName.charAt(0) + '. ' : ''}${userData.lastName}`;

    // ── Live request list ──
    const reqRef = collection(db, 'requests');
    const q = query(reqRef, where('uid', '==', user.uid), orderBy('createdAt', 'desc'));

    onSnapshot(q, (snapshot) => {
        renderRequestList(snapshot, fullName);
    });

    // ── New Request Modal ──
    const newReqBtn = document.querySelector('.new-req-btn');
    if (newReqBtn) {
        newReqBtn.addEventListener('click', () => openModal());
    }

    // ── Submit Request ──
    const submitBtn = document.querySelector('.btn-submit');
    if (submitBtn) {
        submitBtn.addEventListener('click', () => submitRequest(user, userData, fullName));
    }
}

// ── Render request cards from Firestore snapshot ──
function renderRequestList(snapshot, fullName) {
    const listEl = document.querySelector('.request-list');
    if (!listEl) return;

    // Remove all dynamic cards (keep empty state)
    listEl.querySelectorAll('.request-card').forEach(c => c.remove());

    const emptyState = el('emptyState');

    if (snapshot.empty) {
        if (emptyState) emptyState.classList.add('show');
        return;
    }
    if (emptyState) emptyState.classList.remove('show');

    snapshot.forEach(docSnap => {
        const r = docSnap.data();
        const card = buildRequestCard(docSnap.id, r, fullName);
        listEl.insertBefore(card, emptyState);
    });

    // Re-apply active tab filter
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) {
        const status = activeTab.dataset.status || 'all';
        filterByStatus(status);
    }
}

// ── Build a single request card element ──
function buildRequestCard(id, r, fullName) {
    const statusBadgeClass = {
        pending:    'pending',
        processing: 'processing',
        ready:      'ready',
        rejected:   'rejected'
    }[r.status] || 'pending';

    const statusLabel = {
        pending:    'Pending',
        processing: 'Processing',
        ready:      'Ready for Pickup',
        rejected:   'Rejected'
    }[r.status] || 'Pending';

    const submitted = r.createdAt ? formatDate(r.createdAt) : '—';
    const pickup    = r.readyAt   ? formatDate(r.readyAt)   : '—';

    // Track progress steps
    const steps = buildTrackSteps(r.status);

    const card = document.createElement('div');
    card.className = 'request-card';
    card.dataset.status = r.status;
    card.dataset.id = id;

    card.innerHTML = `
        <div class="card-top">
            <div class="req-icon">
                <img src="/${docIcon(r.documentType)}" alt=""
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
                <div class="req-ph" style="display:none;"></div>
            </div>
            <div class="req-name">
                <h3>${r.documentType}</h3>
                <p>Ref: ${r.referenceNo} • ${submitted}</p>
            </div>
            <span class="badge ${statusBadgeClass}">${statusLabel}</span>
        </div>
        <div class="card-details">
            <div class="detail-pair">
                <div>
                    <div class="d-label">Submitted</div>
                    <div class="d-val">${submitted}</div>
                </div>
                <div>
                    <div class="d-label">Purpose</div>
                    <div class="d-val">${r.purpose || '—'}</div>
                </div>
                ${r.status === 'ready' ? `
                <div>
                    <div class="d-label">Ready For Pickup</div>
                    <div class="d-val">${pickup}</div>
                </div>` : ''}
                ${r.status === 'rejected' && r.rejectReason ? `
                <div>
                    <div class="d-label">Reason</div>
                    <div class="d-val">${r.rejectReason}</div>
                </div>` : ''}
            </div>
            <button class="track-btn" onclick="toggleTrack(this)">Track Progress</button>
        </div>
        <div class="progress-track">
            <div class="track-row">${steps}</div>
        </div>
    `;

    return card;
}

// ── Build track step HTML based on current status ──
function buildTrackSteps(status) {
    const statuses = ['submitted', 'processing', 'approved', 'ready'];
    const labels   = ['Submitted', 'Processing', 'Approved', 'Ready'];

    // Map current Firestore status to step index
    const stepMap = {
        pending:    1,
        processing: 2,
        approved:   3,
        ready:      4,
        rejected:   -1
    };
    const currentStep = stepMap[status] ?? 1;
    const isRejected  = status === 'rejected';

    let html = '';
    statuses.forEach((s, i) => {
        const stepNum = i + 1;
        let dotClass = '';
        let content  = stepNum;

        if (isRejected && stepNum === 2) {
            dotClass = 'rejected';
            content  = '✕';
        } else if (stepNum < currentStep) {
            dotClass = 'done';
            content  = '✓';
        } else if (stepNum === currentStep) {
            dotClass = 'active';
        }

        html += `
            <div class="track-step">
                <div class="track-dot ${dotClass}">${content}</div>
                <div class="track-label">${labels[i]}</div>
            </div>`;

        if (stepNum < statuses.length) {
            const connDone = !isRejected && stepNum < currentStep;
            html += `<div class="track-connector ${connDone ? 'done' : ''}"></div>`;
        }
    });

    return html;
}

// ── Submit new document request to Firestore ──
async function submitRequest(user, userData, fullName) {
    const selected = document.querySelector('.doc-type-btn.selected');
    if (!selected) return alert('Please select a document type.');

    const purpose = el('purposeSelect')?.value;
    if (!purpose) return alert('Please select a purpose.');

    const notes  = el('notesInput')?.value.trim() || '';
    const docName = selected.dataset.name;
    const ref     = generateRef();

    try {
        await addDoc(collection(db, 'requests'), {
            uid:          user.uid,
            residentName: fullName,
            documentType: docName,
            purpose,
            notes,
            referenceNo:  ref,
            status:       'pending',
            barangay:     userData.barangay || 'Barangay Banicain',
            city:         userData.city     || 'Olongapo City',
            createdAt:    serverTimestamp(),
            readyAt:      null,
            rejectReason: null
        });

        closeModal();
        if (el('successRef')) el('successRef').textContent = `Ref: ${ref}`;
        if (el('successOverlay')) el('successOverlay').classList.add('show');

    } catch (err) {
        console.error('Submit request error:', err);
        alert('Failed to submit request: ' + err.message);
    }
}

// ── Tab filter ──
function filterByStatus(status) {
    const cards = document.querySelectorAll('.request-card');
    let visible = 0;
    cards.forEach(card => {
        const show = status === 'all' || card.dataset.status === status;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    const empty = el('emptyState');
    if (empty) empty.classList.toggle('show', visible === 0);
}

// Expose tab filter for inline onclick in HTML
window.filterTab = function(status, tabEl) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');
    filterByStatus(status);
};

// Expose track toggle for inline onclick in HTML
window.toggleTrack = function(btn) {
    const track = btn.closest('.request-card').querySelector('.progress-track');
    track.classList.toggle('show');
    btn.textContent = track.classList.contains('show') ? 'Hide' : 'Track Progress';
};

// Modal helpers exposed globally (referenced by HTML onclick attributes)
window.openModal = function() {
    const m = el('modalOverlay');
    if (m) m.classList.add('show');
};
window.closeModal = function() {
    const m = el('modalOverlay');
    if (m) m.classList.remove('show');
};
window.closeModalOutside = function(e) {
    if (e.target === el('modalOverlay')) window.closeModal();
};
window.selectDoc = function(btn) {
    document.querySelectorAll('.doc-type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
};
window.closeDone = function() {
    const o = el('successOverlay');
    if (o) o.classList.remove('show');
};

// Map document names to image filenames
function docIcon(name) {
    const map = {
        'Barangay Clearance':           'Icons/barangayclearance.png',
        'Cert. of Residency':           'Icons/certificateofresidency.png',
        'Certificate of Residency':     'Icons/certificateofresidency.png',
        'Cert. of Indigency':           'Icons/certificateofindigency.png',
        'Certificate of Indigency':     'Icons/certificateofindigency.png',
        'Business Clearance':           'Icons/barangaybusinessclearance.png',
        'Barangay Business Clearance':  'Icons/barangaybusinessclearance.png',
        'Job Seeker Cert.':             'Icons/firsttimejobseekercertificate.png',
        'Good Moral Char.':             'Icons/certificateofgoodmoralcharacter.png',
        'Certificate of Good Moral Character': 'Icons/certificateofgoodmoralcharacter.png',
        'Solo Parent Cert.':            'Icons/soloparentcertificate.png',
        'Solo Parent Certificate':      'Icons/soloparentcertificate.png',
        'Working Permit':               'Icons/workingpermit.png'
    };
    return map[name] || 'Icons/barangayclearance.png';
}

// =============================================
// =============================================
// SCAN / VERIFY QR PAGE
// =============================================
// =============================================
function initScanQR(user, userData) {
    const fullName = `${userData.firstName} ${userData.middleName ? userData.middleName.charAt(0) + '. ' : ''}${userData.lastName}`;

    // ── Manual Verify ──
    const verifyBtn = document.querySelector('.verify-btn');
    if (verifyBtn) {
        verifyBtn.addEventListener('click', () => {
            const val = el('refInput')?.value.trim();
            if (!val) return alert('Please enter a reference number.');
            lookupRequest(val, fullName);
        });
    }

    // Enter key on ref input
    el('refInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = el('refInput').value.trim();
            if (val) lookupRequest(val, fullName);
        }
    });

    // ── Camera Simulate (replace with real QR lib if needed) ──
    const camBtn = document.querySelector('.cam-btn');
    if (camBtn) {
        camBtn.addEventListener('click', () => {
            alert('Camera scanning requires a physical device or QR library integration.\nUse Manual Verification to enter a reference number.');
        });
    }
}

// Lookup a request from Firestore by reference number
async function lookupRequest(refNo, currentUserName) {
    try {
        const q = query(
            collection(db, 'requests'),
            where('referenceNo', '==', refNo)
        );
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            showVerifyResult(null, refNo);
            return;
        }

        const data = snapshot.docs[0].data();
        showVerifyResult(data, refNo);

    } catch (err) {
        console.error('Verify error:', err);
        alert('Verification failed: ' + err.message);
    }
}

// Display verification result
function showVerifyResult(data, refNo) {
    const placeholder = el('resultPlaceholder');
    const card        = el('resultCard');

    if (!data) {
        // Not found
        if (placeholder) {
            placeholder.style.display = '';
            placeholder.querySelector('h3').textContent   = 'Not Found';
            placeholder.querySelector('p').textContent    = `No document found for reference "${refNo}". Please check the number and try again.`;
        }
        if (card) card.classList.remove('show');
        return;
    }

    if (placeholder) placeholder.style.display = 'none';
    if (card) {
        card.classList.add('show');

        // Header
        const hTitle = el('resultDocType');
        const hRef   = el('resultRef');
        if (hTitle) hTitle.textContent = data.documentType || '—';
        if (hRef)   hRef.textContent   = `Ref: ${data.referenceNo}`;

        // Badge — show status
        const badge = card.querySelector('.result-badge');
        if (badge) {
            if (data.status === 'ready') {
                badge.style.background = 'var(--green-bg)';
                badge.style.color      = 'var(--green-text)';
                badge.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke="var(--green-text)"><path d="M20 6L9 17l-5-5"/></svg>
                    VERIFIED — Authentic Document`;
            } else if (data.status === 'rejected') {
                badge.style.background = 'var(--red-bg)';
                badge.style.color      = 'var(--red-text)';
                badge.innerHTML        = '✕ REJECTED — Document Not Approved';
            } else {
                badge.style.background = 'var(--yellow-bg)';
                badge.style.color      = 'var(--yellow-text)';
                badge.innerHTML        = '⏳ PENDING — Document Not Yet Issued';
            }
        }

        // Fields
        const rName    = el('rName');
        const rType    = el('rType');
        const rDate    = el('rDate');
        const rValid   = el('rValid');
        const rPurpose = el('rPurpose');
        const rRef     = el('rRef');

        if (rName)    rName.textContent    = data.residentName   || '—';
        if (rType)    rType.textContent    = data.documentType   || '—';
        if (rDate)    rDate.textContent    = data.readyAt ? formatDate(data.readyAt)   : '—';
        if (rValid)   rValid.textContent   = data.readyAt ? validUntil(data.readyAt)   : '—';
        if (rPurpose) rPurpose.textContent = data.purpose        || '—';
        if (rRef)     rRef.textContent     = data.referenceNo    || refNo;

        // Status field
        const statusField = card.querySelector('.result-field:last-child .r-val');
        if (statusField) {
            const statusMap = {
                pending:    { text: 'Pending',             color: 'var(--yellow)' },
                processing: { text: 'Processing',          color: '#1565C0'       },
                ready:      { text: 'Active • Valid',      color: 'var(--green)'  },
                rejected:   { text: 'Rejected',            color: 'var(--red)'    }
            };
            const s = statusMap[data.status] || statusMap.pending;
            statusField.textContent  = s.text;
            statusField.style.color  = s.color;
        }
    }
}

/** Add 1 year to a Firestore timestamp or ISO string */
function validUntil(val) {
    const d = val?.toDate ? val.toDate() : new Date(val);
    d.setFullYear(d.getFullYear() + 1);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}