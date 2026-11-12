// =============================================
// adminnavbar.js  (shared by every admin page)
// - Notification bell: new pending document requests + new pending users
//   (opens on hover AND click, items link to their pages)
// - Admin avatar hover/click card: full name + email
// Usage: <script type="module" src="adminnavbar.js"></script>
// =============================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

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

// ---------- Styles ----------
const style = document.createElement('style');
style.textContent = `
.notif-wrap, .admin-wrap { position: relative; }
.notif-dot { display: none; }
.notif-dot.show { display: block; }
.notif-count { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #DC3545; color: #fff; font-size: 10px; font-weight: 800; display: none; align-items: center; justify-content: center; border: 2px solid #1B3A6B; pointer-events: none; }
.notif-count.show { display: flex; }
.notif-panel { display: none; position: absolute; top: 46px; right: 0; width: 340px; max-width: calc(100vw - 24px); background: #fff; border: 1.5px solid #D0DCF0; border-radius: 14px; box-shadow: 0 10px 30px rgba(27,58,107,0.2); overflow: hidden; z-index: 300; }
.notif-panel.show { display: block; }
.notif-panel-head { padding: 12px 16px; background: #F0F4FA; border-bottom: 1.5px solid #D0DCF0; font-family: 'Poppins', sans-serif; font-size: 13px; font-weight: 700; color: #1B3A6B; }
.notif-list { max-height: 380px; overflow-y: auto; }
.notif-item { display: flex; gap: 10px; align-items: flex-start; padding: 12px 16px; border-bottom: 1px solid #D0DCF0; cursor: pointer; transition: background 0.15s; }
.notif-item:last-child { border-bottom: none; }
.notif-item:hover { background: #F0F4FA; }
.notif-item.unseen { background: #F3F8FF; }
.notif-ico { width: 32px; height: 32px; flex-shrink: 0; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
.notif-ico.req { background: #FFF3CD; }
.notif-ico.usr { background: #CCE5FF; }
.notif-item h5 { font-size: 12px; font-weight: 800; color: #1B3A6B; }
.notif-item p { font-size: 11px; color: #6B7A99; margin-top: 2px; }
.notif-item time { font-size: 10px; color: #9AA5BC; display: block; margin-top: 2px; }
.notif-empty { padding: 28px 16px; text-align: center; font-size: 13px; color: #6B7A99; }
.admin-card { display: none; position: absolute; top: 46px; right: 0; min-width: 240px; max-width: calc(100vw - 24px); background: #fff; border: 1.5px solid #D0DCF0; border-radius: 14px; box-shadow: 0 10px 30px rgba(27,58,107,0.2); padding: 14px 16px; z-index: 300; }
.admin-card.show { display: block; }
.admin-card-role { font-size: 10px; font-weight: 800; color: #9AA5BC; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px; }
.admin-card-name { font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 700; color: #1B3A6B; word-break: break-word; }
.admin-card-email { font-size: 12px; color: #6B7A99; margin-top: 3px; word-break: break-all; }
`;
document.head.appendChild(style);

// ---------- Markup (replaces the static bell + avatar in the navbar) ----------
const navRight = document.querySelector('.navbar-right');
if (navRight) {
    navRight.innerHTML = `
        <div class="notif-wrap" id="notifWrap">
            <button class="notif-btn" id="notifBtn" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <div class="notif-dot" id="notifDot"></div>
            </button>
            <span class="notif-count" id="notifCount">0</span>
            <div class="notif-panel" id="notifPanel">
                <div class="notif-panel-head">Notifications</div>
                <div class="notif-list" id="notifList"><div class="notif-empty">No new notifications</div></div>
            </div>
        </div>
        <div class="admin-wrap" id="adminWrap">
            <div class="admin-avatar" id="adminAvatar"></div>
            <div class="admin-card" id="adminCard">
                <div class="admin-card-role">Administrator</div>
                <div class="admin-card-name" id="adminCardName">—</div>
                <div class="admin-card-email" id="adminCardEmail">—</div>
            </div>
        </div>`;

    // Avatar: image if available, otherwise initials
    const avatar = document.getElementById('adminAvatar');
    const img = document.createElement('img');
    img.src = 'admin_avatar.png';
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.addEventListener('error', () => {
        const ph = document.createElement('span');
        ph.className = 'av-ph';
        ph.textContent = 'A';
        img.replaceWith(ph);
    });
    avatar.appendChild(img);
}

