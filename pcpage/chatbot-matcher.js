// =============================================
// chatbot-matcher.js — BarangayDocs rule-based chatbot matcher
// No AI services, no API keys, no network. Pure functions that match a
// resident's message against approved `aiKnowledge` entries.
//
// Entry fields used (all optional except question + answer):
//   question        main question
//   altQuestions    other ways of asking the same thing (array of strings)
//   keywords        keywords / phrases (array, or comma-separated string)
//   relatedWords    related words / synonyms (array, or comma-separated string)
//   answer          the reply shown to the resident
//   category        used to suggest related questions
//
// How it works
//   1. Words are lower-cased, stripped of stopwords and reduced to a rough stem.
//   2. Each word the resident typed is matched against the knowledge base's
//      vocabulary: exact, partial (prefix) and misspelled (edit distance).
//   3. Rare words count more than common ones.
//   4. Every entry is scored on its question, each alternative question,
//      keywords, related words and phrases. The best score represents it.
//   5. Entries are ranked, then the result is one of:
//        answer  - one clearly best entry
//        choices - several close entries (or one uncertain "did you mean")
//        none    - nothing suitable
// =============================================

// ── Tuning ──
const MIN_SCORE        = 0.42;  // below this an entry is not relevant at all
const CONFIDENT_SCORE  = 0.62;  // a lone match must reach this to be answered directly
const BAND             = 0.82;  // entries within 82% of the best score are "close matches"
const MAX_CHOICES      = 4;
const MAX_RELATED      = 3;
const MIN_TOKEN_SIM    = 0.7;   // a typed word must resemble a known word at least this much

// ── Fixed replies (same wording as the previous chatbot) ──
export const GREETING_REPLY =
    'Hello! I can answer questions about using BarangayDocs, such as ' +
    'requesting documents, tracking requests, and managing your account. ' +
    'What would you like to know?\n\n' +
    'Kumusta! Maaari akong sumagot ng mga tanong tungkol sa paggamit ng ' +
    'BarangayDocs. Ano po ang gusto ninyong malaman?';

export function noAnswerReply(saved) {
    const savedEn  = saved ? ' I have saved your question so the barangay staff can review it.' : '';
    const savedFil = saved ? ' Naitala ko ang inyong tanong para ma-review ng mga kawani ng barangay.' : '';
    return "I'm sorry, I couldn't find a suitable answer to that, so I can't answer it reliably." + savedEn +
        ' For now, please contact the barangay office directly.\n\n' +
        'Pasensya na po, wala akong nahanap na angkop na sagot dito.' + savedFil +
        ' Sa ngayon, makipag-ugnayan po sa opisina ng barangay.';
}

export const CHOICES_REPLY =
    'I found a few questions that might match. Which one do you mean?\n\n' +
    'May nakita akong ilang posibleng tanong. Alin po ang tinutukoy ninyo?';

export const DID_YOU_MEAN_REPLY =
    "I'm not completely sure I understood. Did you mean this?\n\n" +
    'Hindi po ako lubos na sigurado. Ito po ba ang ibig ninyong itanong?';

// ── Text processing (same rules as the previous backend) ──
const words = (t) => t.split(/\s+/).filter(Boolean);

const STOPWORDS = new Set(words(`
  a an the and or but if of to in on at by for with from as into about
  is are was were be been am do does did have has had can could will would
  should may might must shall i me my mine we us our you your it its this
  that these those there here what which who whom whose when where why how
  please need want get got let tell know also just very some any
  hi hello hey hola thanks thank ok okay good morning afternoon evening bye
  goodbye
  ang ng sa na ko mo ako ka ikaw niya namin natin ninyo nila ba po opo ay
  mga para paano ano saan kailan bakit sino alin pwede puwede maaari
  naman lang din rin ito iyan iyon yung yun kung may mayroon gusto nais
  kailangan kumusta kamusta salamat
`));

export function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stem(word) {
    let w = word;
    if (w.length > 4 && (w.endsWith('ies') || w.endsWith('ied'))) w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
}

// Very common words in this app: they count for little on their own.
const WEAK_TOKENS = new Set(words(`
  barangay brgy barangaydocs document app website site system online service
`).map(stem));

export function tokenize(text) {
    const seen = new Set();
    normalizeText(text).split(' ').forEach(raw => {
        if (raw.length < 2 || STOPWORDS.has(raw)) return;
        seen.add(stem(raw));
    });
    return Array.from(seen);
}

// ── Fuzzy helpers ──

