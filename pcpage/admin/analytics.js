// =============================================
// analytics.js — Handles: admin_analytics.html
// Live analytics from `requests` joined with `residents` (gender, age,
// civil status). Charts: Chart.js (loaded in the HTML file).
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

/* ---------- Field names (add yours to a list if a chart comes up empty) ---------- */
const KEYS = {
    link:    ['residentId', 'userId', 'uid', 'residentUid'],
    gender:  ['gender', 'sex'],
    birth:   ['birthdate', 'birthDate', 'dateOfBirth', 'dob', 'birthday'],
    age:     ['age'],
    civil:   ['civilStatus', 'civil_status', 'maritalStatus'],
    decided: ['updatedAt', 'reviewedAt', 'processedAt'],
    name:    ['fullName', 'name', 'residentName']
};
const first = (obj, list) => { for (const k of list) if (obj?.[k] != null && obj[k] !== '') return obj[k]; return null; };

/* ---------- Helpers ---------- */
const P  = ['#1B3A6B', '#2A5298', '#4FC3F7', '#7E57C2', '#26A69A', '#FFC107', '#FF8A65', '#9AA5BC'];
const ST = ['Submitted', 'Processing', 'Approved', 'Ready', 'Released', 'Rejected'];
const STC = ['#FFC107', '#4FC3F7', '#2A5298', '#26A69A', '#28A745', '#DC3545'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const grp = (s) => s === 'Rejected' ? 'rejected' : ['Approved', 'Ready', 'Released'].includes(s) ? 'accepted' : 'pending';
const cap = (s) => s ? String(s).trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown';
const toD = (v) => !v ? null : v.toDate ? v.toDate() : new Date(v);
const tally = (a, f) => { const m = new Map(); a.forEach(x => { const k = f(x); m.set(k, (m.get(k) || 0) + 1); }); return m; };
const top = (m) => [...m].sort((a, b) => b[1] - a[1]);
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const q = (a, p) => { const x = (a.length - 1) * p, b = Math.floor(x); return a[b] + (a[b + 1] !== undefined ? (x - b) * (a[b + 1] - a[b]) : 0); };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

Chart.defaults.font.family = "'Nunito',sans-serif";
Chart.defaults.color = '#6B7A99';

const state = { reqs: [], res: [] };
const S = { gender: null, civil: null, st: null };
const C = {};
let ALL = [], CUR = [], usingDemo = false;

/* ---------- Data ---------- */
function build() {
    if (!state.reqs.length) { ALL = demo(); usingDemo = true; return; }
    usingDemo = false;
    const byId = new Map(state.res.map(r => [r.id, r]));
    const byName = new Map();
    state.res.forEach(r => {
        const full = first(r, KEYS.name) || [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' ');
        if (full) byName.set(String(full).trim().toLowerCase(), r);
        if (r.firstName && r.lastName) byName.set((r.firstName + ' ' + r.lastName).trim().toLowerCase(), r);
    });
    ALL = state.reqs.map(r => {
        const u = byId.get(first(r, KEYS.link)) || byName.get(String(r.residentName || '').trim().toLowerCase()) || {};
        const created = toD(r.createdAt); if (!created) return null;
        let st = cap(r.status); if (st === 'Pending') st = 'Submitted';
        const birth = toD(first(r, KEYS.birth) ?? first(u, KEYS.birth));
        const rawAge = first(r, KEYS.age) ?? first(u, KEYS.age);
        const age = birth ? Math.floor((created - birth) / 31557600000) : (rawAge != null ? +rawAge : null);
        return { id: r.referenceNo || r.id, doc: r.documentType || 'Unknown', st, created,
            gender: cap(first(r, KEYS.gender) ?? first(u, KEYS.gender)), civil: cap(first(r, KEYS.civil) ?? first(u, KEYS.civil)),
            age: age > 0 && age < 120 ? age : null,
            decided: grp(st) === 'pending' ? null : toD(first(r, KEYS.decided)) };
    }).filter(Boolean);
    const miss = (f) => ALL.filter(f).length;
    const mg = miss(r => r.gender === 'Unknown'), mc = miss(r => r.civil === 'Unknown'), ma = miss(r => r.age == null);
    if (mg || mc || ma) console.info('[analytics] requests missing gender / civil status / age:', mg, mc, ma, 'of', ALL.length,
        '- if these are high, add your field names to KEYS at the top of analytics.js');
}
function demo() {
    let s = 7; const R = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pick = (a) => { let t = R() * a.reduce((x, y) => x + y[1], 0); for (const [v, w] of a) if ((t -= w) < 0) return v; return a[0][0]; };
    const docs = [['Barangay Clearance', 30], ['Certificate of Residency', 22], ['Certificate of Indigency', 15], ['Barangay ID', 12], ['Business Clearance', 8], ['Good Moral Certificate', 7], ['First-Time Jobseeker Certificate', 6]], out = [];
    for (let i = 0; i < 720; i++) {
        const off = Math.floor(365 * Math.pow(R(), 1.3)), dt = new Date(Date.now() - off * 864e5);
        if ([0, 6].includes(dt.getDay()) && R() < .85) { i--; continue; }
        dt.setHours(8 + Math.floor(R() * 9), Math.floor(R() * 60));
        const d = pick(docs), jb = d.startsWith('First'), base = jb ? 21 : d.includes('Indigency') ? 48 : d.includes('Business') ? 40 : 34;
        const age = Math.max(15, Math.min(88, Math.round(base + (jb ? 3 : 14) * (R() + R() + R() + R() - 2) * 1.73)));
        const civil = age < 24 ? pick([['Single', 90], ['Married', 6], ['Live-In', 4]]) : age >= 60 ? pick([['Married', 45], ['Widowed', 40], ['Single', 8], ['Separated', 7]]) : pick([['Single', 35], ['Married', 45], ['Live-In', 8], ['Separated', 7], ['Widowed', 5]]);
        const st = off < 4 ? pick([['Submitted', 50], ['Processing', 50]]) : R() < (d.includes('Business') ? .14 : .08) ? 'Rejected' : pick([['Released', 72], ['Ready', 18], ['Approved', 10]]);
        out.push({ id: 'DEMO-' + i, doc: d, st, gender: pick([['Female', 53], ['Male', 47]]), civil, age, created: dt,
            decided: grp(st) === 'pending' ? null : new Date(dt.getTime() + (1 + Math.floor(R() * 5)) * 864e5) });
    }
    return out;
}
function syncDocOptions() {
    const sel = $('doc'), cur = sel.value, names = [...new Set(ALL.map(r => r.doc))].sort();
    if (names.join('|') === [...sel.options].slice(1).map(o => o.value).join('|')) return;
    sel.length = 1;
    names.forEach(n => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
    sel.value = names.includes(cur) ? cur : 'all';
}

/* ---------- Charts ---------- */
function mk(id, type, data, o = {}, key) {
    if (C[id]) { C[id].data = data; C[id].update(); return; }
    C[id] = new Chart($(id), { type, data, options: Object.assign({ responsive: true, maintainAspectRatio: false,
        onClick: key ? (e, els) => {
            if (!els.length) return; const v = C[id].data.labels[els[0].index];
            if (key === 'doc') $('doc').value = $('doc').value === v ? 'all' : v; else S[key] = S[key] === v ? null : v;
            render();
        } : undefined,
        onHover: (e, els) => { e.native.target.style.cursor = key && els.length ? 'pointer' : 'default'; } }, o) });
}
const shortTick = function (v) { const s = this.getLabelForValue(v); return innerWidth < 640 && s.length > 16 ? s.slice(0, 15) + '\u2026' : s; };
const leg = { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } } };

