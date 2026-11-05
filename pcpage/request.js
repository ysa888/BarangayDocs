// =============================================
// request.js
// Handles: barangaydocs_request.html
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
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
    getDocs,
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const el = (id) => document.getElementById(id);

// Live map of documentName → icon filename, populated from Firestore
const docsIconMap = {};

// =============================================
// Helpers
// =============================================
function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function generateRef() {
    const year = new Date().getFullYear();
    const rand = String(Math.floor(10000 + Math.random() * 90000));
    return `BRY-${year}-${rand}`; // Format: BRY-2026-XXXXX
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
}

// =============================================
// Auth Guard
// =============================================
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

    // Passed — init the page
    initPage(user, userData);
});

// =============================================
// Init Page
// =============================================
function initPage(user, userData) {
    const fullName = [
        userData.firstName,
        userData.middleName ? userData.middleName.charAt(0) + '.' : '',
        userData.lastName
    ].filter(Boolean).join(' ');

    // Populate sidebar
    const avatar = el('sidebarAvatar');
    const name = el('sidebarName');
    const role = el('sidebarRole');
    if (avatar) avatar.textContent = getInitials(fullName);
    if (name) name.textContent = fullName;
    if (role) role.textContent = 'Resident • Barangay Banicain';

    // Load active document types from Firestore (real-time)
    listenDocumentTypes();

    // Query without orderBy to avoid composite index requirement
    const q = query(
        collection(db, 'requests'),
        where('uid', '==', user.uid)
    );

    onSnapshot(q, (snapshot) => {
        // Sort client-side by createdAt descending
        const sorted = snapshot.docs.slice().sort((a, b) => {
            const aTime = a.data().createdAt?.toMillis?.() || 0;
            const bTime = b.data().createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        });
        renderRequestList(sorted, snapshot.empty);
    });

    // Submit request button
    el('submitRequestBtn')?.addEventListener('click', () => {
        submitRequest(user, userData, fullName);
    });

    // New request button
    document.querySelector('.new-req-btn')?.addEventListener('click', openModal);

    // Logout
    el('logoutBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        el('logoutModal')?.classList.add('show');
    });

    el('confirmLogout')?.addEventListener('click', async () => {
        await signOut(auth);
        window.location.href = 'barangaydocs_login.html';
    });
}

// =============================================
// Render Request List
// =============================================
function renderRequestList(sortedDocs, isEmpty) {
    const listEl = el('requestList');
    if (!listEl) return;

    listEl.querySelectorAll('.request-card').forEach(c => c.remove());

    const emptyState = el('emptyState');

    if (isEmpty || sortedDocs.length === 0) {
        if (emptyState) emptyState.classList.add('show');
        return;
    }
    if (emptyState) emptyState.classList.remove('show');

    sortedDocs.forEach(docSnap => {
        const card = buildRequestCard(docSnap.id, docSnap.data());
        listEl.insertBefore(card, emptyState);
    });

    const activeTab = document.querySelector('.tab.active');
    if (activeTab) filterByStatus(activeTab.dataset.status || 'all');
}

