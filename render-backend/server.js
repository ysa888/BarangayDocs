/**
 * BarangayDocs - aiChat on Render (replaces the Firebase Cloud Function).
 *
 * Reuses handler.js and knowledge.js unchanged. Firestore is reached with
 * firebase-admin using a service account (Firestore reads/writes work on the
 * Spark plan). Secrets come from Render environment variables.
 *
 * Environment variables:
 *   GEMINI_API_KEY             Gemini API key (required)
 *   GEMINI_MODEL               Gemini model name (default: gemini-2.5-flash)
 *   FIREBASE_SERVICE_ACCOUNT   Full service-account JSON (required)
 *   ALLOWED_ORIGINS            Comma-separated site origins allowed by CORS,
 *                              e.g. https://barangaydocs-df957.web.app
 *   PORT                       Set by Render automatically
 */

const express = require("express");
const admin = require("firebase-admin");
const {createHandler} = require("./handler");
const {createKnowledgeStore, logUnanswered} = require("./knowledge");

const getRequiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing environment variable: " + name);
  }
  return value;
};

// --- Firebase Admin (service account from env) ---------------------------
let serviceAccount;
try {
  serviceAccount = JSON.parse(getRequiredEnv("FIREBASE_SERVICE_ACCOUNT"));
} catch (err) {
  console.error("FIREBASE_SERVICE_ACCOUNT is missing or not valid JSON.");
  throw err;
}
admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const knowledgeStore = createKnowledgeStore(db);

const logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const handler = createHandler({
  getApiKey: () => getRequiredEnv("GEMINI_API_KEY"),
  getModel: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
  getEntries: knowledgeStore.getEntries,
  logUnanswered: (question, reason) =>
    logUnanswered(db, FieldValue, question, reason),
  logger: logger,
  allowedOrigins: allowedOrigins,
});

const app = express();
app.disable("x-powered-by");

// CORS header for real (non-preflight) responses; handler.js answers OPTIONS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  next();
});

app.use(express.json({limit: "100kb"}));

// Malformed JSON -> same error shape the handler uses.
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({error: {
      code: "invalid-body",
      message: "Send a JSON body with Content-Type: application/json.",
    }});
  }
  return next();
});

// Health check for Render.
app.get("/", (req, res) => res.status(200).send("ok"));

// Same path as the old Cloud Function URL (.../aiChat).
app.all("/aiChat", handler);

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info("aiChat listening on port " + port));