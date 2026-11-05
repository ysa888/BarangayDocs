// ============================================================
// adminscanqr.js — Standalone script for BarangayDocs Scan / Verify QR page
// Does NOT depend on bdapp.js
// ============================================================

import { initializeApp }   from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
                           from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, collection, query, where, getDocs,
    updateDoc, serverTimestamp, onSnapshot                          // ✅ FIX #3: added missing imports
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// ── Firebase config ──────────────────────────────────────────
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

// ── State: track currently-displayed doc so action buttons can update it ──
// ✅ FIX #5: store docId after lookup so action buttons know which record to update
let currentDocId   = null;
let currentDocData = null;

// ── Helpers ──────────────────────────────────────────────────

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

// ✅ FIX #7: showToast was missing entirely — ported from adminrequests.js
function showToast(msg) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// ── QR Code & Expiry Helpers (ported from adminrequests.js) ──────────────

function generateQRCode(canvasId, text) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof QRious === 'undefined') return;
    new QRious({
        element: canvas,
        value: text,
        size: 200,
        backgroundAlpha: 1,
        foreground: '#1B3A6B',
        background: '#ffffff',
        level: 'H'
    });
}

function daysInMonth(month, year) {
    if (!month) return 31;
    return new Date(year || 2024, month, 0).getDate();
}

function refreshDayOptions(month, year, selectedDay) {
    const dayEl = el('expiry-day');
    if (!dayEl) return;
    const max     = daysInMonth(month, year);
    const current = selectedDay || parseInt(dayEl.value) || '';
    dayEl.innerHTML = '<option value="">Day</option>';
    for (let d = 1; d <= max; d++) {
        const opt       = document.createElement('option');
        opt.value       = d;
        opt.textContent = d;
        if (d === current) opt.selected = true;
        dayEl.appendChild(opt);
    }
}

function prefillExpiry() {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    const m = next.getMonth() + 1;
    const d = next.getDate();
    const y = next.getFullYear();

    const monthEl = el('expiry-month');
    const yearEl  = el('expiry-year');
    if (monthEl) monthEl.value = m;
    if (yearEl)  yearEl.value  = y;
    refreshDayOptions(m, y, d);

    monthEl?.addEventListener('change', () => {
        const yr = parseInt(el('expiry-year')?.value);
        refreshDayOptions(parseInt(monthEl.value), yr);
    });
    yearEl?.addEventListener('input', () => {
        const yr = parseInt(yearEl.value);
        const mo = parseInt(el('expiry-month')?.value);
        refreshDayOptions(mo, yr);
    });
}

