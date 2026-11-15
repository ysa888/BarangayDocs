// =============================================
// rejectreasons.js  (pcpage/admin/)
// Shared "Reason for Rejection" picker for every admin screen that
// can reject a request: adminrequests.js, admindashboard.js, adminscanqr.js
//
// To add / remove / rename a fixed reason, edit REJECT_REASONS below —
// it is the only place the list lives.
// =============================================

export const OTHER_CODE = 'other';

export const REJECT_REASONS = [
    { code: 'incomplete_info',   label: 'Incomplete or missing information' },
    { code: 'invalid_id',        label: 'Invalid or unreadable ID / supporting document' },
    { code: 'not_resident',      label: 'Not a registered resident of the barangay' },
    { code: 'details_mismatch',  label: 'Details do not match barangay records' },
    { code: 'duplicate',         label: 'Duplicate request' },
    { code: 'invalid_purpose',   label: 'Purpose of request is unclear or not valid' },
    { code: OTHER_CODE,          label: 'Other (please specify)' }
];

const OTHER_MAX_LENGTH = 200;

/** Escape text before putting it inside innerHTML templates. */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Turns an existing reason <textarea> into: [dropdown of fixed reasons] + [textarea shown only for "Other"].
 * No HTML changes needed — the dropdown is inserted right before the textarea.
 * Safe to call repeatedly on the same textarea (returns the same controller).
 *
 * Controller:
 *   getResult() -> { ok, reason, code, error }
 *   reset()     -> back to "Select a reason…"
 *   setVisible(bool) -> show/hide the whole picker (used by the QR page modal)
 */
export function mountRejectReasonPicker(textarea) {
    if (!textarea) return null;
    if (textarea._rejectPicker) return textarea._rejectPicker;

    const select = document.createElement('select');
    select.id = (textarea.id || 'reject') + '-select';
    select.setAttribute('aria-label', 'Reason for rejection');
    select.style.cssText =
        "width:100%;height:42px;border:2px solid var(--border,#E2E8F0);border-radius:10px;padding:0 12px;" +
        "font-family:'Nunito',sans-serif;font-size:13px;color:var(--text-main,#1B2A4A);" +
        "background:var(--bg,#F4F6FB);outline:none;cursor:pointer;";

    const placeholder = new Option('Select a reason…', '');
    placeholder.disabled = true;
    select.add(placeholder);
    REJECT_REASONS.forEach(r => select.add(new Option(r.label, r.code)));
    select.value = '';

    textarea.parentNode.insertBefore(select, textarea);
    textarea.placeholder = 'Please specify the reason for rejection…';
    textarea.maxLength = OTHER_MAX_LENGTH;
    textarea.style.marginTop = '10px';

    let visible = true;
    const sync = () => {
        const isOther = select.value === OTHER_CODE;
        textarea.style.display = (visible && isOther) ? '' : 'none';
        if (visible && isOther) textarea.focus();
    };
    select.addEventListener('change', sync);

    const controller = {
        getResult() {
            const code = select.value;
            if (!code) {
                return { ok: false, error: 'Please select a reason for rejection.' };
            }
            if (code === OTHER_CODE) {
                const text = textarea.value.trim();
                if (!text) return { ok: false, error: 'Please specify the reason for rejection.' };
                return { ok: true, reason: text, code };
            }
            const found = REJECT_REASONS.find(r => r.code === code);
            return { ok: true, reason: found ? found.label : code, code };
        },
        reset() {
            select.value = '';
            textarea.value = '';
            sync();
        },
        setVisible(v) {
            visible = !!v;
            select.style.display = visible ? '' : 'none';
            sync();
        }
    };

    textarea._rejectPicker = controller;
    sync(); // starts with textarea hidden until "Other" is picked
    return controller;
}

/**
 * Shows "Reason for rejection: …" under a result badge (admin QR result card).
 * Creates the box on first use, hides it when the request isn't rejected.
 */
export function renderRejectReasonBox(afterEl, data) {
    let box = document.getElementById('resultRejectReason');
    if (!box && afterEl) {
        box = document.createElement('div');
        box.id = 'resultRejectReason';
        box.style.cssText =
            "margin-top:10px;padding:10px 14px;border-radius:10px;background:#F8D7DA;color:#721C24;" +
            "font-size:13px;font-weight:700;line-height:1.4;";
        afterEl.insertAdjacentElement('afterend', box);
    }
    if (!box) return;
    if (data && data.status === 'rejected' && data.rejectReason) {
        box.textContent = 'Reason for rejection: ' + data.rejectReason;
        box.style.display = '';
    } else {
        box.style.display = 'none';
    }
}