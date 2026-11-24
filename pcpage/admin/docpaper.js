// =============================================
// docpaper.js
// Movable, formattable text boxes for the document preview.
//
// Used by: docedit.js (admin editing).
// Reusable by: request.js (resident view) through boxesLayerHtml().
//
// Boxes are stored on the request as requests/{id}.docOverrides.textBoxes
// (never on residents/{uid}). Positions are in the document's own CSS pixels
// (top-left of the certificate / template = 0,0), so they do not depend on the
// zoom level used while editing.
//
// The boxes live in ONE persistent overlay element ("layer"). docedit.js calls
// attachTo(host) whenever the visible document element changes (built-in
// certificate or admin template), so the layer survives template re-renders.
// =============================================

const FONTS = [
    { label: 'Palatino',        css: "'Palatino Linotype','Book Antiqua',Palatino,serif" },
    { label: 'Times New Roman', css: "'Times New Roman',Times,serif" },
    { label: 'Georgia',         css: "Georgia,serif" },
    { label: 'Arial',           css: "Arial,Helvetica,sans-serif" },
    { label: 'Verdana',         css: "Verdana,Geneva,sans-serif" },
    { label: 'Courier New',     css: "'Courier New',monospace" }
];
export const FONT_LABELS = FONTS.map(f => f.label);
const DEFAULT_FONT = FONTS[0].label;
const MAX_BOXES = 30;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(clamp(n, lo, hi)) : dflt;
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const newId = () => 'tb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Validates / normalises a list of boxes (also what gets written to Firestore). */
export function sanitizeBoxes(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_BOXES).map(b => ({
        id:        String(b?.id || newId()).slice(0, 40),
        x:         num(b?.x, 0, 5000, 0),
        y:         num(b?.y, 0, 10000, 0),
        w:         num(b?.w, 40, 2000, 200),
        text:      String(b?.text ?? '').slice(0, 1000),
        font:      FONT_LABELS.includes(b?.font) ? b.font : DEFAULT_FONT,
        size:      num(b?.size, 6, 96, 14),
        bold:      !!b?.bold,
        italic:    !!b?.italic,
        underline: !!b?.underline,
        align:     ['left', 'center', 'right'].includes(b?.align) ? b.align : 'left',
        color:     /^#[0-9a-f]{6}$/i.test(b?.color || '') ? b.color : '#111111'
    }));
}

// All styling is inline so a box looks identical on screen, in the print window and in a clone.
const boxCss = (b) => `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;box-sizing:border-box;`;
function bodyCss(b) {
    const f = FONTS.find(x => x.label === b.font) || FONTS[0];
    return `font-family:${f.css};font-size:${b.size}px;line-height:1.35;color:${b.color};` +
           `font-weight:${b.bold ? 700 : 400};font-style:${b.italic ? 'italic' : 'normal'};` +
           `text-decoration:${b.underline ? 'underline' : 'none'};text-align:${b.align};` +
           `white-space:pre-wrap;overflow-wrap:anywhere;padding:2px 4px;margin:0;text-transform:none;letter-spacing:normal;`;
}

/** Static HTML for a set of boxes — for read-only views (resident page, printing). */
export function boxesLayerHtml(list) {
    const bs = sanitizeBoxes(list);
    if (!bs.length) return '';
    return `<div class="dpe-tb-layer" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;">` +
        bs.map(b => `<div style="${boxCss(b)}pointer-events:none;"><div style="${bodyCss(b)}">${esc(b.text)}</div></div>`).join('') +
        `</div>`;
}

// ---------------------------------------------
// Live layer
// ---------------------------------------------
let layer = null;
let host = null;
let boxes = [];
let editing = false;
let selId = null;
let focusId = null;
let drag = null;
let cb = { onChange() {}, onSelect() {} };
let styled = false;

export function init(callbacks = {}) {
    cb = { onChange() {}, onSelect() {}, ...callbacks };
    injectStyle();
}