function getExpiryDate() {
    const month = parseInt(el('expiry-month')?.value);
    const day   = parseInt(el('expiry-day')?.value);
    const year  = parseInt(el('expiry-year')?.value);
    const errEl = el('expiry-error');

    const showErr = (msg) => {
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        return null;
    };
    if (errEl) errEl.style.display = 'none';

    if (!month || !day || !year) return showErr('Please fill in all expiration date fields.');
    if (year < 2024 || year > 2099) return showErr('Please enter a valid year (2024 – 2099).');

    const maxDay = daysInMonth(month, year);
    if (day > maxDay) return showErr(`${['','January','February','March','April','May','June','July','August','September','October','November','December'][month]} ${year} only has ${maxDay} days.`);

    const expiry = new Date(year, month - 1, day);
    expiry.setHours(23, 59, 59, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (expiry <= today) return showErr('Expiration date must be in the future.');

    return expiry;
}

function formatExpiry(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Open QR Modal (Mark Ready mode) ─────────────────────────────────────

function openReadyModal(docId, data) {
    const overlay = el('qr-modal');
    if (!overlay) return;

    const docCode = `BRY-DOC-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 90000))}`;

    el('modal-doc-code').textContent = docCode;
    el('modal-ref-no').textContent   = data.referenceNo  || '—';
    el('modal-resident').textContent = data.residentName || '—';
    el('modal-doc-type').textContent = data.documentType || '—';

    const pickerEl  = el('expiry-picker');
    const expiryRow = el('modal-expiry-row');
    if (pickerEl)  pickerEl.style.display  = '';
    if (expiryRow) expiryRow.style.display = 'none';

    prefillExpiry();
    overlay.classList.add('show');

    const tempQr = `REF:${data.referenceNo}|CODE:${docCode}|RES:${data.residentName}|DOC:${data.documentType}`;
    setTimeout(() => generateQRCode('qr-canvas', tempQr), 100);

    const confirmBtn = el('confirm-ready');
    confirmBtn.style.display = '';
    confirmBtn.textContent   = 'Confirm & Mark Ready';
    confirmBtn.disabled      = false;

    confirmBtn.onclick = async () => {
        const expiry = getExpiryDate();
        if (!expiry) return;

        const qrContent = `REF:${data.referenceNo}|CODE:${docCode}|RES:${data.residentName}|DOC:${data.documentType}|EXP:${expiry.toISOString().split('T')[0]}`;
        generateQRCode('qr-canvas', qrContent);

        confirmBtn.disabled    = true;
        confirmBtn.textContent = 'Saving…';

        try {
            await updateDoc(doc(db, 'requests', docId), {
                status:    'ready',
                docCode,
                qrContent,
                expiresAt: expiry,
                readyAt:   serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            currentDocData = { ...currentDocData, status: 'ready', docCode, qrContent, expiresAt: expiry };
            showResult(currentDocData, currentDocData.referenceNo);
            overlay.classList.remove('show');
            showToast('✓ QR generated. Document is ready for release.');
        } catch (err) {
            console.error(err);
            showToast('Failed to save QR. Check Firestore rules.');
        } finally {
            confirmBtn.disabled    = false;
            confirmBtn.textContent = 'Confirm & Mark Ready';
        }
    };

    el('cancel-ready').textContent = 'Cancel';
    el('cancel-ready').onclick = () => overlay.classList.remove('show');
}

// ── Open QR Modal (View QR mode) ─────────────────────────────────────────

async function openQRModal(docId, data) {
    const snap   = await getDoc(doc(db, 'requests', docId));
    const latest = snap.exists() ? snap.data() : data;

    const overlay = el('qr-modal');
    if (!overlay) return;

    el('modal-doc-code').textContent = latest.docCode     || '—';
    el('modal-ref-no').textContent   = latest.referenceNo || '—';
    el('modal-resident').textContent = latest.residentName || '—';
    el('modal-doc-type').textContent = latest.documentType || '—';

    const pickerEl   = el('expiry-picker');
    const expiryRow  = el('modal-expiry-row');
    const expiryDisp = el('modal-expiry-display');
    if (pickerEl)  pickerEl.style.display  = 'none';
    if (expiryRow) {
        expiryRow.style.display = latest.expiresAt ? '' : 'none';
        if (expiryDisp) expiryDisp.textContent = formatExpiry(latest.expiresAt);
    }

    overlay.classList.add('show');
    setTimeout(() => generateQRCode('qr-canvas', latest.qrContent || latest.referenceNo), 100);

    el('confirm-ready').style.display = 'none';
    el('cancel-ready').textContent    = 'Close';
    el('cancel-ready').onclick = () => {
        overlay.classList.remove('show');
        el('confirm-ready').style.display = '';
        el('cancel-ready').textContent    = 'Cancel';
        if (pickerEl)  pickerEl.style.display  = '';
        if (expiryRow) expiryRow.style.display = 'none';
    };
}

// ── Auth Guard ───────────────────────────────────────────────

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

        // Show admin initials in navbar avatar
        const adminData = adminDoc.data();
        const initials  = ((adminData.firstName?.[0] || '') + (adminData.lastName?.[0] || '')).toUpperCase() || 'A';
        const avPh      = document.querySelector('.av-ph');
        if (avPh) avPh.textContent = initials;

        // ✅ FIX #1: was calling initDashboard() which doesn't exist — correct call is initVerifyPage()
        initVerifyPage();
        loadSidebarBadges();

    } catch (err) {
        console.error('Auth guard error:', err);
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
    }
});

// ── Sidebar ──────────────────────────────────────────────────

// ✅ FIX #2: was a local function — must be window.toggleSidebar so the
//    HTML onclick="toggleSidebar()" can find it
window.toggleSidebar = function () {
    const sb   = el('sidebar');
    const main = el('mainContent');
    if (!sb || !main) return;
    if (window.innerWidth <= 640) {
        sb.classList.toggle('open');
    } else {
        sb.classList.toggle('collapsed');
        main.classList.toggle('expanded');
    }
};

// ── Logout ───────────────────────────────────────────────────

el('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

// ── Verify Page Logic ────────────────────────────────────────

function initVerifyPage() {
    const verifyBtn = el('verifyBtn');
    const refInput  = el('refInput');

    if (verifyBtn) {
        verifyBtn.addEventListener('click', () => {
            const val = refInput?.value.trim();
            if (!val) { refInput?.focus(); return; }
            lookupRequest(val);
        });
    }

    refInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = refInput.value.trim();
            if (val) lookupRequest(val);
        }
    });

    // Camera button — placeholder (real QR scanning needs jsQR or ZXing)
    el('launchCamBtn')?.addEventListener('click', () => {
        alert('Camera scanning requires a QR library integration.\nUse Manual Verification to enter a reference number.');
    });

    // ✅ FIX #4 & #6: wire admin action buttons + confirm modal
    wireAdminActionButtons();
}