function render() {
    syncDocOptions();
    const p = +$('period').value, d = $('doc').value, now = Date.now();
    const R = ALL.filter(r => (!p || now - r.created < p * 864e5) && (d === 'all' || r.doc === d) &&
        (!S.gender || r.gender === S.gender) && (!S.civil || r.civil === S.civil) && (!S.st || r.st === S.st));
    CUR = R;
    $('demo').hidden = !usingDemo;
    const acc = R.filter(r => grp(r.st) === 'accepted').length, rej = R.filter(r => r.st === 'Rejected').length, pen = R.length - acc - rej, dec = acc + rej;
    const times = R.filter(r => r.decided).map(r => (r.decided - r.created) / 864e5).filter(t => t >= 0);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    $('count').textContent = R.length + (R.length === 1 ? ' request' : ' requests');

    const chips = $('chips'); chips.innerHTML = '';
    [['gender', S.gender], ['civil', S.civil], ['st', S.st]].filter(c => c[1]).forEach(([k, v]) => {
        const c = el('span', 'chip', v + ' \u2715'); c.addEventListener('click', () => { S[k] = null; render(); }); chips.appendChild(c);
    });
    const kp = $('kpis'); kp.innerHTML = '';
    [['Total requests', R.length, ''], ['Accepted', acc + ' (' + pct(acc, dec) + '%)', 'g'], ['Rejected', rej + ' (' + pct(rej, dec) + '%)', 'r'],
     ['Pending', pen, 'y'], ['Avg. processing time', avg.toFixed(1) + ' days', '']].forEach(([l, v, c]) => {
        const k = el('div', 'kpi ' + c); k.append(el('small', '', l), el('b', '', v)); kp.appendChild(k);
    });

    /* line: bucket by span */
    const ts = R.map(r => +r.created), span = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 864e5 : 0, mode = span <= 45 ? 'd' : span <= 180 ? 'w' : 'm';
    const key = (dt) => { const x = new Date(dt); if (mode === 'm') x.setDate(1); if (mode === 'w') x.setDate(x.getDate() - (x.getDay() + 6) % 7); return ymd(x); };
    const B = {}; R.forEach(r => { const k = key(r.created); (B[k] = B[k] || [0, 0, 0])[0]++; if (grp(r.st) === 'accepted') B[k][1]++; if (r.st === 'Rejected') B[k][2]++; });
    const ks = Object.keys(B).sort(), lab = ks.map(k => new Date(k + 'T00:00:00').toLocaleDateString('en-PH', mode === 'm' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' }));
    mk('cLine', 'line', { labels: lab, datasets: [
        { label: 'Total', data: ks.map(k => B[k][0]), borderColor: '#1B3A6B', backgroundColor: 'rgba(79,195,247,.18)', fill: true, tension: .35 },
        { label: 'Accepted', data: ks.map(k => B[k][1]), borderColor: '#28A745', tension: .35 },
        { label: 'Rejected', data: ks.map(k => B[k][2]), borderColor: '#DC3545', tension: .35 }] },
        Object.assign({ scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }, elements: { point: { radius: 2 } } }, leg));

    const sc = tally(R, r => r.st);
    mk('cStatus', 'doughnut', { labels: ST, datasets: [{ data: ST.map(s => sc.get(s) || 0), backgroundColor: STC, borderWidth: 2 }] }, Object.assign({ cutout: '58%' }, leg), 'st');

    const dc = top(tally(R, r => r.doc)), dl = dc.map(x => x[0]);
    mk('cDocs', 'bar', { labels: dl, datasets: [{ label: 'Requests', data: dc.map(x => x[1]), backgroundColor: '#2A5298', borderRadius: 6 }] },
        { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { callback: shortTick } } } }, 'doc');
    const og = (k) => dl.map(n => R.filter(r => r.doc === n && grp(r.st) === k).length);
    mk('cOutcome', 'bar', { labels: dl, datasets: [{ label: 'Accepted', data: og('accepted'), backgroundColor: '#28A745' }, { label: 'Rejected', data: og('rejected'), backgroundColor: '#DC3545' }, { label: 'Pending', data: og('pending'), backgroundColor: '#FFC107' }] },
        Object.assign({ indexAxis: 'y', scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true, ticks: { callback: shortTick } } } }, leg));

    const gc = top(tally(R, r => r.gender)), cc = top(tally(R, r => r.civil));
    mk('cGender', 'pie', { labels: gc.map(x => x[0]), datasets: [{ data: gc.map(x => x[1]), backgroundColor: ['#E91E8C', '#2A5298', '#7E57C2', '#9AA5BC'], borderWidth: 2 }] }, leg, 'gender');
    mk('cCivil', 'doughnut', { labels: cc.map(x => x[0]), datasets: [{ data: cc.map(x => x[1]), backgroundColor: P, borderWidth: 2 }] }, Object.assign({ cutout: '55%' }, leg), 'civil');
    const wd = tally(R, r => (r.created.getDay() + 6) % 7);
    mk('cDay', 'bar', { labels: DAYS, datasets: [{ label: 'Requests', data: DAYS.map((_, i) => wd.get(i) || 0), backgroundColor: DAYS.map((_, i) => i > 4 ? '#9AA5BC' : '#4FC3F7'), borderRadius: 6 }] },
        { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } });

    /* age histogram + cumulative line, descriptive stats */
    const ag = R.map(r => r.age).filter(a => a != null).sort((a, b) => a - b), st = $('stats'); st.innerHTML = '';
    if (ag.length) {
        const lo = Math.floor(ag[0] / 5) * 5, hi = Math.floor(ag[ag.length - 1] / 5) * 5, bins = [];
        for (let b = lo; b <= hi; b += 5) bins.push(b);
        const cnt = bins.map(b => ag.filter(a => a >= b && a < b + 5).length); let run = 0;
        mk('cAge', 'bar', { labels: bins.map(b => b + '-' + (b + 4)), datasets: [
            { type: 'line', label: 'Cumulative %', data: cnt.map(c => pct(run += c, ag.length)), borderColor: '#DC3545', yAxisID: 'y1', tension: .3, pointRadius: 2 },
            { label: 'Residents', data: cnt, backgroundColor: '#2A5298', borderRadius: 4, yAxisID: 'y' }] },
            Object.assign({ scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } } } }, leg));
        const mean = ag.reduce((a, b) => a + b, 0) / ag.length, sd = Math.sqrt(ag.reduce((a, b) => a + (b - mean) ** 2, 0) / ag.length), mo = top(tally(ag, a => a))[0][0];
        [['Requests with age data', ag.length], ['Mean', mean.toFixed(1)], ['Median', q(ag, .5).toFixed(1)], ['Most common age', mo], ['Std. deviation', sd.toFixed(1)],
         ['Youngest / oldest', ag[0] + ' / ' + ag[ag.length - 1]], ['Q1 / Q3', q(ag, .25).toFixed(1) + ' / ' + q(ag, .75).toFixed(1)], ['Interquartile range', (q(ag, .75) - q(ag, .25)).toFixed(1)]]
            .forEach(([l, v]) => { const r = el('div', 'sr'); r.append(el('span', '', l), el('b', '', v)); st.appendChild(r); });
    } else {
        if (C.cAge) { C.cAge.data = { labels: [], datasets: [] }; C.cAge.update(); }
        st.appendChild(el('div', 'sr', 'No age data for this selection'));
    }

    /* insights */
    const I = [];
    if (dc.length) I.push(`${dc[0][0]} is the most requested document (${pct(dc[0][1], R.length)}% of requests)`);
    const rr = dl.map(n => { const x = R.filter(r => r.doc === n && grp(r.st) !== 'pending'); return [n, pct(x.filter(r => r.st === 'Rejected').length, x.length), x.length]; }).filter(x => x[2] >= 10).sort((a, b) => b[1] - a[1]);
    if (rr.length) I.push(`Highest rejection rate: ${rr[0][0]} at ${rr[0][1]}%`);
    const bd = [...wd].sort((a, b) => b[1] - a[1])[0]; if (bd) I.push(`Busiest day: ${DAYS[bd[0]]}`);
    const bm = top(tally(R, r => r.created.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })))[0]; if (bm) I.push(`Peak month: ${bm[0]} (${bm[1]} requests)`);
    if (gc.length && gc[0][0] !== 'Unknown') I.push(`${gc[0][0]} residents file ${pct(gc[0][1], R.length)}% of requests`);
    const ins = $('ins'); ins.innerHTML = ''; I.forEach(t => ins.appendChild(el('span', '', t)));
}

