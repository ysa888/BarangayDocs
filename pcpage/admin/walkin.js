// =============================================
// walkin.js  (pcpage/admin/)
// "Walk-in Request": lets an admin create a document request on behalf of
// someone who has no account. Adds its own button + modal (no HTML needed
// besides loading this script) and writes to requests/{id} with NO uid.
//
// Needs the updated firestore.rules (admin create branch for isWalkIn).
// New requests show up in the existing lists automatically (onSnapshot).
// =============================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
    getFirestore, collection, query, where, getDocs, addDoc, doc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

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

// Same purposes as the resident form (barangaydocs_request.html)
const PURPOSES = ['Employment', 'Travel', 'Medical', 'School / Scholarship',
                  'Government Requirement', 'Loan Application', 'Business', 'Other'];

function generateRef() {                       // same format as request.js: BRY-2026-12345
    const year = new Date().getFullYear();
    const rand = String(Math.floor(10000 + Math.random() * 90000));
    return `BRY-${year}-${rand}`;
}

let adminUser = null;
let built = false;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------
// UI
// ---------------------------------------------
function build() {
    if (built) return;
    built = true;

    const style = document.createElement('style');
    style.textContent = `
    .wi-btn{float:right;height:38px;padding:0 16px;background:var(--primary,#1B3A6B);color:#fff;border:none;border-radius:10px;font:800 13px 'Nunito',sans-serif;cursor:pointer}
    .wi-btn:hover{opacity:.9}
    .wi-overlay{display:none;position:fixed;inset:0;background:rgba(10,20,50,.55);backdrop-filter:blur(3px);z-index:1000;align-items:center;justify-content:center;padding:16px}
    .wi-overlay.show{display:flex}
    .wi-box{background:#fff;border-radius:20px;padding:24px;width:100%;max-width:520px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(27,58,107,.18);font-family:'Nunito',sans-serif}
    .wi-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
    .wi-head h3{font:700 18px 'Poppins',sans-serif;color:var(--text-main,#1B2A4A);margin:0}
    .wi-x{background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-sub,#5A6A85)}
    .wi-sub{font-size:12px;color:var(--text-sub,#5A6A85);margin-bottom:16px}
    .wi-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .wi-f{display:flex;flex-direction:column;min-width:0}
    .wi-f.wide{grid-column:1/-1}
    .wi-f label{font-size:11px;font-weight:800;color:var(--text-sub,#5A6A85);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px}
    .wi-f label i{color:#DC3545;font-style:normal}
    .wi-f input,.wi-f select,.wi-f textarea{width:100%;border:2px solid var(--border,#D0DCF0);border-radius:10px;padding:10px 12px;font:600 13px 'Nunito',sans-serif;color:var(--text-main,#1B2A4A);background:var(--bg,#F0F4FA);outline:none;box-sizing:border-box}
    .wi-f input:focus,.wi-f select:focus,.wi-f textarea:focus{border-color:var(--primary,#1B3A6B);background:#fff}
    .wi-f textarea{resize:none;height:70px}
    .wi-err{display:none;margin-top:12px;font-size:12px;font-weight:800;color:#DC3545}
    .wi-actions{display:flex;gap:10px;margin-top:18px}
    .wi-actions button{height:42px;border-radius:10px;font:800 13px 'Nunito',sans-serif;cursor:pointer}
    .wi-cancel{flex:1;background:transparent;border:2px solid var(--border,#D0DCF0);color:var(--text-sub,#5A6A85)}
    .wi-save{flex:2;background:var(--primary,#1B3A6B);border:none;color:#fff}
    .wi-save:disabled{opacity:.6;cursor:wait}
    .wi-done{display:none;text-align:center;padding:10px 0}
    .wi-done .ref{font:800 22px 'Poppins',sans-serif;color:var(--primary,#1B3A6B);letter-spacing:1px;margin:8px 0}
    .wi-done p{font-size:13px;color:var(--text-sub,#5A6A85);margin:0}
    @media(max-width:560px){.wi-grid{grid-template-columns:1fr}.wi-btn{float:none;margin-bottom:10px}}`;
    document.head.appendChild(style);

    // Button in the page header
    const header = document.querySelector('.page-header');
    if (header) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'wi-btn'; b.textContent = '＋ Walk-in Request';
        b.addEventListener('click', openModal);
        header.insertBefore(b, header.firstChild);
    }

    // Modal
    const overlay = document.createElement('div');
    overlay.className = 'wi-overlay'; overlay.id = 'wi-overlay';
    overlay.innerHTML = `
    <div class="wi-box" role="dialog" aria-modal="true" aria-labelledby="wi-title">
      <div class="wi-head"><h3 id="wi-title">Walk-in Request</h3><button type="button" class="wi-x" id="wi-x" aria-label="Close">✕</button></div>
      <div class="wi-sub">For residents without an account. Creates a pending request on their behalf.</div>
      <div id="wi-form">
        <div class="wi-grid">
          <div class="wi-f wide"><label for="wi-name">Full name <i>*</i></label><input id="wi-name" maxlength="120" autocomplete="off" placeholder="e.g. Juan Dela Cruz"></div>
          <div class="wi-f"><label for="wi-contact">Contact number</label><input id="wi-contact" maxlength="20" inputmode="tel" placeholder="09XXXXXXXXX"></div>
          <div class="wi-f"><label for="wi-age">Age</label><input id="wi-age" maxlength="3" inputmode="numeric" placeholder="e.g. 34"></div>
          <div class="wi-f"><label for="wi-occ">Occupation</label><input id="wi-occ" maxlength="80"></div>
          <div class="wi-f"><label for="wi-addr">Address</label><input id="wi-addr" maxlength="200" placeholder="Street / Purok"></div>
          <div class="wi-f"><label for="wi-doc">Document <i>*</i></label><select id="wi-doc"><option value="">Loading…</option></select></div>
          <div class="wi-f"><label for="wi-purpose">Purpose <i>*</i></label><select id="wi-purpose"></select></div>
          <div class="wi-f wide"><label for="wi-notes">Notes (optional)</label><textarea id="wi-notes" maxlength="300" placeholder="Any special instructions…"></textarea></div>
        </div>
        <div class="wi-err" id="wi-err"></div>
        <div class="wi-actions">
          <button type="button" class="wi-cancel" id="wi-cancel">Cancel</button>
          <button type="button" class="wi-save" id="wi-save">Create Request</button>
        </div>
      </div>
      <div class="wi-done" id="wi-done">
        <div style="font-size:34px">✓</div>
        <p>Walk-in request created. Reference number:</p>
        <div class="ref" id="wi-ref">—</div>
        <p>Give this number to the resident.</p>
        <div class="wi-actions">
          <button type="button" class="wi-cancel" id="wi-close">Close</button>
          <button type="button" class="wi-save" id="wi-another">Add another</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const purposeSel = $('wi-purpose');
    purposeSel.add(new Option('Select purpose', ''));
    PURPOSES.forEach(p => purposeSel.add(new Option(p, p)));

    $('wi-x').onclick = $('wi-cancel').onclick = $('wi-close').onclick = closeModal;
    $('wi-another').onclick = () => { resetForm(); showForm(true); };
    $('wi-save').onclick = submit;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

function showForm(on) {
    $('wi-form').style.display = on ? '' : 'none';
    $('wi-done').style.display = on ? 'none' : 'block';
}
function setError(msg) {
    const e = $('wi-err');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
}
function resetForm() {
    ['wi-name', 'wi-contact', 'wi-age', 'wi-occ', 'wi-addr', 'wi-notes'].forEach(id => { $(id).value = ''; });
    $('wi-purpose').value = '';
    $('wi-doc').value = '';
    setError('');
    const s = $('wi-save'); s.disabled = false; s.textContent = 'Create Request';
}

async function loadDocTypes() {
    const sel = $('wi-doc');
    try {
        const snap = await getDocs(query(collection(db, 'documents'), where('status', '==', 'active')));
        const names = snap.docs.map(d => d.data().name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        sel.innerHTML = '';
        sel.add(new Option(names.length ? 'Select document' : 'No active documents', ''));
        names.forEach(n => sel.add(new Option(n, n)));
    } catch (err) {
        console.error('Walk-in: could not load document types', err);
        sel.innerHTML = '';
        sel.add(new Option('Could not load documents', ''));
    }
}

function openModal() {
    resetForm();
    showForm(true);
    $('wi-overlay').classList.add('show');
    loadDocTypes();
    $('wi-name').focus();
}
function closeModal() { $('wi-overlay')?.classList.remove('show'); }

// ---------------------------------------------
// Submit
// ---------------------------------------------
async function submit() {
    if (!adminUser) return setError('You must be signed in as an admin.');

    const name    = $('wi-name').value.trim().replace(/\s+/g, ' ');
    const contact = $('wi-contact').value.replace(/[\s-]/g, '');
    const age     = $('wi-age').value.trim();
    const occ     = $('wi-occ').value.trim();
    const addr    = $('wi-addr').value.trim();
    const docType = $('wi-doc').value;
    const purpose = $('wi-purpose').value;
    const notes   = $('wi-notes').value.trim();

    if (name.length < 2)  return setError('Please enter the resident’s full name.');
    if (!docType)         return setError('Please select a document.');
    if (!purpose)         return setError('Please select a purpose.');
    if (contact && !/^(\+?63|0)\d{10}$/.test(contact)) return setError('Contact number looks invalid (e.g. 09171234567).');
    if (age && !/^\d{1,3}$/.test(age)) return setError('Age must be a number.');

    const btn = $('wi-save');
    btn.disabled = true; btn.textContent = 'Saving…'; setError('');

    const ref = generateRef();
    try {
        // NOTE: no "uid" field on purpose — the rules identify walk-ins by isWalkIn.
        await addDoc(collection(db, 'requests'), {
            residentName: name,
            documentType: docType,
            purpose,
            notes,
            referenceNo:  ref,
            status:       'pending',
            barangay:     'Barangay Banicain',
            city:         'Olongapo City',
            createdAt:    serverTimestamp(),
            readyAt:      null,
            rejectReason: null,
            docCode:      null,
            qrContent:    null,
            // walk-in details
            isWalkIn:       true,
            source:         'walk-in',
            contactNumber:  contact,
            age,
            occupation:     occ,
            address:        addr,
            createdBy:      adminUser.uid,
            createdByEmail: adminUser.email || ''
        });
        $('wi-ref').textContent = ref;
        showForm(false);
    } catch (err) {
        console.error('Walk-in submit error:', err);
        setError('Could not save: ' + (err.code === 'permission-denied'
            ? 'permission denied — publish the updated firestore.rules first.'
            : err.message));
        btn.disabled = false; btn.textContent = 'Create Request';
    }
}

// ---------------------------------------------
// Only admins get the button
// ---------------------------------------------
onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
        const a = await getDoc(doc(db, 'admins', user.uid));
        if (!a.exists()) return;
    } catch (_) { return; }
    adminUser = user;
    build();
});