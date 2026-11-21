// =============================================
// imageviewer.js
// Full-screen image viewer with zoom + drag.
//   - mouse wheel / trackpad pinch: zoom at the pointer
//   - drag: move the picture in any direction
//   - two-finger pinch + drag on phones
//   - double-click / double-tap: zoom in, again to reset
//   - keys: + / - zoom, 0 reset, arrows move, Esc close
// =============================================
export function openLightbox(src) {
    document.getElementById('rd-lightbox')?.remove();

    const lb = document.createElement('div');
    lb.id = 'rd-lightbox';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(10,20,50,0.9);z-index:1200;overflow:hidden;' +
        'touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;';

    const img = new Image();
    img.alt = 'Enlarged photo';
    img.draggable = false;
    img.style.cssText = 'position:absolute;left:0;top:0;max-width:none;transform-origin:0 0;border-radius:8px;background:#fff;will-change:transform;opacity:0;';
    lb.appendChild(img);

    const btnCss = 'height:36px;min-width:36px;padding:0 12px;border:none;border-radius:10px;background:rgba(255,255,255,0.14);' +
        'color:#fff;font:800 14px Nunito,sans-serif;cursor:pointer;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.dataset.vc = '1'; closeBtn.textContent = '\u2715'; closeBtn.title = 'Close (Esc)';
    closeBtn.style.cssText = btnCss + 'position:absolute;top:14px;right:14px;font-size:16px;';
    lb.appendChild(closeBtn);

    const bar = document.createElement('div');
    bar.dataset.vc = '1';
    bar.style.cssText = 'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;' +
        'padding:8px;border-radius:14px;background:rgba(10,20,50,0.75);max-width:calc(100% - 24px);';
    const mkBtn = (txt, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = txt; b.title = title; b.style.cssText = btnCss; b.addEventListener('click', fn);
        bar.appendChild(b); return b;
    };
    mkBtn('\u2212', 'Zoom out (-)', () => zoomAt(1 / 1.25, lb.clientWidth / 2, lb.clientHeight / 2));
    const pctEl = document.createElement('span');
    pctEl.style.cssText = 'min-width:48px;text-align:center;color:#fff;font:800 13px Nunito,sans-serif;';
    bar.appendChild(pctEl);
    mkBtn('+', 'Zoom in (+)', () => zoomAt(1.25, lb.clientWidth / 2, lb.clientHeight / 2));
    mkBtn('Reset', 'Reset (0)', () => fitView());
    lb.appendChild(bar);

    const hint = document.createElement('div');
    hint.textContent = 'Scroll to zoom \u2022 drag to move \u2022 double-click to reset';
    hint.style.cssText = 'position:absolute;left:0;right:0;bottom:74px;text-align:center;color:rgba(255,255,255,0.65);' +
        'font:700 12px Nunito,sans-serif;pointer-events:none;padding:0 12px;';
    lb.appendChild(hint);

    let s = 1, tx = 0, ty = 0, fit = 1;
    const nw = () => img.naturalWidth || 1, nh = () => img.naturalHeight || 1;
    const maxS = () => Math.max(fit * 8, 3), minS = () => fit * 0.5;

    function apply() {
        // keep at least a corner of the picture on screen so it can't be lost
        const keep = 80, W = lb.clientWidth, H = lb.clientHeight;
        tx = Math.min(W - keep, Math.max(keep - nw() * s, tx));
        ty = Math.min(H - keep, Math.max(keep - nh() * s, ty));
        img.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
        pctEl.textContent = Math.round(s / fit * 100) + '%';
    }
    function fitView() {
        const W = lb.clientWidth, H = lb.clientHeight;
        fit = Math.min((W - 32) / nw(), (H - 130) / nh(), 2);
        s = fit; tx = (W - nw() * s) / 2; ty = (H - 56 - nh() * s) / 2;
        apply();
    }
    function zoomAt(f, cx, cy) {
        const ns = Math.min(maxS(), Math.max(minS(), s * f));
        tx = cx - (cx - tx) * (ns / s);
        ty = cy - (cy - ty) * (ns / s);
        s = ns; apply();
    }

    img.addEventListener('load', () => { fitView(); img.style.opacity = '1'; });
    img.addEventListener('error', () => { hint.textContent = 'Could not load this image.'; hint.style.bottom = '50%'; });
    img.src = src;

    lb.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
    }, { passive: false });

    // drag (1 pointer) and pinch (2 pointers)
    const ptr = new Map(); let moved = 0, lastDist = 0, lastMid = null;
    const mid = () => { const p = [...ptr.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) }; };
    lb.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-vc]')) return;
        lb.setPointerCapture(e.pointerId);
        ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = 0; lb.style.cursor = 'grabbing';
        if (ptr.size === 2) { const m = mid(); lastDist = m.d; lastMid = m; }
    });
    lb.addEventListener('pointermove', (e) => {
        const p = ptr.get(e.pointerId); if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        if (ptr.size === 2) {
            const m = mid();
            if (lastDist) zoomAt(m.d / lastDist, m.x, m.y);
            if (lastMid) { tx += m.x - lastMid.x; ty += m.y - lastMid.y; apply(); }
            lastDist = m.d; lastMid = m;
        } else { tx += dx; ty += dy; apply(); }
    });
    const up = (e) => {
        if (!ptr.has(e.pointerId)) return;
        ptr.delete(e.pointerId); lastDist = 0; lastMid = null;
        if (!ptr.size) {
            lb.style.cursor = 'grab';
            // a plain click on the dark area (not the picture) closes the viewer
            if (moved < 6 && e.target === lb && e.type === 'pointerup') closeLb();
        }
    };
    lb.addEventListener('pointerup', up);
    lb.addEventListener('pointercancel', up);

    img.addEventListener('dblclick', (e) => {
        if (s > fit * 1.05) fitView(); else zoomAt(2.5, e.clientX, e.clientY);
    });

    const onKey = (e) => {
        const cx = lb.clientWidth / 2, cy = lb.clientHeight / 2;
        if (e.key === 'Escape') closeLb();
        else if (e.key === '+' || e.key === '=') zoomAt(1.25, cx, cy);
        else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.25, cx, cy);
        else if (e.key === '0') fitView();
        else if (e.key === 'ArrowLeft')  { tx += 40; apply(); }
        else if (e.key === 'ArrowRight') { tx -= 40; apply(); }
        else if (e.key === 'ArrowUp')    { ty += 40; apply(); }
        else if (e.key === 'ArrowDown')  { ty -= 40; apply(); }
        else return;
        e.preventDefault();
    };
    const onResize = () => { if (img.naturalWidth) fitView(); };
    function closeLb() {
        lb.remove();
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
    }
    closeBtn.addEventListener('click', closeLb);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    document.body.appendChild(lb);
}