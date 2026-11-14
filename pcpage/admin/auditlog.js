// =============================================
// auditlog.js — Handles: admin_audit_log.html
// Shows the history of every request: who did what and when.
// Sources: `auditLogs` (admin actions) + the original submission of each
// document request / profile change request.
// =============================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain: "barangaydocs-df957.firebaseapp.com",
    projectId: "barangaydocs-df957",
    storageBucket: "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId: "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId: "G-YG0Y575BRD"
};
const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const $    = (id) => document.getElementById(id);

const LABELS = {
    submitted: 'Submitted', request_processing: 'Processing', request_approved: 'Approved',
    request_ready: 'Ready + QR issued', request_released: 'Released', request_rejected: 'Rejected',
    profile_approved: 'Change approved', profile_rejected: 'Change rejected'
};
const pillClass = (a) => a.replace(/^(request|profile)_/, '');

const state = { logs: [], reqs: [], profs: [] };
let focusId = null;   // filter to one request's trail

const ms = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);
const fmt = (v) => {
    const t = ms(v); if (!t) return '—';
    const d = new Date(t);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
};
function cell(text, small) {
    const d = document.createElement('div');
    d.textContent = text || '—';
    if (small) { const s = document.createElement('small'); s.textContent = small; d.appendChild(s); }
    return d;
}

function events() {
    const out = state.logs.map(l => ({ ...l }));
    state.reqs.forEach(r => out.push({
        action: 'submitted', targetType: 'request', targetId: r.id, referenceNo: r.referenceNo,
        residentName: r.residentName, documentType: r.documentType, details: r.purpose ? 'Purpose: ' + r.purpose : '',
        adminEmail: '', createdAt: r.createdAt, synthetic: true
    }));
    state.profs.forEach(r => out.push({
        action: 'submitted', targetType: 'profileChange', targetId: r.id, referenceNo: '',
        residentName: r.residentName, documentType: 'Information change',
        details: (r.changedFields || []).join(', ') + (r.reason ? ' — ' + r.reason : ''),
        adminEmail: '', createdAt: r.createdAt, synthetic: true
    }));
    return out.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

function render() {
    const list = $('al-list'); list.innerHTML = '';
    const q = $('al-search').value.trim().toLowerCase();
    const type = $('al-type').value;

    const rows = events().filter(e =>
        (type === 'all' || e.targetType === type) &&
        (!focusId || e.targetId === focusId) &&
        (!q || [e.referenceNo, e.residentName, e.adminEmail, e.documentType, e.details, LABELS[e.action]]
                .join(' ').toLowerCase().includes(q)));

    const chipWrap = $('al-chip-wrap'); chipWrap.innerHTML = '';
    if (focusId) {
        const chip = document.createElement('span'); chip.className = 'al-chip';
        chip.textContent = 'Showing one request only — click to show all ✕';
        chip.addEventListener('click', () => { focusId = null; render(); });
        chipWrap.appendChild(chip);
    }

    if (!rows.length) { const e = document.createElement('div'); e.className = 'al-empty'; e.textContent = 'No activity found.'; list.appendChild(e); return; }

    rows.forEach(e => {
        const row = document.createElement('div'); row.className = 'al-row';
        const ev = document.createElement('div');
        const pill = document.createElement('span');
        pill.className = 'al-pill ' + pillClass(e.action);
        pill.textContent = LABELS[e.action] || e.action;
        ev.appendChild(pill);

        const ref = document.createElement('div');
        const link = document.createElement('span'); link.className = 'al-ref';
        link.textContent = e.referenceNo || (e.targetType === 'profileChange' ? 'Info change' : '—');
        link.title = 'Show the full trail of this request';
        link.addEventListener('click', () => { focusId = e.targetId; render(); });
        ref.appendChild(link);
        if (e.documentType) { const s = document.createElement('small'); s.textContent = e.documentType; ref.appendChild(s); }

        row.append(cell(fmt(e.createdAt)), ev, ref, cell(e.residentName),
                   cell(e.synthetic ? 'Resident' : (e.adminEmail || 'Admin')), cell(e.details));
        list.appendChild(row);
    });
}

let sidebarOpen = true;
window.toggleSidebar = function () {
    sidebarOpen = !sidebarOpen;
    $('sidebar').classList.toggle('collapsed', !sidebarOpen);
    $('mainContent').classList.toggle('expanded', !sidebarOpen);
};
$('sign-out-btn')?.addEventListener('click', async () => { await signOut(auth); window.location.href = '../barangaydocs_login.html'; });

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }
    const a = await getDoc(doc(db, 'admins', user.uid));
    if (!a.exists() || a.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth); window.location.href = '../barangaydocs_login.html'; return;
    }
    const sub = (name, key) => onSnapshot(collection(db, name),
        (s) => { state[key] = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); },
        (err) => console.error('Audit listener failed:', name, err));
    sub('auditLogs', 'logs'); sub('requests', 'reqs'); sub('profileChangeRequests', 'profs');

    onSnapshot(query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (s) => { const b = $('pending-requests-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'profileChangeRequests'), where('status', '==', 'pending')),
        (s) => { const b = $('profile-changes-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'residents'), where('status', '==', 'pending')),
        (s) => { const b = $('pending-users-badge'); if (b) b.textContent = s.size; });
});

$('al-search').addEventListener('input', render);
$('al-type').addEventListener('change', render);