// =============================================
// adminrequests.js
// Handles: admin_pending_requests.html
//          admin_all_requests.html
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { mountRejectReasonPicker } from "./rejectreasons.js";
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
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { sendSMS } from './sms.js';
import { baseValues, effectiveValues, paintDocument } from './docoverrides.js';
import { openLightbox } from './imageviewer.js';

// Admin-made template view (same renderer the resident preview uses). null = built-in certificate.
let templateView = null;

// Always read the latest saved template from Firestore each time a preview opens
// doctemplate.js is loaded lazily so a problem there can never break this page
let templateLib = null;
async function getTemplateLib() {
    if (!templateLib) templateLib = await import('./doctemplate.js');
    return templateLib;
}

async function fetchLatestTemplate(documentType) {
    try {
        const tSnap = await getDocs(query(collection(db, 'documentTemplates'), where('documentName', '==', documentType)));
        if (!tSnap.empty) return { id: tSnap.docs[0].id, ...tSnap.docs[0].data() };
    } catch (err) {
        console.warn('Could not fetch latest template:', err);
    }
    try {
        return (await getTemplateLib()).loadTemplateForType(db, documentType);
    } catch (err) {
        console.warn('Template loader unavailable, using built-in certificate:', err);
        return null;
    }
}
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
// Embed mode (?embed=1) — used by the Dashboard.
// The page is loaded transparent inside an overlay iframe on the dashboard:
// only the popups show, and the parent is told when the last popup closes.
// =============================================
const isEmbed = new URLSearchParams(location.search).get('embed') === '1';
if (isEmbed) {
    const st = document.createElement('style');
    st.textContent = `
        html, body { background: transparent !important; }
        body > *:not([class*="modal"]):not([class*="overlay"]):not([class*="lightbox"]):not([id*="lightbox"]):not([class*="toast"]):not(script):not(style) {
            visibility: hidden !important; pointer-events: none !important;
        }`;
    document.head.appendChild(st);

    let seen = false, timer = null;
    const popupOpen = () => [...document.querySelectorAll('.modal-overlay, .confirm-overlay, #request-detail-modal')]
        .some(e => getComputedStyle(e).display !== 'none');
    const tellParent = () => parent.postMessage({ type: 'requests-embed-close' }, location.origin);
    const check = () => {
        if (popupOpen()) { seen = true; clearTimeout(timer); return; }
        if (seen) { clearTimeout(timer); timer = setTimeout(() => { if (!popupOpen()) tellParent(); }, 500); }
    };
    new MutationObserver(check).observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style']
    });
    setTimeout(() => { if (!seen) tellParent(); }, 8000);   // nothing opened (e.g. request not found)
}

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
    const map = { pending: 'pending', processing: 'processing', approved: 'approved', ready: 'ready', released: 'released', rejected: 'rejected' };
    return map[status] || 'pending';
}

function getBadgeLabel(status) {
    const map = { pending: 'Submitted', processing: 'Processing', approved: 'Awaiting Signature', ready: 'Ready for Pickup', released: 'Released', rejected: 'Rejected' };
    return map[status] || status;
}

// Document validity — only meaningful once a QR/expiry exists
// (status 'ready' or 'released'). Returns 'active', 'expired' or null.
function getValidity(status, expiresAt) {
    if (status !== 'ready' && status !== 'released') return null;
    if (!expiresAt) return null;
    const d = expiresAt?.toDate ? expiresAt.toDate() : new Date(expiresAt);
    if (isNaN(d.getTime())) return null;
    return d.getTime() < Date.now() ? 'expired' : 'active';
}

// Status column = just the process badge (Submitted, Processing, ...)
function statusCellHTML(status) {
    return `<span class="badge ${getBadgeClass(status)}">${getBadgeLabel(status)}</span>`;
}

// Validity column = Active / Expired (only ready/released docs), else a dash
function validityCellHTML(status, expiresAt) {
    const v = getValidity(status, expiresAt);
    return v
        ? `<span class="badge validity ${v}">${v === 'active' ? 'Active' : 'Expired'}</span>`
        : `<span class="no-validity">—</span>`;
}

function renderStatusCell(row, status, expiresAt) {
    const cell = row.querySelector('.col-status');
    if (cell) cell.innerHTML = statusCellHTML(status);
    const vcell = row.querySelector('.col-validity');   // only exists on All Requests
    if (vcell) vcell.innerHTML = validityCellHTML(status, expiresAt);
    row.dataset.status = status;
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
function refreshDayOptions(month, year, selectedDay, prefix = 'expiry') {
    const dayEl = document.getElementById(prefix + '-day');
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
function getExpiryDate(prefix = 'expiry', silent = false) {
    const month = parseInt(document.getElementById(prefix + '-month')?.value);
    const day   = parseInt(document.getElementById(prefix + '-day')?.value);
    const year  = parseInt(document.getElementById(prefix + '-year')?.value);
    const errEl = document.getElementById(prefix + '-error');

    const showErr = (msg) => {
        if (errEl && !silent) { errEl.textContent = msg; errEl.style.display = 'block'; }
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
// Action layout per status
// primary  = the one button always visible in the row
// menu     = everything else, inside the ⋮ kebab menu
// =============================================
const ACTION_LABELS = {
    viewrequest:  'View Request',
    viewdocument: 'View Document',
    preview:      'Preview',
    viewqr:       'View QR',
    reject:       'Reject request',
    void:         'Void request'
};

function getActionConfig(status) {
    switch (status) {
        case 'pending':      // 1. View Request -> Process / Reject
            return { primary: { action: 'viewrequest',    label: 'View Request',      cls: 'btn-process' },
                     menu: ['reject'] };
        case 'processing':   // 2. Preview (editable) -> Approve
            return { primary: { action: 'previewapprove', label: 'Preview & Approve', cls: 'btn-approve' },
                     menu: ['viewrequest', 'reject'] };
        case 'approved':     // 3. QR + ref generated, waiting for signature -> 4. Mark as Ready
            return { primary: { action: 'markready',      label: 'Mark as Ready',     cls: 'btn-approve' },
                     menu: ['viewqr', 'preview', 'void'] };
        case 'ready':        // 5. Ready for Pickup -> 6. Mark as Released
            return { primary: { action: 'released',       label: 'Mark as Released',  cls: 'btn-approve' },
                     menu: ['viewqr', 'viewdocument', 'void'] };
        case 'released':
            return { primary: { action: 'viewdocument',   label: 'View Document',     cls: 'btn-view-doc' },
                     menu: ['viewqr'] };
        default:
            return null;
    }
}

function getActionButtons(docId, status) {
    const cfg = getActionConfig(status);
    if (!cfg) {
        return status === 'rejected'
            ? `<span style="font-size:11px;color:var(--red-text);">Rejected</span>` : '';
    }
    const kebab = cfg.menu.length
        ? `<button class="kebab-btn" data-id="${docId}" data-action="kebab" title="More actions">&#8942;</button>` : '';
    return `<button class="${cfg.primary.cls}" data-id="${docId}" data-action="${cfg.primary.action}">${cfg.primary.label}</button>${kebab}`;
}

// =============================================
// Run an action (shared by row buttons and kebab items)
// =============================================
function runAction(action, docId, row, data) {
    if (action === 'reject' || action === 'void')        openRejectModal(docId, row);
    else if (action === 'viewrequest')                    openRequestModal(docId, data, row);
    else if (action === 'previewapprove')                 openDocumentModal(docId, data, { mode: 'approve', row });
    else if (action === 'markready')                      openDocumentModal(docId, data, { mode: 'ready', row });
    else if (action === 'viewqr')                         openQRModal(docId, data);
    else if (action === 'viewdocument' || action === 'preview') openDocumentModal(docId, data);
    else updateRequestStatus(docId, action, row, data);
}

function wireRowButtons(row, docId, data) {
    row.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = btn.dataset.action;
            if (action === 'kebab') { e.stopPropagation(); openKebabMenu(btn, docId, row, data); }
            else runAction(action, docId, row, data);
        });
    });
}

