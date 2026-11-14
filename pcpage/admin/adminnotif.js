// =============================================
// adminnotif.js — makes the admin top-bar bell work on every admin page.
// Shows what needs attention (new document requests, profile change
// requests, pending registrations). Items are clickable; the red dot only
// appears when something is waiting.
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

const btn = document.querySelector('.notif-btn');
if (btn) {
    // ---- UI ----
    const style = document.createElement('style');
    style.textContent = `
    .an-wrap{position:relative;display:inline-flex}
    .an-count{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 4px;border-radius:99px;background:#DC3545;color:#fff;font:800 10px 'Nunito',sans-serif;display:none;align-items:center;justify-content:center;border:2px solid #1B3A6B;pointer-events:none}
    .an-count.show{display:flex}
    .an-drop{display:none;position:absolute;top:calc(100% + 10px);right:0;width:340px;max-width:92vw;background:#fff;border:2px solid #D0DCF0;border-radius:16px;box-shadow:0 12px 40px rgba(27,58,107,.18);z-index:900;overflow:hidden;font-family:'Nunito',sans-serif}
    .an-drop.show{display:block}
    .an-head{padding:13px 16px;border-bottom:1.5px solid #D0DCF0;font:700 14px 'Poppins',sans-serif;color:#1B3A6B}
    .an-list{max-height:360px;overflow-y:auto}
    .an-item{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid #D0DCF0;cursor:pointer;transition:background .15s}
    .an-item:hover,.an-item:focus-visible{background:#F0F4FA;outline:none}
    .an-item:last-child{border-bottom:none}
    .an-dot{width:9px;height:9px;border-radius:50%;margin-top:5px;flex-shrink:0}
    .an-dot.req{background:#FFC107}.an-dot.prof{background:#2A5298}.an-dot.user{background:#DC3545}
    .an-t{font-size:13px;font-weight:800;color:#1B3A6B}
    .an-s{font-size:11.5px;color:#6B7A99;margin-top:2px}
    .an-empty{padding:30px 16px;text-align:center;font-size:13px;font-weight:700;color:#9AA5BC}`;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'an-wrap';
    btn.parentNode.insertBefore(wrap, btn);
    wrap.appendChild(btn);
    const count = document.createElement('span'); count.className = 'an-count';
    const drop  = document.createElement('div');  drop.className = 'an-drop';
    drop.innerHTML = '<div class="an-head">Needs your attention</div><div class="an-list"></div>';
    wrap.append(count, drop);
    const list = drop.querySelector('.an-list');
    const dot  = btn.querySelector('.notif-dot');
    if (dot) dot.style.display = 'none';

    btn.addEventListener('click', (e) => { e.stopPropagation(); drop.classList.toggle('show'); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) drop.classList.remove('show'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') drop.classList.remove('show'); });

    // ---- data ----
    const state = { req: [], prof: [], user: [] };
    const ts = (v) => v?.toMillis?.() ?? 0;
    const ago = (v) => {
        const m = Math.floor((Date.now() - ts(v)) / 60000);
        if (!ts(v)) return '';
        if (m < 1) return 'Just now'; if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    };

    function render() {
        const items = [
            ...state.req.map(d  => ({ k: 'req',  href: 'admin_pending_requests.html', t: 'New document request', s: `${d.documentType || 'Document'} · ${d.residentName || ''}`, time: d.createdAt })),
            ...state.prof.map(d => ({ k: 'prof', href: 'admin_profile_changes.html',   t: 'Profile change request', s: `${d.residentName || ''} · ${(d.changedFields || []).join(', ')}`, time: d.createdAt })),
            ...state.user.map(d => ({ k: 'user', href: 'admin_pending_users.html',     t: 'New registration', s: `${d.firstName || ''} ${d.lastName || ''}`.trim(), time: d.createdAt }))
        ].sort((a, b) => ts(b.time) - ts(a.time));

        const total = state.req.length + state.prof.length + state.user.length;
        count.textContent = total > 99 ? '99+' : total;
        count.classList.toggle('show', total > 0);

        list.innerHTML = '';
        if (!items.length) { const e = document.createElement('div'); e.className = 'an-empty'; e.textContent = 'You\'re all caught up'; list.appendChild(e); return; }
        items.slice(0, 15).forEach(it => {
            const row = document.createElement('div'); row.className = 'an-item'; row.tabIndex = 0; row.setAttribute('role', 'link');
            const d = document.createElement('div'); d.className = 'an-dot ' + it.k;
            const b = document.createElement('div');
            const t = document.createElement('div'); t.className = 'an-t'; t.textContent = it.t;
            const s = document.createElement('div'); s.className = 'an-s'; s.textContent = [it.s, ago(it.time)].filter(Boolean).join(' · ');
            b.append(t, s); row.append(d, b);
            const go = () => { window.location.href = it.href; };
            row.addEventListener('click', go);
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
            list.appendChild(row);
        });
    }
    render();

    onAuthStateChanged(auth, async (user) => {
        if (!user) return;
        try {
            const a = await getDoc(doc(db, 'admins', user.uid));
            if (!a.exists()) return;
        } catch (_) { return; }
        const sub = (q, key) => onSnapshot(q, (snap) => { state[key] = snap.docs.map(d => d.data()); render(); },
                                           (err) => console.error('Bell listener failed:', key, err));
        sub(query(collection(db, 'requests'), where('status', '==', 'pending')), 'req');
        sub(query(collection(db, 'profileChangeRequests'), where('status', '==', 'pending')), 'prof');
        sub(query(collection(db, 'residents'), where('status', '==', 'pending')), 'user');
    });
}