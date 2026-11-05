// =============================================
// adminrequests.js
// Handles: admin_pending_requests.html
//          admin_all_requests.html
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    orderBy,
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

// helper used by loadSidebarBadges
const el = (id) => document.getElementById(id);

// =============================================
// Page Detection
// Use window.PAGE_TYPE if set by the HTML page,
// otherwise fall back to document.title check.
// =============================================
const isPendingPage = window.PAGE_TYPE === 'pending' || document.title.includes('Pending Requests');
const isAllPage     = window.PAGE_TYPE === 'all'     || document.title.includes('All Requests');

// =============================================
// Auth Guard
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }

    const adminDoc = await getDoc(doc(db, 'admins', user.uid));
    if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    if (isPendingPage) initPendingRequests();
    if (isAllPage)     initAllRequests();
    loadSidebarBadges();
});

// =============================================
// Sidebar & Sign Out
// =============================================
let sidebarOpen = true;
window.toggleSidebar = function () {
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
    document.getElementById('mainContent').classList.toggle('expanded', !sidebarOpen);
};

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
    setTimeout(() => t.classList.remove('show'), 3000);
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
    const map = { pending: 'pending', processing: 'processing', approved: 'processing', ready: 'ready', released: 'active', rejected: 'rejected' };
    return map[status] || 'pending';
}

function getBadgeLabel(status) {
    const map = { pending: 'Submitted', processing: 'Processing', approved: 'Approved', ready: 'Ready for Release', released: 'Released', rejected: 'Rejected' };
    return map[status] || status;
}

function docIcon(name) {
    const map = {
        'Barangay Clearance': 'Icons/barangayclearance.png',
        'Cert. of Residency': 'Icons/certificateofresidency.png',
        'Cert. of Indigency': 'Icons/certificateofindigency.png',
        'Business Clearance': 'Icons/barangaybusinessclearance.png',
        'Job Seeker Cert.': 'Icons/firsttimejobseekercertificate.png',
        'Good Moral Char.': 'Icons/certificateofgoodmoralcharacter.png',
        'Solo Parent Cert.': 'Icons/soloparentcertificate.png',
        'Working Permit': 'Icons/workingpermit.png'
    };
    return '' + (map[name] || 'Icons/barangayclearance.png');
}

// =============================================
// Generate QR Code using QRious library
// =============================================
function generateQRCode(canvasId, text) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    new QRious({
        element: canvas,
        value: text,
        size: 130,
        backgroundAlpha: 1,
        foreground: '#1B3A6B',
        background: '#ffffff',
        level: 'H'
    });
}

// =============================================
// Expiry Date Helpers
// =============================================

// How many days are in a given month/year
function daysInMonth(month, year) {
    if (!month) return 31;
    return new Date(year || 2024, month, 0).getDate();
}

// Rebuild the day <select> based on chosen month + year
function refreshDayOptions(month, year, selectedDay) {
    const dayEl = document.getElementById('expiry-day');
    if (!dayEl) return;
    const max     = daysInMonth(month, year);
    const current = selectedDay || parseInt(dayEl.value) || '';
    dayEl.innerHTML = '<option value="">Day</option>';
    for (let d = 1; d <= max; d++) {
        const opt      = document.createElement('option');
        opt.value      = d;
        opt.textContent = d;
        if (d === current) opt.selected = true;
        dayEl.appendChild(opt);
    }
}

// Pre-fill the expiry picker to 1 year from today
function prefillExpiry() {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    const m = next.getMonth() + 1;
    const d = next.getDate();
    const y = next.getFullYear();

    const monthEl = document.getElementById('expiry-month');
    const yearEl  = document.getElementById('expiry-year');
    if (monthEl) monthEl.value = m;
    if (yearEl)  yearEl.value  = y;
    refreshDayOptions(m, y, d);

    // Wire month + year change → refresh days
    monthEl?.addEventListener('change', () => {
        const yr = parseInt(document.getElementById('expiry-year')?.value);
        refreshDayOptions(parseInt(monthEl.value), yr);
    });
    yearEl?.addEventListener('input', () => {
        const yr = parseInt(yearEl.value);
        const mo = parseInt(document.getElementById('expiry-month')?.value);
        refreshDayOptions(mo, yr);
    });
}