// =============================================
// Build Request Card
// =============================================
function buildRequestCard(id, r) {
    const statusConfig = {
        pending: { label: 'Submitted', cls: 'pending' },
        processing: { label: 'Processing', cls: 'processing' },
        approved: { label: 'Approved', cls: 'processing' },
        ready: { label: 'Ready for Pickup', cls: 'ready' },
        released: { label: 'Released', cls: 'ready' },
        rejected: { label: 'Rejected', cls: 'rejected' }
    };

    const cfg = statusConfig[r.status] || statusConfig.pending;
    const submitted = r.createdAt ? formatDate(r.createdAt) : '—';
    const pickup = r.readyAt ? formatDate(r.readyAt) : '—';

    const card = document.createElement('div');
    card.className = 'request-card';
    card.dataset.status = r.status;
    card.dataset.id = id;

    card.innerHTML = `
        <div class="card-top">
            <div class="req-icon">
                <img src="${docIcon(r.documentType)}" alt=""
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
                <div class="req-ph" style="display:none;"></div>
            </div>
            <div class="req-name">
                <h3>${r.documentType || '—'}</h3>
                <p>Ref: ${r.referenceNo || '—'} &bull; ${submitted}</p>
            </div>
            <span class="badge ${cfg.cls}">${cfg.label}</span>
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
                ${r.status === 'ready' || r.status === 'released' ? `
                <div>
                    <div class="d-label">Ready For Pickup</div>
                    <div class="d-val">${pickup}</div>
                </div>
                <div>
                    <div class="d-label">Document Code</div>
                    <div class="d-val" style="font-family:'Poppins',sans-serif;color:var(--primary);font-weight:800;">${r.docCode || r.referenceNo || '—'}</div>
                </div>
                <div>
                    <div class="d-label">Reference No</div>
                    <div class="d-val" style="font-family:'Poppins',sans-serif;color:var(--primary);font-weight:800;">${r.referenceNo || '—'}</div>
                </div>` : ''}
                ${r.status === 'rejected' && r.rejectReason ? `
                <div>
                    <div class="d-label">Reason</div>
                    <div class="d-val" style="color:var(--red);">${r.rejectReason}</div>
                </div>` : ''}
            </div>
            <button class="track-btn" data-id="${id}">Track Progress</button>
            ${(r.status === 'ready' || r.status === 'released') ? `<button class="view-doc-btn">View Document</button>` : ''}
        </div>
        <div class="progress-track" id="track-${id}">
            <div class="track-row">${buildTrackSteps(r.status)}</div>
        </div>
    `;

    // Wire track button
    card.querySelector('.track-btn').addEventListener('click', (e) => {
        const track = el(`track-${id}`);
        const btn = e.currentTarget;
        track.classList.toggle('show');
        btn.textContent = track.classList.contains('show') ? 'Hide' : 'Track Progress';
    });

    // Wire View Document button (only for ready/released)
    card.querySelector('.view-doc-btn')?.addEventListener('click', () => {
        openDocumentPreview(id, r);
    });

    return card;
}

// =============================================
// Build Track Steps
// =============================================
function buildTrackSteps(status) {
    const isRejected = status === 'rejected';

    const steps = isRejected
        ? [
            { label: 'Submitted', done: true, active: false, rejected: false },
            { label: 'Processing', done: false, active: false, rejected: true },
            { label: 'Rejected', done: false, active: true, rejected: true }
        ]
        : [
            { label: 'Submitted', done: ['processing', 'approved', 'ready', 'released'].includes(status), active: status === 'pending' },
            { label: 'Processing', done: ['approved', 'ready', 'released'].includes(status), active: status === 'processing' },
            { label: 'Approved', done: ['ready', 'released'].includes(status), active: status === 'approved' },
            { label: 'Ready for Pickup', done: status === 'released', active: status === 'ready' },
            { label: 'Released', done: false, active: status === 'released' }
        ];

    let html = '';
    steps.forEach((s, i) => {
        let dotClass = '';
        let content = i + 1;

        if (s.rejected) { dotClass = 'rejected'; content = '✕'; }
        else if (s.done) { dotClass = 'done'; content = '✓'; }
        else if (s.active) { dotClass = 'active'; }

        html += `
            <div class="track-step">
                <div class="track-dot ${dotClass}">${content}</div>
                <div class="track-label">${s.label}</div>
            </div>`;

        if (i < steps.length - 1) {
            html += `<div class="track-connector ${s.done && !isRejected ? 'done' : ''}"></div>`;
        }
    });

    return html;
}

