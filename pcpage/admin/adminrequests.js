// =============================================
// adminrequests.js
// Handles: admin_pending_requests.html and admin_all_requests.html
// Live list of requests + View Request / Process / Reject /
// Preview & Approve / Mark as Ready (QR + expiry) / Mark as Released.
// Also runs as the transparent pop-up over the dashboard (?embed=1&open=<id>).
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, collection, addDoc, updateDoc, query, where,
    onSnapshot, getDocs, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// Show something right away so a blank list always means "the script did not run"
{ const b = document.getElementById('requests-body'); if (b) b.innerHTML = '<div style="padding:24px;text-align:center;color:#6B7A99;font-size:13px;">Loading...</div>'; }
window.addEventListener('unhandledrejection', e => console.error('adminrequests.js unhandled error:', e.reason));

// These two files live next to the admin pages in most setups, but the resident side imports them
// from ./admin/. Try every likely location instead of failing the whole script on a wrong path.
async function importFirst(paths) {
    for (const p of paths) {
        try { return await import(p); } catch (err) { console.warn('Could not load ' + p, err); }
    }
    console.error('None of these could be loaded: ' + paths.join(', ') + ' - using built-in fallbacks.');
    return {};
}
const [mOver, mTpl] = await Promise.all([
    importFirst(['./docoverrides.js', './admin/docoverrides.js', '../admin/docoverrides.js']),
    importFirst(['./doctemplate.js',  './admin/doctemplate.js',  '../admin/doctemplate.js'])
]);
const baseValues      = mOver.baseValues      || ((r, rd) => ({ residentName: r?.residentName || '—', age: '—', occupation: '—', address: 'Barangay Banicain, Olongapo City, Zambales', birthday: '', contactNumber: '' }));
const effectiveValues = mOver.effectiveValues || ((base, o) => ({ ...base, ...(o || {}) }));
const paintDocument   = mOver.paintDocument   || (() => {});
const loadTemplateForType = mTpl.loadTemplateForType || (async () => null);
const createTemplateView  = mTpl.createTemplateView  || null;

// Helper modules are loaded defensively: if one is missing or throws on load, the dashboard
// (and the View Request popup) still works with the built-in fallbacks below.
async function tryImport(path) {
    try { return await import(path); }
    catch (err) { console.error('Could not load ' + path + ' - using fallback:', err); return {}; }
}
const [mViewer, mReasons, mSms, mResident] = await Promise.all([
    tryImport('./imageviewer.js'), tryImport('./rejectreasons.js'),
    tryImport('./sms.js'),         tryImport('./residentinfo.js')
]);

const isImgSrc = mResident.isImgSrc || (v => typeof v === 'string' && /^(https?:\/\/|data:image\/|\/|\.\/)/i.test(v.trim()));
const findIdImages = mResident.findIdImages || ((rd = {}, r = {}) => {
    const out = [];
    const keys = Object.keys(rd).concat(Object.keys(r));
    keys.forEach(k => {
        if (!/id|valid|front|back/i.test(k) || /^(uid|residentid|requestphoto)/i.test(k)) return;
        [rd[k], r[k]].forEach(v => { if (isImgSrc(v) && !out.includes(v)) out.push(v); });
    });
    return out;
});
const formatBirthDate = mResident.formatBirthDate || ((rd = {}, r = {}) => {
    const v = rd.birthDate || rd.birthday || rd.dob || r.birthDate || r.birthday;
    const d = v?.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
});
const resolveAge = mResident.resolveAge || ((rd = {}, r = {}) => {
    if (rd.age || r.age) return rd.age || r.age;
    const v = rd.birthDate || rd.birthday || rd.dob || r.birthDate || r.birthday;
    const d = v?.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? Math.floor((Date.now() - d) / 31557600000) : '';
});
const resolveAddress = mResident.resolveAddress || ((rd = {}, r = {}) =>
    rd.address || r.address || [rd.street, rd.barangay || r.barangay, rd.city || r.city].filter(Boolean).join(', '));