// Optimal-string-alignment edit distance (counts a swap of two letters as 1).
function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const al = a.length, bl = b.length;
    let prev2 = new Array(bl + 1).fill(0);
    let prev  = new Array(bl + 1);
    let cur   = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= bl; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                v = Math.min(v, prev2[j - 2] + 1);
            }
            cur[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
        [prev2, prev, cur] = [prev, cur, prev2];
    }
    return prev[bl];
}

// How alike two (stemmed) words are, 0..1. `q` = typed word, `e` = known word.
function tokenSim(q, e) {
    if (q === e) return 1;
    const isNum = /^\d+$/.test(q) || /^\d+$/.test(e);
    if (isNum) return 0;
    // partial word: "clear" -> "clearance"
    if (q.length >= 3 && e.startsWith(q) && (q.length >= 4 || q.length / e.length >= 0.6)) {
        return Math.min(0.9, 0.7 + 0.2 * (q.length / e.length));
    }
    // typed word is a longer form of a known word: "requirements" vs "requirement"
    if (e.length >= 4 && q.startsWith(e)) return 0.8;
    // spelling mistakes (short words must match exactly)
    const len = Math.max(q.length, e.length);
    const allowed = len <= 4 ? 0 : len <= 7 ? 1 : 2;
    if (allowed === 0) return 0;
    const d = editDistance(q, e, allowed);
    if (d > allowed) return 0;
    return d === 1 ? 0.82 : 0.68;
}

function trigrams(s) {
    const p = '  ' + s + ' ';
    const out = new Map();
    for (let i = 0; i < p.length - 2; i++) {
        const g = p.slice(i, i + 3);
        out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
}

// Sørensen–Dice similarity of two strings' trigrams, 0..1.
function dice(a, b) {
    if (!a || !b) return 0;
    const A = trigrams(a), B = trigrams(b);
    let inter = 0, total = 0;
    A.forEach(n => { total += n; });
    B.forEach((n, g) => { total += n; if (A.has(g)) inter += Math.min(n, A.get(g)); });
    return total ? (2 * inter) / total : 0;
}

const asList = (v) => {
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim());
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
};