// =============================================
// Listen to Active Document Types (real-time)
// =============================================
function listenDocumentTypes() {
    const q = query(
        collection(db, 'documents'),
        where('status', '==', 'active')
    );

    onSnapshot(q, (snapshot) => {
        const grid = el('docTypeGrid');
        if (!grid) return;

        // Rebuild the icon map
        Object.keys(docsIconMap).forEach(k => delete docsIconMap[k]);

        // Sort by name for consistent ordering
        const docs = snapshot.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        if (docs.length === 0) {
            grid.innerHTML = '<div class="doc-type-grid-empty">No documents available at this time.</div>';
            return;
        }

        // Rebuild icon map
        docs.forEach(d => { docsIconMap[d.name] = d.icon || 'Icons/barangayclearance.png'; });

        // Preserve the currently selected doc name (if any) across re-renders
        const prevSelected = grid.querySelector('.doc-type-btn.selected')?.dataset.name || null;

        // Render buttons
        grid.innerHTML = docs.map((d, i) => {
            const icon = d.icon || 'Icons/barangayclearance.png';
            const isFirst = i === 0;
            // Re-select previously selected doc; fall back to first
            const isSelected = prevSelected ? d.name === prevSelected : isFirst;
            return `
                <div class="doc-type-btn${isSelected ? ' selected' : ''}"
                     data-name="${d.name}"
                     onclick="selectDoc(this)">
                    <img class="doc-type-icon"
                         src="${icon}"
                         alt="${d.name}"
                         onerror="this.src='Icons/barangayclearance.png'">
                    ${d.name}
                </div>`;
        }).join('');
    });
}

// =============================================
// Submit Request
// =============================================
async function submitRequest(user, userData, fullName) {
    const selected = document.querySelector('.doc-type-btn.selected');
    if (!selected) return alert('Please select a document type.');

    const purpose = el('purposeSelect')?.value;
    if (!purpose) return alert('Please select a purpose.');

    const notes = el('notesInput')?.value.trim() || '';
    const docName = selected.dataset.name;
    const ref = generateRef();

    try {
        await addDoc(collection(db, 'requests'), {
            uid: user.uid,
            residentName: fullName,
            documentType: docName,
            purpose,
            notes,
            referenceNo: ref,
            status: 'pending',
            barangay: userData.barangay || 'Barangay Banicain',
            city: userData.city || 'Olongapo City',
            createdAt: serverTimestamp(),
            readyAt: null,
            rejectReason: null,
            docCode: null,
            qrContent: null
        });

        closeModal();
        if (el('successRef')) el('successRef').textContent = `Ref: ${ref}`;
        el('successOverlay')?.classList.add('show');

    } catch (err) {
        console.error('Submit error:', err);
        alert('Failed to submit request: ' + err.message);
    }
}

// =============================================
// View Document Preview Modal
// =============================================
async function openDocumentPreview(requestId, cachedData) {
    // Fetch latest to get docCode, qrContent, expiresAt
    const snap = await getDoc(doc(db, 'requests', requestId));
    const r    = snap.exists() ? snap.data() : cachedData;

    // Fetch resident profile for age/occupation
    let residentData = {};
    if (r.uid) {
        const resSnap = await getDoc(doc(db, 'residents', r.uid));
        if (resSnap.exists()) residentData = resSnap.data();
    }

    const overlay = el('doc-preview-modal');
    if (!overlay) return;

    const issueDate = r.readyAt?.toDate ? r.readyAt.toDate() : new Date();
    const day    = issueDate.getDate();
    const month  = issueDate.toLocaleString('en-PH', { month: 'long' }).toUpperCase();
    const year   = issueDate.getFullYear();

    // Age — compute from dateOfBirth if present, else read direct age field
    const age = resolveAge(residentData);

    // Occupation — fall back chain
    const occupation = residentData.occupation
        || residentData.work
        || residentData.jobTitle
        || residentData.job
        || residentData.civilStatus
        || '—';

    // "Issued in" = formatted issue date (e.g. "MAY 11, 2026")
    const issuedInDate = issueDate.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    }).toUpperCase();

    const setText = (id, val) => {
        const node = el(id);
        if (node) node.textContent = (val !== undefined && val !== null) ? String(val) : '—';
    };

    setText('dp-cert-title',  r.documentType  || '(CERTIFICATE NAME)');
    setText('dp-name',        r.residentName  || '—');
    setText('dp-age',         age);
    setText('dp-occupation',  occupation);
    setText('dp-day',         ordinal(day));
    setText('dp-month',       month);
    setText('dp-year',        year);
    setText('dp-doc-code',    r.docCode       || '—');
    setText('dp-ref-no',      r.referenceNo   || '—');
    setText('dp-issued-in',   issuedInDate);
    setText('dp-expiration',  formatExpiryDate(r.expiresAt));
    setText('dp-issued-in-2', issuedInDate);

    // Generate QR
    const qrWrap = el('dp-qr-wrap');
    if (qrWrap) {
        qrWrap.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'dp-qr-canvas';
        qrWrap.appendChild(canvas);
        setTimeout(() => {
            new QRious({
                element: canvas,
                value:   r.qrContent || r.referenceNo || 'NO-QR',
                size:    100,
                backgroundAlpha: 1,
                foreground: '#1B3A6B',
                background: '#ffffff',
                level: 'H'
            });
        }, 120);
    }

    overlay.classList.add('show');

    el('dp-close')?.addEventListener('click', () => overlay.classList.remove('show'), { once: true });
    el('dp-print')?.addEventListener('click', () => printDocument(), { once: true });
}