const openLightbox = mViewer.openLightbox || (src => window.open(src, '_blank'));
const sendSMS = mSms.sendSMS || (async () => {});
const mountRejectReasonPicker = mReasons.mountRejectReasonPicker || (ta => ({
    reset() { if (ta) ta.value = ''; },
    getResult() {
        const reason = (ta?.value || '').trim();
        return reason ? { ok: true, reason, code: 'other' } : { ok: false, error: 'Please enter a reason for rejection.' };
    }
}));

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
let templateView = null;                       // used by the certificate preview below

const params   = new URLSearchParams(location.search);
const EMBED    = params.get('embed') === '1';
const OPEN_ID  = params.get('open');
const IS_ALL   = !!el('tab-scroll');           // all-requests page has the status tabs
const PAGE_STATUSES = IS_ALL ? null : ['pending', 'processing', 'approved'];

let allDocs = [];                              // [{ id, ...data }] live
let activeTab = 'all';
let embedHandled = false;

// =============================================
// Small helpers
// =============================================
function showToast(msg) {
    const t = el('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
}
function formatDate(val) {
    if (!val) return '—';
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const BADGE_LABEL = { pending:'Submitted', processing:'Processing', approved:'Awaiting Signature', ready:'Ready', released:'Released', rejected:'Rejected' };

const docsIconMap = {};
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

// =============================================
// Notify the resident (audit log + in-app + SMS) for every status change
// =============================================
async function notifyStatus(docId, status, reason) {
    let r;
    try {
        const rs = await getDoc(doc(db, 'requests', docId));
        if (!rs.exists()) return;
        r = rs.data();
    } catch (err) { console.error('Notify: could not load request', err); return; }

    const ref = `${r.referenceNo} (${r.documentType})`;
    const T = {
        processing: ['Request Processing', `BarangayDocs: Your request ${ref} is now being processed.`],
        approved:   ['Request Approved',   `BarangayDocs: Your request ${ref} was approved and is waiting for the Barangay Captain's signature.`],
        ready:      ['Ready for Pickup',   `BarangayDocs: Your ${r.documentType} (${r.referenceNo}) is ready for pickup.`],
        released:   ['Document Released',  `BarangayDocs: Your ${r.documentType} (${r.referenceNo}) has been released. Thank you!`],
        rejected:   ['Request Rejected',   `BarangayDocs: Request ${r.referenceNo} was rejected.${reason ? ' Reason: ' + reason : ' Check the app for details.'}`]
    }[status];
    if (!T) return;
    const [title, message] = T;

    try {
        await addDoc(collection(db, 'auditLogs'), {
            action: 'request_' + status, targetType: 'request', targetId: docId,
            referenceNo: r.referenceNo || '', residentName: r.residentName || '',
            residentUid: r.uid || '', documentType: r.documentType || '',
            details: status === 'rejected' && reason ? 'Reason: ' + reason : '',
            adminUid: auth.currentUser?.uid || '', adminEmail: auth.currentUser?.email || '',
            createdAt: serverTimestamp()
        });
    } catch (err) { console.error('Audit log failed (check Firestore rules):', err); }

    try {
        if (r.uid) {
            await addDoc(collection(db, 'notifications'), {
                uid: r.uid, requestId: docId, referenceNo: r.referenceNo || '',
                type: 'request_status', status, title, message, read: false, createdAt: serverTimestamp()
            });
        }
    } catch (err) { console.error('Notify: in-app notification failed', err); }

    try {
        let phone = r.contactNumber || null;
        if (r.uid) {
            const res = await getDoc(doc(db, 'residents', r.uid));
            if (res.exists()) { const x = res.data(); phone = x.contactNumber || x.phone || x.mobile || phone; }
        }
        await sendSMS(phone, message);
    } catch (err) { console.error('Notify: SMS failed', err); }
}

// =============================================
// Reject popup + View Request modal (details, live photo, valid ID)
// =============================================
function openRejectPopup(docId, r) {
    document.getElementById('reject-popup')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.id = 'reject-popup';
    overlay.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3>Reject Request</h3>
                <button class="modal-close" type="button" data-rj="close">✕</button>
            </div>
            <div style="padding:0 0 16px;">
                <label style="font-size:11px;font-weight:800;color:var(--text-sub);text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:8px;">Reason for Rejection</label>
                <textarea id="dash-reject-reason" placeholder="Please specify the reason for rejection…" maxlength="200" style="width:100%;height:90px;border:2px solid var(--border);border-radius:10px;padding:10px 14px;font-family:'Nunito',sans-serif;font-size:13px;color:var(--text-main);background:var(--bg);outline:none;resize:none;"></textarea>
            </div>
            <div class="modal-btn-row" style="margin-top:0;">
                <button type="button" class="modal-btn-cancel" data-rj="close">Cancel</button>
                <button type="button" class="modal-btn-save" data-rj="confirm" style="background:var(--red);">Confirm Rejection</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const picker = mountRejectReasonPicker(overlay.querySelector('#dash-reject-reason'));
    picker.reset();
    const close = () => { picker.reset(); overlay.remove(); };
    overlay.querySelectorAll('[data-rj="close"]').forEach(b => b.onclick = close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const confirmBtn = overlay.querySelector('[data-rj="confirm"]');
    confirmBtn.onclick = async () => {
        const { ok, reason, code, error } = picker.getResult();
        if (!ok) return alert(error);
        confirmBtn.disabled = true;
        try {
            await updateDoc(doc(db, 'requests', docId), {
                status: 'rejected', rejectReason: reason, rejectReasonCode: code,
                updatedAt: serverTimestamp()
            });
            notifyStatus(docId, 'rejected', reason);
            close();
            showToast('Request rejected.');
        } catch (err) {
            console.error(err);
            confirmBtn.disabled = false;
            alert('Could not reject the request. Try again.');
        }
    };
}

// =============================================
// View Request modal — details + valid ID (zoomable) + Process / Reject
// Built in JS so the HTML needs no change. Same popup as the Requests page.
// =============================================
const rdSafe = (fn, fallback, ...args) => { try { const v = fn(...args); return v ?? fallback; } catch (e) { console.error('Request modal helper failed:', e); return fallback; } };

async function openRequestModal(docId, data, row) {
  try {
    await openRequestModalInner(docId, data, row);
  } catch (err) {
    console.error('Could not open request:', err);
    showToast('Could not open this request. Check the console for details.');
  }
}

async function openRequestModalInner(docId, data, row) {
    let r = data || {}, rd = {};
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
    const faceSrc = rdSafe(() => [rd.faceUrl, rd.photoUrl, rd.profilePhoto, rd.profileUrl, rd.photo, rd.avatar].find(isImgSrc), '') || '';
    const idImgs  = rdSafe(findIdImages, [], rd, r) || [];
    const livePic = /^https?:\/\//i.test(r.requestPhotoUrl || '') ? r.requestPhotoUrl : '';
    const initial = String(r.residentName || '?').trim().charAt(0).toUpperCase();
    const imgBox  = (src, label) =>
        `<img class="rd-zoom" src="${src}" alt="${label}" style="display:block;width:100%;max-height:200px;object-fit:contain;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;cursor:zoom-in;">`;
    const birthTxt = rdSafe(formatBirthDate, '', rd, r);
    const sexTxt   = rd.sex || rd.gender;

    if (!document.getElementById('rd-compare-style')) {
        const st = document.createElement('style');
        st.id = 'rd-compare-style';
        st.textContent = `
          #request-detail-modal .modal-box { max-height:92vh; overflow-y:auto; }
          .rd-compare { display:grid; grid-template-columns: minmax(0,1fr) 320px; gap:20px; align-items:start; }
          .rd-col-title { font-size:11px; font-weight:800; color:var(--text-sub); text-transform:uppercase; letter-spacing:.5px; margin:0 0 10px; }
          .rd-info-grid { display:grid; grid-template-columns: 1fr 1fr; gap:0 14px; }
          .rd-info-grid .modal-field.rd-wide { grid-column: 1 / -1; }
          .rd-pic-col { position:sticky; top:0; }
          .rd-pic-col img.rd-id { display:block; width:100%; height:230px; object-fit:contain; background:var(--bg); border:1.5px solid var(--border); border-radius:10px; cursor:zoom-in; transition:box-shadow .15s; }
          .rd-pic-col img.rd-id:hover { box-shadow:0 4px 14px rgba(27,58,107,.25); }
          .rd-pic-col .rd-id + .rd-id { margin-top:8px; }
          @media (max-width: 760px) {
            .rd-compare { grid-template-columns: 1fr; }
            .rd-pic-col { position:static; order:-1; display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
            .rd-pic-col .rd-col-title { grid-column:1/-1; margin:0; }
            .rd-pic-col img.rd-id { height:170px; margin:0 !important; }
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
                        ${field('Age', rdSafe(resolveAge, '', rd, r))}
                        ${wide('Contact', rd.contactNumber || rd.phone || rd.mobile || r.contactNumber)}
                        ${wide('Address', rdSafe(resolveAddress, '', rd, r))}
                    </div>
                </div>
                <!-- RIGHT: valid ID picture, beside the details for easy comparison -->
                <div class="rd-pic-col">
                    <p class="rd-col-title">Live Photo taken at request (click to zoom)</p>
                    ${livePic
                        ? `<img class="rd-zoom rd-id" src="${esc(livePic)}" alt="Live photo">`
                        : `<div class="modal-field"><p>No live photo on this request</p></div>`}
                    <p class="rd-col-title" style="margin-top:16px;">Valid ID (click to zoom, drag to move)</p>
                    ${idImgs.length
                        ? idImgs.map((s, i) => `<img class="rd-zoom rd-id" src="${s}" alt="ID ${i + 1}">`).join('')
                        : `<div class="modal-field"><p>No ID image found on this resident</p></div>`}
                </div>
            </div>
            <div class="modal-btn-row" id="rd-buttons" style="margin-top:16px;"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.rd-zoom').forEach(img => img.addEventListener('click', () => openLightbox(img.src)));
    overlay.style.zIndex = '1000';

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
        mk('Reject', 'modal-btn-cancel', () => { close(); openRejectPopup(docId, r); });
    }
    if (r.status === 'pending') {
        mk('Process', 'modal-btn-save', async () => {
            try {
                await updateDoc(doc(db, 'requests', docId), { status: 'processing', updatedAt: serverTimestamp() });
                notifyStatus(docId, 'processing');
                close();
                showToast('✓ Request marked as Processing');
            } catch (err) {
                console.error(err);
                showToast('Failed to update. Check Firestore rules.');
            }
        });
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

    // ── Admin-made template for this document type? Use it. Otherwise fall through
    //    to the original hardcoded certificate below (unchanged).
    const legacyEl = el('doc-preview-content');
    const wrapEl   = overlay.querySelector('.doc-preview-wrapper');
    let tplEl      = el('doc-preview-template');
    // Always read the latest saved template straight from Firestore each time the preview opens
    // (falls back to the shared loader if nothing is found or the read fails)
    let tpl = null;
    try {
        const tSnap = await getDocs(query(collection(db, 'documentTemplates'), where('documentName', '==', r.documentType)));
        if (!tSnap.empty) tpl = { id: tSnap.docs[0].id, ...tSnap.docs[0].data() };
    } catch (err) {
        console.warn('Could not fetch latest template:', err);
    }
    if (!tpl) tpl = await loadTemplateForType(db, r.documentType);

    if (tpl && legacyEl && createTemplateView) {
        if (!tplEl) {
            tplEl = document.createElement('div');
            tplEl.id = 'doc-preview-template';
            legacyEl.parentNode.insertBefore(tplEl, legacyEl);
        }
        if (!templateView || templateView.container !== tplEl) {
            templateView = createTemplateView(tplEl);
            templateView.container = tplEl;
        }
        legacyEl.style.display = 'none';
        if (wrapEl) wrapEl.style.maxWidth = '1000px';

        overlay.classList.add('show');
        el('dp-close').onclick = () => overlay.classList.remove('show');
        el('dp-print').onclick = () => printDocument();

        // fixed-size pages, header/footer/background, and the admin's corrections (docOverrides)
        await templateView.show({
            template: tpl, request: r, resident: residentData, overrides: r.docOverrides
        });
        return;
    }

    // No template → make sure the built-in certificate is the one visible
    if (templateView) templateView.hide();
    if (tplEl) tplEl.style.display = 'none';
    legacyEl.style.display = '';
    if (wrapEl) wrapEl.style.maxWidth = '';

    const issueDate = r.readyAt?.toDate ? r.readyAt.toDate() : new Date();
    const day    = issueDate.getDate();
    const month  = issueDate.toLocaleString('en-PH', { month: 'long' }).toUpperCase();
    const year   = issueDate.getFullYear();

    // Age — compute from dateOfBirth if present, else read direct age field
    const age = resolveAgeLocal(residentData);

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

    // Apply admin corrections stored on the request (docOverrides).
    // These live on the request only — the resident profile is never changed.
    paintDocument(effectiveValues(baseValues(r, residentData), r.docOverrides));

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

    // Assigned (not added) so re-opening the preview never stacks duplicate handlers
    el('dp-close').onclick = () => overlay.classList.remove('show');
    el('dp-print').onclick = () => printDocument();
}

// =============================================
// Print / Save PDF
// Embeds all certificate CSS + converts QR
// canvas to a static <img> so it prints correctly
// =============================================
function printDocument() {
    // Admin-made template: print the exact same pages that are shown in the preview
    if (templateView && templateView.active) {
        templateView.print('Barangay Document');
        return;
    }

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

function resolveAgeLocal(rd) {
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
// Certificate preview (+ Approve button while the request is "processing")
// =============================================
async function openPreviewFor(id, r, { approve = false } = {}) {
    await openDocumentPreview(id, r);
    const overlay = el('doc-preview-modal');
    if (!overlay) return;
    const bar = overlay.querySelector('.doc-preview-toolbar > div');
    el('dp-approve-admin')?.remove();

    // docedit.js may already provide its own approve control; only add ours if it doesn't
    if (approve && bar && !document.querySelector('#dp-approve, [data-dp-approve]')) {
        const b = document.createElement('button');
        b.id = 'dp-approve-admin';
        b.type = 'button';
        b.className = 'dp-btn dp-btn-primary';
        b.textContent = '✓ Approve';
        b.onclick = async () => {
            if (!confirm('Approve this request? It will move to "Awaiting Signature".')) return;
            b.disabled = true;
            try {
                await updateDoc(doc(db, 'requests', id), { status: 'approved', approvedAt: serverTimestamp(), updatedAt: serverTimestamp() });
                notifyStatus(id, 'approved');
                overlay.classList.remove('show');
                showToast('✓ Request approved');
            } catch (err) {
                console.error(err); b.disabled = false;
                showToast('Failed to approve. Check Firestore rules.');
            }
        };
        bar.insertBefore(b, bar.firstChild);
    }
    const closeBtn = el('dp-close');
    if (closeBtn) closeBtn.onclick = () => overlay.classList.remove('show');
}

// =============================================
// Ready modal: generate QR + expiry date (mode "make"), or just show it (mode "view")
// =============================================
function genDocCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return 'DOC-' + s;
}
function fillDays() {
    const m = +el('expiry-month').value, y = +el('expiry-year').value || new Date().getFullYear();
    const sel = el('expiry-day'), keep = sel.value;
    const n = m ? new Date(y, m, 0).getDate() : 31;
    sel.innerHTML = '<option value="">Day</option>' + Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    if (keep && +keep <= n) sel.value = keep;
}
function drawQR(value) {
    try { new QRious({ element: el('qr-canvas'), value, size: 200, foreground: '#1B3A6B', background: '#ffffff', level: 'H' }); }
    catch (e) { console.error('QR failed', e); }
}
function openReadyModal(id, r, mode) {
    const modal = el('qr-modal'); if (!modal) return;
    const viewOnly = mode === 'view';
    const docCode   = r.docCode || genDocCode();
    const qrContent = r.qrContent || `BARANGAYDOCS|${docCode}|${r.referenceNo || ''}`;

    el('modal-doc-code').textContent = docCode;
    el('modal-ref-no').textContent   = r.referenceNo || '—';
    el('modal-resident').textContent = r.residentName || '—';
    el('modal-doc-type').textContent = r.documentType || '—';
    drawQR(qrContent);

    el('expiry-picker').style.display    = viewOnly ? 'none' : '';
    el('modal-expiry-row').style.display = viewOnly ? '' : 'none';
    el('confirm-ready').style.display    = viewOnly ? 'none' : '';
    el('cancel-ready').textContent       = viewOnly ? 'Close' : 'Cancel';
    el('expiry-error').style.display = 'none';
    if (viewOnly) {
        const d = r.expiresAt?.toDate ? r.expiresAt.toDate() : (r.expiresAt ? new Date(r.expiresAt) : null);
        el('modal-expiry-display').textContent = d ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
    } else {
        el('expiry-month').value = '';
        el('expiry-year').value  = new Date().getFullYear();
        fillDays(); el('expiry-day').value = '';
    }

    const close = () => modal.classList.remove('show');
    el('cancel-ready').onclick = close;
    el('expiry-month').onchange = fillDays;
    el('expiry-year').oninput   = fillDays;
    el('confirm-ready').onclick = async () => {
        const m = +el('expiry-month').value, d = +el('expiry-day').value, y = +el('expiry-year').value;
        const err = el('expiry-error');
        const fail = (t) => { err.textContent = t; err.style.display = 'block'; };
        if (!m || !d || !y) return fail('Please choose the full expiration date.');
        const exp = new Date(y, m - 1, d, 23, 59, 59);
        if (isNaN(exp) || exp.getMonth() !== m - 1) return fail('That date does not exist.');
        if (exp <= new Date()) return fail('Expiration must be a future date.');
        err.style.display = 'none';
        const btn = el('confirm-ready'); btn.disabled = true;
        try {
            await updateDoc(doc(db, 'requests', id), {
                status: 'ready', docCode, qrContent,
                expiresAt: Timestamp.fromDate(exp),
                readyAt: serverTimestamp(), updatedAt: serverTimestamp()
            });
            notifyStatus(id, 'ready');
            close();
            showToast('✓ Marked as Ready for pickup');
        } catch (e) {
            console.error(e); showToast('Failed to update. Check Firestore rules.');
        } finally { btn.disabled = false; }
    };
    modal.classList.add('show');
}

async function releaseRequest(id, r) {
    if (!confirm(`Mark ${r.referenceNo || 'this request'} as Released to the resident?`)) return false;
    try {
        await updateDoc(doc(db, 'requests', id), { status: 'released', releasedAt: serverTimestamp(), updatedAt: serverTimestamp() });
        notifyStatus(id, 'released');
        showToast('✓ Marked as Released');
        return true;
    } catch (e) { console.error(e); showToast('Failed to update. Check Firestore rules.'); return false; }
}

// =============================================
// List rendering
// =============================================
function actionButtons(id, s) {
    const b = (cls, act, label) => `<button type="button" class="${cls}" data-act="${act}" data-id="${id}">${label}</button>`;
    switch (s) {
        case 'pending':    return b('btn-process', 'view', 'View Request');
        case 'processing': return b('btn-approve', 'approve', 'Preview &amp; Approve') + b('btn-reject', 'reject', 'Reject');
        case 'approved':   return b('btn-approve', 'ready', 'Mark as Ready') + b('btn-view', 'doc', 'View');
        case 'ready':      return b('btn-approve', 'release', 'Mark as Released') + b('btn-view', 'qr', 'View QR') + b('btn-view-doc', 'doc', 'View Document');
        case 'released':   return b('btn-view-doc', 'doc', 'View Document');
        case 'rejected':   return b('btn-view', 'view', 'View Request');
        default:           return '';
    }
}
function validityCell(r) {
    if (!['ready', 'released'].includes(r.status) || !r.expiresAt) return '<span style="font-size:12px;color:var(--text-light);">—</span>';
    const d = r.expiresAt?.toDate ? r.expiresAt.toDate() : new Date(r.expiresAt);
    const expired = d < new Date();
    return `<span class="badge validity ${expired ? 'expired' : 'active'}">${expired ? 'Expired' : 'Active'}</span>`;
}
function buildRow(r) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.id = r.id; row.dataset.status = r.status;
    row.innerHTML = `
        <div class="col-icon"><div class="doc-icon-sm"><img src="${esc(docIcon(r.documentType))}" alt="" onerror="this.style.display='none'"></div></div>
        <div class="col-name"><h4>${esc(r.documentType || '—')}</h4><p>${esc(r.referenceNo || '—')}</p></div>
        <div class="col-user"><span>${esc(r.residentName || '—')}</span></div>
        <div class="col-date"><span>${esc(formatDate(r.createdAt))}</span></div>
        <div class="col-purpose"><span>${esc(r.purpose || '—')}</span></div>
        <div class="col-status"><span class="badge ${esc(r.status || 'pending')}">${esc(BADGE_LABEL[r.status] || r.status || '—')}</span></div>
        ${IS_ALL ? `<div class="col-validity">${validityCell(r)}</div>` : ''}
        <div class="col-action"><div class="action-row">${actionButtons(r.id, r.status)}</div></div>`;
    return row;
}
function visibleDocs() {
    const q = (el('search-input')?.value || '').trim().toLowerCase();
    const f = (el('doc-filter')?.value || 'all').toLowerCase();
    return allDocs.filter(r => {
        if (PAGE_STATUSES && !PAGE_STATUSES.includes(r.status)) return false;
        if (IS_ALL && activeTab !== 'all' && r.status !== activeTab) return false;
        if (f !== 'all' && String(r.documentType || '').toLowerCase() !== f) return false;
        if (q && !`${r.residentName || ''} ${r.referenceNo || ''}`.toLowerCase().includes(q)) return false;
        return true;
    }).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}
function renderList() {
    const body = el('requests-body'); if (!body) return;
    const list = visibleDocs();
    body.innerHTML = '';
    if (!list.length) {
        body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sub);font-size:13px;">No requests found.</div>';
    } else {
        list.forEach(r => body.appendChild(buildRow(r)));
    }
    const open = allDocs.filter(r => ['pending', 'processing', 'approved'].includes(r.status)).length;
    const badge = el('pending-requests-badge');
    if (badge) { badge.textContent = open; badge.style.display = open ? '' : 'none'; }
}

// One click handler for every row button
function wireList() {
    el('requests-body')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]'); if (!btn) return;
        const r = allDocs.find(x => x.id === btn.dataset.id); if (!r) return;
        runAction(btn.dataset.act, r);
    });
    el('search-input')?.addEventListener('input', renderList);
    el('doc-filter')?.addEventListener('change', renderList);
    document.querySelectorAll('.tab-btn').forEach(t => t.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === t));
        activeTab = t.dataset.status || 'all';
        renderList();
    }));
}
function runAction(act, r) {
    const id = r.id;
    if (act === 'view')    return openRequestModal(id, r);
    if (act === 'approve') return openPreviewFor(id, r, { approve: true });
    if (act === 'doc')     return openPreviewFor(id, r);
    if (act === 'ready')   return openReadyModal(id, r, 'make');
    if (act === 'qr')      return openReadyModal(id, r, 'view');
    if (act === 'release') return releaseRequest(id, r);
    if (act === 'reject')  return openRejectPopup(id, r);
}

// =============================================
// Pop-up mode over the dashboard (?embed=1&open=<id>)
// =============================================
function setupEmbed() {
    if (!EMBED) return;
    const st = document.createElement('style');
    st.textContent = `html, body { background: transparent !important; }
        body > *:not(.modal-overlay):not(.toast):not(script):not(style) { display: none !important; }`;
    document.head.appendChild(st);

    let timer = null;
    const check = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (embedHandled && !document.querySelector('.modal-overlay.show')) {
                parent.postMessage({ type: 'requests-embed-close' }, location.origin);
            }
        }, 250);
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
function handleEmbedOpen() {
    if (!EMBED || embedHandled || !OPEN_ID) return;
    const r = allDocs.find(x => x.id === OPEN_ID);
    if (!r) return;                       // wait for the next snapshot
    embedHandled = true;
    const byStatus = { pending: 'view', processing: 'approve', approved: 'ready', ready: 'release', released: 'doc', rejected: 'view' };
    Promise.resolve(runAction(byStatus[r.status] || 'view', r)).finally(() => {
        // actions that only show a confirm() and no modal still need to close the embed
        setTimeout(() => { if (!document.querySelector('.modal-overlay.show')) parent.postMessage({ type: 'requests-embed-close' }, location.origin); }, 400);
    });
}
setupEmbed();

// =============================================
// Reject popup from the page's own reject modal is unused: the JS-built popup above is used
// everywhere so the dashboard and these pages behave the same.
// =============================================

// =============================================
// Reject modal built into the page (kept hidden)  /  Sidebar + sign out
// =============================================
let sidebarOpen = true;
window.toggleSidebar = function () {
    const sidebar = el('sidebar'), main = el('mainContent');
    if (window.matchMedia('(max-width: 900px)').matches) {
        const open = sidebar.classList.toggle('open');
        el('sidebar-backdrop')?.classList.toggle('show', open);
        return;
    }
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('collapsed', !sidebarOpen);
    main?.classList.toggle('expanded', !sidebarOpen);
};
el('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

// =============================================
// Auth guard (admins only) → start the live list
// =============================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }
    try {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
            alert('Access denied. Admins only.');
            await signOut(auth);
            window.location.href = '../barangaydocs_login.html';
            return;
        }
        const a = adminDoc.data();
        const initials = ((a.firstName?.[0] || '') + (a.lastName?.[0] || '')).toUpperCase() || 'A';
        const avPh = document.querySelector('.av-ph'); if (avPh) avPh.textContent = initials;

        wireList();
        const body = el('requests-body');
        if (body) body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-sub);font-size:13px;">Loading...</div>';

        onSnapshot(collection(db, 'requests'), (snap) => {
            allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderList();
            handleEmbedOpen();
        }, (err) => {
            console.error('Requests listener failed (check Firestore rules):', err);
            if (body) body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red-text);font-size:13px;">Could not load requests. Check Firestore rules and your connection.</div>';
        });
    } catch (err) {
        console.error('Auth guard error:', err);
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
    }
});