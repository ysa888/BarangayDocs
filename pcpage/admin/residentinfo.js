// =============================================
// residentinfo.js
// Helpers that read a resident / request record (birthday, age, address, ID photos).
// Same logic the Requests pages use, shared so the Dashboard popup matches.
// =============================================

// Turn whatever is stored as a birth date (string, Timestamp, Date, ms) into a Date
function parseBirthDate(v) {
    if (!v) return null;
    if (v?.toDate) return v.toDate();                       // Firestore Timestamp
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    if (typeof v === 'number') return new Date(v);
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);          // YYYY-MM-DD
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);             // MM/DD/YYYY
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    const d = new Date(s);                                              // "May 4, 2001" etc.
    return isNaN(d) ? null : d;
}

const BIRTH_KEYS = ['birthday', 'birthDate', 'birthdate', 'dateOfBirth', 'dob', 'birth_date', 'date_of_birth', 'bday'];
const AGE_KEYS   = ['age', 'Age'];

// sources = resident profile first, then the request doc itself as a fallback
function findBirthDate(...sources) {
    for (const src of sources) {
        if (!src) continue;
        for (const k of BIRTH_KEYS) {
            const d = parseBirthDate(src[k]);
            if (d) return d;
        }
        for (const k of Object.keys(src)) {                      // any key that looks like a birth date
            if (/birth|bday|dob/i.test(k) && !/place|age/i.test(k)) {
                const d = parseBirthDate(src[k]);
                if (d) return d;
            }
        }
        const y = src.birthYear || src.birth_year, mo = src.birthMonth || src.birth_month, da = src.birthDay || src.birth_day;
        if (y && mo && da) {
            const mIdx = isNaN(+mo) ? new Date(`${mo} 1, 2000`).getMonth() : +mo - 1;
            const d = new Date(+y, mIdx, +da);
            if (!isNaN(d)) return d;
        }
    }
    return null;
}

export function formatBirthDate(...sources) {
    const d = findBirthDate(...sources);
    return d ? d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
}

export function resolveAge(...sources) {
    const bd = findBirthDate(...sources);
    if (bd) return computeAge(bd);
    for (const src of sources) {
        if (!src) continue;
        for (const k of AGE_KEYS) {
            if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== '') return src[k];
        }
    }
    return '—';
}

function computeAge(dob) {
    const d = dob instanceof Date ? dob : parseBirthDate(dob);
    if (!d) return '—';
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    const mDiff = today.getMonth() - d.getMonth();
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < d.getDate())) age--;
    return age >= 0 ? age : '—';
}

const ID_KEYS = ['idUrl', 'idPhotoUrl', 'idImageUrl', 'validIdUrl', 'validId', 'idImage', 'idPicture',
                 'idFront', 'idFrontUrl', 'idBack', 'idBackUrl', 'governmentIdUrl', 'govIdUrl', 'idPhoto', 'id_url'];
export const isImgSrc = v => typeof v === 'string' && /^(https?:|data:image)/i.test(v);

export function findIdImages(rd, r) {
    const out = [];
    for (const src of [rd, r]) {
        if (!src) continue;
        for (const k of ID_KEYS) if (isImgSrc(src[k]) && !out.includes(src[k])) out.push(src[k]);
        for (const k of Object.keys(src)) {          // anything else that looks like an ID image
            if (/(^|[^a-z])id([^a-z]|$)|validid|govid|idcard|idphoto|idimage|idfront|idback/i.test(k)
                && !/face|selfie|profile|uid|docid|requestid/i.test(k)
                && isImgSrc(src[k]) && !out.includes(src[k])) out.push(src[k]);
        }
    }
    return out;
}

const ADDRESS_KEYS = ['address', 'fullAddress', 'homeAddress', 'home_address', 'residentAddress',
                      'currentAddress', 'completeAddress', 'streetAddress', 'location'];

// Full home address: a single stored string, or built from separate parts
export function resolveAddress(...sources) {
    for (const src of sources) {
        if (!src) continue;
        for (const k of ADDRESS_KEYS) {
            const v = src[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (v && typeof v === 'object') {                  // address stored as a map
                const joined = Object.values(v).filter(x => typeof x === 'string' && x.trim()).join(', ');
                if (joined) return joined;
            }
        }
    }
    for (const src of sources) {
        if (!src) continue;
        const parts = [
            src.houseNo || src.houseNumber || src.blockLot,
            src.street,
            src.purok || src.zone || src.sitio,
            src.barangay,
            src.city || src.municipality,
            src.province
        ].filter(x => typeof x === 'string' ? x.trim() : x).map(x => String(x).trim());
        if (parts.length) {
            if (!src.barangay) parts.push('Barangay Banicain, Olongapo City, Zambales');
            return parts.join(', ');
        }
    }
    return '';
}