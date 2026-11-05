// ============================================================
// adminhistory.js — Audit History for BarangayDocs Admin
// Pulls events from: requests, residents, documents collections
// ============================================================

import { initializeApp }  from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    getDoc,
    doc,
    query,
    orderBy,
    onSnapshot,   // ← ADDED
    where         // ← ADDED
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// ── Firebase Config ─────────────────────────────────────────
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

// ── Auth Guard ───────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }

    const adminDoc = await getDoc(doc(db, 'admins', user.uid));
    if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth);
        window.location.href = '../barangaydocs_login.html';
        return;
    }

    const adminData = adminDoc.data();
    const initials  = ((adminData.firstName?.[0] || '') + (adminData.lastName?.[0] || '')).toUpperCase() || 'A';
    const avPh      = document.querySelector('.av-ph');
    if (avPh) avPh.textContent = initials;

    initHistoryPage();
    loadSidebarBadges(); // ← ADDED
});

// ── Sidebar ──────────────────────────────────────────────────
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

el('sign-out-btn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '../barangaydocs_login.html';
});

// ── Toast ────────────────────────────────────────────────────
function showToast(msg) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Helpers ──────────────────────────────────────────────────
function tsToDate(val) {
    if (!val) return null;
    return val?.toDate ? val.toDate() : new Date(val);
}

