// barangaystatus.js — shared by barangaydocs_home.html and admin_dashboard.html
// Firestore doc: settings/barangayStatus
//   { type: 'auto' | 'closed' | 'open', until: <ms>, reasonKey, reason, note, updatedAt }

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
  authDomain: "barangaydocs-df957.firebaseapp.com",
  projectId: "barangaydocs-df957",
  storageBucket: "barangaydocs-df957.firebasestorage.app",
  messagingSenderId: "1006488581565",
  appId: "1:1006488581565:web:b1269001298ff935838ed4",
  measurementId: "G-YG0Y575BRD"
};
// reuse the page's existing Firebase app if one is already initialized
const db = getFirestore(getApps().length ? getApp() : initializeApp(firebaseConfig));

const REF = () => doc(db, "settings", "barangayStatus");
const TZ = 8 * 3600 * 1000;      // Asia/Manila (UTC+8, no DST)
const OPEN_H = 8, CLOSE_H = 17;  // 8:00 AM – 5:00 PM, Mon–Fri

export const REASONS = [
  { key: "all_admin_out", label: "All admin are out" },
  { key: "lunch",         label: "Lunch break" },
  { key: "meeting",       label: "Meeting / official activity" },
  { key: "outage",        label: "Power or internet outage" },
  { key: "other",         label: "Others" }
];

const parts = ms => { const d = new Date(ms + TZ);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours() }; };
const at = (y, m, d, h) => Date.UTC(y, m, d, h) - TZ;

export function isScheduledOpen(ms) {
  const p = parts(ms);
  return p.dow >= 1 && p.dow <= 5 && p.h >= OPEN_H && p.h < CLOSE_H;
}
export function nextOpenTime(ms) {           // next weekday 8:00 AM
  const p = parts(ms);
  for (let i = 0; i < 8; i++) {
    const t = at(p.y, p.m, p.d + i, OPEN_H), dow = (p.dow + i) % 7;
    if (dow >= 1 && dow <= 5 && t > ms) return t;
  }
}
export function nextCloseTime(ms) {          // next 5:00 PM
  const p = parts(ms);
  for (let i = 0; i < 2; i++) { const t = at(p.y, p.m, p.d + i, CLOSE_H); if (t > ms) return t; }
}

// Manual overrides expire by themselves: a manual close ends at the next 8 AM,
// so no cron/Cloud Function is needed. Every client computes the same result.
export function computeStatus(data, now = Date.now()) {
  const o = data && data.until > now && data.type !== "auto" ? data : null;
  if (o && o.type === "closed")
    return { open: false, source: "manual", reason: o.reason || "", note: o.note || "", reopenAt: o.until };
  if (o && o.type === "open")
    return { open: true, source: "manual", closeAt: o.until };
  const sched = isScheduledOpen(now);
  return sched ? { open: true, source: "schedule" }
               : { open: false, source: "schedule", reopenAt: nextOpenTime(now) };
}

export function formatReopen(ms, now = Date.now()) {
  const a = parts(now), b = parts(ms);
  const dayDiff = Math.round((at(b.y, b.m, b.d, 0) - at(a.y, a.m, a.d, 0)) / 86400000);
  const day = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow"
    : ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][b.dow];
  const h = b.h % 12 || 12, ap = b.h >= 12 ? "PM" : "AM";
  return `${day} ${h}:00 ${ap}`;
}

export function watchStatus(cb) {
  return onSnapshot(REF(), s => cb(s.exists() ? s.data() : null), err => { console.error('barangayStatus listener:', err); cb(null); });
}
const write = d => setDoc(REF(), { ...d, updatedAt: serverTimestamp() });

export const setClosed = (reasonKey, reason, note = "") =>
  write({ type: "closed", until: nextOpenTime(Date.now()), reasonKey, reason, note });
export const setOpen = () =>
  write({ type: "open", until: nextCloseTime(Date.now()), reasonKey: "", reason: "", note: "" });
export const clearOverride = () =>
  write({ type: "auto", until: 0, reasonKey: "", reason: "", note: "" });