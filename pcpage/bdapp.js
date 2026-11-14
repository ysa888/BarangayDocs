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
    sendPasswordResetEmail,
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

    // Request changes to name / birthday / sex / civil status / address / residency
    wireInfoChangeRequest(user, userData, fullName);

    // Settings modals — About, Terms & Conditions, Privacy Policy
    wireSettingsModals();
}

// =============================================
// CHANGE PASSWORD  (Account → Settings → Change Password)
// Two ways to change it:
//   1) Know current password  → current > new > confirm  (re-auth + updatePassword)
//   2) Forgot current password → verification link sent to the account email;
//      once the link is opened & verified, the resident sets a new password.
// The modal + its CSS are injected from here, so no HTML edits are needed.
// =============================================
const CPW_MIN_LEN        = 8;    // minimum new-password length
const CPW_RESEND_SECONDS = 60;   // cooldown before the reset link can be resent

const CPW_ICONS = {
    lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    mail:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    eye:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

const CPW_CSS = `
.cpw-overlay{position:fixed;inset:0;background:rgba(15,28,54,.55);backdrop-filter:blur(2px);z-index:600;display:flex;align-items:center;justify-content:center;padding:16px;animation:cpwFade .18s ease}
.cpw-overlay[hidden],.cpw-overlay [hidden]{display:none!important}
.cpw-modal{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow-y:auto;background:var(--card-bg,#fff);border-radius:20px;padding:32px 28px 26px;box-shadow:0 24px 60px rgba(15,28,54,.3);animation:cpwPop .22s ease;font-family:'Nunito',sans-serif}
.cpw-x{position:absolute;top:14px;right:14px;width:34px;height:34px;border:none;border-radius:10px;background:transparent;color:var(--text-light,#9AA5BC);cursor:pointer;display:flex;align-items:center;justify-content:center}
.cpw-x:hover{background:var(--bg,#F0F4FA);color:var(--text-main,#1B3A6B)}
.cpw-x svg{width:18px;height:18px}
.cpw-icon{width:56px;height:56px;border-radius:16px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:var(--bg,#F0F4FA);color:var(--primary-light,#2A5298)}
.cpw-icon svg{width:26px;height:26px}
.cpw-icon.ok{background:var(--green-bg,#D4EDDA);color:var(--green,#28A745)}
.cpw-modal h3{font-family:'Poppins',sans-serif;font-size:20px;font-weight:700;color:var(--text-main,#1B3A6B);text-align:center;margin-bottom:6px}
.cpw-sub{font-size:13.5px;line-height:1.6;color:var(--text-sub,#6B7A99);text-align:center;margin-bottom:22px}
.cpw-sub b{color:var(--text-main,#1B3A6B)}
.cpw-field{margin-bottom:14px}
.cpw-field label{display:block;font-size:12.5px;font-weight:800;color:var(--text-main,#1B3A6B);margin-bottom:6px}
.cpw-input{position:relative}
.cpw-input input{width:100%;height:46px;padding:0 44px 0 14px;border:2px solid var(--border,#D0DCF0);border-radius:12px;font-family:'Nunito',sans-serif;font-size:14px;color:var(--text-main,#1B3A6B);background:#fff;outline:none;transition:border-color .15s,box-shadow .15s}
.cpw-input input:focus{border-color:var(--primary-light,#2A5298);box-shadow:0 0 0 3px rgba(42,82,152,.12)}
.cpw-field.err .cpw-input input{border-color:#DC3545;box-shadow:0 0 0 3px rgba(220,53,69,.1)}
.cpw-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:none;background:transparent;color:var(--text-light,#9AA5BC);cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center}
.cpw-eye:hover{color:var(--primary-light,#2A5298)}
.cpw-eye svg{width:18px;height:18px}
.cpw-ferr{font-size:11.5px;font-weight:700;color:#DC3545;margin-top:5px;min-height:0}
.cpw-meter{display:flex;gap:5px;margin-top:9px}
.cpw-meter i{flex:1;height:5px;border-radius:99px;background:var(--border,#D0DCF0);transition:background .2s}
.cpw-meter[data-lvl="1"] i:nth-child(-n+1){background:#DC3545}
.cpw-meter[data-lvl="2"] i:nth-child(-n+2){background:#F5A623}
.cpw-meter[data-lvl="3"] i:nth-child(-n+3){background:#7BC043}
.cpw-meter[data-lvl="4"] i{background:var(--green,#28A745)}
.cpw-meter-label{font-size:11.5px;font-weight:700;color:var(--text-sub,#6B7A99);margin-top:5px}
.cpw-rules{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}
.cpw-rules li{font-size:12px;font-weight:600;color:var(--text-light,#9AA5BC);display:flex;align-items:center;gap:7px}
.cpw-rules li::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid var(--border,#D0DCF0);flex-shrink:0;transition:all .15s}
.cpw-rules li.ok{color:var(--green-text,#155724)}
.cpw-rules li.ok::before{background:var(--green,#28A745) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center/9px no-repeat;border-color:var(--green,#28A745)}
.cpw-alert{border-radius:12px;padding:11px 14px;font-size:13px;font-weight:700;line-height:1.5;margin-bottom:14px}
.cpw-alert.error{background:var(--red-bg,#F8D7DA);color:var(--red-text,#721C24)}
.cpw-alert.info{background:#E8F1FD;color:var(--primary,#1B3A6B)}
.cpw-btn{width:100%;height:48px;border:none;border-radius:12px;background:var(--primary,#1B3A6B);color:#fff;font-family:'Nunito',sans-serif;font-size:14.5px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background .15s,opacity .15s}
.cpw-btn:hover:not(:disabled){background:var(--primary-light,#2A5298)}
.cpw-btn:disabled{opacity:.6;cursor:not-allowed}
.cpw-btn.ghost{background:transparent;border:2px solid var(--border,#D0DCF0);color:var(--text-sub,#6B7A99)}
.cpw-btn.ghost:hover:not(:disabled){background:var(--bg,#F0F4FA)}
.cpw-link{display:block;margin:14px auto 0;background:none;border:none;font-family:'Nunito',sans-serif;font-size:13px;font-weight:800;color:var(--primary-light,#2A5298);cursor:pointer;padding:4px 8px}
.cpw-link:hover{text-decoration:underline}
.cpw-spin{width:16px;height:16px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cpwSpin .7s linear infinite}
.cpw-emailbox{display:flex;align-items:center;gap:10px;background:var(--bg,#F0F4FA);border:2px solid var(--border,#D0DCF0);border-radius:12px;padding:12px 14px;margin-bottom:16px;font-weight:800;font-size:14px;color:var(--text-main,#1B3A6B);word-break:break-all}
.cpw-emailbox svg{width:18px;height:18px;color:var(--primary-light,#2A5298);flex-shrink:0}
.cpw-steps{list-style:none;counter-reset:s;margin:0 0 18px;padding:0;display:grid;gap:10px}
.cpw-steps li{counter-increment:s;display:flex;gap:11px;align-items:flex-start;font-size:13px;line-height:1.5;color:var(--text-sub,#6B7A99);font-weight:600}
.cpw-steps li::before{content:counter(s);width:22px;height:22px;border-radius:50%;background:var(--primary,#1B3A6B);color:#fff;font-size:11.5px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.cpw-hint{font-size:12px;color:var(--text-light,#9AA5BC);text-align:center;line-height:1.5;margin-top:12px}
@keyframes cpwFade{from{opacity:0}to{opacity:1}}
@keyframes cpwPop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes cpwSpin{to{transform:rotate(360deg)}}
@media(max-width:480px){.cpw-modal{padding:28px 20px 22px}}
`;

function cpwField(id, label, autocomplete) {
    return `
    <div class="cpw-field" id="${id}Field">
        <label for="${id}">${label}</label>
        <div class="cpw-input">
            <input type="password" id="${id}" autocomplete="${autocomplete}" spellcheck="false">
            <button type="button" class="cpw-eye" data-target="${id}" aria-label="Show password">${CPW_ICONS.eye}</button>
        </div>
        <div class="cpw-ferr" id="${id}Err" role="alert"></div>
    </div>`;
}

function cpwMaskEmail(email = '') {
    const [name, domain] = email.split('@');
    if (!domain) return email;
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(name.length - 2, 3))}@${domain}`;
}

function cpwStrength(pw) {
    if (!pw) return { lvl: 0, label: '' };
    let score = 0;
    if (pw.length >= CPW_MIN_LEN) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    if (pw.length < CPW_MIN_LEN) score = Math.min(score, 1);
    const lvl = Math.max(1, Math.min(score, 4));
    return { lvl, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][lvl] };
}

function cpwErrorMessage(err) {
    switch (err?.code) {
        case 'auth/wrong-password':
        case 'auth/invalid-credential':    return { field: 'cpwCurrent', msg: 'Current password is incorrect.' };
        case 'auth/too-many-requests':     return { msg: 'Too many attempts. Please wait a few minutes, or use "Forgot your current password?".' };
        case 'auth/weak-password':         return { field: 'cpwNew', msg: 'That password is too weak. Try a longer one.' };
        case 'auth/requires-recent-login': return { msg: 'For your security, please sign out and sign in again, then retry.' };
        case 'auth/network-request-failed':return { msg: 'No internet connection. Please check your network and try again.' };
        default:                           return { msg: 'Something went wrong. Please try again.' };
    }
}

function wireChangePassword(user) {
    // ── Inject styles + modal once ──
    if (!el('cpwStyles')) {
        const style = document.createElement('style');
        style.id = 'cpwStyles';
        style.textContent = CPW_CSS;
        document.head.appendChild(style);
    }
    if (!el('cpwOverlay')) {
        const wrap = document.createElement('div');
        wrap.id = 'cpwOverlay';
        wrap.className = 'cpw-overlay';
        wrap.hidden = true;
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-labelledby', 'cpwTitle');
        wrap.innerHTML = `
        <div class="cpw-modal">
            <button type="button" class="cpw-x" id="cpwClose" aria-label="Close">${CPW_ICONS.close}</button>
            <div class="cpw-icon" id="cpwIcon"></div>
            <h3 id="cpwTitle"></h3>
            <p class="cpw-sub" id="cpwSub"></p>

            <!-- VIEW 1: change with current password -->
            <form id="cpwViewChange" novalidate>
                ${cpwField('cpwCurrent', 'Current password', 'current-password')}
                ${cpwField('cpwNew', 'New password', 'new-password')}
                <div class="cpw-meter" id="cpwMeter" data-lvl="0"><i></i><i></i><i></i><i></i></div>
                <div class="cpw-meter-label" id="cpwMeterLabel"></div>
                <ul class="cpw-rules" id="cpwRules">
                    <li data-rule="len">At least ${CPW_MIN_LEN} characters</li>
                    <li data-rule="mix">Contains a letter and a number</li>
                    <li data-rule="diff">Different from your current password</li>
                </ul>
                <div style="height:14px"></div>
                ${cpwField('cpwConfirm', 'Confirm new password', 'new-password')}
                <div class="cpw-alert error" id="cpwAlert" role="alert" hidden></div>
                <button type="submit" class="cpw-btn" id="cpwSubmit">Update Password</button>
                <button type="button" class="cpw-link" id="cpwGoForgot">Forgot your current password?</button>
            </form>

            <!-- VIEW 2: forgot → send verification link -->
            <div id="cpwViewForgot">
                <div class="cpw-emailbox">${CPW_ICONS.mail}<span id="cpwEmailMasked"></span></div>
                <div class="cpw-alert error" id="cpwForgotAlert" role="alert" hidden></div>
                <button type="button" class="cpw-btn" id="cpwSend">Send Verification Link</button>
                <button type="button" class="cpw-link" id="cpwBackChange">← I remember my password</button>
            </div>

            <!-- VIEW 3: link sent -->
            <div id="cpwViewSent">
                <ol class="cpw-steps">
                    <li>Open the email we just sent you.</li>
                    <li>Click the verification link inside it.</li>
                    <li>Set your new password on the page that opens.</li>
                    <li>Come back here and sign in with your new password.</li>
                </ol>
                <button type="button" class="cpw-btn" id="cpwDone">Done</button>
                <button type="button" class="cpw-link" id="cpwResend">Resend link</button>
                <p class="cpw-hint">Can't find it? Check your Spam or Promotions folder. The link expires after a short time.</p>
            </div>

            <!-- VIEW 4: success -->
            <div id="cpwViewSuccess">
                <button type="button" class="cpw-btn" id="cpwSuccessClose">Done</button>
            </div>
        </div>`;
        document.body.appendChild(wrap);
    }

    // ── Refs ──
    const overlay   = el('cpwOverlay');
    const views     = { change: el('cpwViewChange'), forgot: el('cpwViewForgot'), sent: el('cpwViewSent'), success: el('cpwViewSuccess') };
    const inCurrent = el('cpwCurrent'), inNew = el('cpwNew'), inConfirm = el('cpwConfirm');
    const submitBtn = el('cpwSubmit'), sendBtn = el('cpwSend'), resendBtn = el('cpwResend');
    let busy = false, resendTimer = null;

    const META = {
        change:  { icon: 'lock',  title: 'Change Password',     sub: 'Enter your current password, then choose a new one.' },
        forgot:  { icon: 'mail',  title: 'Verify It\'s You',    sub: 'We\'ll email a verification link to the address on your account. Open the link to set a new password.' },
        sent:    { icon: 'mail',  title: 'Check Your Email',    sub: '' },
        success: { icon: 'check', title: 'Password Updated',    sub: 'Your password was changed successfully. Use your new password the next time you sign in.' }
    };

    function setView(name) {
        Object.entries(views).forEach(([k, v]) => { v.hidden = k !== name; });
        const m = META[name];
        el('cpwIcon').innerHTML = CPW_ICONS[m.icon];
        el('cpwIcon').classList.toggle('ok', name === 'success');
        el('cpwTitle').textContent = m.title;
        el('cpwSub').innerHTML = name === 'sent'
            ? `A verification link was sent to <b>${cpwMaskEmail(user.email)}</b>.`
            : m.sub;
    }

    function setBusy(btn, on, idleText) {
        busy = on;
        btn.disabled = on;
        btn.innerHTML = on ? '<span class="cpw-spin"></span> Please wait…' : idleText;
    }

    function showAlert(id, msg) { const a = el(id); a.textContent = msg; a.hidden = !msg; }
    function setFieldError(id, msg) {
        el(id + 'Field').classList.toggle('err', !!msg);
        el(id + 'Err').textContent = msg || '';
    }
    function clearErrors() {
        ['cpwCurrent', 'cpwNew', 'cpwConfirm'].forEach(id => setFieldError(id, ''));
        showAlert('cpwAlert', ''); showAlert('cpwForgotAlert', '');
    }

    // Live strength meter + requirement checklist
    function updateStrength() {
        const pw = inNew.value;
        const rules = {
            len:  pw.length >= CPW_MIN_LEN,
            mix:  /[A-Za-z]/.test(pw) && /\d/.test(pw),
            diff: pw.length > 0 && pw !== inCurrent.value
        };
        el('cpwRules').querySelectorAll('li').forEach(li => li.classList.toggle('ok', rules[li.dataset.rule]));
        const s = cpwStrength(pw);
        el('cpwMeter').dataset.lvl = s.lvl;
        el('cpwMeterLabel').textContent = s.label ? `Strength: ${s.label}` : '';
        return rules;
    }

    function resetAll() {
        clearInterval(resendTimer);
        resendTimer = null;
        [inCurrent, inNew, inConfirm].forEach(i => { i.value = ''; i.type = 'password'; });
        overlay.querySelectorAll('.cpw-eye').forEach(b => { b.innerHTML = CPW_ICONS.eye; b.setAttribute('aria-label', 'Show password'); });
        clearErrors();
        updateStrength();
        setBusy(submitBtn, false, 'Update Password');
        setBusy(sendBtn, false, 'Send Verification Link');
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend link';
        busy = false;
    }

    function openModal() {
        resetAll();
        el('cpwEmailMasked').textContent = cpwMaskEmail(user.email);
        setView('change');
        overlay.hidden = false;
        setTimeout(() => inCurrent.focus(), 50);
    }
    function closeModal() {
        if (busy) return;
        overlay.hidden = true;
        resetAll();
    }

    // ── Wire open triggers ──
    const triggers = [];
    document.querySelectorAll('.menu-item').forEach(item => {
        const h4 = item.querySelector('h4');
        if (h4 && h4.textContent.trim() === 'Change Password') triggers.push(item);
    });
    const byId = el('menuChangePassword');
    if (byId && !triggers.includes(byId)) triggers.push(byId);
    triggers.forEach(t => {
        t.style.cursor = 'pointer';
        t.addEventListener('click', openModal);
    });

    // ── Close handlers ──
    el('cpwClose').addEventListener('click', closeModal);
    el('cpwDone').addEventListener('click', closeModal);
    el('cpwSuccessClose').addEventListener('click', closeModal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });

    // ── Show / hide password toggles ──
    overlay.querySelectorAll('.cpw-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = el(btn.dataset.target);
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.innerHTML = show ? CPW_ICONS.eyeOff : CPW_ICONS.eye;
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });
    });

    // ── Live feedback ──
    inCurrent.addEventListener('input', () => { setFieldError('cpwCurrent', ''); showAlert('cpwAlert', ''); updateStrength(); });
    inNew.addEventListener('input',     () => { setFieldError('cpwNew', ''); updateStrength(); if (inConfirm.value) setFieldError('cpwConfirm', inConfirm.value === inNew.value ? '' : 'Passwords do not match.'); });
    inConfirm.addEventListener('input', () => setFieldError('cpwConfirm', inConfirm.value && inConfirm.value !== inNew.value ? 'Passwords do not match.' : ''));

    // ── Switch between flows ──
    el('cpwGoForgot').addEventListener('click',   () => { clearErrors(); setView('forgot'); });
    el('cpwBackChange').addEventListener('click', () => { clearErrors(); setView('change'); setTimeout(() => inCurrent.focus(), 50); });

    // ── FLOW 1: current password → new password ──
    views.change.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        clearErrors();

        const current = inCurrent.value, newPw = inNew.value, confirmPw = inConfirm.value;
        const rules = updateStrength();
        let firstBad = null;

        if (!current)                       { setFieldError('cpwCurrent', 'Please enter your current password.'); firstBad = firstBad || inCurrent; }
        if (!rules.len)                     { setFieldError('cpwNew', `Password must be at least ${CPW_MIN_LEN} characters.`); firstBad = firstBad || inNew; }
        else if (!rules.mix)                { setFieldError('cpwNew', 'Include at least one letter and one number.'); firstBad = firstBad || inNew; }
        else if (newPw === current)         { setFieldError('cpwNew', 'New password must be different from your current one.'); firstBad = firstBad || inNew; }
        if (!confirmPw)                     { setFieldError('cpwConfirm', 'Please confirm your new password.'); firstBad = firstBad || inConfirm; }
        else if (confirmPw !== newPw)       { setFieldError('cpwConfirm', 'Passwords do not match.'); firstBad = firstBad || inConfirm; }
        if (firstBad) { firstBad.focus(); return; }

        setBusy(submitBtn, true);
        try {
            const credential = EmailAuthProvider.credential(user.email, current);
            await reauthenticateWithCredential(user, credential);
            await updatePassword(user, newPw);
            setView('success');
            [inCurrent, inNew, inConfirm].forEach(i => { i.value = ''; });
        } catch (err) {
            console.error('Change password failed:', err);
            const { field, msg } = cpwErrorMessage(err);
            if (field) { setFieldError(field, msg); el(field).focus(); }
            else showAlert('cpwAlert', msg);
        } finally {
            setBusy(submitBtn, false, 'Update Password');
        }
    });

    // ── FLOW 2: forgot → email verification link ──
    function startResendCooldown() {
        let left = CPW_RESEND_SECONDS;
        resendBtn.disabled = true;
        resendBtn.textContent = `Resend link in ${left}s`;
        clearInterval(resendTimer);
        resendTimer = setInterval(() => {
            left--;
            if (left <= 0) {
                clearInterval(resendTimer);
                resendBtn.disabled = false;
                resendBtn.textContent = 'Resend link';
            } else {
                resendBtn.textContent = `Resend link in ${left}s`;
            }
        }, 1000);
    }

    async function sendResetLink(fromSentView) {
        if (busy) return false;
        showAlert('cpwForgotAlert', '');
        if (!fromSentView) setBusy(sendBtn, true);
        try {
            try {
                // After the reset, offer a way back to the login page
                await sendPasswordResetEmail(auth, user.email, {
                    url: new URL('barangaydocs_login.html', window.location.href).href
                });
            } catch (err) {
                // Domain not whitelisted in Firebase → fall back to the default email
                if (err?.code === 'auth/unauthorized-continue-uri' || err?.code === 'auth/invalid-continue-uri') {
                    await sendPasswordResetEmail(auth, user.email);
                } else throw err;
            }
            setView('sent');
            startResendCooldown();
            return true;
        } catch (err) {
            console.error('Send reset email failed:', err);
            const msg = err?.code === 'auth/too-many-requests'
                ? 'Too many requests. Please wait a few minutes and try again.'
                : err?.code === 'auth/network-request-failed'
                    ? 'No internet connection. Please check your network and try again.'
                    : 'We couldn\'t send the email. Please try again.';
            if (fromSentView) { setView('forgot'); }
            showAlert('cpwForgotAlert', msg);
            return false;
        } finally {
            if (!fromSentView) setBusy(sendBtn, false, 'Send Verification Link');
        }
    }

    sendBtn.addEventListener('click',   () => sendResetLink(false));
    resendBtn.addEventListener('click', () => sendResetLink(true));
}

// =============================================
// REQUEST INFORMATION CHANGE  (Account → Personal Information)
// Residents can't edit identity details directly. They tick what they want
// to change, fill in the new values, give a reason, and submit ONE request.
// Staff review it (old → new) in `profileChangeRequests`; nothing on the
// resident record changes until a request is approved.
// Not changeable here: email, contact number (and barangay / city / province).
// =============================================
const ICR_COLLECTION = 'profileChangeRequests';

const ICR_CSS = `
.icr-modal{max-width:520px}
.icr-intro{font-size:12.5px;color:var(--text-sub,#6B7A99);background:var(--bg,#F0F4FA);border-radius:12px;padding:10px 14px;margin-bottom:16px;line-height:1.55;font-weight:600}
.icr-opt{border:2px solid var(--border,#D0DCF0);border-radius:14px;margin-bottom:10px;background:#fff;transition:border-color .15s,box-shadow .15s}
.icr-opt.on{border-color:var(--primary-light,#2A5298);box-shadow:0 0 0 3px rgba(42,82,152,.08)}
.icr-head{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;user-select:none}
.icr-head input{width:18px;height:18px;accent-color:var(--primary,#1B3A6B);flex-shrink:0;cursor:pointer}
.icr-title{font-size:14px;font-weight:800;color:var(--text-main,#1B3A6B);white-space:nowrap}
.icr-cur{font-size:12px;font-weight:600;color:var(--text-light,#9AA5BC);margin-left:auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.icr-body{padding:2px 14px 12px}
.icr-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.icr-body .cpw-field{margin-bottom:10px}
.icr-plain input,.icr-plain select{width:100%;height:44px;padding:0 14px;border:2px solid var(--border,#D0DCF0);border-radius:12px;font-family:'Nunito',sans-serif;font-size:14px;color:var(--text-main,#1B3A6B);background:#fff;outline:none}
.icr-plain input:focus,.icr-plain select:focus,.icr-textarea:focus{border-color:var(--primary-light,#2A5298);box-shadow:0 0 0 3px rgba(42,82,152,.12)}
.icr-textarea{width:100%;min-height:78px;padding:11px 14px;border:2px solid var(--border,#D0DCF0);border-radius:12px;font-family:'Nunito',sans-serif;font-size:14px;color:var(--text-main,#1B3A6B);resize:vertical;outline:none}
.cpw-field.err .icr-plain input,.cpw-field.err .icr-plain select,.cpw-field.err .icr-textarea{border-color:#DC3545}
.icr-fixed{font-size:12px;font-weight:700;color:var(--text-sub,#6B7A99);background:var(--bg,#F0F4FA);border-radius:10px;padding:9px 12px}
.icr-btns{display:flex;gap:10px;margin-top:6px}
.icr-btns .cpw-btn{flex:1}
.icr-hint{font-size:12px;font-weight:600;color:var(--text-sub,#6B7A99);background:var(--bg,#F0F4FA);border-radius:10px;padding:9px 12px;margin-bottom:10px;line-height:1.55}
.icr-hint b{color:var(--text-main,#1B3A6B)}
.icr-drop{width:100%;height:46px;border:2px dashed var(--border,#D0DCF0);border-radius:12px;background:transparent;color:var(--primary-light,#2A5298);font-family:'Nunito',sans-serif;font-size:13.5px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.icr-drop svg{width:18px;height:18px}
.icr-drop:hover:not(:disabled){background:var(--bg,#F0F4FA);border-color:var(--primary-light,#2A5298)}
.icr-drop:disabled{opacity:.5;cursor:not-allowed}
.cpw-field.err .icr-drop{border-color:#DC3545}
.icr-thumbs{display:grid;gap:8px;margin-top:10px}
.icr-thumb{display:flex;align-items:center;gap:12px;border:2px solid var(--border,#D0DCF0);border-radius:12px;padding:8px 10px}
.icr-thumb img{width:48px;height:48px;object-fit:cover;border-radius:8px;flex-shrink:0;background:var(--bg,#F0F4FA)}
.icr-thumb .tn{flex:1;min-width:0}
.icr-thumb .tn div:first-child{font-size:13px;font-weight:800;color:var(--text-main,#1B3A6B);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icr-thumb .tn div:last-child{font-size:11.5px;font-weight:600;color:var(--text-light,#9AA5BC)}
.icr-thumb button{border:none;background:transparent;color:#DC3545;font-family:'Nunito',sans-serif;font-size:12.5px;font-weight:800;cursor:pointer;padding:6px 8px;border-radius:8px}
.icr-thumb button:hover{background:var(--red-bg,#F8D7DA)}
.icr-banner{border-radius:14px;padding:12px 16px;font-size:13px;font-weight:700;line-height:1.5;margin-top:14px}
.icr-banner.pending{background:var(--yellow-bg,#FFF3CD);color:var(--yellow-text,#856404)}
.icr-banner.rejected{background:var(--red-bg,#F8D7DA);color:var(--red-text,#721C24)}
.icr-banner small{display:block;font-weight:600;margin-top:2px;opacity:.9}
.icr-trigger{margin-top:14px;width:100%;height:46px;border:2px solid var(--primary-light,#2A5298);background:transparent;color:var(--primary-light,#2A5298);border-radius:12px;font-family:'Nunito',sans-serif;font-size:14px;font-weight:800;cursor:pointer}
.icr-trigger:hover:not(:disabled){background:var(--primary-light,#2A5298);color:#fff}
.icr-trigger:disabled{opacity:.55;cursor:not-allowed}
@media(max-width:480px){.icr-row{grid-template-columns:1fr}.icr-cur{display:none}}
`;

CPW_ICONS.edit = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

CPW_ICONS.upload = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

const ICR_MAX_PROOFS     = 2;        // photos per request
const ICR_MAX_PROOF_CHARS = 380000;  // per compressed photo (keeps the request under Firestore's 1 MB doc limit)
const ICR_MAX_ORIGINAL   = 10 * 1024 * 1024;

/** Shrink a photo in the browser → JPEG data URL under ICR_MAX_PROOF_CHARS */
async function icrCompress(file) {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode'));
        i.src = url;
    }).finally(() => URL.revokeObjectURL(url));

    let maxSide = 1400, quality = 0.75;
    for (let i = 0; i < 7; i++) {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', quality);
        if (out.length <= ICR_MAX_PROOF_CHARS) return out;
        quality = Math.max(0.5, quality - 0.08);
        maxSide = Math.round(maxSide * 0.8);
    }
    throw new Error('too_large');
}

const ICR_NAME_RE = /^[\p{L}][\p{L}\s.'’-]*$/u;

function icrInput(id, label, type = 'text', extra = '') {
    return `
    <div class="cpw-field" id="${id}Field">
        <label for="${id}">${label}</label>
        <div class="cpw-input icr-plain"><input type="${type}" id="${id}" ${extra}></div>
    </div>`;
}

function icrGroup(key, label, body) {
    return `
    <div class="icr-opt" id="icrOpt_${key}">
        <label class="icr-head">
            <input type="checkbox" id="icrChk_${key}">
            <span class="icr-title">${label}</span>
            <span class="icr-cur" id="icrCur_${key}"></span>
        </label>
        <div class="icr-body" id="icrBody_${key}" hidden>
            ${body}
            <div class="cpw-ferr" id="icrErr_${key}" role="alert"></div>
        </div>
    </div>`;
}

function wireInfoChangeRequest(user, userData, fullName) {
    // Reuse shared modal styles from the change-password module, plus ours
    if (!el('cpwStyles')) {
        const s = document.createElement('style'); s.id = 'cpwStyles'; s.textContent = CPW_CSS; document.head.appendChild(s);
    }
    if (!el('icrStyles')) {
        const s = document.createElement('style'); s.id = 'icrStyles'; s.textContent = ICR_CSS; document.head.appendChild(s);
    }
    if (el('icrOverlay')) return;

    // ── Current values (residency field name differs between versions → detect) ──
    const resKey = ['yearsOfResidency', 'yearsResidency', 'years_of_residency', 'residency', 'residencyYears']
        .find(k => userData[k] !== undefined && userData[k] !== null && userData[k] !== '') || 'yearsOfResidency';
    const cur = {
        firstName:   userData.firstName   || '',
        middleName:  userData.middleName  || '',
        lastName:    userData.lastName    || '',
        birthday:    userData.birthday    || '',
        sex:         userData.sex         || '',
        civilStatus: userData.civilStatus || '',
        houseNumber: userData.houseNumber || '',
        [resKey]:    userData[resKey] ?? ''
    };
    const today = new Date().toISOString().split('T')[0];
    const prettyDate = (v) => {
        const d = v ? new Date(v) : null;
        return d && !isNaN(d) ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Not provided';
    };

    // ── Groups: one checkbox each; `read` validates + returns the new values ──
    const GROUPS = [
        {
            key: 'name', label: 'Name', proof: 'required', hint: 'Valid ID, birth certificate or marriage certificate', keys: ['firstName', 'middleName', 'lastName'],
            summary: () => [cur.firstName, cur.middleName, cur.lastName].filter(Boolean).join(' ') || '—',
            read() {
                const v = { firstName: el('icrFirst').value.trim().replace(/\s+/g, ' '), middleName: el('icrMiddle').value.trim().replace(/\s+/g, ' '), lastName: el('icrLast').value.trim().replace(/\s+/g, ' ') };
                if (!v.firstName || !v.lastName) return { error: 'First name and last name are required.' };
                if (!ICR_NAME_RE.test(v.firstName) || !ICR_NAME_RE.test(v.lastName) || (v.middleName && !ICR_NAME_RE.test(v.middleName)))
                    return { error: 'Names can only contain letters, spaces, hyphens, apostrophes and periods.' };
                return { values: v };
            }
        },
        {
            key: 'birthday', label: 'Date of Birth', proof: 'required', hint: 'Birth certificate or a valid ID showing your birth date', keys: ['birthday'],
            summary: () => prettyDate(cur.birthday),
            read() {
                const v = el('icrBirthday').value;
                if (!v) return { error: 'Please enter your date of birth.' };
                if (v > today || v < '1900-01-01') return { error: 'Please enter a valid date of birth.' };
                return { values: { birthday: v } };
            }
        },
        {
            key: 'sex', label: 'Sex', proof: 'required', hint: 'Birth certificate or valid ID', keys: ['sex'],
            summary: () => cur.sex || 'Not provided',
            read() {
                const v = el('icrSex').value;
                return v ? { values: { sex: v } } : { error: 'Please select an option.' };
            }
        },
        {
            key: 'civil', label: 'Civil Status', proof: 'required', hint: 'Marriage certificate (or death certificate of spouse)', keys: ['civilStatus'],
            summary: () => cur.civilStatus || 'Not provided',
            read() {
                const v = el('icrCivil').value;
                return v ? { values: { civilStatus: v } } : { error: 'Please select an option.' };
            }
        },
        {
            key: 'address', label: 'Home Address', proof: 'optional', hint: 'Utility bill, lease or valid ID showing the new address', keys: ['houseNumber'],
            summary: () => cur.houseNumber || 'Not provided',
            read() {
                const v = el('icrHouse').value.trim().replace(/\s+/g, ' ');
                return v.length >= 3 ? { values: { houseNumber: v } } : { error: 'Please enter your house no. / street.' };
            }
        },
        {
            key: 'residency', label: 'Years of Residency', proof: 'optional', hint: 'Any document showing how long you have lived here', keys: [resKey],
            summary: () => cur[resKey] !== '' ? `${cur[resKey]} year(s)` : 'Not provided',
            read() {
                const raw = el('icrYears').value.trim();
                const n = Number(raw);
                if (raw === '' || !Number.isInteger(n) || n < 0 || n > 120) return { error: 'Enter a whole number from 0 to 120.' };
                return { values: { [resKey]: n } };
            }
        }
    ];

    // ── Build modal ──
    const wrap = document.createElement('div');
    wrap.id = 'icrOverlay';
    wrap.className = 'cpw-overlay';
    wrap.hidden = true;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'icrTitle');
    wrap.innerHTML = `
    <div class="cpw-modal icr-modal">
        <button type="button" class="cpw-x" id="icrClose" aria-label="Close">${CPW_ICONS.close}</button>
        <div class="cpw-icon" id="icrIcon"></div>
        <h3 id="icrTitle">Request Information Change</h3>
        <p class="cpw-sub" id="icrSub">Tick what you want to update. Barangay staff will review your request before anything is changed.</p>

        <form id="icrForm" novalidate>
            ${icrGroup('name', 'Name', `
                <div class="icr-row">
                    ${icrInput('icrFirst', 'First name', 'text', 'autocomplete="off"')}
                    ${icrInput('icrLast', 'Last name', 'text', 'autocomplete="off"')}
                </div>
                ${icrInput('icrMiddle', 'Middle name <span style="font-weight:600;color:var(--text-light)">(optional)</span>', 'text', 'autocomplete="off"')}`)}
            ${icrGroup('birthday', 'Date of Birth', icrInput('icrBirthday', 'New date of birth', 'date', `max="${today}"`))}
            ${icrGroup('sex', 'Sex', `
                <div class="cpw-field" id="icrSexField"><label for="icrSex">New value</label>
                <div class="cpw-input icr-plain"><select id="icrSex"><option value="">Select</option><option>Male</option><option>Female</option></select></div></div>`)}
            ${icrGroup('civil', 'Civil Status', `
                <div class="cpw-field" id="icrCivilField"><label for="icrCivil">New value</label>
                <div class="cpw-input icr-plain"><select id="icrCivil"><option value="">Select</option><option>Single</option><option>Married</option><option>Widowed</option></select></div></div>`)}
            ${icrGroup('address', 'Home Address', `
                ${icrInput('icrHouse', 'House No. / Street', 'text', 'autocomplete="off"')}
                <div class="icr-fixed">Barangay Banicain, Olongapo City, Zambales</div>`)}
            ${icrGroup('residency', 'Years of Residency', icrInput('icrYears', 'Years of residency', 'number', 'min="0" max="120" step="1" inputmode="numeric"'))}

            <div class="cpw-field" id="icrProofField" style="margin-top:16px" hidden>
                <label>Supporting document <span id="icrProofReq" style="font-weight:600;color:var(--text-light)"></span></label>
                <div class="icr-hint" id="icrProofHint"></div>
                <input type="file" id="icrProofFile" accept="image/*" multiple hidden>
                <button type="button" class="icr-drop" id="icrProofBtn">${CPW_ICONS.upload}<span id="icrProofBtnTxt">Add photo of document</span></button>
                <div class="icr-thumbs" id="icrThumbs"></div>
                <div class="cpw-ferr" id="icrProofErr" role="alert"></div>
            </div>

            <div class="cpw-field" id="icrReasonField" style="margin-top:16px" hidden>
                <label for="icrReason">Reason for the change</label>
                <textarea id="icrReason" class="icr-textarea" maxlength="300" placeholder="e.g. Corrected spelling of my surname, I got married, I moved to a new house…"></textarea>
                <div class="cpw-ferr" id="icrReasonErr" role="alert"></div>
            </div>

            <div class="cpw-alert error" id="icrAlert" role="alert" hidden></div>
            <div class="icr-btns">
                <button type="button" class="cpw-btn ghost" id="icrCancel">Cancel</button>
                <button type="submit" class="cpw-btn" id="icrSubmit">Submit Request</button>
            </div>
        </form>

        <div id="icrViewDone" hidden>
            <button type="button" class="cpw-btn" id="icrDone">Done</button>
        </div>
    </div>`;
    document.body.appendChild(wrap);

    // ── Refs / state ──
    const form = el('icrForm'), viewDone = el('icrViewDone'), submitBtn = el('icrSubmit');
    let busy = false, hasPending = false, processing = false;
    let proofs = [];   // [{ name, size, dataUrl }]

    const setIcon = (name, ok = false) => { el('icrIcon').innerHTML = CPW_ICONS[name]; el('icrIcon').classList.toggle('ok', ok); };
    const setErr = (key, msg) => { el('icrErr_' + key).textContent = msg || ''; };
    const showAlert = (msg) => { const a = el('icrAlert'); a.textContent = msg || ''; a.hidden = !msg; };
    const selectedGroups = () => GROUPS.filter(g => el('icrChk_' + g.key).checked);

    function renderThumbs() {
        const box = el('icrThumbs');
        box.innerHTML = '';
        proofs.forEach((p, i) => {
            const row = document.createElement('div'); row.className = 'icr-thumb';
            const img = document.createElement('img'); img.src = p.dataUrl; img.alt = 'Document preview';
            const tn = document.createElement('div'); tn.className = 'tn';
            const n1 = document.createElement('div'); n1.textContent = p.name;
            const n2 = document.createElement('div'); n2.textContent = Math.max(1, Math.round(p.size / 1024)) + ' KB';
            tn.append(n1, n2);
            const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Remove';
            rm.addEventListener('click', () => { proofs.splice(i, 1); renderThumbs(); });
            row.append(img, tn, rm);
            box.appendChild(row);
        });
        const full = proofs.length >= ICR_MAX_PROOFS;
        el('icrProofBtn').disabled = full;
        el('icrProofBtnTxt').textContent = full ? `Maximum of ${ICR_MAX_PROOFS} photos added`
            : proofs.length ? 'Add another photo' : 'Add photo of document';
    }

    function updateProofUI() {
        const sel = selectedGroups();
        el('icrProofField').hidden = sel.length === 0;
        el('icrProofReq').textContent = sel.some(g => g.proof === 'required') ? '(required)' : '(optional)';
        const hint = el('icrProofHint');
        hint.innerHTML = '';
        sel.forEach(g => {
            const d = document.createElement('div');
            const b = document.createElement('b'); b.textContent = g.label + ': ';
            d.append(b, document.createTextNode(g.hint));
            hint.appendChild(d);
        });
    }

    function updateSubmitLabel() {
        const n = selectedGroups().length;
        updateProofUI();
        el('icrReasonField').hidden = n === 0;
        submitBtn.textContent = n > 1 ? `Submit Request (${n} changes)` : 'Submit Request';
    }

    function resetForm() {
        // Pre-fill with the CURRENT values so residents only edit what's wrong
        el('icrFirst').value = cur.firstName;  el('icrMiddle').value = cur.middleName;  el('icrLast').value = cur.lastName;
        el('icrBirthday').value = cur.birthday ? String(cur.birthday).slice(0, 10) : '';
        el('icrSex').value = cur.sex;  el('icrCivil').value = cur.civilStatus;
        el('icrHouse').value = cur.houseNumber;  el('icrYears').value = cur[resKey];
        el('icrReason').value = '';
        proofs = []; processing = false; renderThumbs();
        el('icrProofErr').textContent = ''; el('icrProofField').classList.remove('err');
        GROUPS.forEach(g => {
            el('icrChk_' + g.key).checked = false;
            el('icrBody_' + g.key).hidden = true;
            el('icrOpt_' + g.key).classList.remove('on');
            el('icrCur_' + g.key).textContent = 'Current: ' + g.summary();
            setErr(g.key, '');
        });
        ['icrFirst', 'icrLast', 'icrMiddle', 'icrBirthday', 'icrHouse', 'icrYears', 'icrSex', 'icrCivil'].forEach(id => el(id + 'Field')?.classList.remove('err'));
        el('icrReasonField').classList.remove('err'); el('icrReasonErr').textContent = '';
        showAlert('');
        updateSubmitLabel();
        submitBtn.disabled = false;
        busy = false;
    }

    function openModal() {
        if (hasPending) return;
        resetForm();
        setIcon('edit');
        el('icrTitle').textContent = 'Request Information Change';
        el('icrSub').textContent = 'Tick what you want to update. Barangay staff will review your request before anything is changed.';
        form.hidden = false; viewDone.hidden = true;
        wrap.hidden = false;
    }
    function closeModal() { if (busy) return; wrap.hidden = true; }

    // ── Events ──
    GROUPS.forEach(g => {
        el('icrChk_' + g.key).addEventListener('change', (e) => {
            el('icrBody_' + g.key).hidden = !e.target.checked;
            el('icrOpt_' + g.key).classList.toggle('on', e.target.checked);
            setErr(g.key, ''); showAlert('');
            updateSubmitLabel();
            if (e.target.checked) el('icrBody_' + g.key).querySelector('input,select')?.focus();
        });
    });
    el('icrClose').addEventListener('click', closeModal);
    el('icrCancel').addEventListener('click', closeModal);
    el('icrDone').addEventListener('click', closeModal);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) closeModal(); });
    el('icrProofBtn').addEventListener('click', () => el('icrProofFile').click());
    el('icrProofFile').addEventListener('change', async (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        const perr = el('icrProofErr');
        perr.textContent = '';
        el('icrProofField').classList.remove('err');
        for (const f of files) {
            if (proofs.length >= ICR_MAX_PROOFS) { perr.textContent = `You can attach up to ${ICR_MAX_PROOFS} photos.`; break; }
            if (!f.type.startsWith('image/'))   { perr.textContent = 'Please choose a photo (JPG or PNG).'; continue; }
            if (f.size > ICR_MAX_ORIGINAL)      { perr.textContent = 'That photo is over 10 MB. Please choose a smaller one.'; continue; }
            processing = true;
            submitBtn.disabled = true;
            el('icrProofBtnTxt').textContent = 'Preparing photo…';
            try {
                const dataUrl = await icrCompress(f);
                proofs.push({ name: f.name, size: Math.round(dataUrl.length * 0.75), dataUrl });
            } catch (err) {
                console.error('Proof photo failed:', err);
                perr.textContent = 'We couldn\'t read that photo. Try a JPG or PNG.';
            }
        }
        processing = false;
        submitBtn.disabled = false;
        renderThumbs();
    });
    el('icrReason').addEventListener('input', () => { el('icrReasonField').classList.remove('err'); el('icrReasonErr').textContent = ''; });

    // ── Submit: validate every ticked group, then create ONE request ──
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        if (processing) return showAlert('Please wait, your photo is still being prepared.');
        showAlert('');
        el('icrProofErr').textContent = ''; el('icrProofField').classList.remove('err');
        GROUPS.forEach(g => setErr(g.key, ''));
        el('icrReasonField').classList.remove('err'); el('icrReasonErr').textContent = '';

        const selected = selectedGroups();
        if (!selected.length) return showAlert('Tick at least one item you want to change.');

        const updates = {}, previous = {}, changedFields = [];
        let firstBad = null;
        for (const g of selected) {
            const r = g.read();
            if (r.error) { setErr(g.key, r.error); firstBad = firstBad || g.key; continue; }
            const same = g.keys.every(k => String(r.values[k] ?? '').trim() === String(cur[k] ?? '').trim());
            if (same) { setErr(g.key, 'This is the same as your current information.'); firstBad = firstBad || g.key; continue; }
            g.keys.forEach(k => { updates[k] = r.values[k]; previous[k] = cur[k] ?? ''; });
            changedFields.push(g.label);
        }
        const needProof = selected.some(g => g.proof === 'required');
        if (needProof && !proofs.length) {
            el('icrProofField').classList.add('err');
            el('icrProofErr').textContent = 'Please attach a photo of a supporting document.';
            firstBad = firstBad || 'proof';
        }
        const reason = el('icrReason').value.trim();
        if (reason.length < 10) {
            el('icrReasonField').classList.add('err');
            el('icrReasonErr').textContent = 'Please tell us why (at least 10 characters).';
            firstBad = firstBad || 'reason';
        }
        if (firstBad) {
            (firstBad === 'reason' ? el('icrReason') : firstBad === 'proof' ? el('icrProofBtn') : el('icrBody_' + firstBad).querySelector('input,select'))?.focus();
            return;
        }

        busy = true; submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="cpw-spin"></span> Submitting…';
        try {
            // Guard against a second pending request (e.g. from another tab)
            const dup = await getDocs(query(collection(db, ICR_COLLECTION), where('uid', '==', user.uid), where('status', '==', 'pending')));
            if (!dup.empty) { hasPending = true; busy = false; closeModal(); return; }

            await addDoc(collection(db, ICR_COLLECTION), {
                uid: user.uid,
                email: user.email,
                residentName: fullName,
                status: 'pending',
                changedFields,
                updates,
                previous,
                reason,
                proofRequired: needProof,
                proof: proofs.map(p => ({ name: p.name, type: 'image/jpeg', size: p.size, dataUrl: p.dataUrl })),
                createdAt: serverTimestamp()
            });
            busy = false;
            setIcon('check', true);
            el('icrTitle').textContent = 'Request Submitted';
            el('icrSub').textContent = `Your request to change ${changedFields.join(', ')} was sent to the barangay for review. You can track its status on this page.`;
            form.hidden = true; viewDone.hidden = false;
        } catch (err) {
            console.error('Info change request failed:', err);
            showAlert(err?.code === 'permission-denied'
                ? 'You don\'t have permission to submit this request. Please contact the barangay office.'
                : 'We couldn\'t submit your request. Please check your connection and try again.');
        } finally {
            busy = false;
            submitBtn.disabled = false;
            updateSubmitLabel();
        }
    });

    // ── Entry point: button + live status banner on the Account page ──
    let trigger = el('requestInfoChangeBtn');
    let banner  = el('icrBanner');
    if (!trigger) {
        const host = el('infoFullName')?.closest('[class*="card"], [class*="section"]') || document.querySelector('.content, main');
        if (host) {
            banner = document.createElement('div'); banner.id = 'icrBanner'; banner.hidden = true;
            trigger = document.createElement('button');
            trigger.type = 'button'; trigger.id = 'requestInfoChangeBtn'; trigger.className = 'icr-trigger';
            trigger.textContent = 'Request Information Change';
            host.appendChild(banner); host.appendChild(trigger);
        }
    }
    if (trigger) trigger.addEventListener('click', openModal);

    // Live status of the resident's latest request
    onSnapshot(query(collection(db, ICR_COLLECTION), where('uid', '==', user.uid)), (snap) => {
        const reqs = snap.docs.map(d => d.data())
            .sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
        const latest = reqs[0];
        hasPending = latest?.status === 'pending';
        if (trigger) {
            trigger.disabled = hasPending;
            trigger.textContent = hasPending ? 'Request Pending Review' : 'Request Information Change';
        }
        if (!banner) return;
        if (latest && (latest.status === 'pending' || latest.status === 'rejected')) {
            const what = (latest.changedFields || []).join(', ');
            banner.hidden = false;
            banner.className = 'icr-banner ' + latest.status;
            banner.innerHTML = '';
            const line = document.createElement('div');
            line.textContent = latest.status === 'pending'
                ? `Your request to change ${what} is waiting for staff review.`
                : `Your request to change ${what} was not approved.`;
            banner.appendChild(line);
            if (latest.status === 'rejected' && latest.adminNote) {
                const note = document.createElement('small');
                note.textContent = 'Reason: ' + latest.adminNote;
                banner.appendChild(note);
            }
        } else {
            banner.hidden = true;
        }
    }, (err) => console.error('Info change status listener failed:', err));
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
            if (['approved', 'ready', 'released'].includes(data.status)) {
                badge.style.background = 'var(--green-bg)';
                badge.style.color      = 'var(--green-text)';
                badge.innerHTML        = '✓ VERIFIED — Authentic Document';
            } else if (data.status === 'rejected') {
                badge.style.background = 'var(--red-bg)';
                badge.style.color      = 'var(--red-text)';
                badge.innerHTML        = '✕ REJECTED — Document Not Approved';
            } else {
                badge.style.background = 'var(--yellow-bg)';
                badge.style.color      = 'var(--yellow-text)';
                badge.innerHTML        = '○ PENDING — Document Not Yet Issued';
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
                approved:   { text: 'Active • Valid',      color: 'var(--green)'  },
                ready:      { text: 'Active • Valid',      color: 'var(--green)'  },
                released:   { text: 'Active • Valid',      color: 'var(--green)'  },
                rejected:   { text: 'Rejected',            color: 'var(--red)'    }
            };
            const s = statusMap[data.status] || statusMap.pending;
            statusField.textContent  = s.text;
            statusField.style.color  = s.color;
        }

        // Timeline — Processing step
        const tProc = el('timeProcessing');
        if (tProc && ['processing', 'approved', 'ready', 'released'].includes(data.status)) {
            const when = data.processedAt || data.approvedAt || data.readyAt || data.updatedAt;
            tProc.textContent = when ? formatDate(when) : 'Done';
            tProc.classList.remove('pending-txt');
        }

        // Timeline — Ready for Pickup step
        if (['ready', 'released'].includes(data.status)) {
            const lblReady  = el('lblReady');
            const timeReady = el('timeReady');
            if (lblReady) lblReady.classList.remove('muted');
            if (timeReady) {
                timeReady.textContent = data.readyAt ? formatDate(data.readyAt) : 'Done';
                timeReady.classList.remove('pending-txt');
            }
        }
    }
}

/** Add 1 year to a Firestore timestamp or ISO string */
function validUntil(val) {
    const d = val?.toDate ? val.toDate() : new Date(val);
    d.setFullYear(d.getFullYear() + 1);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}