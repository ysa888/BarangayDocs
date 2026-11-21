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
Chart.register({ id: 'emptyMsg', afterDraw(ch) {   // "no data" text for the AI charts
    if (!ch.canvas.id.startsWith('cAi') || !ch.chartArea) return;
    if (ch.data.datasets.some(d => (d.data || []).some(v => +v > 0))) return;
    const { ctx, chartArea: a } = ch;
    ctx.save(); ctx.fillStyle = '#9AA5BC'; ctx.font = "700 13px Nunito, sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No data for this period', (a.left + a.right) / 2, (a.top + a.bottom) / 2); ctx.restore();
} });

const state = { reqs: [], res: [], reqsLoaded: false, reqsError: false };
const AI = { ratings: [], unans: [], kb: [], usage: [] };   // anonymous fields only, no names or uids
let AIS = null;                                           // last AI summary, used by the CSV export
const S = { gender: null, civil: null, st: null };
const C = {};
let ALL = [], CUR = [];

/* ---------- Data ---------- */
function build() {
    if (!state.reqs.length) { ALL = []; return; }
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
function syncDocOptions() {
    const sel = $('doc'), cur = sel.value, names = [...new Set(ALL.map(r => r.doc))].sort();
    if (names.join('|') === [...sel.options].slice(1).map(o => o.value).join('|')) return;
    sel.length = 1;
    names.forEach(n => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
    sel.value = names.includes(cur) ? cur : 'all';
}

/* ---------- Charts ---------- */
const OPT = {}, KEY = {};
function mk(id, type, data, o = {}, key) {
    OPT[id] = o; KEY[id] = key;
    if (C[id]) { C[id].data = data; C[id].update(); return; }
    C[id] = new Chart($(id), { type, data, options: Object.assign({ responsive: true, maintainAspectRatio: false,
        onClick: (e, els) => openPop(id, els.length ? els[0].index : -1),
        onHover: (e) => { e.native.target.style.cursor = 'default'; } }, o) });
}

/* ---------- Details popup (same modal style as BarangayDocs) ---------- */
let pop = null, popChart = null;
const dup = (v) => Array.isArray(v) ? v.map(dup) : (v && Object.getPrototypeOf(v) === Object.prototype) ? Object.fromEntries(Object.keys(v).map(k => [k, dup(v[k])])) : v;
function closePop() {
    if (popChart) { popChart.destroy(); popChart = null; }
    if (pop) pop.classList.remove('show');
    document.body.style.overflow = '';
}
function buildPop() {
    pop = el('div', 'modal-overlay'); pop.id = 'popOverlay';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'true');
    pop.innerHTML = '<div class="modal-box"><div class="modal-header"><h3 id="popTitle"></h3>' +
        '<button class="modal-close" type="button" aria-label="Close">\u2715</button></div>' +
        '<p class="modal-sub" id="popSub"></p><div class="pop-pick" id="popPick" hidden></div>' +
        '<div class="pop-cv"><canvas id="popCanvas"></canvas></div>' +
        '<div class="pop-table" id="popTable"></div><div class="modal-btn-row" id="popBtns"></div></div>';
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => { if (e.target === pop) closePop(); });
    pop.querySelector('.modal-close').addEventListener('click', closePop);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop.classList.contains('show')) closePop(); });
}
function showPop(o) {
    if (!pop) buildPop();
    if (popChart) { popChart.destroy(); popChart = null; }
    $('popTitle').textContent = o.title; $('popSub').textContent = o.sub || '';
    pop.querySelector('.pop-cv').hidden = !o.chart;
    if (o.chart) {
        popChart = new Chart($('popCanvas'), dup(o.chart));
        if (o.active != null && o.active >= 0) { popChart.setActiveElements(popChart.data.datasets.map((_, di) => ({ datasetIndex: di, index: o.active }))); popChart.update(); }
    }
    const pick = $('popPick'); pick.hidden = !o.pick; pick.textContent = o.pick || '';
    const hl = [].concat(o.hl == null ? [] : o.hl), wrap = $('popTable'); wrap.innerHTML = '';
    if (o.rows && o.rows.length) {
        const tb = el('table'), hr = el('tr'), body = el('tbody');
        o.head.forEach(h => hr.appendChild(el('th', '', h)));
        tb.appendChild(el('thead')).appendChild(hr);
        o.rows.forEach((r, i) => { const tr = el('tr', hl.includes(i) ? 'hl' : ''); r.forEach(v => tr.appendChild(el('td', '', v == null ? '\u2014' : v))); body.appendChild(tr); });
        tb.appendChild(body); wrap.appendChild(tb);
    } else wrap.appendChild(el('div', 'empty', 'No data for this selection yet.'));
    const btns = $('popBtns'); btns.innerHTML = '';
    const close = el('button', 'modal-btn-cancel', 'Close'); close.type = 'button'; close.addEventListener('click', closePop); btns.appendChild(close);
    if (o.action) { const f = el('button', 'modal-btn-save', o.action.label); f.type = 'button'; f.addEventListener('click', o.action.run); btns.appendChild(f); }
    pop.classList.add('show'); document.body.style.overflow = 'hidden';
}
/* makes a KPI box or insight chip open a details popup (cursor stays default) */
function clickable(node, cfg) {
    node.tabIndex = 0; node.setAttribute('role', 'button');
    const go = () => showPop(cfg);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
}
function openPop(id, idx) {
    const src = C[id], card = $(id).closest('.card'), key = KEY[id];
    const labels = src.data.labels.slice(), dsets = src.data.datasets;
    const cols = dsets.map((d, i) => d.label || (dsets.length === 1 ? 'Count' : 'Series ' + (i + 1)));
    const single = dsets.length === 1, total = single ? dsets[0].data.reduce((a, b) => a + (+b || 0), 0) : 0;
    const o = {
        title: card.querySelector('h3').textContent, sub: card.querySelector('p').textContent,
        chart: { type: src.config.type, data: dup({ labels: src.data.labels, datasets: src.data.datasets }),
                 options: Object.assign({ responsive: true, maintainAspectRatio: false }, dup(OPT[id])) },
        active: idx, hl: idx >= 0 ? idx : null,
        head: ['Item', ...cols, ...(single ? ['Share'] : [])],
        rows: labels.map((l, i) => [l, ...dsets.map(d => d.data[i]), ...(single ? [pct(+dsets[0].data[i] || 0, total) + '%'] : [])])
    };
    if (idx >= 0) o.pick = labels[idx] + ' \u2014 ' + dsets.map((d, i) => (single ? '' : cols[i] + ': ') + d.data[idx]).join(' \u2022 ') +
        (single ? ' (' + pct(+dsets[0].data[idx] || 0, total) + '%)' : '');
    if (key && idx >= 0) {
        const v = labels[idx], on = key === 'doc' ? $('doc').value === v : S[key] === v;
        o.action = { label: on ? 'Clear filter' : 'Filter page by ' + v, run: () => {
            if (key === 'doc') $('doc').value = on ? 'all' : v; else S[key] = on ? null : v;
            closePop(); render();
        } };
    }
    showPop(o);
}
const shortTick = function (v) { const s = this.getLabelForValue(v); return innerWidth < 640 && s.length > 16 ? s.slice(0, 15) + '\u2026' : s; };
const leg = { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } } };

/* chart configs for the KPI popups (the visual shown above the table) */
const popBar = (labels, datasets, extra = {}, horizontal = true) => labels.length ? { type: 'bar', data: { labels, datasets },
    options: Object.assign({ responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
        plugins: { legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } },
        scales: horizontal ? { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { callback: shortTick } } }
                           : { y: { beginAtZero: true, ticks: { precision: 0 } } } }, extra) } : null;
const popDonut = (labels, data, colors) => labels.length ? { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2 }] },
    options: Object.assign({ responsive: true, maintainAspectRatio: false, cutout: '58%' }, leg) } : null;

function render() {
    syncDocOptions();
    const p = +$('period').value, d = $('doc').value, now = Date.now();
    const R = ALL.filter(r => (!p || now - r.created < p * 864e5) && (d === 'all' || r.doc === d) &&
        (!S.gender || r.gender === S.gender) && (!S.civil || r.civil === S.civil) && (!S.st || r.st === S.st));
    CUR = R;
    const nb = $('demo');
    if (state.reqsError) { nb.textContent = 'Could not load requests from Firestore. Check your connection or permissions.'; nb.hidden = false; }
    else { nb.textContent = 'No requests in Firestore yet. This page fills in automatically as residents submit requests.'; nb.hidden = ALL.length > 0 || !state.reqsLoaded; }
    const acc = R.filter(r => grp(r.st) === 'accepted').length, rej = R.filter(r => r.st === 'Rejected').length, pen = R.length - acc - rej, dec = acc + rej;
    const times = R.filter(r => r.decided).map(r => (r.decided - r.created) / 864e5).filter(t => t >= 0);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    $('count').textContent = R.length + (R.length === 1 ? ' request' : ' requests');

    const chips = $('chips'); chips.innerHTML = '';
    [['gender', S.gender], ['civil', S.civil], ['st', S.st]].filter(c => c[1]).forEach(([k, v]) => {
        const c = el('span', 'chip', v + ' \u2715'); c.addEventListener('click', () => { S[k] = null; render(); }); chips.appendChild(c);
    });
    const kp = $('kpis'); kp.innerHTML = '';
    const stc = tally(R, r => r.st), dn = top(tally(R, r => r.doc)).map(x => x[0]);
    const perDoc = (pick) => dn.map(n => { const x = R.filter(r => r.doc === n), c = x.filter(pick).length, dd = x.filter(r => grp(r.st) !== 'pending').length; return [n, c, dd, pct(c, dd) + '%']; })
        .filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const atimes = dn.map(n => { const t = R.filter(r => r.doc === n && r.decided).map(r => (r.decided - r.created) / 864e5).filter(x => x >= 0); return [n, t.length ? (t.reduce((a, b) => a + b, 0) / t.length).toFixed(1) : null, t.length]; }).filter(r => r[2] > 0);
    const kpiCfg = {
        'Total requests': { title: 'Total requests', sub: 'All requests for the current filters, grouped by status', head: ['Status', 'Requests', 'Share'],
            rows: [...new Set([...ST, ...stc.keys()])].filter(x => stc.get(x)).map(x => [x, stc.get(x), pct(stc.get(x), R.length) + '%']) },
        'Accepted': { title: 'Accepted requests', sub: 'Accepted includes approved, ready, and released', head: ['Document', 'Accepted', 'Decided', 'Acceptance rate'], rows: perDoc(r => grp(r.st) === 'accepted') },
        'Rejected': { title: 'Rejected requests', sub: 'Rejected requests by document', head: ['Document', 'Rejected', 'Decided', 'Rejection rate'], rows: perDoc(r => r.st === 'Rejected') },
        'Pending': { title: 'Pending requests', sub: 'Submitted or processing, by document', head: ['Document', 'Pending'],
            rows: dn.map(n => [n, R.filter(r => r.doc === n && grp(r.st) === 'pending').length]).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]) },
        'Avg. processing time': { title: 'Average processing time', sub: 'Days from request to decision, by document', head: ['Document', 'Avg. days', 'Decided requests'],
            rows: atimes.length ? [...atimes, ['All documents', avg.toFixed(1), times.length]] : [] }
    };
    /* each KPI shows its own visual in the popup */
    const sKeys = ST.filter(x => stc.get(x));
    kpiCfg['Total requests'].chart = popDonut(sKeys, sKeys.map(x => stc.get(x)), sKeys.map(x => STC[ST.indexOf(x)]));
    kpiCfg['Accepted'].chart = popBar(kpiCfg['Accepted'].rows.map(r => r[0]), [{ label: 'Accepted', data: kpiCfg['Accepted'].rows.map(r => r[1]), backgroundColor: '#28A745', borderRadius: 6 }]);
    kpiCfg['Rejected'].chart = popBar(kpiCfg['Rejected'].rows.map(r => r[0]), [{ label: 'Rejected', data: kpiCfg['Rejected'].rows.map(r => r[1]), backgroundColor: '#DC3545', borderRadius: 6 }]);
    kpiCfg['Pending'].chart = popBar(kpiCfg['Pending'].rows.map(r => r[0]), [{ label: 'Pending', data: kpiCfg['Pending'].rows.map(r => r[1]), backgroundColor: '#FFC107', borderRadius: 6 }]);
    kpiCfg['Avg. processing time'].chart = popBar(atimes.map(r => r[0]), [{ label: 'Avg. days', data: atimes.map(r => +r[1]), backgroundColor: '#2A5298', borderRadius: 6 }],
        { scales: { x: { beginAtZero: true }, y: { ticks: { callback: shortTick } } } });
    [['Total requests', R.length, ''], ['Accepted', acc + ' (' + pct(acc, dec) + '%)', 'g'], ['Rejected', rej + ' (' + pct(rej, dec) + '%)', 'r'],
     ['Pending', pen, 'y'], ['Avg. processing time', avg.toFixed(1) + ' days', '']].forEach(([l, v, c]) => {
        const k = el('div', 'kpi ' + c); k.append(el('small', '', l), el('b', '', v)); clickable(k, kpiCfg[l]); kp.appendChild(k);
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
    mk('cGender', 'pie', { labels: gc.map(x => x[0]), datasets: [{ data: gc.map(x => x[1]), backgroundColor: ['#2A5298', '#E91E8C', '#7E57C2', '#9AA5BC'], borderWidth: 2 }] }, leg, 'gender');
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

    /* insights (each chip opens the table behind it) */
    const I = [];
    const rr = dl.map(n => { const x = R.filter(r => r.doc === n && grp(r.st) !== 'pending'); return [n, pct(x.filter(r => r.st === 'Rejected').length, x.length), x.length]; }).filter(x => x[2] >= 10).sort((a, b) => b[1] - a[1]);
    const share = (arr) => arr.map(x => [x[0], x[1], pct(x[1], R.length) + '%']);
    if (dc.length) I.push([`${dc[0][0]} is the most requested document (${pct(dc[0][1], R.length)}% of requests)`,
        { title: 'Most requested documents', sub: 'Share of all requests for the current filters', head: ['Document', 'Requests', 'Share'], rows: share(dc), hl: 0 }]);
    if (rr.length) I.push([`Highest rejection rate: ${rr[0][0]} at ${rr[0][1]}%`,
        { title: 'Rejection rate by document', sub: 'Documents with at least 10 decided requests', head: ['Document', 'Rejection rate', 'Decided requests'], rows: rr.map(x => [x[0], x[1] + '%', x[2]]), hl: 0 }]);
    const bd = [...wd].sort((a, b) => b[1] - a[1])[0];
    if (bd) I.push([`Busiest day: ${DAYS[bd[0]]}`,
        { title: 'Requests by weekday', sub: 'When residents file the most requests', head: ['Day', 'Requests', 'Share'], rows: share(DAYS.map((d, i) => [d, wd.get(i) || 0])), hl: bd[0] }]);
    const mt = top(tally(R, r => r.created.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }))), bm = mt[0];
    if (bm) I.push([`Peak month: ${bm[0]} (${bm[1]} requests)`,
        { title: 'Requests by month', sub: 'Busiest months first', head: ['Month', 'Requests', 'Share'], rows: share(mt), hl: 0 }]);
    if (gc.length && gc[0][0] !== 'Unknown') I.push([`${gc[0][0]} residents file ${pct(gc[0][1], R.length)}% of requests`,
        { title: 'Requests by gender', sub: 'Share of requests by resident gender', head: ['Gender', 'Requests', 'Share'], rows: share(gc), hl: 0 }]);
    const ins = $('ins'); ins.innerHTML = ''; I.forEach(([t, cfg]) => { const c = el('span', '', t); clickable(c, cfg); ins.appendChild(c); });
    renderAI();
}