// Validate & return a Date, or null if invalid
function getExpiryDate() {
    const month = parseInt(document.getElementById('expiry-month')?.value);
    const day   = parseInt(document.getElementById('expiry-day')?.value);
    const year  = parseInt(document.getElementById('expiry-year')?.value);
    const errEl = document.getElementById('expiry-error');

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

// Format a Date or Firestore Timestamp for display
function formatExpiry(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

// =============================================
// Build action buttons based on status
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
        return `
            <button class="btn-approve" data-id="${docId}" data-action="ready">Mark Ready + QR</button>`;
    }
    if (status === 'ready') {
        return `
            <button class="btn-approve"   data-id="${docId}" data-action="released">Mark Released</button>
            <button class="btn-view"      data-id="${docId}" data-action="viewqr">View QR</button>
            <button class="btn-view-doc"  data-id="${docId}" data-action="viewdocument">View Document</button>`;
    }
    if (status === 'released') {
        return `
            <button class="btn-view"      data-id="${docId}" data-action="viewqr">View QR</button>
            <button class="btn-view-doc"  data-id="${docId}" data-action="viewdocument">View Document</button>`;
    }
    if (status === 'rejected') {
        return `<span style="font-size:11px;color:var(--red-text);">Rejected</span>`;
    }
    return '';
}

// =============================================
// Wire action buttons on a row
// =============================================
function wireRowButtons(row, docId, data) {
    row.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'reject')         openRejectModal(docId, row);
            else if (action === 'viewqr')      openQRModal(docId, data);
            else if (action === 'ready')       openReadyModal(docId, data, row);
            else if (action === 'viewdocument') openDocumentModal(docId, data);
            else updateRequestStatus(docId, action, row, data);
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

        // Update row UI
        const badge = row.querySelector('.badge');
        if (badge) {
            badge.className = `badge ${getBadgeClass(newStatus)}`;
            badge.textContent = getBadgeLabel(newStatus);
        }

        const actionCol = row.querySelector('.col-action');
        if (actionCol) {
            actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, newStatus)}</div>`;
            wireRowButtons(row, docId, { ...data, status: newStatus });
        }

        showToast(`✓ Request marked as ${getBadgeLabel(newStatus)}`);

    } catch (err) {
        console.error('Update error:', err);
        showToast('Failed to update. Check Firestore rules.');
    }
}

// =============================================
// Reject Modal
// =============================================
function openRejectModal(docId, row) {
    const overlay = document.getElementById('reject-modal');
    if (!overlay) return;
    overlay.classList.add('show');

    document.getElementById('confirm-reject').onclick = async () => {
        const reason = document.getElementById('reject-reason').value.trim();
        if (!reason) return alert('Please enter a rejection reason.');

        await updateDoc(doc(db, 'requests', docId), {
            status: 'rejected',
            rejectReason: reason,
            updatedAt: serverTimestamp()
        });

        const badge = row.querySelector('.badge');
        if (badge) { badge.className = 'badge rejected'; badge.textContent = 'Rejected'; }
        const actionCol = row.querySelector('.col-action');
        if (actionCol) actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'rejected')}</div>`;

        overlay.classList.remove('show');
        document.getElementById('reject-reason').value = '';
        showToast('Request rejected.');
    };

    document.getElementById('cancel-reject').onclick = () => {
        overlay.classList.remove('show');
        document.getElementById('reject-reason').value = '';
    };
}