// ── Index: prepare approved Firestore entries for matching ──
// docs: [{ id, data }]  →  index object used by matchMessage / relatedTo
export function buildIndex(docs) {
    const entries = [];
    (docs || []).forEach(({ id, data }) => {
        const d = data || {};
        if (typeof d.question !== 'string' || typeof d.answer !== 'string') return;
        if (!d.question.trim() || !d.answer.trim()) return;

        const questions = [d.question, ...asList(d.altQuestions || d.alternativeQuestions)];
        const variants = questions.map(q => {
            const tokens = tokenize(q);
            return { text: q, norm: normalizeText(q), tokens: new Set(tokens), joined: tokens.join(' ') };
        });

        // Single-word keywords / related words match as words; multi-word ones as phrases.
        const kwTokens = new Set();
        const kwPhrases = [];
        [...asList(d.keywords), ...asList(d.relatedWords)].forEach(k => {
            const n = normalizeText(k);
            if (!n) return;
            if (n.indexOf(' ') === -1) tokenize(k).forEach(t => kwTokens.add(t));
            else {
                kwPhrases.push(n);
                // a phrase also lends its words, at lower trust (kept separate below)
            }
        });

        const category = typeof d.category === 'string' && d.category.trim() ? d.category.trim() : 'General';
        const all = new Set(kwTokens);
        variants.forEach(v => v.tokens.forEach(t => all.add(t)));
        entries.push({
            id, category, question: d.question, answer: d.answer,
            variants, kwTokens, kwPhrases, allTokens: all,
            mainTokens: variants[0].tokens
        });
    });

    // Document frequency of each known word (how many entries use it)
    const df = new Map();
    entries.forEach(e => e.allTokens.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
    return { entries, df, vocab: Array.from(df.keys()), byId: new Map(entries.map(e => [e.id, e])) };
}

const idf = (index, token) => {
    const n = index.entries.length;
    const f = index.df.get(token) || 0;
    const base = 1 + Math.log((n + 1) / (f + 1));
    return WEAK_TOKENS.has(token) ? base * 0.35 : base;
};

// ── Matching ──
// Returns { kind: 'greeting' | 'answer' | 'choices' | 'none', ... }
export function matchMessage(index, message) {
    const qTokens = tokenize(message);
    if (qTokens.length === 0) return { kind: 'greeting' };
    if (!index.entries.length) return { kind: 'none' };

    const qNorm = normalizeText(message);

    // 1) Resolve each typed word to the known words it could mean.
    const resolved = qTokens.map(t => {
        const matches = new Map();   // known word -> similarity
        let best = 0, bestTok = null;
        index.vocab.forEach(v => {
            const s = tokenSim(t, v);
            if (s >= MIN_TOKEN_SIM) {
                matches.set(v, s);
                if (s > best || (s === best && idf(index, v) > idf(index, bestTok))) { best = s; bestTok = v; }
            }
        });
        const weight = bestTok ? idf(index, bestTok) : 0.25 * (WEAK_TOKENS.has(t) ? 0.35 : 1);
        return { token: t, matches, weight, known: !!bestTok, weak: WEAK_TOKENS.has(t) || (bestTok && WEAK_TOKENS.has(bestTok)) };
    });
    const totalW = resolved.reduce((s, r) => s + r.weight, 0) || 1;
    const qJoined = qTokens.join(' ');

    const bestSim = (set) => resolved.map(r => {
        let b = 0;
        r.matches.forEach((s, v) => { if (s > b && set.has(v)) b = s; });
        return b;
    });

    // 2) Score every entry.
    const scored = [];
    index.entries.forEach(entry => {
        // exact (normalized) match of the question or an alternative wins outright
        const exact = entry.variants.some(v => v.norm && v.norm === qNorm);

        let top = 0;
        entry.variants.forEach(v => {
            const union = new Set([...v.tokens, ...entry.kwTokens]);
            const sims = bestSim(union);
            let cov = 0;
            resolved.forEach((r, i) => { cov += r.weight * sims[i]; });
            cov /= totalW;

            // how much of this question the resident's words cover
            let pNum = 0, pDen = 0;
            v.tokens.forEach(tok => {
                const w = idf(index, tok);
                let b = 0;
                resolved.forEach(r => { const s = r.matches.get(tok); if (s && s > b) b = s; });
                pNum += w * b; pDen += w;
            });
            const prec = pDen ? pNum / pDen : 0;

            const sim = dice(qJoined, v.joined);
            const score = 0.55 * cov + 0.25 * prec + 0.20 * sim;
            if (score > top) top = score;
        });

        // phrases the admin added ("request rejected", "lost id")
        let phraseHit = false;
        entry.kwPhrases.forEach(p => {
            if (qNorm.indexOf(p) > -1) { top += 0.3; phraseHit = true; }
            else if (p.length >= 6 && dice(qNorm, p) >= 0.8) { top += 0.2; phraseHit = true; }
        });

        // must share at least one real topic word (or phrase) with the entry
        const sims = bestSim(entry.allTokens);
        const strong = phraseHit || resolved.some((r, i) => !r.weak && sims[i] >= MIN_TOKEN_SIM);
        if (!exact && (!strong || top < MIN_SCORE)) return;
        scored.push({ entry, score: exact ? 2 : top });
    });

    if (!scored.length) return { kind: 'none' };
    scored.sort((a, b) => b.score - a.score || a.entry.question.length - b.entry.question.length);

    const best = scored[0].score;
    const close = scored.filter(s => s.score >= best * BAND).slice(0, MAX_CHOICES);
    const toChoice = (s) => ({ id: s.entry.id, question: s.entry.question, score: s.score });

    if (close.length === 1 && best >= CONFIDENT_SCORE) {
        return { kind: 'answer', entry: scored[0].entry, score: best };
    }
    return { kind: 'choices', uncertain: close.length === 1, choices: close.map(toChoice) };
}

// ── Questions related to an entry the resident just read ──
// Only entries in the same (real) category or sharing topic words are offered.
export function relatedTo(index, entryId, exclude) {
    const base = index.byId.get(entryId);
    if (!base) return [];
    const skip = new Set([entryId, ...(exclude || [])]);
    const out = [];
    index.entries.forEach(e => {
        if (skip.has(e.id)) return;
        let shared = 0, union = new Set([...base.mainTokens, ...e.mainTokens]);
        let wShared = 0, wUnion = 0;
        union.forEach(t => {
            const w = idf(index, t);
            wUnion += w;
            if (base.mainTokens.has(t) && e.mainTokens.has(t)) { shared++; wShared += w; }
        });
        const jac = wUnion ? wShared / wUnion : 0;
        const sameCat = base.category !== 'General' && e.category === base.category;
        if (shared >= 1 && (jac >= 0.3 || sameCat) || (sameCat && jac >= 0.1)) {
            out.push({ id: e.id, question: e.question, score: jac + (sameCat ? 0.3 : 0) });
        }
    });
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_RELATED);
}