/**
 * BarangayDocs - Cloud Functions
 *
 * Stage 1: Gemini AI backend (endpoint `aiChat`).
 * Stage 2: answers are grounded in approved knowledge stored in Firestore
 *          (see knowledge.js); unanswered questions are saved for review.
 *
 * The Gemini API key lives in Firebase Secret Manager (never in the
 * frontend or in source control).
 */

const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

const {createKnowledgeStore, logUnanswered} = require("./knowledge");
const {createHandler} = require("./handler");

initializeApp();

// For cost control: max containers running at the same time (per function).
setGlobalOptions({maxInstances: 10});

// ---------------------------------------------------------------------------
// Configuration (unchanged from Stage 1)
// ---------------------------------------------------------------------------

// Secret: set with `firebase functions:secrets:set GEMINI_API_KEY`.
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Model name is a normal (non-secret) parameter so you can switch models
// without editing code. Override it in functions/.env (GEMINI_MODEL=...).
const GEMINI_MODEL = defineString("GEMINI_MODEL", {
  default: "gemini-2.5-flash",
});

// Websites allowed to call this endpoint from a browser (CORS).
// Replace the Vercel entry with your real Vercel domain.
const ALLOWED_ORIGINS = [
  "https://barangaydocs-df957.web.app",
  "https://barangaydocs-df957.firebaseapp.com",
  "https://YOUR-APP.vercel.app",
  "http://localhost:5000",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
];

// ---------------------------------------------------------------------------
// POST /aiChat   body: {"message": "..."}
//   -> {"reply", "answered", "sources", ["questionSaved"]}
// ---------------------------------------------------------------------------

// The knowledge store is created on first use (keeps cold starts light).
let knowledgeStore = null;
const getKnowledgeStore = () => {
  if (!knowledgeStore) {
    knowledgeStore = createKnowledgeStore(getFirestore());
  }
  return knowledgeStore;
};

const handler = createHandler({
  getApiKey: () => GEMINI_API_KEY.value(),
  getModel: () => GEMINI_MODEL.value(),
  getEntries: () => getKnowledgeStore().getEntries(),
  logUnanswered: (question, reason) => {
    return logUnanswered(getFirestore(), FieldValue, question, reason);
  },
  logger: logger,
});

const options = {
  secrets: [GEMINI_API_KEY],
  cors: ALLOWED_ORIGINS,
  timeoutSeconds: 30,
};

exports.aiChat = onRequest(options, handler);