// =============================================
// profilechanges.js
// Handles: admin_profile_changes.html
// Residents' "Request Information Change" submissions
// (collection: profileChangeRequests)
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, collection, query, where, onSnapshot,
    doc, getDoc, updateDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { sendSMS } from './sms.js';

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
const $    = (id) => document.getElementById(id);

const FIELD_LABELS = {
    firstName: 'First name', middleName: 'Middle name', lastName: 'Last name',
    birthday: 'Date of birth', sex: 'Sex', civilStatus: 'Civil status',
    houseNumber: 'House no. / street'
};
const labelOf = (k) => FIELD_LABELS[k] || (/resid/i.test(k) ? 'Years of residency' : k);

let allRequests = [];      // [{ id, ...data }]
let activeTab   = 'pending';
let current     = null;    // request being reviewed

// ---------- helpers ----------
function toast(msg) {
    const t = $('pc-toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
}
function fmtDate(v) {
    if (!v) return '—';
    const d = v?.toDate ? v.toDate() : new Date(v);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtVal(k, v) {
    if (v === undefined || v === null || v === '') return '(empty)';
    if (k === 'birthday') {
        const d = new Date(v);
        return isNaN(d) ? String(v) : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    }
    if (/resid/i.test(k)) return `${v} year(s)`;
    return String(v);
}
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;   // textContent → no HTML injection
    return e;
}

// ---------- notify resident (in-app record + SMS) ----------
async function notifyResident(r, requestId, approved, note) {
    try {
        await addDoc(collection(db, 'auditLogs'), {
            action:       approved ? 'profile_approved' : 'profile_rejected',
            targetType:   'profileChange',
            targetId:     requestId,
            referenceNo:  '',
            residentName: r.residentName || '',
            residentUid:  r.uid || '',
            documentType: 'Information change',
            details:      (r.changedFields || []).join(', ') + (note ? ' — Reason: ' + note : ''),
            adminUid:     auth.currentUser?.uid || '',
            adminEmail:   auth.currentUser?.email || '',
            createdAt:    serverTimestamp()
        });
    } catch (e) { console.error('Audit log failed (check Firestore rules):', e); }

    const what = (r.changedFields || []).join(', ') || 'personal information';
    const message = approved
        ? `BarangayDocs: Your request to change ${what} was APPROVED and your information has been updated.`
        : `BarangayDocs: Your request to change ${what} was not approved.${note ? ' Reason: ' + note : ''}`;

    try {
        await addDoc(collection(db, 'notifications'), {
            uid: r.uid, requestId, type: 'profile_change',
            status: approved ? 'approved' : 'rejected',
            title: approved ? 'Information change approved' : 'Information change rejected',
            message, read: false, createdAt: serverTimestamp()
        });
    } catch (e) { console.error('In-app notification failed (check Firestore rules):', e); }

    try {
        const rs = await getDoc(doc(db, 'residents', r.uid));
        const d  = rs.exists() ? rs.data() : {};
        await sendSMS(d.contactNumber || d.phone || d.mobile, message);
    } catch (e) { console.error('SMS failed:', e); }
}

// ---------- list ----------
function renderList() {
    const list = $('pc-list');
    list.innerHTML = '';
    const rows = allRequests
        .filter(r => activeTab === 'all' || r.status === activeTab)
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    $('pc-count-pending').textContent = allRequests.filter(r => r.status === 'pending').length;

    if (!rows.length) {
        list.appendChild(el('div', 'pc-empty', activeTab === 'pending' ? 'No pending profile change requests.' : 'Nothing here yet.'));
        return;
    }
    rows.forEach(r => {
        const row  = el('div', 'pc-row');
        const who  = el('div', 'who');
        who.append(el('h4', '', r.residentName || '—'), el('p', '', r.email || ''));
        const what = el('div', 'what', (r.changedFields || []).join(', ') || '—');
        what.appendChild(el('small', '', (r.proof?.length || 0) + ' document(s) attached'));
        what.firstChild.after(document.createElement('br'));
        const when = el('div', 'when', fmtDate(r.createdAt));
        const st   = el('div', 'st');
        st.appendChild(el('span', 'pc-pill ' + (r.status || 'pending'), (r.status || 'pending').replace(/^./, c => c.toUpperCase())));
        const act  = el('div', 'act');
        const btn  = el('button', 'pc-review', r.status === 'pending' ? 'Review' : 'View');
        btn.addEventListener('click', () => openReview(r));
        act.appendChild(btn);
        row.append(who, what, when, st, act);
        list.appendChild(row);
    });
}

// ---------- review modal ----------
function openReview(r) {
    current = r;
    const pending = r.status === 'pending';
    $('pc-title').textContent = r.residentName || 'Review request';
    $('pc-sub').textContent = `Submitted ${fmtDate(r.createdAt)} · ${r.email || ''}`;

    const diff = $('pc-diff');
    diff.innerHTML = ''; diff.className = 'pc-diff';
    Object.keys(r.updates || {}).forEach(k => {
        diff.append(
            el('div', 'lbl', labelOf(k)),
            el('div', 'pc-old', fmtVal(k, r.previous?.[k])),
            el('div', 'pc-arrow', '→'),
            el('div', 'pc-new', fmtVal(k, r.updates[k]))
        );
    });

    $('pc-reason').textContent = r.reason || '—';

    const proofs = $('pc-proofs');
    proofs.innerHTML = '';
    (r.proof || []).forEach(p => {
        if (!p?.dataUrl || !String(p.dataUrl).startsWith('data:image/')) return;
        const img = document.createElement('img');
        img.src = p.dataUrl; img.alt = p.name || 'Supporting document';
        img.addEventListener('click', () => {
            $('pc-lightbox').querySelector('img').src = p.dataUrl;
            $('pc-lightbox').classList.add('show');
        });
        proofs.appendChild(img);
    });
    $('pc-proof-block').hidden = !proofs.children.length;

    $('pc-note').value = ''; $('pc-note-err').textContent = '';
    $('pc-note-block').hidden = true;
    $('pc-actions').hidden = !pending;
    $('pc-approve').disabled = $('pc-reject').disabled = false;
    $('pc-reject').textContent = 'Reject';

    if (!pending && r.status === 'rejected' && r.adminNote) {
        $('pc-note-block').hidden = false;
        $('pc-note').value = r.adminNote; $('pc-note').readOnly = true;
    } else { $('pc-note').readOnly = false; }

    $('pc-modal').classList.add('show');
}
const closeReview = () => { $('pc-modal').classList.remove('show'); current = null; };

async function approve() {
    if (!current) return;
    const r = current;
    $('pc-approve').disabled = $('pc-reject').disabled = true;
    $('pc-approve').textContent = 'Applying…';
    try {
        // 1) apply the new values to the resident's record
        await updateDoc(doc(db, 'residents', r.uid), { ...r.updates, updatedAt: serverTimestamp() });
        // 2) mark the request approved
        await updateDoc(doc(db, 'profileChangeRequests', r.id), {
            status: 'approved', reviewedAt: serverTimestamp(), reviewedBy: auth.currentUser?.uid || null
        });
        notifyResident(r, r.id, true);
        closeReview();
        toast('✓ Approved. Resident information updated.');
    } catch (err) {
        console.error('Approve failed:', err);
        toast(err?.code === 'permission-denied'
            ? 'Permission denied. Check Firestore rules.' : 'Failed to approve. Please try again.');
    } finally { $('pc-approve').textContent = 'Approve & Apply Changes'; $('pc-approve').disabled = $('pc-reject').disabled = false; }
}

async function reject() {
    if (!current) return;
    // first click reveals the reason box, second click confirms
    if ($('pc-note-block').hidden) {
        $('pc-note-block').hidden = false;
        $('pc-note').focus();
        $('pc-reject').textContent = 'Confirm Reject';
        return;
    }
    const note = $('pc-note').value.trim();
    if (note.length < 5) { $('pc-note-err').textContent = 'Please enter a reason (at least 5 characters).'; return; }
    const r = current;
    $('pc-approve').disabled = $('pc-reject').disabled = true;
    try {
        await updateDoc(doc(db, 'profileChangeRequests', r.id), {
            status: 'rejected', adminNote: note,
            reviewedAt: serverTimestamp(), reviewedBy: auth.currentUser?.uid || null
        });
        notifyResident(r, r.id, false, note);
        closeReview();
        toast('Request rejected.');
    } catch (err) {
        console.error('Reject failed:', err);
        toast(err?.code === 'permission-denied'
            ? 'Permission denied. Check Firestore rules.' : 'Failed to reject. Please try again.');
    } finally { $('pc-approve').disabled = $('pc-reject').disabled = false; }
}

// ---------- sidebar / sign out ----------
let sidebarOpen = true;
window.toggleSidebar = function () {
    sidebarOpen = !sidebarOpen;
    $('sidebar').classList.toggle('collapsed', !sidebarOpen);
    $('mainContent').classList.toggle('expanded', !sidebarOpen);
};
$('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

function loadSidebarBadges() {
    onSnapshot(query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (s) => { const b = $('pending-requests-badge'); if (b) b.textContent = s.size; });
    onSnapshot(collection(db, 'residents'),
        (s) => { const b = $('pending-users-badge'); if (b) b.textContent = s.docs.filter(d => d.data().status === 'pending').length; });
}

// ---------- init ----------
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }
    const adminDoc = await getDoc(doc(db, 'admins', user.uid));
    if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    onSnapshot(collection(db, 'profileChangeRequests'), (snap) => {
        allRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderList();
        const b = $('profile-changes-badge');
        if (b) b.textContent = allRequests.filter(r => r.status === 'pending').length;
    }, (err) => {
        console.error('Profile change listener failed:', err);
        $('pc-list').innerHTML = '';
        $('pc-list').appendChild(el('div', 'pc-empty', 'Could not load requests. Check Firestore rules.'));
    });
    loadSidebarBadges();
});

document.querySelectorAll('.pc-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.pc-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    activeTab = t.dataset.status;
    renderList();
}));
$('pc-close').addEventListener('click', closeReview);
$('pc-modal').addEventListener('mousedown', (e) => { if (e.target === $('pc-modal')) closeReview(); });
$('pc-approve').addEventListener('click', approve);
$('pc-reject').addEventListener('click', reject);
$('pc-lightbox').addEventListener('click', () => $('pc-lightbox').classList.remove('show'));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('pc-lightbox').classList.remove('show'); closeReview(); }
});