// ── Firestore Lookup ─────────────────────────────────────────

async function lookupRequest(refNo) {
    const btn = el('verifyBtn');

    if (btn) {
        btn.disabled  = true;
        btn.innerHTML = '<div class="spinner"></div> Verifying…';
    }

    try {
        const q        = query(collection(db, 'requests'), where('referenceNo', '==', refNo));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            // ✅ FIX #5: clear stored state when nothing is found
            currentDocId   = null;
            currentDocData = null;
            showResult(null, refNo);
        } else {
            const docSnap = snapshot.docs[0];
            // ✅ FIX #5: store docId and data so action buttons can use them
            currentDocId   = docSnap.id;
            currentDocData = docSnap.data();
            showResult(currentDocData, refNo);
        }

    } catch (err) {
        console.error('Verify error:', err);
        const ph = el('resultPlaceholder');
        const rc = el('resultCard');
        if (rc) rc.classList.remove('show');
        if (ph) {
            ph.style.display = '';
            const h3 = ph.querySelector('h3');
            const p  = ph.querySelector('p');
            if (h3) h3.textContent = 'Lookup Failed';
            if (p)  p.textContent  = `Could not retrieve document. Make sure your Firestore rules allow authenticated reads by referenceNo. (${err.message})`;
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

    if (!data) {
        if (placeholder) {
            placeholder.style.display = '';
            const h3 = placeholder.querySelector('h3');
            const p  = placeholder.querySelector('p');
            if (h3) h3.textContent = 'Not Found';
            if (p)  p.textContent  = `No document found for reference "${refNo}". Please check the number and try again.`;
        }
        if (card) card.classList.remove('show');
        updateAdminActionButtons(null);  // hide / disable all action buttons
        return;
    }

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
            released:   { bg: '#DBEAFE', color: '#1565C0', icon: '✔',  text: 'RELEASED — Document Issued'   },
            ready:      { bg: '#D4EDDA', color: '#155724', icon: '✔',  text: 'READY — Awaiting Pickup'      },
            approved:   { bg: '#D4EDDA', color: '#155724', icon: '✔',  text: 'APPROVED — Generating QR'     },
            processing: { bg: '#E8F4FD', color: '#0D47A1', icon: '⚙',  text: 'PROCESSING — Being Prepared'  },
            rejected:   { bg: '#F8D7DA', color: '#721C24', icon: '✕',  text: 'REJECTED — Not Approved'      },
            pending:    { bg: '#FFF3CD', color: '#856404', icon: '⏳', text: 'PENDING — Not Yet Issued'     },
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

    const issuedTs = data.readyAt || data.releasedAt || null;
    setText('rDate',  issuedTs ? formatDate(issuedTs) : null);
    setText('rValid', data.expiresAt ? formatExpiry(data.expiresAt) : (issuedTs ? validUntil(issuedTs) : null));

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
        rStatus.textContent      = sm.text;
        rStatus.style.color      = sm.color;
        rStatus.style.fontWeight = '800';
    }

    // Timeline
    // Use status rank so steps go green based on workflow progress,
    // not just whether a timestamp field exists (processedAt may be missing
    // if the request skipped directly from pending to approved).
    const statusRank = { pending: 0, processing: 1, approved: 2, ready: 3, released: 4 };
    const currentRank = statusRank[data.status] ?? 0;
    const isRejected = data.status === 'rejected';
    const steps = [
        { dot: 'dotSubmitted',  line: 'lineSubmitted',  lbl: 'lblSubmitted',  time: 'timeSubmitted',  label: 'Submitted',          ts: data.createdAt,   rank: 0 },
        { dot: 'dotProcessing', line: 'lineProcessing', lbl: 'lblProcessing', time: 'timeProcessing', label: 'Processing Started', ts: data.processedAt, rank: 1 },
        { dot: 'dotReady',      line: 'lineReady',      lbl: 'lblReady',      time: 'timeReady',      label: 'Ready for Pickup',   ts: data.readyAt,     rank: 3 },
        { dot: 'dotReleased',   line: null,             lbl: 'lblReleased',   time: 'timeReleased',   label: 'Released',           ts: data.releasedAt,  rank: 4 },
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
            dot.className        = 'tl-dot done';
            if (line) line.className = 'tl-line done';
            lbl.className        = 'tl-label';
            lbl.textContent      = step.label;
            time.className       = 'tl-time done-txt';
            time.textContent     = step.ts ? formatDateTime(step.ts) : '—';
        } else if (isRejected && i > 0) {
            dot.className        = 'tl-dot rejected-dot';
            if (line) line.className = 'tl-line';
            lbl.className        = 'tl-label muted';
            lbl.textContent      = step.label;
            time.className       = 'tl-time';
            time.textContent     = 'N/A — Rejected';
        } else {
            dot.className        = 'tl-dot';
            if (line) line.className = 'tl-line';
            lbl.className        = 'tl-label muted';
            lbl.textContent      = step.label;
            time.className       = 'tl-time pending-txt';
            time.textContent     = 'Awaiting';
        }
    });

    // Refresh action button visibility based on new status
    updateAdminActionButtons(data.status);
}