/* ---------- AI Assistant section (anonymous: ratings, unanswered, usage, knowledge base) ---------- */
const REASONS = { 'no-match': 'No match', 'model-no-answer': 'AI had no answer', partial: 'Partly answered' };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
const bucketer = (dates) => {
    const t = dates.map(Number), span = t.length ? (Math.max(...t) - Math.min(...t)) / 864e5 : 0, mode = span <= 45 ? 'd' : span <= 180 ? 'w' : 'm';
    const key = (dt) => { const x = new Date(dt); x.setHours(0, 0, 0, 0); if (mode === 'm') x.setDate(1); if (mode === 'w') x.setDate(x.getDate() - (x.getDay() + 6) % 7); return ymd(x); };
    const label = (k) => new Date(k + 'T00:00:00').toLocaleDateString('en-PH', mode === 'm' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
    return { key, label };
};
function renderAI() {
    if (!$('aiKpis')) return;
    const p = +$('period').value, now = Date.now(), cutoff = p ? now - p * 864e5 : 0;
    const inP = (d) => !p || (d && +d >= cutoff);
    const RT = AI.ratings.filter(r => r.n >= 1 && r.n <= 5 && inP(r.at));
    const UN = AI.unans.filter(u => inP(u.at));
    const US = AI.usage.filter(u => !p || (u.date && +u.date >= cutoff - 864e5));
    const KB = AI.kb;

    const avg = RT.length ? RT.reduce((a, r) => a + r.n, 0) / RT.length : 0;
    const sat = RT.filter(r => r.n >= 4).length;
    const asked = US.reduce((a, u) => a + u.asked, 0), answered = US.reduce((a, u) => a + u.answered, 0);
    const waiting = AI.unans.filter(u => (u.status || 'new') === 'new').length;
    $('aiNoUsage').hidden = AI.usage.length > 0;

    AIS = [['Ratings', RT.length], ['Average rating', avg ? avg.toFixed(2) : ''], ['Rated 4-5 stars (%)', RT.length ? pct(sat, RT.length) : ''],
        ['Questions asked', asked], ['Questions answered', answered], ['Answer rate (%)', asked ? pct(answered, asked) : ''], ['Unanswered questions waiting', waiting]];

    /* ratings over time: bars = count, line = average */
    const rb = bucketer(RT.map(r => r.at)), RB = {};
    RT.forEach(r => { const k = rb.key(r.at); (RB[k] = RB[k] || []).push(r.n); });
    const rk = Object.keys(RB).sort();
    mk('cAiTrend', 'bar', { labels: rk.map(rb.label), datasets: [
        { type: 'line', label: 'Average stars', order: 0, data: rk.map(k => +(RB[k].reduce((a, b) => a + b, 0) / RB[k].length).toFixed(2)), borderColor: '#1B3A6B', backgroundColor: '#1B3A6B', yAxisID: 'y', tension: .35, pointRadius: 4, pointHoverRadius: 6 },
        { label: 'Ratings', order: 1, data: rk.map(k => RB[k].length), backgroundColor: 'rgba(79,195,247,.45)', borderRadius: 6, maxBarThickness: 40, yAxisID: 'y1' }] },
        Object.assign({ scales: { y: { min: 0, max: 5, ticks: { stepSize: 1 } }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } }, leg));

    const dist = [5, 4, 3, 2, 1].map(n => RT.filter(r => r.n === n).length);
    mk('cAiDist', 'bar', { labels: ['5 stars', '4 stars', '3 stars', '2 stars', '1 star'], datasets: [{ label: 'Ratings', data: dist, backgroundColor: '#2A5298', borderRadius: 6, maxBarThickness: 28 }] },
        { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.x + ' rating' + (c.parsed.x === 1 ? '' : 's') + (RT.length ? ' (' + pct(c.parsed.x, RT.length) + '%)' : '') } } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } } });

    /* chat activity per day / week / month */
    const ub = bucketer(US.map(u => u.date).filter(Boolean)), UB = {};
    US.filter(u => u.date).forEach(u => { const k = ub.key(u.date); (UB[k] = UB[k] || [0, 0]); UB[k][0] += u.asked; UB[k][1] += u.answered; });
    const uk = Object.keys(UB).sort();
    mk('cAiUse', 'bar', { labels: uk.map(ub.label), datasets: [
        { label: 'Asked', data: uk.map(k => UB[k][0]), backgroundColor: '#2A5298', borderRadius: 4, maxBarThickness: 32 },
        { label: 'Answered', data: uk.map(k => UB[k][1]), backgroundColor: '#28A745', borderRadius: 4, maxBarThickness: 32 }] },
        Object.assign({ scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }, leg));

    /* unanswered: ranked list (wraps long questions, shows reason + status) */
    const tq = [...UN].sort((a, b) => b.count - a.count).slice(0, 10);
    const list = $('aiTopList'); list.innerHTML = '';
    if (!tq.length) list.appendChild(el('div', 'empty', 'No unanswered questions for this period.'));
    tq.forEach((u, i) => {
        const row = el('div', 'uitem'), body = el('div', 'ubody'), meta = el('div', 'umeta'), cnt = el('div', 'ucount'), bar = el('div', 'ubar'), fill = document.createElement('i');
        fill.style.width = Math.max(4, Math.round(u.count / tq[0].count * 100)) + '%'; bar.appendChild(fill);
        meta.append(el('span', 'pill', REASONS[u.reason] || cap(u.reason)), el('span', '', (u.status || 'new') === 'new' ? 'Waiting for a knowledge entry' : cap(u.status)));
        body.append(el('div', 'uq', u.q || '(no text)'), meta, bar);
        cnt.append(el('b', '', u.count + '\u00D7'), el('small', '', 'asked'));
        row.append(el('div', 'rank', String(i + 1)), body, cnt); list.appendChild(row);
    });

    /* knowledge base coverage: category x status */
    const cats = [...new Set(KB.map(k => k.cat))].sort();
    const cs = (s) => cats.map(c => KB.filter(k => k.cat === c && k.status === s).length);
    mk('cAiKb', 'bar', { labels: cats, datasets: [
        { label: 'Approved', data: cs('approved'), backgroundColor: '#28A745', maxBarThickness: 28 },
        { label: 'Draft', data: cs('draft'), backgroundColor: '#FFC107' },
        { label: 'Archived', data: cs('archived'), backgroundColor: '#9AA5BC' }] },
        Object.assign({ indexAxis: 'y', scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true, ticks: { callback: shortTick } } } }, leg));

    /* KPI boxes + insights (each opens the table behind it) */
    const distCfg = { title: 'Rating distribution', sub: 'How many residents gave each score', head: ['Score', 'Ratings', 'Share'],
        rows: [5, 4, 3, 2, 1].map((n, i) => [n + (n === 1 ? ' star' : ' stars'), dist[i], pct(dist[i], RT.length) + '%']) };
    const useCfg = { title: 'Chat activity', sub: 'Questions asked and answered by the assistant', head: ['Period', 'Asked', 'Answered', 'Answer rate'],
        rows: uk.map(k => [ub.label(k), UB[k][0], UB[k][1], pct(UB[k][1], UB[k][0]) + '%']) };
    const qRows = (arr) => arr.map(u => [clip(u.q || '(no text)', 90), u.count + '\u00D7', (u.status || 'new') === 'new' ? 'Waiting' : cap(u.status)]);
    const topCfg = { title: 'Most asked unanswered questions', sub: 'Top 10 for the selected period', head: ['Question', 'Times asked', 'Status'], rows: qRows(tq), hl: 0 };
    const waitCfg = { title: 'Unanswered questions waiting', sub: 'Still waiting for a knowledge entry (top 10 by times asked)', head: ['Question', 'Times asked', 'Status'],
        rows: qRows(AI.unans.filter(u => (u.status || 'new') === 'new').sort((a, b) => b.count - a.count).slice(0, 10)) };
    const kbCfg = { title: 'Knowledge base coverage', sub: 'Entries per category and status', head: ['Category', 'Approved', 'Draft', 'Archived'],
        rows: cats.map((c, i) => [c, cs('approved')[i], cs('draft')[i], cs('archived')[i]]) };

    distCfg.chart = RT.length ? popBar(['5 stars', '4 stars', '3 stars', '2 stars', '1 star'], [{ label: 'Ratings', data: dist, backgroundColor: '#2A5298', borderRadius: 6 }]) : null;
    useCfg.chart = popBar(uk.map(ub.label), [{ label: 'Asked', data: uk.map(k => UB[k][0]), backgroundColor: '#2A5298', borderRadius: 4 },
        { label: 'Answered', data: uk.map(k => UB[k][1]), backgroundColor: '#28A745', borderRadius: 4 }], {}, false);
    const qChart = (arr) => popBar(arr.map(u => clip(u.q || '(no text)', 40)), [{ label: 'Times asked', data: arr.map(u => u.count), backgroundColor: '#FF8A65', borderRadius: 6 }]);
    topCfg.chart = qChart(tq);
    waitCfg.chart = qChart(AI.unans.filter(u => (u.status || 'new') === 'new').sort((a, b) => b.count - a.count).slice(0, 10));
    kbCfg.chart = popBar(cats, [{ label: 'Approved', data: cs('approved'), backgroundColor: '#28A745' }, { label: 'Draft', data: cs('draft'), backgroundColor: '#FFC107' },
        { label: 'Archived', data: cs('archived'), backgroundColor: '#9AA5BC' }], { scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true, ticks: { callback: shortTick } } } });

    const kp = $('aiKpis'); kp.innerHTML = '';
    [['Average rating', RT.length ? avg.toFixed(1) + ' / 5' : '\u2014', '', distCfg],
     ['Rated 4-5 stars', RT.length ? pct(sat, RT.length) + '%' : '\u2014', 'g', Object.assign({}, distCfg, { hl: [0, 1] })],
     ['Questions asked', asked ? asked : '\u2014', '', useCfg],
     ['Answer rate', asked ? pct(answered, asked) + '%' : '\u2014', 'g', useCfg],
     ['Unanswered, waiting', waiting, waiting ? 'r' : '', waitCfg]].forEach(([l, v, c, cfg]) => {
        const k = el('div', 'kpi ' + c); k.append(el('small', '', l), el('b', '', v)); clickable(k, cfg); kp.appendChild(k);
    });

    /* insights */
    const I = [];
    if (RT.length) I.push([`Residents rate the assistant ${avg.toFixed(1)} / 5 on average (${RT.length} rating${RT.length === 1 ? '' : 's'})`, distCfg]);
    if (asked) I.push([`${pct(answered, asked)}% of questions were answered from the knowledge base`, useCfg]);
    if (tq.length) I.push([`Most repeated unanswered question: "${clip(tq[0].q, 60)}" (${tq[0].count}x)`, topCfg]);
    if (waiting) I.push([`${waiting} unanswered question${waiting === 1 ? '' : 's'} still waiting for a knowledge entry`, waitCfg]);
    const ap = KB.filter(k => k.status === 'approved').length; if (KB.length) I.push([`${ap} of ${KB.length} knowledge entries are approved and live`, kbCfg]);
    const ins = $('aiIns'); ins.innerHTML = ''; I.forEach(([t, cfg]) => { const c = el('span', '', t); clickable(c, cfg); ins.appendChild(c); });
}