// =============================================
// Kebab (⋮) menu
// Attached to <body> so the table card's
// overflow can't clip it.
// =============================================
function closeKebabMenu() {
    document.querySelectorAll('.kebab-menu').forEach(m => m.remove());
}

function openKebabMenu(btn, docId, row, data) {
    const alreadyOpen = document.querySelector('.kebab-menu');
    closeKebabMenu();
    if (alreadyOpen && alreadyOpen.dataset.for === docId) return; // second click toggles it closed

    const cfg = getActionConfig(row.dataset.status);
    if (!cfg) return;

    const menu = document.createElement('div');
    menu.className = 'kebab-menu';
    menu.dataset.for = docId;
    menu.innerHTML = cfg.menu.map(a => {
        const danger = a === 'reject' || a === 'void';
        const sep = danger && cfg.menu.length > 1 ? '<div class="kebab-sep"></div>' : '';
        return `${sep}<button class="kebab-item${danger ? ' danger' : ''}" type="button" data-kact="${a}">${danger ? '✕ ' : ''}${ACTION_LABELS[a]}</button>`;
    }).join('');
    document.body.appendChild(menu);

    const r = btn.getBoundingClientRect();
    menu.style.top  = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;

    menu.querySelectorAll('.kebab-item').forEach(item => {
        item.addEventListener('click', () => {
            closeKebabMenu();
            runAction(item.dataset.kact, docId, row, data);
        });
    });
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.kebab-menu') && !e.target.closest('.kebab-btn')) closeKebabMenu();
});
window.addEventListener('scroll', closeKebabMenu, true);
window.addEventListener('resize', closeKebabMenu);

// Messages sent to the resident for each status change
const STATUS_MESSAGES = {
    processing: r => `BarangayDocs: Your request ${r.referenceNo} (${r.documentType}) is now being processed.`,
    approved:   r => `BarangayDocs: Your request ${r.referenceNo} (${r.documentType}) has been approved and is now waiting for the authorized signature. We'll notify you once it's ready for pickup.`,
    ready:      r => `BarangayDocs: Ref ${r.referenceNo} (${r.documentType}) is READY for pickup.`,
    released:   r => `BarangayDocs: Ref ${r.referenceNo} (${r.documentType}) has been released. Thank you!`,
    rejected:   r => `BarangayDocs: Request ${r.referenceNo} was rejected.${r.rejectReason ? ' Reason: ' + r.rejectReason : ' Check the app for details.'}`
};

// Registers an in-app notification (Firestore "notifications") AND sends an SMS.
// Each channel is isolated so one failing never blocks the other.
async function notifyRequest(docId, status) {
    const makeMsg = STATUS_MESSAGES[status];
    if (!makeMsg) return;

    let r;
    try {
        const rs = await getDoc(doc(db, 'requests', docId));
        if (!rs.exists()) return;
        r = rs.data();
    } catch (err) { console.error('Notify: could not load request', err); return; }

    // Audit trail entry for this status change
    try {
        const extra = status === 'rejected' ? (r.rejectReason ? 'Reason: ' + r.rejectReason : '')
                    : status === 'approved' ? ('Doc code ' + (r.docCode || '—') + (r.expiresAt ? ', expires ' + formatExpiry(r.expiresAt) : ''))
                    : '';
        await addDoc(collection(db, 'auditLogs'), {
            action:       'request_' + status,
            targetType:   'request',
            targetId:     docId,
            referenceNo:  r.referenceNo || '',
            residentName: r.residentName || '',
            residentUid:  r.uid || '',
            documentType: r.documentType || '',
            details:      extra,
            adminUid:     auth.currentUser?.uid || '',
            adminEmail:   auth.currentUser?.email || '',
            createdAt:    serverTimestamp()
        });
    } catch (err) { console.error('Audit log failed (check Firestore rules):', err); }

    const message = makeMsg(r);

    // 1) In-app notification — this is what registers it for the resident
    try {
        if (r.uid) {
            await addDoc(collection(db, 'notifications'), {
                uid:         r.uid,
                requestId:   docId,
                referenceNo: r.referenceNo || '',
                type:        'request_status',
                status,
                title:       'Request ' + getBadgeLabel(status),
                message,
                read:        false,
                createdAt:   serverTimestamp()
            });
        } else {
            console.warn('Notify: request has no uid, in-app notification skipped');
        }
    } catch (err) { console.error('Notify: in-app notification failed (check Firestore rules)', err); }

    // 2) SMS
    try {
        let phone = r.contactNumber || null;
        if (r.uid) {
            const res = await getDoc(doc(db, 'residents', r.uid));
            if (res.exists()) {
                const d = res.data();
                phone = d.contactNumber || d.phone || d.mobile || phone;
            }
        }
        await sendSMS(phone, message);
    } catch (err) { console.error('Notify: SMS failed', err); }
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
        notifyRequest(docId, newStatus);

        // Update row UI
        renderStatusCell(row, newStatus, data.expiresAt);

        const actionCol = row.querySelector('.col-action');
        if (actionCol) {
            actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, newStatus)}</div>`;
            wireRowButtons(row, docId, { ...data, status: newStatus });
        }

        showToast(`✓ Request marked as ${getBadgeLabel(newStatus)}`);
        return true;

    } catch (err) {
        console.error('Update error:', err);
        showToast('Failed to update. Check Firestore rules.');
        return false;
    }
}

// Re-draw a row's status + action buttons after a status change
function refreshRow(row, docId, status, data) {
    if (!row) return;
    renderStatusCell(row, status, data.expiresAt);
    const actionCol = row.querySelector('.col-action');
    if (actionCol) {
        actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, status)}</div>`;
        wireRowButtons(row, docId, { ...data, status });
    }
}

// "Back" — move a request one step back if the admin misclicked.
// No SMS / in-app notification is sent for a step back (only an audit-log entry).
async function revertStatus(docId, row, data, toStatus) {
    // Legal lock: once the document is signed (Ready for Pickup) or released, it can never be moved back
    if (data.status === 'ready' || data.status === 'released') {
        showToast('Signed documents can no longer be moved back.');
        return false;
    }
    try {
        await updateDoc(doc(db, 'requests', docId), {
            status: toStatus,
            updatedAt: serverTimestamp()
        });
        try {
            await addDoc(collection(db, 'auditLogs'), {
                action:       'request_reverted_to_' + toStatus,
                targetType:   'request',
                targetId:     docId,
                referenceNo:  data.referenceNo || '',
                residentName: data.residentName || '',
                residentUid:  data.uid || '',
                documentType: data.documentType || '',
                details:      'Moved back from ' + (data.status || '—') + ' to ' + toStatus,
                adminUid:     auth.currentUser?.uid || '',
                adminEmail:   auth.currentUser?.email || '',
                createdAt:    serverTimestamp()
            });
        } catch (err) { console.error('Audit log failed:', err); }

        refreshRow(row, docId, toStatus, data);
        showToast(`↩ Moved back to ${getBadgeLabel(toStatus)}`);
        return true;
    } catch (err) {
        console.error('Revert error:', err);
        showToast('Failed to go back. Check Firestore rules.');
        return false;
    }
}