window.exportCSV = function () {
    const h = 'Reference,Document,Status,Gender,Age,Civil status,Requested,Decided\n';
    const b = CUR.map(r => [r.id, r.doc, r.st, r.gender, r.age ?? '', r.civil, r.created.toISOString(), r.decided ? r.decided.toISOString() : '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([h + b], { type: 'text/csv' })); a.download = 'barangaydocs-analytics.csv'; a.click();
    const t = $('toast'); t.textContent = 'CSV exported'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000);
};

/* ---------- Page shell (same as the other admin pages) ---------- */
let sidebarOpen = true;
const mobile = window.matchMedia('(max-width: 640px)');
function setDrawer(open) {
    $('sidebar').classList.toggle('open', open);
    $('sidebarBackdrop')?.classList.toggle('show', open);
    document.querySelector('.hamburger-btn')?.setAttribute('aria-expanded', String(open));
}
window.toggleSidebar = function () {
    if (mobile.matches) { setDrawer(!$('sidebar').classList.contains('open')); return; }
    sidebarOpen = !sidebarOpen;
    $('sidebar').classList.toggle('collapsed', !sidebarOpen);
    $('mainContent').classList.toggle('expanded', !sidebarOpen);
};
$('sidebarBackdrop')?.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
mobile.addEventListener('change', () => setDrawer(false));
$('sign-out-btn')?.addEventListener('click', async () => { await signOut(auth); window.location.href = '../barangaydocs_login.html'; });
$('period').addEventListener('change', render);
$('doc').addEventListener('change', render);

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../barangaydocs_login.html'; return; }
    const a = await getDoc(doc(db, 'admins', user.uid));
    if (!a.exists() || a.data().role !== 'admin') {
        alert('Access denied. Admins only.');
        await signOut(auth); window.location.href = '../barangaydocs_login.html'; return;
    }
    const sub = (name, key) => onSnapshot(collection(db, name),
        (s) => { state[key] = s.docs.map(d => ({ id: d.id, ...d.data() })); build(); render(); },
        (err) => { console.error('Analytics listener failed:', name, err); if (key === 'reqs') { build(); render(); } });
    sub('requests', 'reqs'); sub('residents', 'res');

    onSnapshot(query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (s) => { const b = $('pending-requests-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'profileChangeRequests'), where('status', '==', 'pending')),
        (s) => { const b = $('profile-changes-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'residents'), where('status', '==', 'pending')),
        (s) => { const b = $('pending-users-badge'); if (b) b.textContent = s.size; });
});