// =============================================
// Ready + QR Modal — generate doc code & QR
// =============================================
function openReadyModal(docId, data, row) {
    const overlay = document.getElementById('qr-modal');
    if (!overlay) return;

    // Generate unique doc code: BRY-DOC-YYYY-XXXXX
    const docCode = `BRY-DOC-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 90000))}`;

    document.getElementById('modal-doc-code').textContent = docCode;
    document.getElementById('modal-ref-no').textContent   = data.referenceNo;
    document.getElementById('modal-resident').textContent = data.residentName;
    document.getElementById('modal-doc-type').textContent = data.documentType;

    // Show expiry picker, hide expiry display row
    const pickerEl    = document.getElementById('expiry-picker');
    const expiryRow   = document.getElementById('modal-expiry-row');
    if (pickerEl)  pickerEl.style.display  = '';
    if (expiryRow) expiryRow.style.display = 'none';

    // Pre-fill expiry to 1 year from today & wire day refresh
    prefillExpiry();

    overlay.classList.add('show');

    // Generate QR after modal is visible (no expiry in QR yet — updated on confirm)
    const tempQr = `REF:${data.referenceNo}|CODE:${docCode}|RES:${data.residentName}|DOC:${data.documentType}`;
    setTimeout(() => generateQRCode('qr-canvas', tempQr), 100);

    // Reset confirm button
    const confirmBtn = document.getElementById('confirm-ready');
    confirmBtn.style.display = '';
    confirmBtn.textContent   = 'Confirm & Mark Ready';

    confirmBtn.onclick = async () => {
        const expiry = getExpiryDate();
        if (!expiry) return; // validation failed — error shown inline

        // Rebuild QR content with expiry
        const qrContent = `REF:${data.referenceNo}|CODE:${docCode}|RES:${data.residentName}|DOC:${data.documentType}|EXP:${expiry.toISOString().split('T')[0]}`;

        // Regenerate QR with expiry baked in
        generateQRCode('qr-canvas', qrContent);

        confirmBtn.disabled    = true;
        confirmBtn.textContent = 'Saving…';

        try {
            await updateDoc(doc(db, 'requests', docId), {
                status:     'ready',
                docCode,
                qrContent,
                expiresAt:  expiry,
                readyAt:    serverTimestamp(),
                updatedAt:  serverTimestamp()
            });

            const badge = row.querySelector('.badge');
            if (badge) { badge.className = 'badge ready'; badge.textContent = 'Ready for Release'; }
            const actionCol = row.querySelector('.col-action');
            if (actionCol) {
                actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'ready')}</div>`;
                wireRowButtons(row, docId, { ...data, status: 'ready', docCode, qrContent, expiresAt: expiry });
            }

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

    document.getElementById('cancel-ready').textContent = 'Cancel';
    document.getElementById('cancel-ready').onclick = () => overlay.classList.remove('show');
}

// =============================================
// View QR Modal
// =============================================
async function openQRModal(docId, data) {
    // Fetch latest data to get docCode/qrContent/expiresAt
    const snap   = await getDoc(doc(db, 'requests', docId));
    const latest = snap.exists() ? snap.data() : data;

    const overlay = document.getElementById('qr-modal');
    if (!overlay) return;

    document.getElementById('modal-doc-code').textContent = latest.docCode    || '—';
    document.getElementById('modal-ref-no').textContent   = latest.referenceNo || '—';
    document.getElementById('modal-resident').textContent = latest.residentName || '—';
    document.getElementById('modal-doc-type').textContent = latest.documentType || '—';

    // Show expiry row, hide expiry picker
    const pickerEl   = document.getElementById('expiry-picker');
    const expiryRow  = document.getElementById('modal-expiry-row');
    const expiryDisp = document.getElementById('modal-expiry-display');
    if (pickerEl)  pickerEl.style.display  = 'none';
    if (expiryRow) {
        expiryRow.style.display = latest.expiresAt ? '' : 'none';
        if (expiryDisp) expiryDisp.textContent = formatExpiry(latest.expiresAt);
    }

    overlay.classList.add('show');
    setTimeout(() => generateQRCode('qr-canvas', latest.qrContent || latest.referenceNo), 100);

    document.getElementById('confirm-ready').style.display = 'none';
    document.getElementById('cancel-ready').textContent    = 'Close';
    document.getElementById('cancel-ready').onclick = () => {
        overlay.classList.remove('show');
        document.getElementById('confirm-ready').style.display = '';
        document.getElementById('cancel-ready').textContent    = 'Cancel';
        if (pickerEl)  pickerEl.style.display  = '';
        if (expiryRow) expiryRow.style.display = 'none';
    };
}

// =============================================
// View Document Modal — renders the barangay certificate
// =============================================
async function openDocumentModal(docId, data) {
    // Always fetch latest from Firestore so all fields are current
    const snap   = await getDoc(doc(db, 'requests', docId));
    const r      = snap.exists() ? snap.data() : data;

    // Also fetch resident profile for age/occupation
    let residentData = {};
    if (r.uid) {
        const resSnap = await getDoc(doc(db, 'residents', r.uid));
        if (resSnap.exists()) residentData = resSnap.data();
    }

    populateAndShowDocModal(r, residentData);
}

function populateAndShowDocModal(r, residentData) {
    const overlay = document.getElementById('doc-preview-modal');
    if (!overlay) return;

    // Issue date — prefer readyAt (when it was finalized), else today
    const issueDate = r.readyAt?.toDate ? r.readyAt.toDate() : new Date();
    const day   = issueDate.getDate();
    const month = issueDate.toLocaleString('en-PH', { month: 'long' }).toUpperCase();
    const year  = issueDate.getFullYear();

    // "Issued in" = the formatted issue date (e.g. "MAY 11, 2026")
    const issuedInDate = issueDate.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    }).toUpperCase();

    // Resident age — compute from dateOfBirth if available, else read age field directly
    const age = resolveAge(residentData);

    // Occupation — fall back chain
    const occupation = residentData.occupation
        || residentData.work
        || residentData.jobTitle
        || residentData.job
        || residentData.civilStatus
        || '—';

    const fullName = r.residentName || '—';

    // Fill template fields
    setText('dp-cert-title',   r.documentType  || '(CERTIFICATE NAME)');
    setText('dp-name',         fullName);
    setText('dp-age',          age);
    setText('dp-occupation',   occupation);
    setText('dp-day',          ordinal(day));
    setText('dp-month',        month);
    setText('dp-year',         year);
    setText('dp-doc-code',     r.docCode       || '—');
    setText('dp-ref-no',       r.referenceNo   || '—');
    setText('dp-issued-in',    issuedInDate);
    setText('dp-expiration',   formatExpiry(r.expiresAt));
    setText('dp-issued-in-2',  issuedInDate);

    // QR code
    const qrWrap = document.getElementById('dp-qr-wrap');
    if (qrWrap) {
        qrWrap.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'dp-qr-canvas';
        qrWrap.appendChild(canvas);
        setTimeout(() => generateQRCode('dp-qr-canvas', r.qrContent || r.referenceNo || 'NO-QR'), 120);
    }

    overlay.classList.add('show');

    document.getElementById('dp-close')?.addEventListener('click', () => {
        overlay.classList.remove('show');
    }, { once: true });

    document.getElementById('dp-print')?.addEventListener('click', () => {
        printDocument();
    }, { once: true });
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value !== undefined && value !== null ? String(value) : '—';
}

function ordinal(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function resolveAge(rd) {
    const dob = rd.birthday;
    if (!dob) return '—';
    return computeAge(dob);
}

function computeAge(dob) {
    if (!dob) return '—';
    const [y, m, d] = String(dob).split('-').map(Number);
    if (!y || !m || !d) return '—';
    const today = new Date();
    let age = today.getFullYear() - y;
    const mDiff = today.getMonth() + 1 - m;
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < d)) age--;
    return age;
}

// =============================================
// Print / Save PDF — FIXED
// Embeds all certificate CSS + converts QR
// canvas to a static <img> so it prints correctly
// =============================================
function printDocument() {
    const content = document.getElementById('doc-preview-content');
    if (!content) return;

    // 1. Capture the QR canvas as a PNG data URL BEFORE opening the new window
    //    (canvas pixels are lost when transferred via innerHTML/outerHTML)
    const qrCanvas = document.getElementById('dp-qr-canvas');
    let qrDataUrl = '';
    if (qrCanvas) {
        try { qrDataUrl = qrCanvas.toDataURL('image/png'); } catch (e) { /* tainted canvas — skip */ }
    }

    // 2. Deep-clone the certificate so we can safely mutate it
    const clone = content.cloneNode(true);

    // 3. Replace the <canvas> inside the clone with a static <img>
    if (qrDataUrl) {
        const cloneCanvas = clone.querySelector('#dp-qr-canvas');
        if (cloneCanvas) {
            const img = document.createElement('img');
            img.src = qrDataUrl;
            img.style.cssText = 'width:100px;height:100px;display:block;';
            cloneCanvas.replaceWith(img);
        }
    }

    // 4. Also grab the barangay seal src so it resolves in the new window
    const sealImg = content.querySelector('.bry-seal img');
    const sealSrc = sealImg ? sealImg.src : ''; // absolute URL — safe to reuse

    // 5. Open a clean print window with all certificate styles embedded
    const win = window.open('', '_blank', 'width=900,height=750');
    if (!win) {
        alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
        return;
    }

    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Barangay Document</title>
  <link
    href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Poppins:wght@600;700;800&display=swap"
    rel="stylesheet"
  >
  <style>
    /* ── Reset ── */
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ── Page ── */
    body {
      background: #fff;
      display: flex;
      justify-content: center;
      padding: 30px;
      font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
    }

    /* ── Certificate Paper ── */
    .bry-doc {
      background: #fff;
      border: 3px solid #111;
      padding: 48px 56px 38px;
      font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
      color: #111;
      width: 720px;
      max-width: 100%;
    }

    /* ── Header ── */
    .bry-header {
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 18px;
    }
    .bry-seal {
      width: 84px;
      height: 84px;
      flex-shrink: 0;
    }
    .bry-seal img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .bry-header-text {
      text-align: center;
      flex: 1;
      padding-right: 100px;
    }
    .bry-republic {
      font-size: 12px;
      letter-spacing: 0.04em;
      line-height: 1.7;
      font-variant: small-caps;
    }
    .bry-name {
      font-size: 32px;
      font-weight: 900;
      letter-spacing: 0.02em;
      margin-top: 4px;
    }

    /* ── Divider ── */
    .bry-divider {
      height: 5px;
      background: #111;
      margin: 14px 0 26px;
    }

    /* ── Office label ── */
    .bry-office {
      text-align: center;
      font-size: 12px;
      letter-spacing: 0.16em;
      font-family: Arial, sans-serif;
      margin-bottom: 10px;
    }

    /* ── Certificate title ── */
    .bry-cert-title {
      text-align: center;
      font-size: 26px;
      font-weight: 900;
      text-decoration: underline;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 24px;
    }

    /* ── "To Whom It May Concern" ── */
    .bry-subject {
      font-size: 13px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 16px;
      font-family: Arial, sans-serif;
    }

    /* ── Body text ── */
    .bry-body {
      text-align: center;
      font-size: 13px;
      line-height: 1.9;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 20px;
    }
    .bry-field { text-decoration: underline; }

    /* ── Footer ── */
    .bry-footer {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 26px;
      gap: 20px;
    }
    .bry-meta {
      font-size: 11px;
      line-height: 2;
      font-family: Arial, sans-serif;
      letter-spacing: 0.03em;
      margin-bottom: 8px;
    }

    /* ── QR box ── */
    .bry-qr-box {
      width: 100px;
      height: 100px;
      background: #d8d8d8;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .bry-qr-label {
      font-size: 10px;
      font-family: Arial, sans-serif;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin-top: 5px;
      margin-left: 20px;
    }

    /* ── Signature block ── */
    .bry-sign { text-align: center; }
    .bry-sign-name {
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 0.04em;
    }
    .bry-sign-role {
      font-size: 11px;
      font-family: Arial, sans-serif;
      letter-spacing: 0.08em;
    }
    .bry-sign-sys { margin-top: 14px; }
    .bry-sys-name {
      font-size: 14px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }
    .bry-sys-sub {
      font-size: 10px;
      font-family: Arial, sans-serif;
      letter-spacing: 0.1em;
    }

    /* ── Print tweaks ── */
    @media print {
      body { padding: 0; }
      .bry-doc { border: 3px solid #111 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  ${clone.outerHTML}
</body>
</html>`);

    win.document.close();

    // Wait for fonts/images to load before triggering print dialog
    win.addEventListener('load', () => {
        setTimeout(() => {
            win.focus();
            win.print();
            // Delay close so "Save as PDF" dialog has time to appear
            setTimeout(() => win.close(), 1000);
        }, 400);
    });
}

