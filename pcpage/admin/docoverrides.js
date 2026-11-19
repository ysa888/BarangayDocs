// =============================================
// docoverrides.js
// Shared by: docedit.js (admin) and request.js (resident)
//
// Document-specific corrections are stored on the request document
// (requests/{id}.docOverrides) and NEVER written to residents/{uid}.
// This module is the single source of truth for how a certificate's
// values are derived and painted, so admin preview, resident view
// and printing always match.
// =============================================

export const DEFAULT_ADDRESS = 'Barangay Banicain, Olongapo City, Zambales';

// Free-text fields an admin may correct on a single document
export const TEXT_KEYS = ['residentName', 'age', 'occupation', 'address', 'birthday', 'contactNumber'];

// Which certificate element each text field is painted into
export const FIELD_EL = {
    residentName: 'dp-name',
    age:          'dp-age',
    occupation:   'dp-occupation',
    address:      'dp-address'
};

const pick = (obj, keys) => {
    for (const k of keys) {
        const v = obj?.[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
};

export function computeAge(dob) {
    if (!dob) return '—';
    const [y, m, d] = String(dob).split('-').map(Number);
    if (!y || !m || !d) return '—';
    const today = new Date();
    let age = today.getFullYear() - y;
    const mDiff = today.getMonth() + 1 - m;
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < d)) age--;
    return age;
}

// Same fallback chain the resident preview already uses
export function profileOccupation(rd) {
    return rd?.occupation || rd?.work || rd?.jobTitle || rd?.job || rd?.civilStatus || '—';
}

export function profileContact(rd) {
    return pick(rd, ['contactNumber', 'contact', 'phone', 'phoneNumber', 'mobile', 'mobileNumber']);
}

export function profileAddress(rd) {
    return pick(rd, ['address', 'homeAddress', 'streetAddress']);
}

/**
 * Values the certificate would show with NO admin corrections.
 * Derived from the request + the resident's profile (read-only).
 */
export function baseValues(request, resident) {
    const rd = resident || {};
    return {
        residentName:  request?.residentName || '—',
        age:           String(computeAge(rd.birthday)),
        occupation:    String(profileOccupation(rd)),
        address:       DEFAULT_ADDRESS,   // keeps the existing wording of the template
        birthday:      rd.birthday ? String(rd.birthday) : '',
        contactNumber: profileContact(rd)
    };
}

/** base + overrides → what the certificate actually shows */
export function effectiveValues(base, overrides) {
    const o = overrides || {};
    const out = { ...base };
    TEXT_KEYS.forEach(k => {
        if (typeof o[k] === 'string' && o[k].trim() !== '') out[k] = o[k].trim();
    });
    out.showBirthday  = o.showBirthday === true;
    out.showContact   = o.showContact === true;
    out.remarks       = typeof o.remarks === 'string' ? o.remarks.trim() : '';
    return out;
}

/** Form state → minimal overrides object (only what differs from base) */
export function buildOverrides(base, form) {
    const o = {};
    TEXT_KEYS.forEach(k => {
        const v = String(form[k] ?? '').trim();
        if (v && v !== String(base[k] ?? '')) o[k] = v;
    });
    if (form.showBirthday) o.showBirthday = true;
    if (form.showContact)  o.showContact = true;
    const r = String(form.remarks ?? '').trim();
    if (r) o.remarks = r;
    return o;
}

export function formatDob(val) {
    if (!val) return '';
    const [y, m, d] = String(val).split('-').map(Number);
    if (!y || !m || !d) return String(val);
    return new Date(y, m - 1, d).toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

// When an admin-made template is being shown instead of the built-in certificate,
// doctemplate.js registers a painter here so every paintDocument() call (including the
// live edits from docedit.js) re-renders the template too.
let templatePainter = null;
export function setTemplatePainter(fn) { templatePainter = typeof fn === 'function' ? fn : null; }

/** Paint effective values into the certificate DOM */
export function paintDocument(values) {
    if (templatePainter) templatePainter(values);
    const set = (id, v) => {
        const n = document.getElementById(id);
        if (n) n.textContent = (v !== undefined && v !== null && v !== '') ? String(v) : '—';
    };
    set('dp-name',       values.residentName);
    set('dp-age',        values.age);
    set('dp-occupation', values.occupation);
    set('dp-address',    values.address);

    // Optional "Date of Birth / Contact No." line
    const parts = [];
    if (values.showBirthday && values.birthday)
        parts.push(`Date of Birth: ${formatDob(values.birthday)}`);
    if (values.showContact && values.contactNumber)
        parts.push(`Contact No.: ${values.contactNumber}`);
    const extra = document.getElementById('dp-extra-line');
    if (extra) {
        extra.textContent = parts.join('  •  ');
        extra.style.display = parts.length ? '' : 'none';
    }

    // Optional remarks paragraph
    const rem = document.getElementById('dp-remarks');
    if (rem) {
        rem.textContent = values.remarks || '';
        rem.style.display = values.remarks ? '' : 'none';
    }
}
//njklg