// =============================================
// Print / Save PDF
// Embeds all certificate CSS + converts QR
// canvas to a static <img> so it prints correctly
// =============================================
function printDocument() {
    const content = el('doc-preview-content');
    if (!content) return;

    // 1. Capture the QR canvas as a PNG data URL BEFORE opening the new window
    //    (canvas pixels are lost when transferred via innerHTML/outerHTML)
    const qrCanvas = el('dp-qr-canvas');
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

function ordinal(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function resolveAge(rd) {
    // Registration stores field as 'birthday' (plain string "YYYY-MM-DD")
    const dob = rd.birthday;
    if (!dob) return '—';
    return computeAge(dob);
}

function computeAge(dob) {
    if (!dob) return '—';
    // birthday is stored as "YYYY-MM-DD" string — parse safely without timezone shift
    const [y, m, d] = String(dob).split('-').map(Number);
    if (!y || !m || !d) return '—';
    const today = new Date();
    let age = today.getFullYear() - y;
    const mDiff = today.getMonth() + 1 - m;
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < d)) age--;
    return age;
}

function formatExpiryDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

// =============================================
// Tab Filter
// =============================================
function filterByStatus(status) {
    const cards = document.querySelectorAll('.request-card');
    let visible = 0;
    cards.forEach(card => {
        const show = status === 'all' || card.dataset.status === status;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    el('emptyState')?.classList.toggle('show', visible === 0);
}

// Expose for inline onclick in HTML tabs
window.filterTab = function (status, tabEl) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');
    filterByStatus(status);
};

// =============================================
// Modal Controls (exposed for HTML onclick)
// =============================================
window.openModal = function () {
    el('modalOverlay')?.classList.add('show');
};
window.closeModal = function () {
    el('modalOverlay')?.classList.remove('show');
};
window.closeModalOutside = function (e) {
    if (e.target === el('modalOverlay')) window.closeModal();
};
window.selectDoc = function (btn) {
    document.querySelectorAll('.doc-type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
};
window.closeDone = function () {
    el('successOverlay')?.classList.remove('show');
};

// =============================================
// Doc Icon Map
// Falls back to hardcoded map if Firestore icon isn't loaded yet
// =============================================
function docIcon(name) {
    if (docsIconMap[name]) return docsIconMap[name];
    const fallback = {
        'Barangay Clearance': 'Icons/barangayclearance.png',
        'Cert. of Residency': 'Icons/certificateofresidency.png',
        'Cert. of Indigency': 'Icons/certificateofindigency.png',
        'Business Clearance': 'Icons/barangaybusinessclearance.png',
        'Job Seeker Cert.': 'Icons/firsttimejobseekercertificate.png',
        'Good Moral Char.': 'Icons/certificateofgoodmoralcharacter.png',
        'Solo Parent Cert.': 'Icons/soloparentcertificate.png',
        'Working Permit': 'Icons/workingpermit.png'
    };
    return fallback[name] || 'Icons/barangayclearance.png';
}