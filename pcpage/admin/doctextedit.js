// =============================================
// doctextedit.js
// Free editing of ANY text on the document paper.
//
// Every run of text on the paper gets a stable number (its position in reading order). An admin
// edit is stored as { i, from, to }: text run #i was "from" and now reads "to". The edit is only
// applied while the run still reads "from", so a changed template / profile never gets garbled.
//
// Saved on the request as requests/{id}.docOverrides.textEdits (resident profile untouched).
//
// Works on a live DOM (built-in certificate) and on an HTML string (admin templates, so the
// edits also reach the template engine's pages and its print output).
// =============================================

const ZW = '​';   // invisible anchor so an empty field can receive a caret
const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'TEXTAREA', 'NOSCRIPT', 'CANVAS', 'SVG', 'TITLE', 'HEAD']);
const origOfNode = new WeakMap();   // live DOM: text node → its untouched text

/** Validates edits (also what gets written to Firestore). */
export function sanitizeEdits(list) {
    const seen = new Set(), out = [];
    for (const e of Array.isArray(list) ? list : []) {
        const i = Number(e?.i);
        if (!Number.isInteger(i) || i < 0 || i > 5000 || seen.has(i)) continue;
        if (typeof e.from !== 'string' || typeof e.to !== 'string') continue;
        seen.add(i);
        out.push({ i, from: e.from.slice(0, 1000), to: e.to.slice(0, 1000) });
        if (out.length >= 300) break;
    }
    return out.sort((a, b) => a.i - b.i);
}

// Put the tagged wrappers back to plain text (live DOM)
function unwrap(root) {
    root.querySelectorAll('.dpe-tn').forEach(w => {
        const p = w.parentNode;
        if (!p) return;
        if (w.dataset.kind === 'empty') p.textContent = w.dataset.orig ?? '';
        else p.replaceChild(w.ownerDocument.createTextNode(w.dataset.orig ?? ''), w);
    });
}

// Text runs, in reading order: non-blank text nodes + blank [data-field] elements (empty chips)
function collectSlots(root, skipNode) {
    const slots = [];
    const walk = (n) => {
        for (const c of Array.from(n.childNodes)) {
            if (c.nodeType === 3) {
                if (c.nodeValue.trim() !== '' && !(skipNode && skipNode(c))) slots.push({ node: c });
            } else if (c.nodeType === 1) {
                if (SKIP_TAGS.has(c.tagName.toUpperCase())) continue;
                if (c.classList.contains('dpe-tb-layer')) continue;
                const emptyChip = c.dataset.dpeOrig !== undefined ||
                    (c.hasAttribute('data-field') && !c.children.length && c.textContent.trim() === '');
                if (emptyChip) { if (!(skipNode && skipNode(c))) slots.push({ el: c }); }
                else walk(c);
            }
        }
    };
    walk(root);
    return slots;
}

/**
 * Apply edits under `root`. tag=true wraps every run in <span class="dpe-tn" data-i data-orig>
 * so the editor can find it. Safe to call repeatedly on the same live DOM.
 */
export function applyEdits(root, edits, { tag = false, skipNode = null } = {}) {
    unwrap(root);
    const map = new Map((edits || []).map(e => [e.i, e]));
    const doc = root.ownerDocument;
    collectSlots(root, skipNode).forEach((s, i) => {
        const e = map.get(i);
        if (s.node) {
            const n = s.node;
            if (!origOfNode.has(n)) origOfNode.set(n, n.nodeValue);
            const orig = origOfNode.get(n);
            n.nodeValue = (e && e.from === orig) ? e.to : orig;
            if (tag) {
                const w = doc.createElement('span');
                w.className = 'dpe-tn';
                w.dataset.i = String(i); w.dataset.orig = orig; w.dataset.kind = 'text';
                n.parentNode.replaceChild(w, n);
                w.appendChild(n);
            }
        } else {
            const el = s.el;
            if (el.dataset.dpeOrig === undefined) el.dataset.dpeOrig = el.textContent;
            const orig = el.dataset.dpeOrig;
            const val = (e && e.from === orig) ? e.to : orig;
            el.textContent = '';
            if (tag) {
                const w = doc.createElement('span');
                w.className = 'dpe-tn';
                w.dataset.i = String(i); w.dataset.orig = orig; w.dataset.kind = 'empty';
                w.textContent = val + ZW;
                el.appendChild(w);
            } else {
                el.textContent = val;
            }
        }
    });
}

/** Forget everything applied to a live DOM and show the untouched text again. */
export function resetEdits(root, skipNode) {
    applyEdits(root, [], { tag: false, skipNode });
    root.querySelectorAll('[data-dpe-orig]').forEach(e => e.removeAttribute('data-dpe-orig'));
}

/** Same thing for an HTML string (used by doctemplate.js before the engine paginates it). */
export function transformHtml(html, edits, opts = {}) {
    if (!(Array.isArray(edits) && edits.length) && !opts.tag) return html;
    const d = document.implementation.createHTMLDocument('');   // inert: nothing loads
    d.body.innerHTML = html;
    applyEdits(d.body, edits, opts);
    d.body.querySelectorAll('[data-dpe-orig]').forEach(e => e.removeAttribute('data-dpe-orig'));
    return d.body.innerHTML;
}

/** What the admin typed into a tagged run (anchor characters removed). */
export const readRun = (w) => ({
    i: Number(w.dataset.i),
    from: w.dataset.orig ?? '',
    to: (w.textContent || '').replace(/​/g, '')
});