// ── Admin Action Buttons ──────────────────────────────────────
// ✅ FIX #4: admin action buttons were never wired — now fully connected

function wireAdminActionButtons() {
    el('btnProcess')?.addEventListener('click', () => openConfirmModal('processing'));
    el('btnReady')?.addEventListener('click',   () => {
        if (!currentDocId || !currentDocData) return;
        openReadyModal(currentDocId, currentDocData);
    });
    el('btnRelease')?.addEventListener('click', () => openConfirmModal('released'));
    el('btnReject')?.addEventListener('click',  () => openConfirmModal('rejected'));
    el('btnViewQR')?.addEventListener('click',  () => {
        if (!currentDocId || !currentDocData) return;
        openQRModal(currentDocId, currentDocData);
    });

    // ✅ FIX #6: confirm modal buttons were never wired
    el('confirmCancel')?.addEventListener('click', closeConfirmModal);
    el('confirmOk')?.addEventListener('click', handleConfirm);
}

// Show/hide action buttons based on current document status
function updateAdminActionButtons(status) {
    const btnProcess = el('btnProcess');
    const btnReady   = el('btnReady');
    const btnRelease = el('btnRelease');
    const btnReject  = el('btnReject');
    const btnViewQR  = el('btnViewQR');
    const note       = el('actionNote');

    // If no doc loaded, hide everything
    if (!status) {
        [btnProcess, btnReady, btnRelease, btnReject, btnViewQR].forEach(b => { if (b) b.style.display = 'none'; });
        if (note) note.textContent = '';
        return;
    }

    if (btnProcess) btnProcess.style.display = status === 'pending'                    ? '' : 'none';
    if (btnReady)   btnReady.style.display   = ['processing', 'approved'].includes(status) ? '' : 'none';
    if (btnRelease) btnRelease.style.display = status === 'ready'                     ? '' : 'none';
    if (btnReject)  btnReject.style.display  = ['pending', 'processing', 'approved', 'ready'].includes(status) ? '' : 'none';
    // Show View QR for ready and released statuses
    if (btnViewQR)  btnViewQR.style.display  = ['ready', 'released'].includes(status) ? '' : 'none';

    if (note) {
        note.textContent = status === 'released' ? 'This document has already been released.' :
                           status === 'rejected'  ? 'This request was rejected.' : '';
    }
}