// =============================================
// Build Table Row
// =============================================
function buildRow(docId, data) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.id     = docId;
    row.dataset.status = data.status;
    row.dataset.name   = (data.residentName || '').toLowerCase();
    row.dataset.doc    = (data.documentType || '').toLowerCase();

    row.innerHTML = `
        <div class="col-icon">
            <div class="doc-icon-sm">
                <img src="${docIcon(data.documentType)}" alt="" onerror="this.style.display='none'">
            </div>
        </div>
        <div class="col-name">
            <h4>${data.documentType || '—'}</h4>
            <p>Ref: ${data.referenceNo || '—'}</p>
        </div>
        <div class="col-user"><span>${data.residentName || '—'}</span></div>
        <div class="col-date"><span>${formatDate(data.createdAt)}</span></div>
        <div class="col-purpose"><span>${data.purpose || '—'}</span></div>
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
// Search & Filter
// =============================================
function applyFilters(tbody) {
    const search    = document.getElementById('search-input')?.value.toLowerCase() || '';
    const docFilter = document.getElementById('doc-filter')?.value.toLowerCase() || 'all';

    tbody.querySelectorAll('.table-row').forEach(row => {
        const nameMatch = row.dataset.name?.includes(search) || row.dataset.doc?.includes(search);
        const docMatch  = docFilter === 'all' || row.dataset.doc?.includes(docFilter);
        row.style.display = (nameMatch && docMatch) ? '' : 'none';
    });
}

// =============================================
// PENDING REQUESTS PAGE
// =============================================
function initPendingRequests() {
    const tbody = document.getElementById('requests-body');
    if (!tbody) return;

    const q = query(
        collection(db, 'requests'),
        where('status', 'in', ['pending', 'processing', 'approved'])
    );

    onSnapshot(q, (snapshot) => {
        tbody.innerHTML = '';

        const countEl = document.getElementById('pendingCount');
        if (countEl) countEl.textContent = snapshot.size;

        if (snapshot.empty) {
            tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No pending requests.</div>';
            return;
        }

        const sorted = snapshot.docs.slice().sort((a, b) => {
            const aTime = a.data().createdAt?.toMillis?.() || 0;
            const bTime = b.data().createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        });

        sorted.forEach(docSnap => {
            tbody.appendChild(buildRow(docSnap.id, docSnap.data()));
        });
    });

    document.getElementById('search-input')?.addEventListener('input',  () => applyFilters(tbody));
    document.getElementById('doc-filter')?.addEventListener('change', () => applyFilters(tbody));
}

// =============================================
// ALL REQUESTS PAGE
// =============================================
function initAllRequests() {
    const tbody = document.getElementById('requests-body');
    if (!tbody) return;

    const q = query(collection(db, 'requests'));

    onSnapshot(q, (snapshot) => {
        tbody.innerHTML = '';

        if (snapshot.empty) {
            tbody.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No requests yet.</div>';
            return;
        }

        const sorted = snapshot.docs.slice().sort((a, b) => {
            const aTime = a.data().createdAt?.toMillis?.() || 0;
            const bTime = b.data().createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        });

        sorted.forEach(docSnap => {
            tbody.appendChild(buildRow(docSnap.id, docSnap.data()));
        });

        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab) filterTab(activeTab.dataset.status, tbody);
    });

    document.querySelectorAll('.tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            filterTab(tab.dataset.status, tbody);
        });
    });

    document.getElementById('search-input')?.addEventListener('input',  () => applyFilters(tbody));
    document.getElementById('doc-filter')?.addEventListener('change', () => applyFilters(tbody));
}

function filterTab(status, tbody) {
    tbody.querySelectorAll('.table-row').forEach(row => {
        row.style.display = (status === 'all' || row.dataset.status === status) ? '' : 'none';
    });
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