// =============================================
// Reject Modal
// =============================================
function openRejectModal(docId, row) {
    const overlay = document.getElementById('reject-modal');
    if (!overlay) return;
    const picker = mountRejectReasonPicker(document.getElementById('reject-reason'));
    picker.reset();
    overlay.classList.add('show');

    document.getElementById('confirm-reject').onclick = async () => {
        const { ok, reason, code, error } = picker.getResult();
        if (!ok) return alert(error);

        await updateDoc(doc(db, 'requests', docId), {
            status: 'rejected',
            rejectReason: reason,        // text residents see (fixed label or the "Other" text)
            rejectReasonCode: code,      // e.g. 'incomplete_info' or 'other'
            updatedAt: serverTimestamp()
        });

        notifyRequest(docId, 'rejected');

        renderStatusCell(row, 'rejected');
        const actionCol = row.querySelector('.col-action');
        if (actionCol) actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'rejected')}</div>`;

        overlay.classList.remove('show');
        picker.reset();
        showToast('Request rejected.');
    };

    document.getElementById('cancel-reject').onclick = () => {
        overlay.classList.remove('show');
        picker.reset();
    };
    // bottom "Cancel" button now works too
    document.getElementById('cancel-reject-btn').onclick = document.getElementById('cancel-reject').onclick;
}

// =============================================
// Approve + QR Modal (step 3)
// Generates doc code + QR, sets expiry, saves status = 'approved'
// (Awaiting Signature) and notifies the resident.
// =============================================
async function openApproveModal(docId, data, row) {
    const overlay = document.getElementById('qr-modal');
    if (!overlay) return;

    // Always use the latest saved data so preview edits (docOverrides) are included
    let latest = data;
    try {
        const snap = await getDoc(doc(db, 'requests', docId));
        if (snap.exists()) latest = snap.data();
    } catch (err) { console.error(err); }

    // Keep the same doc code if one was already generated
    const docCode = latest.docCode
        || `BRY-DOC-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 90000))}`;
    const resName = latest.docOverrides?.residentName || latest.residentName;

    const titleEl = overlay.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = 'Generate QR Code';

    document.getElementById('modal-doc-code').textContent = docCode;
    document.getElementById('modal-ref-no').textContent   = latest.referenceNo;
    document.getElementById('modal-resident').textContent = resName;
    document.getElementById('modal-doc-type').textContent = latest.documentType;

    const pickerEl  = document.getElementById('expiry-picker');
    const expiryRow = document.getElementById('modal-expiry-row');
    if (pickerEl)  pickerEl.style.display  = '';
    if (expiryRow) expiryRow.style.display = 'none';
    prefillExpiry();

    overlay.classList.add('show');

    const tempQr = `REF:${latest.referenceNo}|CODE:${docCode}|RES:${resName}|DOC:${latest.documentType}`;
    setTimeout(() => generateQRCode('qr-canvas', tempQr), 100);

    const confirmBtn = document.getElementById('confirm-ready');
    const cancelBtn  = document.getElementById('cancel-ready');
    confirmBtn.style.display = '';
    confirmBtn.disabled      = false;
    confirmBtn.textContent   = 'Generate QR & Approve';
    cancelBtn.style.display  = '';
    cancelBtn.textContent    = 'Cancel';
    cancelBtn.onclick = () => { overlay.classList.remove('show'); resetQRModal(); };

    confirmBtn.onclick = async () => {
        const expiry = getExpiryDate();
        if (!expiry) return; // validation failed — error shown inline

        const qrContent = `REF:${latest.referenceNo}|CODE:${docCode}|RES:${resName}|DOC:${latest.documentType}|EXP:${expiry.toISOString().split('T')[0]}`;
        generateQRCode('qr-canvas', qrContent);

        confirmBtn.disabled    = true;
        confirmBtn.textContent = 'Saving…';

        try {
            await updateDoc(doc(db, 'requests', docId), {
                status:     'approved',
                docCode,
                qrContent,
                expiresAt:  expiry,
                approvedAt: serverTimestamp(),
                updatedAt:  serverTimestamp()
            });

            notifyRequest(docId, 'approved');

            const newData = { ...latest, status: 'approved', docCode, qrContent, expiresAt: expiry };
            renderStatusCell(row, 'approved', expiry);
            const actionCol = row.querySelector('.col-action');
            if (actionCol) {
                actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'approved')}</div>`;
                wireRowButtons(row, docId, newData);
            }

            // Switch the modal into "Awaiting Signature" state (QR stays visible)
            if (titleEl) titleEl.textContent = 'QR Generated';
            if (pickerEl) pickerEl.style.display = 'none';
            if (expiryRow) {
                expiryRow.style.display = '';
                const disp = document.getElementById('modal-expiry-display');
                if (disp) disp.textContent = formatExpiry(expiry);
            }
            cancelBtn.style.display = 'none';
            confirmBtn.disabled     = false;
            confirmBtn.textContent  = 'Awaiting Signature';
            confirmBtn.onclick = () => { overlay.classList.remove('show'); resetQRModal(); };

            showToast('✓ Approved. Waiting for the authorized signature.');
        } catch (err) {
            console.error(err);
            showToast('Failed to approve. Check Firestore rules.');
            confirmBtn.disabled    = false;
            confirmBtn.textContent = 'Generate QR & Approve';
        }
    };
}

// Put the shared QR modal back to its default look
function resetQRModal() {
    const overlay = document.getElementById('qr-modal');
    if (!overlay) return;
    const titleEl = overlay.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = 'QR Code';
    const confirmBtn = document.getElementById('confirm-ready');
    const cancelBtn  = document.getElementById('cancel-ready');
    if (confirmBtn) { confirmBtn.style.display = ''; confirmBtn.disabled = false; }
    if (cancelBtn)  { cancelBtn.style.display = ''; cancelBtn.textContent = 'Cancel'; }
    const pickerEl  = document.getElementById('expiry-picker');
    const expiryRow = document.getElementById('modal-expiry-row');
    if (pickerEl)  pickerEl.style.display  = '';
    if (expiryRow) expiryRow.style.display = 'none';
}