function injectStyle() {
    if (styled) return;
    styled = true;
    const st = document.createElement('style');
    st.id = 'dpe-tb-style';
    st.textContent = `
    .dpe-tb.edit { outline:1px dashed #8A9BBE; }
    .dpe-tb.edit.sel { outline:2px solid #1B3A6B; }
    .dpe-tb.edit .dpe-tb-body { cursor:text; min-height:1.35em; }
    .dpe-tb-body:focus { outline:none; }
    .dpe-tb-move, .dpe-tb-resize { display:none; position:absolute; background:#1B3A6B; color:#fff; font:800 11px 'Nunito',sans-serif; user-select:none; -webkit-user-select:none; touch-action:none; }
    .dpe-tb-move { left:-2px; top:-24px; height:22px; padding:0 10px; align-items:center; border-radius:6px 6px 0 0; cursor:move; white-space:nowrap; }
    .dpe-tb-resize { right:-6px; bottom:-6px; width:12px; height:12px; border-radius:3px; cursor:nwse-resize; }
    .dpe-tb.sel .dpe-tb-move { display:flex; }
    .dpe-tb.sel .dpe-tb-resize { display:block; }
    `;
    document.head.appendChild(st);
}

const find = (id) => boxes.find(b => b.id === id);
const zoom = () => parseFloat(host?.style.zoom) || 1;

// Size of the layer in document pixels (undoes the editing zoom)
function layerSize() {
    const z = zoom();
    const r = layer.getBoundingClientRect();
    return { W: r.width / z, H: r.height / z, z };
}

function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'dpe-tb-layer';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';

    layer.addEventListener('pointerdown', (e) => {
        if (!editing) return;
        const el = e.target.closest('.dpe-tb');
        if (!el) return;
        const b = find(el.dataset.id);
        if (!b) return;
        select(b.id);
        const mode = e.target.closest('.dpe-tb-move') ? 'move' : e.target.closest('.dpe-tb-resize') ? 'resize' : null;
        if (!mode) return;                       // plain click → type in the box
        e.preventDefault();
        drag = { mode, b, el, x: e.clientX, y: e.clientY, bx: b.x, by: b.y, bw: b.w, z: zoom(), id: e.pointerId, t: e.target };
        try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    });

    layer.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = (e.clientX - drag.x) / drag.z, dy = (e.clientY - drag.y) / drag.z;
        const { W, H } = layerSize();
        if (drag.mode === 'move') {
            drag.b.x = Math.round(clamp(drag.bx + dx, 0, Math.max(0, W - 40)));
            drag.b.y = Math.round(clamp(drag.by + dy, 0, Math.max(0, H - 20)));
            drag.el.style.left = drag.b.x + 'px';
            drag.el.style.top  = drag.b.y + 'px';
        } else {
            drag.b.w = Math.round(clamp(drag.bw + dx, 40, Math.max(40, W - drag.b.x)));
            drag.el.style.width = drag.b.w + 'px';
        }
    });

    const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        try { drag.t.releasePointerCapture(e.pointerId); } catch (_) {}
        drag = null;
        cb.onChange();
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);

    layer.addEventListener('input', (e) => {
        const body = e.target.closest('.dpe-tb-body');
        const b = body && find(body.closest('.dpe-tb').dataset.id);
        if (!b) return;
        b.text = body.innerText.replace(/\n$/, '');
        cb.onChange();
    });

    layer.addEventListener('focusin', (e) => {
        const el = e.target.closest('.dpe-tb');
        if (!el) return;
        focusId = el.dataset.id;
        if (editing && selId !== el.dataset.id) select(el.dataset.id);
    });
    layer.addEventListener('focusout', () => { if (layer.isConnected) focusId = null; });

    // plain-text paste only
    layer.addEventListener('paste', (e) => {
        if (!e.target.closest('.dpe-tb-body')) return;
        e.preventDefault();
        const t = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        document.execCommand('insertText', false, t);
    });
    return layer;
}

