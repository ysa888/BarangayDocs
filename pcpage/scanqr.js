// ============================================================
// scanqr.js — Standalone script for BarangayDocs Scan / Verify QR page
// Does NOT depend on bdapp.js
// ============================================================

import { initializeApp }   from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
                           from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, getDocs }
                           from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// ── Firebase config (same project) ──────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain:        "barangaydocs-df957.firebaseapp.com",
    projectId:         "barangaydocs-df957",
    storageBucket:     "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId:             "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId:     "G-YG0Y575BRD"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const el = (id) => document.getElementById(id);

// ── Helpers ──────────────────────────────────────────────────

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
}

function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateTime(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    const date = d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const time = d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${date} at ${time}`;
}

function validUntil(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    d.setFullYear(d.getFullYear() + 1);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Auth Guard ───────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'barangaydocs_login.html';
        return;
    }

    const userDoc = await getDoc(doc(db, 'residents', user.uid));
    if (!userDoc.exists()) {
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
        return;
    }

    const userData = userDoc.data();

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
    if (userData.role === 'admin') {
        window.location.href = 'barangaydocs_admin.html';
        return;
    }

    populateSidebar(userData);
    initVerifyPage(user, userData);
});

// ── Sidebar ──────────────────────────────────────────────────

function populateSidebar(userData) {
    const fullName = `${userData.firstName}${userData.middleName ? ' ' + userData.middleName.charAt(0) + '.' : ''} ${userData.lastName}`;

    document.querySelectorAll('.user-avatar').forEach(av => av.textContent = getInitials(fullName));
    document.querySelectorAll('.user-name').forEach(n  => n.textContent  = fullName);
    document.querySelectorAll('.user-role').forEach(r  => r.textContent  = 'Resident • Barangay Banicain');
}

// ── Logout ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.logout-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const modal = el('logoutModal');
            if (modal) modal.classList.add('show');
            else       await doLogout();
        });
    });

    document.querySelectorAll('.btn-logout').forEach(btn => {
        btn.addEventListener('click', async () => await doLogout());
    });
});

async function doLogout() {
    await signOut(auth);
    window.location.href = 'barangaydocs_login.html';
}

// ── Verify Page Logic ────────────────────────────────────────

function initVerifyPage(user, userData) {

    // Manual verify button
    const verifyBtn = el('verifyBtn');
    const refInput  = el('refInput');

    if (verifyBtn) {
        verifyBtn.addEventListener('click', () => {
            const val = refInput?.value.trim();
            if (!val) { refInput?.focus(); return; }
            lookupRequest(val);
        });
    }

    // Enter key shortcut
    refInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = refInput.value.trim();
            if (val) lookupRequest(val);
        }
    });

    // Camera button — placeholder (real QR needs jsQR or ZXing)
    const camBtn = el('launchCamBtn');
    if (camBtn) {
        camBtn.addEventListener('click', () => {
            alert('Camera scanning requires a QR library integration.\nUse Manual Verification to enter a reference number.');
        });
    }
}

// ── Firestore Lookup ─────────────────────────────────────────

async function lookupRequest(refNo) {
    const btn = el('verifyBtn');

    // Loading state
    if (btn) {
        btn.disabled    = true;
        btn.innerHTML   = '<div class="spinner"></div> Verifying…';
    }

    try {
        const q        = query(collection(db, 'requests'), where('referenceNo', '==', refNo));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            showResult(null, refNo);
        } else {
            showResult(snapshot.docs[0].data(), refNo);
        }

    } catch (err) {
        console.error('Verify error:', err);
        // Surface the error in the placeholder (likely a Firestore rules issue)
        const ph = el('resultPlaceholder');
        const rc = el('resultCard');
        if (rc) rc.classList.remove('show');
        if (ph) {
            ph.style.display = '';
            const h3 = ph.querySelector('h3');
            const p  = ph.querySelector('p');
            if (h3) h3.textContent = 'Lookup Failed';
            if (p)  p.textContent  = `Could not retrieve document. Make sure your Firestore rules allow authenticated users to read requests by referenceNo. (${err.message})`;
        }

    } finally {
        if (btn) {
            btn.disabled  = false;
            btn.innerHTML = 'Verify';
        }
    }
}

// ── Display Result ───────────────────────────────────────────

function showResult(data, refNo) {
    const placeholder = el('resultPlaceholder');
    const card        = el('resultCard');

    // ── Not found ──
    if (!data) {
        if (placeholder) {
            placeholder.style.display = '';
            const h3 = placeholder.querySelector('h3');
            const p  = placeholder.querySelector('p');
            if (h3) h3.textContent = 'Not Found';
            if (p)  p.textContent  = `No document found for reference "${refNo}". Please check the number and try again.`;
        }
        if (card) card.classList.remove('show');
        return;
    }

    // ── Found ──
    if (placeholder) placeholder.style.display = 'none';
    if (!card) return;
    card.classList.add('show');

    // Header
    const hTitle = el('resultDocType');
    const hRef   = el('resultRef');
    if (hTitle) hTitle.textContent = data.documentType || '—';
    if (hRef)   hRef.textContent   = `Ref: ${data.referenceNo || refNo}`;

    // Status badge
    const badge = el('resultBadge');
    if (badge) {
        const badgeMap = {
            released:   { bg: '#DBEAFE', color: '#1565C0', icon: '✔',  text: 'RELEASED — Document Issued'       },
            ready:      { bg: '#D4EDDA', color: '#155724', icon: '✔',  text: 'READY — Awaiting Pickup'          },
            approved:   { bg: '#D4EDDA', color: '#155724', icon: '✔',  text: 'APPROVED — Generating QR'         },
            processing: { bg: '#E8F4FD', color: '#0D47A1', icon: '⚙',  text: 'PROCESSING — Being Prepared'      },
            rejected:   { bg: '#F8D7DA', color: '#721C24', icon: '✕',  text: 'REJECTED — Not Approved'          },
            pending:    { bg: '#FFF3CD', color: '#856404', icon: '⏳', text: 'PENDING — Not Yet Issued'         },
        };
        const b = badgeMap[data.status] || badgeMap.pending;
        badge.style.background = b.bg;
        badge.style.color      = b.color;
        badge.textContent      = `${b.icon}  ${b.text}`;
    }

    // Info fields
    const setText = (id, val) => { const e = el(id); if (e) e.textContent = val || '—'; };

    setText('rName',    data.residentName);
    setText('rType',    data.documentType);
    setText('rPurpose', data.purpose);
    setText('rRef',     data.referenceNo || refNo);

    // Date issued = readyAt (when admin marks ready) or releasedAt as fallback
    const issuedTs = data.readyAt || data.releasedAt || null;
    setText('rDate',  issuedTs ? formatDate(issuedTs)   : null);
    setText('rValid', issuedTs ? validUntil(issuedTs)   : null);

    // Status text with colour
    const rStatus = el('rStatus');
    if (rStatus) {
        const sm = {
            pending:    { text: 'Pending',          color: '#856404' },
            processing: { text: 'Processing',       color: '#0D47A1' },
            approved:   { text: 'Approved',         color: '#155724' },
            ready:      { text: 'Ready for Pickup', color: '#28A745' },
            rejected:   { text: 'Rejected',         color: '#DC3545' },
            released:   { text: 'Released',         color: '#1565C0' },
        }[data.status] || { text: data.status || '—', color: '#6B7A99' };
        rStatus.textContent   = sm.text;
        rStatus.style.color   = sm.color;
        rStatus.style.fontWeight = '800';
    }

    // ── Timeline ──
    // Use status rank so steps go green based on workflow progress,
    // not just whether a timestamp field exists (processedAt may be missing
    // if the request skipped directly from pending to approved).
    const statusRank = { pending: 0, processing: 1, approved: 2, ready: 3, released: 4 };
    const currentRank = statusRank[data.status] ?? 0;
    const isRejected = data.status === 'rejected';

    const steps = [
        { dot: 'dotSubmitted',  line: 'lineSubmitted',  lbl: 'lblSubmitted',  time: 'timeSubmitted',  label: 'Submitted',            ts: data.createdAt,   rank: 0 },
        { dot: 'dotProcessing', line: 'lineProcessing', lbl: 'lblProcessing', time: 'timeProcessing', label: 'Processing Started',   ts: data.processedAt, rank: 1 },
        { dot: 'dotReady',      line: 'lineReady',      lbl: 'lblReady',      time: 'timeReady',      label: 'Ready for Pickup',     ts: data.readyAt,     rank: 3 },
        { dot: 'dotReleased',   line: null,             lbl: 'lblReleased',   time: 'timeReleased',   label: 'Released',             ts: data.releasedAt,  rank: 4 },
    ];

    steps.forEach((step, i) => {
        const dot  = el(step.dot);
        const line = step.line ? el(step.line) : null;
        const lbl  = el(step.lbl);
        const time = el(step.time);
        if (!dot || !lbl || !time) return;

        // Done if status rank has reached or passed this step (and not rejected)
        const done = !isRejected && currentRank >= step.rank;

        if (done) {
            dot.className   = 'tl-dot done';
            if (line) line.className = 'tl-line done';
            lbl.className   = 'tl-label';
            lbl.textContent = step.label;
            time.className  = 'tl-time done-txt';
            time.textContent = step.ts ? formatDateTime(step.ts) : '—';

        } else if (isRejected && i > 0) {
            dot.className   = 'tl-dot rejected-dot';
            if (line) line.className = 'tl-line';
            lbl.className   = 'tl-label muted';
            lbl.textContent = step.label;
            time.className  = 'tl-time';
            time.textContent = 'N/A — Rejected';

        } else {
            dot.className   = 'tl-dot';
            if (line) line.className = 'tl-line';
            lbl.className   = 'tl-label muted';
            lbl.textContent = step.label;
            time.className  = 'tl-time pending-txt';
            time.textContent = 'Awaiting';
        }
    });
}