// ---------- Helpers ----------
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(val) {
    const d = val?.toDate ? val.toDate() : new Date(val);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
function timeAgo(val) {
    if (!val) return '';
    const d = val?.toDate ? val.toDate() : new Date(val);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs} hr ago`;
    return fmtDate(val);
}

// ---------- Hover + click behaviour (shared) ----------
function hoverClick(wrap, panel, onOpen, onClose) {
    let pinned = false, timer = null;
    const open  = () => { clearTimeout(timer); if (panel.classList.contains('show')) return; panel.classList.add('show'); onOpen?.(); };
    const close = () => { pinned = false; clearTimeout(timer); if (!panel.classList.contains('show')) return; panel.classList.remove('show'); onClose?.(); };
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', () => { if (!pinned) timer = setTimeout(close, 200); });
    wrap.firstElementChild.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pinned) close(); else { pinned = true; open(); }
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
}

// ---------- Admin card ----------
async function initAdminCard(user) {
    try {
        const snap = await getDoc(doc(db, 'admins', user.uid));
        const d = snap.exists() ? snap.data() : {};
        const fullName = [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ')
            || d.fullName || d.name || d.username || 'Admin';
        document.getElementById('adminCardName').textContent  = fullName;
        document.getElementById('adminCardEmail').textContent = d.email || user.email || '—';

        const initials = ((d.firstName?.[0] || '') + (d.lastName?.[0] || '')).toUpperCase() || 'A';
        const ph = document.querySelector('#adminAvatar .av-ph');
        if (ph) ph.textContent = initials;
    } catch (err) {
        console.error('Admin card error:', err);
        document.getElementById('adminCardEmail').textContent = user.email || '—';
    }

    const aWrap = document.getElementById('adminWrap');
    hoverClick(aWrap, document.getElementById('adminCard'));
}

// ---------- Notification bell ----------
function initBell() {
    const wrap  = document.getElementById('notifWrap');
    const panel = document.getElementById('notifPanel');
    const list  = document.getElementById('notifList');
    const dot   = document.getElementById('notifDot');
    const count = document.getElementById('notifCount');
    if (!wrap) return;

    const SEEN_KEY = 'bdocs_admin_seen_notifs';   // same key as dashboard
    const loadSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } };
    const saveSeen = (s) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch {} };

    let requests = [], users = [];

    function markAllSeen() {
        const seen = loadSeen();
        requests.forEach(r => seen.add('req_' + r.id));
        users.forEach(u    => seen.add('usr_' + u.id));
        saveSeen(seen);
    }

    function render() {
        const seen  = loadSeen();
        const items = [
            ...requests.map(r => ({ key: 'req_' + r.id, type: 'req', time: r.createdAt, data: r })),
            ...users.map(u    => ({ key: 'usr_' + u.id, type: 'usr', time: u.createdAt, data: u }))
        ].sort((a, b) => (b.time?.toMillis?.() || 0) - (a.time?.toMillis?.() || 0));

        // Keep the dot hidden while the panel is open
        const unseen = panel.classList.contains('show') ? 0 : items.filter(i => !seen.has(i.key)).length;
        dot.classList.toggle('show', unseen > 0);
        count.classList.toggle('show', unseen > 0);
        count.textContent = unseen > 9 ? '9+' : unseen;

        if (!items.length) {
            list.innerHTML = '<div class="notif-empty">No new notifications</div>';
            return;
        }

        list.innerHTML = items.map(i => {
            const isReq = i.type === 'req';
            const d     = i.data;
            const name  = isReq
                ? (d.residentName || 'A resident')
                : ([d.firstName, d.lastName].filter(Boolean).join(' ') || d.fullName || d.email || 'A resident');
            const sub   = isReq ? `${esc(d.documentType || 'Document')} — ${esc(name)}` : esc(name);
            return `
                <div class="notif-item ${seen.has(i.key) ? '' : 'unseen'}" data-href="${isReq ? 'admin_pending_requests.html' : 'admin_pending_users.html'}">
                    <div class="notif-ico ${isReq ? 'req' : 'usr'}">${isReq ? '📄' : '👤'}</div>
                    <div>
                        <h5>${isReq ? 'New document request' : 'New user awaiting approval'}</h5>
                        <p>${sub}</p>
                        <time>${timeAgo(i.time)}</time>
                    </div>
                </div>`;
        }).join('');

        list.querySelectorAll('.notif-item').forEach(el => {
            el.addEventListener('click', () => {
                markAllSeen();
                window.location.href = el.dataset.href;
            });
        });
    }

    onSnapshot(query(collection(db, 'requests'), where('status', '==', 'pending')), (snap) => {
        requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
    });
    onSnapshot(query(collection(db, 'residents'), where('status', '==', 'pending')), (snap) => {
        users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
    });

    hoverClick(
        wrap, panel,
        () => { markAllSeen(); dot.classList.remove('show'); count.classList.remove('show'); },  // on open
        () => render()                                                                           // on close
    );
}

// ---------- Start once an admin is signed in ----------
if (navRight) {
    let started = false;
    onAuthStateChanged(auth, (user) => {
        if (!user || started) return;
        started = true;
        initAdminCard(user);
        initBell();
    });
}