/**
 * BarangayDocs - aiChat request handler.
 *
 * Kept separate from index.js so it can be tested without deploying.
 * Stage 1 behaviour is unchanged: same method check, same validation, same
 * error codes. Stage 2 adds knowledge retrieval before the Gemini call.
 */

const {answerFromKnowledge} = require("./knowledge");

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_MESSAGE_LENGTH = 1000;
const MAX_OUTPUT_TOKENS = 1024;
const GEMINI_TIMEOUT_MS = 20000;

// Consistent error shape: {error: {code, message}}
const fail = (res, status, code, message) => {
  return res.status(status).json({error: {code: code, message: message}});
};

// An Error that the handler turns into an HTTP response.
const httpError = (status, code, message) => {
  const e = new Error(message);
  e.http = {status: status, code: code, message: message};
  return e;
};

// Pull the reply text out of a Gemini generateContent response.
const extractReply = (data) => {
  const candidate = data && data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
};

// deps: {
//   getApiKey, getModel, getEntries, logUnanswered, logger,
//   fetchFn?, allowedOrigins?
// }
const createHandler = (deps) => {
  const logger = deps.logger;
  const doFetch = deps.fetchFn || fetch;
  const allowedOrigins = deps.allowedOrigins || [];

  // Call Gemini; returns reply text or throws an httpError.
  const askGemini = async (systemPrompt, userText) => {
    const url = GEMINI_BASE_URL + "/models/" + deps.getModel() +
      ":generateContent";
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": deps.getApiKey(),
      },
      body: JSON.stringify({
        systemInstruction: {parts: [{text: systemPrompt}]},
        contents: [{role: "user", parts: [{text: userText}]}],
        generationConfig: {
          temperature: 0.2, // low: stick to the provided knowledge
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    };

    let geminiRes;
    try {
      geminiRes = await doFetch(url, init);
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        logger.warn("Gemini request timed out");
        throw httpError(504, "ai-timeout",
            "The AI took too long to respond. Please try again.");
      }
      logger.error("Gemini request failed", err);
      throw httpError(502, "ai-unreachable",
          "Could not reach the AI service. Please try again later.");
    }

    if (!geminiRes.ok) {
      // Log details server-side only; never leak them to the browser.
      const detail = await geminiRes.text().catch(() => "");
      logger.error("Gemini API error", {
        status: geminiRes.status,
        model: deps.getModel(),
        detail: detail.slice(0, 500),
      });
      if (geminiRes.status === 429) {
        throw httpError(429, "ai-rate-limited",
            "The AI is busy right now. Please try again in a minute.");
      }
      throw httpError(502, "ai-error",
          "The AI service returned an error. Please try again later.");
    }

    let data;
    try {
      data = await geminiRes.json();
    } catch (err) {
      logger.error("Gemini returned invalid JSON", err);
      throw httpError(502, "ai-bad-response", "Unexpected AI response.");
    }

    const reply = extractReply(data);
    if (!reply) {
      // Usually a safety block or an empty generation.
      logger.warn("Gemini returned no text", {
        blockReason: data && data.promptFeedback &&
          data.promptFeedback.blockReason,
        finishReason: data && data.candidates && data.candidates[0] &&
          data.candidates[0].finishReason,
      });
      throw httpError(422, "no-reply",
          "The AI could not answer that. Try rephrasing your message.");
    }
    return reply;
  };

  return async (req, res) => {
    // Handle CORS preflight requests explicitly to ensure correct headers
    // are returned for cross-origin browser requests (firebase-functions v2
    // cors option may not reliably intercept OPTIONS
    // without explicit handling).
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.set("Access-Control-Allow-Origin", origin);
      }
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send();
    }

    // CORS preflight (OPTIONS) is answered automatically before this runs.
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return fail(res, 405, "method-not-allowed", "Use POST.");
    }

    // --- Validate the request (unchanged from Stage 1) ---------------------
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(res, 400, "invalid-body",
          "Send a JSON body with Content-Type: application/json.");
    }
    if (typeof body.message !== "string") {
      return fail(res, 400, "invalid-message",
          "\"message\" must be a string.");
    }
    const message = body.message.trim();
    if (message.length === 0) {
      return fail(res, 400, "empty-message", "\"message\" cannot be empty.");
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return fail(res, 400, "message-too-long",
          "\"message\" must be " + MAX_MESSAGE_LENGTH +
          " characters or less.");
    }

    // --- Retrieve approved knowledge, then answer from it ------------------
    try {
      const result = await answerFromKnowledge(message, {
        getEntries: deps.getEntries,
        askGemini: askGemini,
        logUnanswered: deps.logUnanswered,
        warn: (msg, extra) => logger.warn(msg, extra),
      });
      return res.status(200).json(result);
    } catch (err) {
      if (err && err.http) {
        if (err.cause) {
          logger.error(err.message, err.cause);
        }
        return fail(res, err.http.status, err.http.code, err.http.message);
      }
      logger.error("Unexpected error in aiChat", err);
      return fail(res, 500, "internal",
          "Something went wrong. Please try again later.");
    }
  };
};

module.exports = {createHandler};