function makeEl(b) {
    const el = document.createElement('div');
    el.dataset.id = b.id;
    el.className = 'dpe-tb' + (editing ? ' edit' : '') + (editing && b.id === selId ? ' sel' : '');
    el.style.cssText = boxCss(b) + `pointer-events:${editing ? 'auto' : 'none'};`;
    const body = document.createElement('div');
    body.className = 'dpe-tb-body';
    body.style.cssText = bodyCss(b);
    body.textContent = b.text;
    el.appendChild(body);
    if (editing) {
        body.contentEditable = 'plaintext-only';
        if (body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
        body.spellcheck = false;
        const mv = document.createElement('div');
        mv.className = 'dpe-tb-move';
        mv.textContent = '⠿ Move';
        const rs = document.createElement('div');
        rs.className = 'dpe-tb-resize';
        el.append(mv, rs);
    }
    return el;
}

function rebuild() {
    if (!layer) return;
    layer.textContent = '';
    boxes.forEach(b => layer.appendChild(makeEl(b)));
}

const elOf = (id) => layer?.querySelector(`.dpe-tb[data-id="${id}"]`);

// ---------------------------------------------
// Public API
// ---------------------------------------------

/** Show the layer inside `h` (the visible document element), or remove it when h is null. */
export function attachTo(h) {
    ensureLayer();
    if (!h) {
        if (layer.parentNode) layer.remove();
        host = null;
        return;
    }
    host = h;
    if (getComputedStyle(h).position === 'static') h.style.position = 'relative';
    if (layer.parentNode === h) return;
    h.appendChild(layer);
    // The template engine rewrites its container on every repaint, which pulls the layer out of
    // the page. If the admin was typing in a box, put the caret back.
    if (focusId && (!document.activeElement || document.activeElement === document.body)) {
        elOf(focusId)?.querySelector('.dpe-tb-body')?.focus();
        const body = elOf(focusId)?.querySelector('.dpe-tb-body');
        if (body && body.isContentEditable) {
            const r = document.createRange();
            r.selectNodeContents(body); r.collapse(false);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        }
    }
}

export const contains = (node) => !!layer && layer.contains(node);

export function setBoxes(list) {
    ensureLayer();
    boxes = sanitizeBoxes(list);
    if (selId && !find(selId)) { selId = null; cb.onSelect(null); }
    rebuild();
}

export const getBoxes = () => boxes.map(b => ({ ...b }));

export function setEditing(v) {
    ensureLayer();
    editing = !!v;
    if (!editing && selId) { selId = null; cb.onSelect(null); }
    rebuild();
}

export const getSelected = () => { const b = find(selId); return b ? { ...b } : null; };

export function select(id) {
    selId = id && find(id) ? id : null;
    layer?.querySelectorAll('.dpe-tb').forEach(n => n.classList.toggle('sel', editing && n.dataset.id === selId));
    cb.onSelect(getSelected());
}

export function addBox() {
    if (!editing || !layer || boxes.length >= MAX_BOXES) return;
    const { W, H, z } = layerSize();
    // drop it in the middle of what the admin is currently looking at
    let x = (W - 220) / 2, y = H * 0.4;
    const sc = layer.closest('.doc-preview-scroll');
    if (sc) {
        const sr = sc.getBoundingClientRect(), lr = layer.getBoundingClientRect();
        x = ((sr.left + sr.width / 2) - lr.left) / z - 110;
        y = ((sr.top + sr.height / 3) - lr.top) / z;
    }
    const [b] = sanitizeBoxes([{
        id: newId(), x: clamp(x, 0, Math.max(0, W - 220)), y: clamp(y, 0, Math.max(0, H - 40)),
        w: 220, text: 'Text', font: DEFAULT_FONT, size: 14, color: '#111111', align: 'left'
    }]);
    boxes.push(b);
    layer.appendChild(makeEl(b));
    select(b.id);
    cb.onChange();
    const body = elOf(b.id)?.querySelector('.dpe-tb-body');
    if (body) {
        body.focus();
        const r = document.createRange();
        r.selectNodeContents(body);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
}

/** Format the selected box (whole box — font, size, bold, italic, underline, align, color). */
export function updateSelected(patch) {
    const b = find(selId);
    if (!b) return;
    const [clean] = sanitizeBoxes([{ ...b, ...patch }]);
    Object.assign(b, clean, { id: b.id, text: b.text, x: b.x, y: b.y, w: b.w });
    const el = elOf(b.id);
    if (el) {
        el.style.cssText = boxCss(b) + `pointer-events:${editing ? 'auto' : 'none'};`;
        el.querySelector('.dpe-tb-body').style.cssText = bodyCss(b);
    }
    cb.onChange();
    cb.onSelect(getSelected());
}

export function deleteSelected() {
    if (!selId) return;
    boxes = boxes.filter(b => b.id !== selId);
    selId = null;
    focusId = null;
    rebuild();
    cb.onSelect(null);
    cb.onChange();
}