window.exportCSV = function () {
    const h = 'Reference,Document,Status,Gender,Age,Civil status,Requested,Decided\n';
    const b = CUR.map(r => [r.id, r.doc, r.st, r.gender, r.age ?? '', r.civil, r.created.toISOString(), r.decided ? r.decided.toISOString() : '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const aiRows = AIS ? '\n\nAI Assistant (selected period),\n' + AIS.map(([k, v]) => `"${k}","${v}"`).join('\n') : '';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([h + b + aiRows], { type: 'text/csv' })); a.download = 'barangaydocs-analytics.csv'; a.click();
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
        (s) => { state[key] = s.docs.map(d => ({ id: d.id, ...d.data() })); if (key === 'reqs') { state.reqsLoaded = true; state.reqsError = false; } build(); render(); },
        (err) => { console.error('Analytics listener failed:', name, err); if (key === 'reqs') { state.reqsError = true; build(); render(); } });
    sub('requests', 'reqs'); sub('residents', 'res');
    // AI assistant data: only anonymous fields are copied (never residentName or uid)
    const subAi = (name, key, map) => onSnapshot(collection(db, name),
        (s) => { AI[key] = s.docs.map(d => map(d.data(), d.id)); renderAI(); },
        (err) => { console.warn('AI analytics listener failed:', name, err); AI[key] = []; renderAI(); });
    subAi('aiRatings',    'ratings', (d) => ({ n: +d.rating, at: toD(d.createdAt) }));
    subAi('aiUnanswered', 'unans',   (d) => ({ q: d.question, count: +d.count || 1, reason: d.reason, status: d.status, at: toD(d.lastAskedAt || d.firstAskedAt) }));
    subAi('aiKnowledge',  'kb',      (d) => ({ cat: d.category || 'General', status: d.status || 'draft' }));
    subAi('aiUsage',      'usage',   (d, id) => ({ date: new Date(String(d.day || id) + 'T00:00:00'), asked: +d.asked || 0, answered: +d.answered || 0 }));

    onSnapshot(query(collection(db, 'requests'), where('status', 'in', ['pending', 'processing', 'approved'])),
        (s) => { const b = $('pending-requests-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'profileChangeRequests'), where('status', '==', 'pending')),
        (s) => { const b = $('profile-changes-badge'); if (b) b.textContent = s.size; });
    onSnapshot(query(collection(db, 'residents'), where('status', '==', 'pending')),
        (s) => { const b = $('pending-users-badge'); if (b) b.textContent = s.size; });
});