/**
 * Import the initial AI knowledge into Firestore (collection `aiKnowledge`).
 *
 * Run from the `functions` folder:
 *   node scripts/seed-knowledge.js --dry-run     (validate only)
 *   node scripts/seed-knowledge.js               (import new entries)
 *   node scripts/seed-knowledge.js --overwrite   (also replace existing ones)
 *
 * Credentials (one of):
 *   - GOOGLE_APPLICATION_CREDENTIALS=<path to a service-account key file>
 *     (Firebase Console > Project settings > Service accounts > Generate
 *     new private key). Keep that file out of Git and delete it afterwards.
 *   - FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 to import into the emulator.
 *
 * Existing entries are skipped unless --overwrite is given, so edits you
 * make in the Firebase console are not lost by re-running the script.
 */

const fs = require("fs");
const path = require("path");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

const STATUSES = ["draft", "approved", "archived"];

const args = process.argv.slice(2);
const dryRun = args.indexOf("--dry-run") > -1;
const overwrite = args.indexOf("--overwrite") > -1;

// Same checks as the Firestore security rules, so problems show up here.
const validate = (e) => {
  const problems = [];
  const isText = (v, max) => typeof v === "string" && v.trim() &&
    v.length <= max;
  if (!isText(e.id, 100)) problems.push("id");
  if (!isText(e.category, 60)) problems.push("category");
  if (!isText(e.question, 300)) problems.push("question (max 300)");
  if (!isText(e.answer, 2000)) problems.push("answer (max 2000)");
  if (STATUSES.indexOf(e.status) === -1) problems.push("status");
  if (!Array.isArray(e.keywords)) problems.push("keywords (array)");
  return problems;
};

const main = async () => {
  const file = path.join(__dirname, "knowledge.seed.json");
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));

  let bad = 0;
  const ids = new Set();
  entries.forEach((e) => {
    const problems = validate(e);
    if (ids.has(e.id)) problems.push("duplicate id");
    ids.add(e.id);
    if (problems.length) {
      bad++;
      console.error("Invalid entry '" + e.id + "': " + problems.join(", "));
    }
  });
  if (bad) {
    process.exitCode = 1;
    return;
  }

  const counts = {};
  entries.forEach((e) => {
    counts[e.status] = (counts[e.status] || 0) + 1;
  });
  console.log("Seed file OK: " + entries.length + " entries " +
    JSON.stringify(counts));
  if (dryRun) {
    console.log("Dry run - nothing written.");
    return;
  }

  initializeApp({
    projectId: process.env.GCLOUD_PROJECT || "barangaydocs-df957",
  });
  const col = getFirestore().collection("aiKnowledge");

  let created = 0;
  let replaced = 0;
  let skipped = 0;
  for (const e of entries) {
    const data = {
      category: e.category,
      question: e.question,
      answer: e.answer,
      keywords: e.keywords,
      status: e.status,
      source: e.source || "seed",
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (e.note) data.note = e.note;
    const ref = col.doc(e.id);
    const exists = (await ref.get()).exists;
    if (exists && !overwrite) {
      skipped++;
    } else if (exists) {
      await ref.set(data, {merge: true});
      replaced++;
    } else {
      data.createdAt = FieldValue.serverTimestamp();
      await ref.set(data);
      created++;
    }
  }
  console.log("Created " + created + ", replaced " + replaced +
    ", skipped (already exist) " + skipped + ".");
};

main().catch((err) => {
  console.error("Seed failed:", err.message || err);
  process.exitCode = 1;
});