// ── Confirm Modal ─────────────────────────────────────────────

let pendingNewStatus = null;

function openConfirmModal(newStatus) {
    if (!currentDocId) return;

    pendingNewStatus = newStatus;

    const titleMap = {
        processing: 'Mark as Processing',
        ready:      'Mark as Ready for Pickup',
        released:   'Mark as Released',
        rejected:   'Reject Request',
    };
    const bodyMap = {
        processing: 'This will mark the request as currently being processed.',
        ready:      'This will mark the document as ready for pickup and set the issue date.',
        released:   'This will mark the document as released to the resident.',
        rejected:   'This will reject the request. You may add an optional reason below.',
    };

    const titleEl  = el('confirmTitle');
    const bodyEl   = el('confirmBody');
    const noteArea = el('rejectNote');
    const modal    = el('confirmModal');

    if (titleEl)  titleEl.textContent  = titleMap[newStatus]  || 'Confirm Action';
    if (bodyEl)   bodyEl.textContent   = bodyMap[newStatus]   || 'Are you sure?';
    if (noteArea) noteArea.style.display = newStatus === 'rejected' ? '' : 'none';
    if (modal)    modal.classList.add('show');
}

function closeConfirmModal() {
    el('confirmModal')?.classList.remove('show');
    pendingNewStatus = null;
    const noteArea = el('rejectNote');
    if (noteArea) noteArea.value = '';
}

async function handleConfirm() {
    if (!currentDocId || !pendingNewStatus) return;

    const btn = el('confirmOk');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
        const updateData = {
            status:    pendingNewStatus,
            updatedAt: serverTimestamp(),
        };

        // Set the right timestamp field based on new status (mirrors adminrequests.js)
        if (pendingNewStatus === 'processing') updateData.processedAt = serverTimestamp();
        if (pendingNewStatus === 'ready')      updateData.readyAt     = serverTimestamp();
        if (pendingNewStatus === 'released')   updateData.releasedAt  = serverTimestamp();
        if (pendingNewStatus === 'rejected') {
            const reason = el('rejectNote')?.value.trim();
            if (reason) updateData.rejectReason = reason;
        }

        await updateDoc(doc(db, 'requests', currentDocId), updateData);

        // Refresh local state and re-render result card
        currentDocData = { ...currentDocData, ...updateData, status: pendingNewStatus };
        showResult(currentDocData, currentDocData.referenceNo);

        showToast(`✓ Status updated to "${pendingNewStatus}".`);
        closeConfirmModal();

    } catch (err) {
        console.error('Update error:', err);
        showToast(`Failed to update status. Check Firestore rules. (${err.message})`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
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