function formatDateTime(val) {
    const d = tsToDate(val);
    if (!d) return '—';
    const date = d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${date} at ${time}`;
}

function formatDateGroup(d) {
    const today     = new Date();
    const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString())     return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function dateKey(d) {
    // YYYY-MM-DD string for grouping
    return d.toISOString().split('T')[0];
}

// ── Event Definitions ─────────────────────────────────────────
// Each event has: { id, ts (Date), category, type, title, ref, searchText }

function makeEvent(id, ts, category, type, title, ref, searchText) {
    return { id, ts, category, type, title, ref, searchText: (searchText || '').toLowerCase() };
}

// ── Collect Events from Firestore ────────────────────────────

async function collectEvents() {
    const events = [];

    // ── 1. REQUESTS collection ───────────────────────────────
    try {
        const reqSnap = await getDocs(collection(db, 'requests'));

        reqSnap.forEach(docSnap => {
            const d   = docSnap.data();
            const rid = docSnap.id;
            const ref  = d.referenceNo || rid;
            const name = d.residentName || 'Unknown Resident';
            const type = d.documentType || 'Document';

            // Submitted
            if (d.createdAt) {
                events.push(makeEvent(
                    `req-created-${rid}`,
                    tsToDate(d.createdAt),
                    'request', 'submitted',
                    `<span class="highlight">${name}</span> submitted a request for <span class="highlight">${type}</span>`,
                    ref,
                    `${name} ${type} ${ref} submitted request`
                ));
            }

            // Processing started
            if (d.processedAt) {
                events.push(makeEvent(
                    `req-processed-${rid}`,
                    tsToDate(d.processedAt),
                    'request', 'processing',
                    `Request for <span class="highlight">${type}</span> by ${name} marked as <span class="highlight">Processing</span>`,
                    ref,
                    `${name} ${type} ${ref} processing`
                ));
            }

            // Approved (no dedicated timestamp — infer from updatedAt when status=approved)
            if (d.status === 'approved' && d.updatedAt && !d.readyAt) {
                events.push(makeEvent(
                    `req-approved-${rid}`,
                    tsToDate(d.updatedAt),
                    'request', 'approved',
                    `Request for <span class="highlight">${type}</span> by ${name} was <span class="highlight">Approved</span>`,
                    ref,
                    `${name} ${type} ${ref} approved`
                ));
            }

            // Ready for pickup + QR generated
            if (d.readyAt) {
                events.push(makeEvent(
                    `req-ready-${rid}`,
                    tsToDate(d.readyAt),
                    'request', 'ready',
                    `QR code generated — <span class="highlight">${type}</span> for ${name} is <span class="highlight">Ready for Pickup</span>`,
                    ref,
                    `${name} ${type} ${ref} ready pickup qr`
                ));
            }

            // Released
            if (d.releasedAt) {
                events.push(makeEvent(
                    `req-released-${rid}`,
                    tsToDate(d.releasedAt),
                    'request', 'released',
                    `<span class="highlight">${type}</span> for ${name} has been <span class="highlight">Released</span> to the resident`,
                    ref,
                    `${name} ${type} ${ref} released`
                ));
            }

            // Rejected
            if (d.status === 'rejected' && d.updatedAt) {
                const reason = d.rejectReason ? ` — "${d.rejectReason}"` : '';
                events.push(makeEvent(
                    `req-rejected-${rid}`,
                    tsToDate(d.updatedAt),
                    'request', 'rejected',
                    `Request for <span class="highlight">${type}</span> by ${name} was <span class="highlight">Rejected</span>${reason}`,
                    ref,
                    `${name} ${type} ${ref} rejected ${d.rejectReason || ''}`
                ));
            }
        });
    } catch (err) {
        console.error('Failed to load requests:', err);
        showToast('Could not load request history.');
    }

    // ── 2. RESIDENTS collection ───────────────────────────────
    try {
        const resSnap = await getDocs(collection(db, 'residents'));

        resSnap.forEach(docSnap => {
            const d    = docSnap.data();
            const uid  = docSnap.id;
            const first = d.firstName || '';
            const last  = d.lastName  || '';
            const name  = `${first} ${last}`.trim() || 'Unknown Resident';
            const email = d.email || '';

            // Account registered
            if (d.createdAt) {
                events.push(makeEvent(
                    `res-created-${uid}`,
                    tsToDate(d.createdAt),
                    'account', 'register',
                    `New account registered: <span class="highlight">${name}</span>${email ? ` (${email})` : ''}`,
                    null,
                    `${name} ${email} register account created`
                ));
            }

            // Account approved
            if (d.approvedAt || (d.status === 'active' && d.updatedAt)) {
                const approvedTs = d.approvedAt || d.updatedAt;
                events.push(makeEvent(
                    `res-approved-${uid}`,
                    tsToDate(approvedTs),
                    'account', 'account-approved',
                    `Account for <span class="highlight">${name}</span> was <span class="highlight">Approved</span> by admin`,
                    null,
                    `${name} ${email} approved account active`
                ));
            }

            // Account rejected
            if (d.status === 'rejected' && (d.rejectedAt || d.updatedAt)) {
                const rejectedTs = d.rejectedAt || d.updatedAt;
                events.push(makeEvent(
                    `res-rejected-${uid}`,
                    tsToDate(rejectedTs),
                    'account', 'account-rejected',
                    `Account for <span class="highlight">${name}</span> was <span class="highlight">Rejected</span>`,
                    null,
                    `${name} ${email} rejected account`
                ));
            }
        });
    } catch (err) {
        console.error('Failed to load residents:', err);
        showToast('Could not load account history.');
    }

    // ── 3. DOCUMENTS collection ───────────────────────────────
    try {
        const docSnap = await getDocs(collection(db, 'documents'));

        docSnap.forEach(snap => {
            const d   = snap.data();
            const did = snap.id;
            const docName = d.name || d.title || d.documentType || did;

            // Added
            if (d.createdAt) {
                events.push(makeEvent(
                    `doc-created-${did}`,
                    tsToDate(d.createdAt),
                    'document', 'doc-add',
                    `Document type <span class="highlight">${docName}</span> was <span class="highlight">added</span> to the system`,
                    null,
                    `${docName} document added created`
                ));
            }

            // Updated (only if updatedAt differs from createdAt)
            if (d.updatedAt) {
                const created = tsToDate(d.createdAt);
                const updated = tsToDate(d.updatedAt);
                const diffMs  = created && updated ? Math.abs(updated - created) : 9999;
                if (diffMs > 5000) {
                    events.push(makeEvent(
                        `doc-updated-${did}`,
                        updated,
                        'document', 'doc-update',
                        `Document type <span class="highlight">${docName}</span> was <span class="highlight">updated</span>`,
                        null,
                        `${docName} document updated`
                    ));
                }
            }

            // Removed / deactivated
            if (d.status === 'inactive' && (d.deletedAt || d.updatedAt)) {
                const removedTs = d.deletedAt || d.updatedAt;
                events.push(makeEvent(
                    `doc-removed-${did}`,
                    tsToDate(removedTs),
                    'document', 'doc-remove',
                    `Document type <span class="highlight">${docName}</span> was <span class="highlight">removed</span> from the system`,
                    null,
                    `${docName} document removed deleted inactive`
                ));
            }
        });
    } catch (err) {
        console.error('Failed to load documents:', err);
        showToast('Could not load document history.');
    }

    // Sort newest first
    events.sort((a, b) => (b.ts?.getTime() || 0) - (a.ts?.getTime() || 0));
    return events;
}

// ── Event → HTML ─────────────────────────────────────────────

const iconMap = {
    submitted:       { cls: 'icon-request',    svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
    processing:      { cls: 'icon-processing', svg: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>' },
    approved:        { cls: 'icon-approved',   svg: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>' },
    ready:           { cls: 'icon-ready',      svg: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3"/><path d="M20 14v.01"/><path d="M14 20h.01"/><path d="M17 20h3"/><path d="M20 17v3"/>' },
    released:        { cls: 'icon-released',   svg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' },
    rejected:        { cls: 'icon-rejected',   svg: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
    register:        { cls: 'icon-register',   svg: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>' },
    'account-approved': { cls: 'icon-account', svg: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>' },
    'account-rejected': { cls: 'icon-rejected',svg: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="23" y2="12"/><line x1="23" y1="8" x2="19" y2="12"/>' },
    'doc-add':       { cls: 'icon-doc-add',    svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>' },
    'doc-remove':    { cls: 'icon-doc-remove', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/>' },
    'doc-update':    { cls: 'icon-doc-update', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' },
};

const tagMap = {
    request:  '<span class="event-tag tag-request">Request</span>',
    account:  '<span class="event-tag tag-account">Account</span>',
    document: '<span class="event-tag tag-document">Document</span>',
};

const clockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

function buildEventRow(ev) {
    const icon = iconMap[ev.type] || iconMap['submitted'];
    const tag  = tagMap[ev.category] || '';
    const timeStr = ev.ts ? formatDateTime(ev.ts) : '—';
    const refBadge = ev.ref
        ? `<span class="event-ref">${ev.ref}</span>`
        : '';

    return `
      <div class="event-row" data-category="${ev.category}" data-search="${ev.searchText}" data-ts="${ev.ts?.getTime() || 0}">
        <div class="event-icon ${icon.cls}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${icon.svg}
          </svg>
        </div>
        <div class="event-body">
          <div class="event-title">${ev.title}</div>
          <div class="event-meta">
            ${tag}
            <span class="event-time">${clockIcon} ${timeStr}</span>
          </div>
        </div>
        ${refBadge}
      </div>`;
}

// ── Render Feed ───────────────────────────────────────────────

let allEvents = [];

function renderFeed(events) {
    const feed = el('historyFeed');
    if (!feed) return;

    // Remove skeletons
    feed.querySelectorAll('.skeleton-row').forEach(s => s.remove());

    if (events.length === 0) {
        feed.innerHTML = `
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
            <h3>No Activity Found</h3>
            <p>No history entries match your current filters. Try adjusting the search or category.</p>
          </div>`;
        el('filterCount').textContent = '0 events';
        return;
    }

    el('filterCount').textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;

    // Group by date
    const groups = new Map(); // dateKey → [events]
    events.forEach(ev => {
        const key = ev.ts ? dateKey(ev.ts) : 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ev);
    });

    let html = '';
    groups.forEach((evs, key) => {
        const labelDate = evs[0].ts ? new Date(evs[0].ts) : null;
        const label     = labelDate ? formatDateGroup(labelDate) : 'Unknown Date';
        html += `
          <div class="date-group">
            <div class="date-group-header">
              <span class="date-group-label">${label}</span>
              <div class="date-group-line"></div>
              <span class="date-group-count">${evs.length} event${evs.length !== 1 ? 's' : ''}</span>
            </div>
            ${evs.map(buildEventRow).join('')}
          </div>`;
    });

    feed.innerHTML = html;
}

// ── Filters ───────────────────────────────────────────────────

function applyFilters() {
    const search    = (el('searchInput')?.value || '').toLowerCase().trim();
    const category  = el('categoryFilter')?.value || 'all';
    const dateRange = el('dateFilter')?.value || 'all';

    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart  = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const filtered = allEvents.filter(ev => {
        if (category !== 'all' && ev.category !== category) return false;
        if (search && !ev.searchText.includes(search) && !(ev.ref || '').toLowerCase().includes(search)) return false;
        if (dateRange !== 'all' && ev.ts) {
            if (dateRange === 'today'  && ev.ts < todayStart)  return false;
            if (dateRange === 'week'   && ev.ts < weekStart)   return false;
            if (dateRange === 'month'  && ev.ts < monthStart)  return false;
        }
        return true;
    });

    renderFeed(filtered);
}

// ── Stats ─────────────────────────────────────────────────────

function updateStats(events) {
    const counts = { request: 0, account: 0, document: 0 };
    events.forEach(ev => { if (counts[ev.category] !== undefined) counts[ev.category]++; });

    if (el('statRequests'))  el('statRequests').textContent  = counts.request;
    if (el('statAccounts'))  el('statAccounts').textContent  = counts.account;
    if (el('statDocuments')) el('statDocuments').textContent = counts.document;
    if (el('statTotal'))     el('statTotal').textContent     = events.length;
}

// ── Init ─────────────────────────────────────────────────────

async function initHistoryPage() {
    try {
        allEvents = await collectEvents();
        updateStats(allEvents);
        renderFeed(allEvents);

        // Wire filters
        el('searchInput')?.addEventListener('input',     applyFilters);
        el('categoryFilter')?.addEventListener('change', applyFilters);
        el('dateFilter')?.addEventListener('change',     applyFilters);

    } catch (err) {
        console.error('History init error:', err);
        const feed = el('historyFeed');
        if (feed) feed.innerHTML = `
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <h3>Failed to Load History</h3>
            <p>Could not fetch audit data. Check your Firestore rules and connection. (${err.message})</p>
          </div>`;
        showToast('Error loading history.');
    }
}

// =============================================
// Sidebar Badges (real-time)
// =============================================
function loadSidebarBadges() {
    // Count pending + processing + approved requests (matches dashboard)
    onSnapshot(
        query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (snap) => {
            const badge = el('pending-requests-badge');
            if (badge) badge.textContent = snap.size;
        }
    );

    // Count pending residents client-side (matches dashboard)
    onSnapshot(
        collection(db, 'residents'),
        (snap) => {
            const pendingCount = snap.docs.filter(d => d.data().status === 'pending').length;
            const badge = el('pending-users-badge');
            if (badge) badge.textContent = pendingCount;
        }
    );
}