// =============================================
// Mark as Ready (step 4) — runs from the preview modal after signing
// =============================================
async function markRequestReady(docId, row, data, btn, expiry = null) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const update = {
            status:    'ready',
            readyAt:   serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        let finalExpiry = data.expiresAt;
        if (expiry) {                                   // expiry may have been changed in the preview
            finalExpiry = expiry;
            update.expiresAt = expiry;
            update.qrContent = buildQrContent(data, data.docCode, expiry);
        }
        await updateDoc(doc(db, 'requests', docId), update);
        notifyRequest(docId, 'ready');

        renderStatusCell(row, 'ready', finalExpiry);
        const actionCol = row.querySelector('.col-action');
        if (actionCol) {
            actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'ready')}</div>`;
            wireRowButtons(row, docId, { ...data, status: 'ready', expiresAt: finalExpiry, ...(update.qrContent ? { qrContent: update.qrContent } : {}) });
        }
        showToast('✓ Ready for pickup. Next: mark as released once handed over.');
        // auto-open the next step: Mark as Released
        openDocumentModal(docId, { ...data, status: 'ready', expiresAt: finalExpiry }, { mode: 'release', row });
    } catch (err) {
        console.error(err);
        showToast('Failed to update. Check Firestore rules.');
        if (btn) { btn.disabled = false; btn.textContent = '✓ Signed — Mark as Ready'; }
    }
}

// =============================================
// Expiration picker inside the "Preview & Approve" document preview.
// Changing it updates the certificate (expiration + QR) live.
// =============================================
function makeDocCode() {
    return `BRY-DOC-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 90000))}`;
}

function buildQrContent(req, code, expiry) {
    const resName = req.docOverrides?.residentName || req.residentName;
    return `REF:${req.referenceNo}|CODE:${code}|RES:${resName}|DOC:${req.documentType}` +
           (expiry ? `|EXP:${expiry.toISOString().split('T')[0]}` : '');
}

function setupPreviewExpiryPicker(overlay, req, docCode, initialExpiry = null) {
    overlay.querySelector('#dp-expiry-bar')?.remove();

    if (!document.getElementById('dp-expiry-style')) {
        const st = document.createElement('style');
        st.id = 'dp-expiry-style';
        st.textContent = `
          .dp-expiry-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 20px; background:#fff; border-bottom:1.5px solid #D0DCF0; flex-shrink:0; }
          .dp-expiry-bar .dp-exp-label { font-size:11px; font-weight:800; color:#6B7A99; text-transform:uppercase; letter-spacing:.4px; margin-right:4px; }
          .dp-expiry-bar select, .dp-expiry-bar input { height:36px; border:1.5px solid #D0DCF0; border-radius:8px; background:#fff; padding:0 10px; font-family:'Nunito',sans-serif; font-size:13px; font-weight:700; color:#1B3A6B; outline:none; }
          .dp-expiry-bar input { width:90px; }
          .dp-expiry-bar .dp-exp-error { display:none; width:100%; font-size:11px; font-weight:800; color:#DC3545; }
        `;
        document.head.appendChild(st);
    }

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const bar = document.createElement('div');
    bar.id = 'dp-expiry-bar';
    bar.className = 'dp-expiry-bar';
    bar.innerHTML = `
        <span class="dp-exp-label">Expiration Date <b style="color:#DC3545">*</b></span>
        <select id="dpx-month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select>
        <select id="dpx-day"><option value="">Day</option></select>
        <input id="dpx-year" type="number" placeholder="Year" min="2024" max="2099">
        <span id="dpx-error" class="dp-exp-error"></span>`;
    const scroll = overlay.querySelector('.doc-preview-scroll');
    scroll.parentNode.insertBefore(bar, scroll);

    const monthEl = bar.querySelector('#dpx-month');
    const dayEl   = bar.querySelector('#dpx-day');
    const yearEl  = bar.querySelector('#dpx-year');

    // default: the saved expiry (Mark as Ready) or 1 year from today (Approve)
    let next = null;
    if (initialExpiry) {
        const d = initialExpiry?.toDate ? initialExpiry.toDate() : new Date(initialExpiry);
        if (!isNaN(d)) next = d;
    }
    if (!next) {
        next = new Date();
        next.setFullYear(next.getFullYear() + 1);
    }
    monthEl.value = next.getMonth() + 1;
    yearEl.value  = next.getFullYear();
    refreshDayOptions(next.getMonth() + 1, next.getFullYear(), next.getDate(), 'dpx');

    // live update of the certificate
    const refresh = () => {
        const exp = getExpiryDate('dpx', true);
        setText('dp-expiration', exp ? formatExpiry(exp) : '—');
        if (exp) generateQRCode('dp-qr-canvas', buildQrContent(req, docCode, exp));
    };
    monthEl.addEventListener('change', () => {
        refreshDayOptions(parseInt(monthEl.value), parseInt(yearEl.value), null, 'dpx');
        refresh();
    });
    yearEl.addEventListener('input', () => {
        refreshDayOptions(parseInt(monthEl.value), parseInt(yearEl.value), null, 'dpx');
        refresh();
    });
    dayEl.addEventListener('change', refresh);

    setText('dp-doc-code', docCode);
    refresh();
    setTimeout(refresh, 200);   // the QR canvas is created ~120ms after the preview opens
}

// Approve straight from the preview: saves expiry, doc code and QR, then closes the preview
async function approveFromPreview(docId, rowData, row, expiry, docCode, btn, overlay) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
        let latest = rowData;
        const snap = await getDoc(doc(db, 'requests', docId));   // pick up edits made in the preview
        if (snap.exists()) latest = snap.data();

        const code      = latest.docCode || docCode;
        const qrContent = buildQrContent(latest, code, expiry);

        await updateDoc(doc(db, 'requests', docId), {
            status:     'approved',
            docCode:    code,
            qrContent,
            expiresAt:  expiry,
            approvedAt: serverTimestamp(),
            updatedAt:  serverTimestamp()
        });
        notifyRequest(docId, 'approved');

        const newData = { ...latest, status: 'approved', docCode: code, qrContent, expiresAt: expiry };
        renderStatusCell(row, 'approved', expiry);
        const actionCol = row.querySelector('.col-action');
        if (actionCol) {
            actionCol.innerHTML = `<div class="action-row">${getActionButtons(docId, 'approved')}</div>`;
            wireRowButtons(row, docId, newData);
        }
        showToast('✓ Approved. Next: get it signed, then mark it as ready.');
        // auto-open the next step: Signed — Mark as Ready
        openDocumentModal(docId, newData, { mode: 'ready', row });
    } catch (err) {
        console.error(err);
        showToast('Failed to approve. Check Firestore rules.');
        btn.disabled = false;
        btn.textContent = '✓ Approve';
    }
}

// =============================================
// View Request modal (step 1) — details + Process / Reject
// Built in JS so no HTML change is needed.
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

    console.log('[BarangayDocs] resident fields:', Object.keys(rd));
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
        mk('Reject', 'modal-btn-cancel', () => { close(); openRejectModal(docId, row); });
    }
    if (r.status === 'pending') {
        mk('Process', 'modal-btn-save', async () => {
            close();
            const nd = { ...data, ...r };
            const ok = await updateRequestStatus(docId, 'processing', row, nd);
            // auto-open the next step: Preview & Approve
            if (ok) openDocumentModal(docId, { ...nd, status: 'processing' }, { mode: 'approve', row });
        });
    }
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
async function openDocumentModal(docId, data, opts = {}) {
    // Always fetch latest from Firestore so all fields are current
    const snap   = await getDoc(doc(db, 'requests', docId));
    const r      = snap.exists() ? snap.data() : data;

    // Also fetch resident profile for age/occupation
    let residentData = {};
    if (r.uid) {
        const resSnap = await getDoc(doc(db, 'residents', r.uid));
        if (resSnap.exists()) residentData = resSnap.data();
    }

    await populateAndShowDocModal(r, residentData, docId, opts, data);
}

async function populateAndShowDocModal(r, residentData, docId, opts = {}, rowData = {}) {
    const overlay = document.getElementById('doc-preview-modal');
    if (!overlay) return;

    // Issue date — approvedAt (when QR was generated/printed), else readyAt, else today
    const issueDate = r.approvedAt?.toDate ? r.approvedAt.toDate()
                    : r.readyAt?.toDate    ? r.readyAt.toDate()
                    : new Date();
    const day   = issueDate.getDate();
    const month = issueDate.toLocaleString('en-PH', { month: 'long' }).toUpperCase();
    const year  = issueDate.getFullYear();

    // "Issued in" = the formatted issue date (e.g. "MAY 11, 2026")
    const issuedInDate = issueDate.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    }).toUpperCase();

    // Resident age — compute from dateOfBirth if available, else read age field directly
    const age = resolveAge(residentData, r);
    const address = resolveAddress(residentData, r);

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
    if (address) setText('dp-address', address);
    setText('dp-occupation',   occupation);
    setText('dp-day',          ordinal(day));
    setText('dp-month',        month);
    setText('dp-year',         year);
    setText('dp-doc-code',     r.docCode       || '—');
    setText('dp-ref-no',       r.referenceNo   || '—');
    setText('dp-issued-in',    issuedInDate);
    setText('dp-expiration',   formatExpiry(r.expiresAt));
    setText('dp-issued-in-2',  issuedInDate);

    // Apply admin corrections saved on the request (docOverrides) — resident profile is untouched
    const enrichedResident = { ...residentData };
    if (age !== '—')  { enrichedResident.age = age; enrichedResident.birthday = enrichedResident.birthday || residentData.birthDate || residentData.dateOfBirth || residentData.dob; }
    if (address)      { enrichedResident.address = address; }
    paintDocument(effectiveValues(baseValues(r, enrichedResident), r.docOverrides));
    // paintDocument may blank fields it can't map — make sure age/address still show
    if (!r.docOverrides?.age     && age !== '—') setText('dp-age', age);
    if (!r.docOverrides?.address && address)     setText('dp-address', address);

    // Tell the document editor which request is being previewed
    window.BarangayDocEditor?.attach(docId, r);

    // Expiration picker only exists while approving; drop any leftover from a previous open
    overlay.querySelector('#dp-expiry-bar')?.remove();
    const approving  = (opts.mode === 'approve' || opts.mode === 'ready') && opts.row;
    const approveCode = r.docCode || makeDocCode();

    // QR code
    const qrWrap = document.getElementById('dp-qr-wrap');
    if (qrWrap) {
        qrWrap.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'dp-qr-canvas';
        qrWrap.appendChild(canvas);
        setTimeout(() => generateQRCode('dp-qr-canvas', r.qrContent || r.referenceNo || 'NO-QR'), 120);
    }

    // Admin-made template for this document type? Show it instead of the built-in certificate.
    const legacyEl = document.getElementById('doc-preview-content');
    const wrapEl   = overlay.querySelector('.doc-preview-wrapper');
    let tplEl      = document.getElementById('doc-preview-template');
    let tpl        = await fetchLatestTemplate(r.documentType);
    try {
    if (tpl && legacyEl) {
        if (!tplEl) {
            tplEl = document.createElement('div');
            tplEl.id = 'doc-preview-template';
            legacyEl.parentNode.insertBefore(tplEl, legacyEl);
        }
        if (!templateView || templateView.container !== tplEl) {
            templateView = (await getTemplateLib()).createTemplateView(tplEl);
            templateView.container = tplEl;
        }
        tplEl.style.display = '';
        legacyEl.style.display = 'none';
        if (wrapEl) wrapEl.style.maxWidth = '1000px';
    } else {
        if (templateView) templateView.hide();
        if (tplEl) tplEl.style.display = 'none';
        if (legacyEl) legacyEl.style.display = '';
        if (wrapEl) wrapEl.style.maxWidth = '';
    }
    } catch (err) {
        console.warn('Template preview setup failed, using built-in certificate:', err);
        tpl = null;
        if (legacyEl) legacyEl.style.display = '';
        if (wrapEl) wrapEl.style.maxWidth = '';
    }

    overlay.classList.add('show');

    // "Edited details" comparison — only appears when the admin has actually changed something
    const baseForCompare = baseValues(r, enrichedResident);
    let compareOn = false;
    let latestOverrides = r.docOverrides;
    let lastKey = JSON.stringify(r.docOverrides || null);
    let prevMaxWidth = '';
    overlay.querySelector('#dp-compare-view')?.remove();
    const scrollNode = overlay.querySelector('.doc-preview-scroll');
    if (scrollNode) scrollNode.style.display = '';

    // Copy of a rendered document: canvases (QR) become images, ids are dropped so nothing clashes
    const cloneForCompare = (node) => {
        const clone = node.cloneNode(true);
        const src = node.querySelectorAll('canvas'), dst = clone.querySelectorAll('canvas');
        src.forEach((c, i) => {
            try {
                const img = document.createElement('img');
                img.src = c.toDataURL('image/png');
                img.style.cssText = `width:${c.style.width || c.width + 'px'};height:${c.style.height || c.height + 'px'};display:block;`;
                dst[i]?.replaceWith(img);
            } catch (e) { /* tainted canvas — skip */ }
        });
        clone.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
        clone.removeAttribute('id');
        clone.style.display = '';
        clone.style.maxWidth = 'none';
        return clone;
    };

    const paintLive = (ov) => {
        paintDocument(effectiveValues(baseForCompare, ov));
        if (!ov?.age     && age !== '—') setText('dp-age', age);
        if (!ov?.address && address)     setText('dp-address', address);
    };

    // Render the document with the given overrides, copy it, and leave the live view as it was
    const snapshotDoc = async (ov) => {
        const usingTpl = tpl && templateView && tplEl && tplEl.style.display !== 'none';
        if (usingTpl) {
            await templateView.show({ template: tpl, request: r, resident: residentData, overrides: ov });
            return cloneForCompare(tplEl);
        }
        paintLive(ov);
        return cloneForCompare(legacyEl);
    };

    const renderCompare = async () => {
        const had = overlay.querySelector('#dp-compare-view');
        had?.remove();
        const sc = overlay.querySelector('.doc-preview-scroll');
        if (!compareOn) {
            if (had) {
                if (sc) sc.style.display = '';
                if (wrapEl) wrapEl.style.maxWidth = prevMaxWidth;
            }
            return;
        }
        try {
            const orig   = await snapshotDoc(undefined);        // without the admin's corrections
            const edited = await snapshotDoc(latestOverrides);  // with them (live view ends in this state)

            if (!document.getElementById('dp-compare-style')) {
                const st = document.createElement('style');
                st.id = 'dp-compare-style';
                st.textContent = `
                  #dp-compare-view { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:14px 20px; background:#E8EEF8; flex:1; min-height:0; overflow:auto; font-family:'Nunito',sans-serif; }
                  .dp-cmp-col { min-width:0; }
                  .dp-cmp-label { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; color:#6B7A99; margin-bottom:6px; }
                  .dp-cmp-new .dp-cmp-label { color:#146C43; }
                  .dp-cmp-doc { overflow:hidden; background:#fff; border:2px solid #D0DCF0; border-radius:8px; padding:8px; }
                  .dp-cmp-new .dp-cmp-doc { border-color:#146C43; }
                  @media (max-width:900px) { #dp-compare-view { grid-template-columns:1fr; } }
                `;
                document.head.appendChild(st);
            }

            const view = document.createElement('div');
            view.id = 'dp-compare-view';
            const mkCol = (label, cls, node) => {
                const col = document.createElement('div');
                col.className = 'dp-cmp-col ' + cls;
                col.innerHTML = `<div class="dp-cmp-label">${label}</div><div class="dp-cmp-doc"></div>`;
                col.querySelector('.dp-cmp-doc').appendChild(node);
                return col;
            };
            view.append(mkCol('Original', '', orig), mkCol('Edited — current', 'dp-cmp-new', edited));

            if (wrapEl) wrapEl.style.maxWidth = '1500px';
            if (sc) { sc.parentNode.insertBefore(view, sc); sc.style.display = 'none'; }

            // shrink each certificate to fit its column
            view.querySelectorAll('.dp-cmp-doc').forEach(d => {
                const inner = d.firstElementChild;
                const natural = inner.scrollWidth || inner.offsetWidth;
                const avail = d.clientWidth - 16;
                d.style.zoom = natural > avail && natural > 0 ? String(avail / natural) : '1';
            });
        } catch (err) {
            console.warn('Comparison failed:', err);
            showToast('Could not build the comparison.');
            compareOn = false;
            if (sc) sc.style.display = '';
            if (wrapEl) wrapEl.style.maxWidth = prevMaxWidth;
            renderChangesBar(overlay, baseForCompare, latestOverrides, cmpCtl());
        }
    };

    const toggleCompare = () => {
        if (overlay.querySelector('.doc-preview-wrapper.dp-editing')) { showToast('Save or cancel your edits first.'); return; }
        if (!compareOn) prevMaxWidth = wrapEl ? wrapEl.style.maxWidth : '';
        compareOn = !compareOn;
        renderChangesBar(overlay, baseForCompare, latestOverrides, cmpCtl());
        renderCompare();
    };
    const cmpCtl = () => ({ on: compareOn, toggle: toggleCompare });

    renderChangesBar(overlay, baseForCompare, r.docOverrides, cmpCtl());
    watchChanges(overlay, docId, (ov) => {
        const key = JSON.stringify(ov || null);
        if (key === lastKey) return;                     // nothing about the edits changed
        lastKey = key;
        latestOverrides = ov;
        const n = renderChangesBar(overlay, baseForCompare, ov, cmpCtl());
        if (!n) compareOn = false;                       // no edits left → leave comparison
        renderCompare();
    });

    if (approving) setupPreviewExpiryPicker(overlay, r, approveCode, opts.mode === 'ready' ? r.expiresAt : null);

    document.getElementById('dp-close')?.addEventListener('click', () => {
        stopChangesWatch();
        overlay.classList.remove('show');
    }, { once: true });

    document.getElementById('dp-print')?.addEventListener('click', () => {
        printDocument();
    }, { once: true });

    // Step 2 / 4 action button (only when opened from Preview & Approve / Mark as Ready)
    document.querySelectorAll('#dp-approve, #dp-ready, #dp-release').forEach(b => b.remove());
    overlay.querySelector('#dp-step-bar')?.remove();
    if (opts.mode && opts.row) {
        const printBtn = document.getElementById('dp-print');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dp-btn dp-btn-primary';
        // Block while the editor panel is open (unsaved edits would be missed)
        const isEditing = () => !!overlay.querySelector('.doc-preview-wrapper.dp-editing');
        const cur = { ...rowData, ...r };

        // Each step: its main button, and where "Back" goes
        const STEPS = {
            approve: { label: '✓ Approve',                 back: { to: 'pending',    label: '← Back to Request' } },
            ready:   { label: '✓ Signed — Mark as Ready',  back: { to: 'processing', label: '← Back to Preview & Approve' } },
            release: { label: '✓ Mark as Released',        back: null }   // signed = locked, no way back
        };
        const step = STEPS[opts.mode];
        if (step) {
            b.id = 'dp-' + (opts.mode === 'approve' ? 'approve' : opts.mode === 'ready' ? 'ready' : 'release');
            b.textContent = step.label;
            b.onclick = async () => {
                if (isEditing()) { showToast('Save or cancel your edits first.'); return; }
                if (opts.mode === 'release') {
                    b.disabled = true;
                    const ok = await updateRequestStatus(docId, 'released', opts.row, cur);
                    if (ok) overlay.classList.remove('show'); else b.disabled = false;
                    return;
                }
                const expiry = getExpiryDate('dpx');          // validates + shows the error in the bar
                if (!expiry) return;
                if (opts.mode === 'approve') approveFromPreview(docId, cur, opts.row, expiry, approveCode, b, overlay);
                else                         markRequestReady(docId, opts.row, cur, b, expiry);
            };
            // One set of step buttons only (bottom bar): Back (left) + blue Next (right)
            if (!document.getElementById('dp-step-style')) {
                const st = document.createElement('style');
                st.id = 'dp-step-style';
                st.textContent = `
                  .dp-step-btn { height:40px; padding:0 20px; border-radius:10px; font-family:'Nunito',sans-serif; font-size:14px; font-weight:800; cursor:pointer; border:1.5px solid #1B3A6B; transition:background .15s, color .15s; }
                  .dp-step-back { background:#fff; color:#1B3A6B; }
                  .dp-step-back:hover:not(:disabled) { background:#EEF2F9; }
                  .dp-step-next { background:#1B3A6B; color:#fff; }
                  .dp-step-next:hover:not(:disabled) { background:#142C52; }
                  .dp-step-btn:disabled { opacity:.55; cursor:not-allowed; }
                `;
                document.head.appendChild(st);
            }
            b.className = 'dp-step-btn dp-step-next';

            const bar = document.createElement('div');
            bar.id = 'dp-step-bar';
            bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px;background:#fff;border-top:1.5px solid #D0DCF0;flex-shrink:0;';
            let backBtn = null;
            if (step.back) {
                backBtn = document.createElement('button');
                backBtn.type = 'button';
                backBtn.className = 'dp-step-btn dp-step-back';
                backBtn.textContent = step.back.label;
                bar.append(backBtn, b);
            } else {
                const lock = document.createElement('span');
                lock.style.cssText = "font-family:'Nunito',sans-serif;font-size:12px;font-weight:800;color:#6B7A99;";
                lock.textContent = '🔒 Signed and issued — this can no longer be moved back.';
                bar.append(lock, b);
            }

            if (backBtn) backBtn.onclick = async () => {
                if (isEditing()) { showToast('Save or cancel your edits first.'); return; }
                backBtn.disabled = true;
                const ok = await revertStatus(docId, opts.row, cur, step.back.to);
                if (!ok) { backBtn.disabled = false; return; }
                const prev = { ...cur, status: step.back.to };
                overlay.querySelector('#dp-expiry-bar')?.remove();
                if (opts.mode === 'approve') {
                    overlay.classList.remove('show');
                    openRequestModal(docId, prev, opts.row);   // back to step 1
                } else {
                    openDocumentModal(docId, prev, { mode: opts.mode === 'ready' ? 'approve' : 'ready', row: opts.row });
                }
            };

            const scrollEl = overlay.querySelector('.doc-preview-scroll');
            if (scrollEl) scrollEl.parentNode.insertBefore(bar, scrollEl.nextSibling);
        }
    }

    // fixed-size pages + the admin's corrections (docOverrides); docedit.js live edits re-render via paintDocument
    if (tpl && legacyEl && templateView) {
        try {
            await templateView.show({ template: tpl, request: r, resident: residentData, overrides: r.docOverrides });
        } catch (err) {
            console.warn('Template render failed, using built-in certificate:', err);
            templateView.hide();
            legacyEl.style.display = '';
            if (wrapEl) wrapEl.style.maxWidth = '';
        }
    }
}

// =============================================
// "Edited details" bar — original vs. changed, shown only when edits exist.
// Live: follows the request document, so it updates right after the editor saves.
// =============================================
let changesUnsub = null;
function stopChangesWatch() {
    if (changesUnsub) { changesUnsub(); changesUnsub = null; }
}

function prettyKey(k) {
    return String(k).replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
}
function showVal(v) {
    if (v === undefined || v === null || String(v).trim() === '') return '—';
    return String(v);
}

function renderChangesBar(overlay, base, overrides, cmp) {
    overlay.querySelector('#dp-changes-bar')?.remove();

    const isPrim = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
    const changed = Object.keys(overrides || {}).filter(k =>
        isPrim(overrides[k]) && showVal(overrides[k]) !== showVal(base?.[k])
    );
    if (!changed.length) return 0;                     // nothing edited → nothing shown

    if (!document.getElementById('dp-changes-style')) {
        const st = document.createElement('style');
        st.id = 'dp-changes-style';
        st.textContent = `
          .dp-changes-bar { padding:10px 20px; background:#FFF8E6; border-bottom:1.5px solid #F0D9A0; flex-shrink:0; max-height:180px; overflow:auto; font-family:'Nunito',sans-serif; }
          .dp-changes-bar .dp-chg-title { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:11px; font-weight:800; color:#8A6200; text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px; }
          .dp-changes-bar .dp-chg-cmp { height:30px; padding:0 12px; border-radius:8px; border:1.5px solid #1B3A6B; background:#fff; color:#1B3A6B; font-family:'Nunito',sans-serif; font-size:12px; font-weight:800; cursor:pointer; text-transform:none; letter-spacing:0; white-space:nowrap; }
          .dp-changes-bar .dp-chg-cmp:hover { background:#EEF2F9; }
          .dp-changes-bar table { width:100%; border-collapse:collapse; font-size:12px; }
          .dp-changes-bar th { text-align:left; font-size:10px; font-weight:800; color:#6B7A99; text-transform:uppercase; padding:2px 8px 4px 0; }
          .dp-changes-bar td { padding:3px 8px 3px 0; vertical-align:top; color:#1B3A6B; font-weight:700; overflow-wrap:anywhere; }
          .dp-changes-bar td.dp-old { color:#6B7A99; text-decoration:line-through; font-weight:600; }
          .dp-changes-bar td.dp-new { color:#146C43; }
        `;
        document.head.appendChild(st);
    }

    const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const bar = document.createElement('div');
    bar.id = 'dp-changes-bar';
    bar.className = 'dp-changes-bar';
    bar.innerHTML = `
        <div class="dp-chg-title">
            <span>✎ Edited details (${changed.length}) — original vs. changed</span>
            <button type="button" class="dp-chg-cmp">${cmp?.on ? '✕ Close comparison' : '⇄ Compare side by side'}</button>
        </div>
        <table>
            <tr><th>Field</th><th>Original</th><th>Changed to</th></tr>
            ${changed.map(k => `<tr><td>${esc(prettyKey(k))}</td><td class="dp-old">${esc(showVal(base?.[k]))}</td><td class="dp-new">${esc(showVal(overrides[k]))}</td></tr>`).join('')}
        </table>`;
    const scroll = overlay.querySelector('.doc-preview-scroll');
    if (scroll) scroll.parentNode.insertBefore(bar, scroll);
    bar.querySelector('.dp-chg-cmp').onclick = () => cmp?.toggle();
    return changed.length;
}

function watchChanges(overlay, docId, onData) {
    stopChangesWatch();
    changesUnsub = onSnapshot(doc(db, 'requests', docId), (snap) => {
        if (!overlay.classList.contains('show')) { stopChangesWatch(); return; }
        onData(snap.exists() ? snap.data().docOverrides : null);
    }, (err) => console.warn('Changes watch failed:', err));
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

// Turn whatever is stored as a birth date (string, Timestamp, Date, ms) into a Date
function parseBirthDate(v) {
    if (!v) return null;
    if (v?.toDate) return v.toDate();                       // Firestore Timestamp
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    if (typeof v === 'number') return new Date(v);
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);          // YYYY-MM-DD
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);             // MM/DD/YYYY
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    const d = new Date(s);                                              // "May 4, 2001" etc.
    return isNaN(d) ? null : d;
}

const BIRTH_KEYS = ['birthday', 'birthDate', 'birthdate', 'dateOfBirth', 'dob', 'birth_date', 'date_of_birth', 'bday'];
const AGE_KEYS   = ['age', 'Age'];

// sources = resident profile first, then the request doc itself as a fallback
function findBirthDate(...sources) {
    for (const src of sources) {
        if (!src) continue;
        for (const k of BIRTH_KEYS) {
            const d = parseBirthDate(src[k]);
            if (d) return d;
        }
        for (const k of Object.keys(src)) {                      // any key that looks like a birth date
            if (/birth|bday|dob/i.test(k) && !/place|age/i.test(k)) {
                const d = parseBirthDate(src[k]);
                if (d) return d;
            }
        }
        const y = src.birthYear || src.birth_year, mo = src.birthMonth || src.birth_month, da = src.birthDay || src.birth_day;
        if (y && mo && da) {
            const mIdx = isNaN(+mo) ? new Date(`${mo} 1, 2000`).getMonth() : +mo - 1;
            const d = new Date(+y, mIdx, +da);
            if (!isNaN(d)) return d;
        }
    }
    return null;
}

function formatBirthDate(...sources) {
    const d = findBirthDate(...sources);
    return d ? d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
}

function resolveAge(...sources) {
    const bd = findBirthDate(...sources);
    if (bd) return computeAge(bd);
    for (const src of sources) {
        if (!src) continue;
        for (const k of AGE_KEYS) {
            if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== '') return src[k];
        }
    }
    return '—';
}

function computeAge(dob) {
    const d = dob instanceof Date ? dob : parseBirthDate(dob);
    if (!d) return '—';
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    const mDiff = today.getMonth() - d.getMonth();
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < d.getDate())) age--;
    return age >= 0 ? age : '—';
}

const ID_KEYS = ['idUrl', 'idPhotoUrl', 'idImageUrl', 'validIdUrl', 'validId', 'idImage', 'idPicture',
                 'idFront', 'idFrontUrl', 'idBack', 'idBackUrl', 'governmentIdUrl', 'govIdUrl', 'idPhoto', 'id_url'];
const isImgSrc = v => typeof v === 'string' && /^(https?:|data:image)/i.test(v);

function findIdImages(rd, r) {
    const out = [];
    for (const src of [rd, r]) {
        if (!src) continue;
        for (const k of ID_KEYS) if (isImgSrc(src[k]) && !out.includes(src[k])) out.push(src[k]);
        for (const k of Object.keys(src)) {          // anything else that looks like an ID image
            if (/(^|[^a-z])id([^a-z]|$)|validid|govid|idcard|idphoto|idimage|idfront|idback/i.test(k)
                && !/face|selfie|profile|uid|docid|requestid/i.test(k)
                && isImgSrc(src[k]) && !out.includes(src[k])) out.push(src[k]);
        }
    }
    return out;
}

const ADDRESS_KEYS = ['address', 'fullAddress', 'homeAddress', 'home_address', 'residentAddress',
                      'currentAddress', 'completeAddress', 'streetAddress', 'location'];

// Full home address: a single stored string, or built from separate parts
function resolveAddress(...sources) {
    for (const src of sources) {
        if (!src) continue;
        for (const k of ADDRESS_KEYS) {
            const v = src[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (v && typeof v === 'object') {                  // address stored as a map
                const joined = Object.values(v).filter(x => typeof x === 'string' && x.trim()).join(', ');
                if (joined) return joined;
            }
        }
    }
    for (const src of sources) {
        if (!src) continue;
        const parts = [
            src.houseNo || src.houseNumber || src.blockLot,
            src.street,
            src.purok || src.zone || src.sitio,
            src.barangay,
            src.city || src.municipality,
            src.province
        ].filter(x => typeof x === 'string' ? x.trim() : x).map(x => String(x).trim());
        if (parts.length) {
            if (!src.barangay) parts.push('Barangay Banicain, Olongapo City, Zambales');
            return parts.join(', ');
        }
    }
    return '';
}

// =============================================
// Print / Save PDF — FIXED
// Embeds all certificate CSS + converts QR
// canvas to a static <img> so it prints correctly
// =============================================
function printDocument() {
    // Admin-made template: print the exact same pages that are shown in the preview
    if (templateView && templateView.active) {
        templateView.print('Barangay Document');
        return;
    }

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
        <div class="col-status">${statusCellHTML(data.status)}</div>
        ${isAllPage ? `<div class="col-validity">${validityCellHTML(data.status, data.expiresAt)}</div>` : ''}
        <div class="col-action">
            <div class="action-row">${getActionButtons(docId, data.status)}</div>
        </div>
    `;

    wireRowButtons(row, docId, data);
    return row;
}

// =============================================
// List Controller  (sort toggle + filters + pagination)
// =============================================
const PAGE_SIZE = 10;

function injectListStyles() {
    if (document.getElementById('list-controller-styles')) return;
    const s = document.createElement('style');
    s.id = 'list-controller-styles';
    s.textContent = `
        .sort-toggle-btn {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 8px 14px; border-radius: 8px; cursor: pointer;
            border: 1px solid #1B3A6B; background: #fff; color: #1B3A6B;
            font-size: 13px; font-weight: 600; font-family: inherit;
            margin-left: 8px; white-space: nowrap;
        }
        .sort-toggle-btn:hover { background: #1B3A6B; color: #fff; }
        .list-pager {
            display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 10px; padding: 14px 4px; font-size: 13px;
        }
        .list-pager .pager-info { color: var(--text-sub, #6b7280); }
        .list-pager .pager-btns { display: flex; gap: 6px; flex-wrap: wrap; }
        .list-pager button {
            min-width: 34px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
            border: 1px solid #d1d5db; background: #fff; color: #1B3A6B;
            font-size: 13px; font-family: inherit;
        }
        .list-pager button:hover:not(:disabled) { background: #eef2f9; }
        .list-pager button.active { background: #1B3A6B; color: #fff; border-color: #1B3A6B; }
        .list-pager button:disabled { opacity: .4; cursor: not-allowed; }
    `;
    document.head.appendChild(s);
}

function createListController(tbody, { emptyMsg, getTab }) {
    injectListStyles();

    const state = { docs: [], sort: 'newest', page: 1 };

    // ---- Sort button (placed next to the filter dropdown, else above the list) ----
    const sortBtn = document.createElement('button');
    sortBtn.type = 'button';
    sortBtn.className = 'sort-toggle-btn';
    const anchor = document.getElementById('doc-filter') || document.getElementById('search-input');
    if (anchor) anchor.insertAdjacentElement('afterend', sortBtn);
    else tbody.parentNode.insertBefore(sortBtn, tbody);

    // ---- Pager (below the list) ----
    const pager = document.createElement('div');
    pager.className = 'list-pager';
    tbody.insertAdjacentElement('afterend', pager);

    const timeOf = (d) => d.data().createdAt?.toMillis?.() ?? Date.now();

    function getFiltered() {
        const search    = document.getElementById('search-input')?.value.toLowerCase() || '';
        const docFilter = document.getElementById('doc-filter')?.value.toLowerCase() || 'all';
        const tab       = getTab ? getTab() : 'all';

        return state.docs.filter(d => {
            const data = d.data();
            const name = (data.residentName || '').toLowerCase();
            const type = (data.documentType || '').toLowerCase();
            const searchOk = name.includes(search) || type.includes(search);
            const docOk    = docFilter === 'all' || type.includes(docFilter);
            const tabOk    = tab === 'all' || data.status === tab;
            return searchOk && docOk && tabOk;
        });
    }

    function renderPager(total, totalPages) {
        pager.innerHTML = '';
        if (total === 0) return;

        const start = (state.page - 1) * PAGE_SIZE + 1;
        const end   = Math.min(state.page * PAGE_SIZE, total);

        const info = document.createElement('div');
        info.className = 'pager-info';
        info.textContent = `Showing ${start}–${end} of ${total}`;
        pager.appendChild(info);

        if (totalPages <= 1) return;

        const btns = document.createElement('div');
        btns.className = 'pager-btns';

        const mk = (label, page, { disabled = false, active = false } = {}) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.disabled = disabled;
            if (active) b.classList.add('active');
            b.addEventListener('click', () => { state.page = page; render(); });
            btns.appendChild(b);
        };

        mk('‹ Prev', state.page - 1, { disabled: state.page === 1 });

        // window of up to 5 page numbers around the current page
        let from = Math.max(1, state.page - 2);
        let to   = Math.min(totalPages, from + 4);
        from     = Math.max(1, to - 4);
        for (let p = from; p <= to; p++) mk(String(p), p, { active: p === state.page });

        mk('Next ›', state.page + 1, { disabled: state.page === totalPages });

        pager.appendChild(btns);
    }

    function render() {
        sortBtn.textContent = state.sort === 'newest' ? '↓ Newest first' : '↑ Oldest first';
        sortBtn.title = 'Click to switch sort order';

        const filtered = getFiltered().sort((a, b) =>
            state.sort === 'newest' ? timeOf(b) - timeOf(a) : timeOf(a) - timeOf(b)
        );

        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        if (state.page > totalPages) state.page = totalPages;

        tbody.innerHTML = '';

        if (filtered.length === 0) {
            const msg = state.docs.length === 0 ? emptyMsg : 'No matching requests.';
            tbody.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">${msg}</div>`;
            renderPager(0, 1);
            return;
        }

        const pageDocs = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
        pageDocs.forEach(docSnap => tbody.appendChild(buildRow(docSnap.id, docSnap.data())));
        renderPager(filtered.length, totalPages);
    }

    sortBtn.addEventListener('click', () => {
        state.sort = state.sort === 'newest' ? 'oldest' : 'newest';
        state.page = 1;
        render();
    });

    const resetAndRender = () => { state.page = 1; render(); };
    document.getElementById('search-input')?.addEventListener('input',  resetAndRender);
    document.getElementById('doc-filter')?.addEventListener('change', resetAndRender);

    return {
        setDocs(docs) { state.docs = docs; render(); },
        resetAndRender
    };
}

// =============================================
// Open a request straight from a link (used by the Dashboard)
//   ?open=<docId>                 -> runs that request's next step
//   ?open=<docId>&action=process  -> Process, then Preview & Approve
//   ?open=<docId>&action=reject   -> Reject popup
// Everything goes through the same popups as clicking the row here.
// =============================================
let deepLinkDone = false;
function handleDeepLink(docs) {
    if (deepLinkDone) return;
    const p = new URLSearchParams(location.search), id = p.get('open');
    if (!id) { deepLinkDone = true; return; }
    const snap = docs.find(d => d.id === id);
    if (!snap) return;                       // not in this list (yet)
    deepLinkDone = true;
    history.replaceState(null, '', location.pathname + location.hash);   // so a refresh doesn't repeat it

    const data = snap.data(), status = data.status, want = p.get('action');
    const row = document.querySelector(`.table-row[data-id="${id}"]`) || buildRow(id, data);
    if (want === 'reject' && (status === 'pending' || status === 'processing')) { openRejectModal(id, row); return; }
    if (want === 'process' && status === 'pending') {
        (async () => {
            const ok = await updateRequestStatus(id, 'processing', row, data);
            if (ok) openDocumentModal(id, { ...data, status: 'processing' }, { mode: 'approve', row });
        })();
        return;
    }
    const cfg = getActionConfig(status);
    if (cfg) runAction(cfg.primary.action, id, row, data);
}

// =============================================
// PENDING REQUESTS PAGE
// =============================================
function initPendingRequests() {
    const tbody = document.getElementById('requests-body');
    if (!tbody) return;

    const list = createListController(tbody, { emptyMsg: 'No pending requests.' });

    const q = query(
        collection(db, 'requests'),
        where('status', 'in', ['pending', 'processing', 'approved'])
    );

    onSnapshot(q, (snapshot) => {
        const countEl = document.getElementById('pendingCount');
        if (countEl) countEl.textContent = snapshot.size;
        list.setDocs(snapshot.docs);
        handleDeepLink(snapshot.docs);
    });
}

// =============================================
// ALL REQUESTS PAGE
// =============================================
function initAllRequests() {
    const tbody = document.getElementById('requests-body');
    if (!tbody) return;

    const list = createListController(tbody, {
        emptyMsg: 'No requests yet.',
        getTab: () => document.querySelector('.tab-btn.active')?.dataset.status || 'all'
    });

    onSnapshot(query(collection(db, 'requests')), (snapshot) => {
        list.setDocs(snapshot.docs);
        handleDeepLink(snapshot.docs);
    });

    document.querySelectorAll('.tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            list.resetAndRender();
        });
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
        query(collection(db, 'profileChangeRequests'), where('status', '==', 'pending')),
        (snap) => {
            const badge = el('profile-changes-badge');
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