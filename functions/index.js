const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const MEMBERS_COLLECTION = "members";
const PHONE_INDEX_COLLECTION = "memberPhoneIndex";

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "").replace(/^91/, "").slice(-10);
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickAllowedOrigin(origin) {
  const allowedOrigins = splitCsv(process.env.MSG91_ALLOWED_ORIGINS);
  if (!origin) return allowedOrigins[0] || "*";
  if (!allowedOrigins.length) return origin;
  return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
}

function setCorsHeaders(req, res) {
  const origin = pickAllowedOrigin(req.headers.origin);
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Vary", "Origin");
}

function sendJson(req, res, status, payload) {
  setCorsHeaders(req, res);
  res.status(status).json(payload);
}

function extractVerifiedPhone(payload) {
  const candidates = [
    payload?.phone,
    payload?.mobile,
    payload?.identifier,
    payload?.data?.phone,
    payload?.data?.mobile,
    payload?.data?.identifier,
    payload?.user?.phone,
    payload?.user?.mobile,
  ];
  const verifiedPhone = normalizePhone(candidates.find(Boolean) || "");
  return verifiedPhone;
}

async function verifyMsg91AccessTokenWithProvider(accessToken) {
  const verifyUrl = String(process.env.MSG91_VERIFY_URL || "").trim();
  const authKey = String(process.env.MSG91_AUTH_KEY || "").trim();
  if (!verifyUrl || !authKey) {
    const error = new Error("MSG91 verify URL or auth key is not configured.");
    error.status = 500;
    throw error;
  }

  const response = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authkey: authKey,
    },
    body: JSON.stringify({
      accessToken,
      token: accessToken,
    }),
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    payload = { raw: rawText };
  }

  if (!response.ok) {
    const upstreamError = new Error(payload?.message || "MSG91 access token verification failed.");
    upstreamError.status = response.status;
    upstreamError.payload = payload;
    throw upstreamError;
  }

  return payload;
}

exports.msg91VerifyAccessToken = onRequest({ region: "us-central1" }, async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    sendJson(req, res, 405, { message: "Method not allowed." });
    return;
  }

  try {
    const accessToken = String(req.body?.accessToken || "").trim();
    const requestedPhone = normalizePhone(req.body?.phone || "");
    const intent = String(req.body?.intent || "").trim().toLowerCase();

    if (!accessToken) {
      sendJson(req, res, 400, { message: "Access token is required." });
      return;
    }
    if (!["login", "signup"].includes(intent)) {
      sendJson(req, res, 400, { message: "Intent must be login or signup." });
      return;
    }

    const providerPayload = await verifyMsg91AccessTokenWithProvider(accessToken);
    const verifiedPhone = extractVerifiedPhone(providerPayload);
    if (!verifiedPhone) {
      sendJson(req, res, 502, {
        message: "MSG91 verified the token but did not return a phone number we could normalize.",
        providerPayload,
      });
      return;
    }
    if (requestedPhone && requestedPhone !== verifiedPhone) {
      sendJson(req, res, 409, {
        message: "The OTP was verified for a different phone number.",
        phone: verifiedPhone,
      });
      return;
    }

    if (intent === "signup") {
      const existingIndex = await db.collection(PHONE_INDEX_COLLECTION).doc(verifiedPhone).get();
      sendJson(req, res, 200, {
        ok: true,
        verified: true,
        phone: verifiedPhone,
        alreadyRegistered: existingIndex.exists,
      });
      return;
    }

    const phoneIndexDoc = await db.collection(PHONE_INDEX_COLLECTION).doc(verifiedPhone).get();
    if (!phoneIndexDoc.exists || !phoneIndexDoc.data()?.uid) {
      sendJson(req, res, 404, {
        message: "No Parichayam account is linked to this verified mobile number yet.",
        phone: verifiedPhone,
      });
      return;
    }

    const memberUid = String(phoneIndexDoc.data().uid || "").trim();
    const memberDoc = await db.collection(MEMBERS_COLLECTION).doc(memberUid).get();
    if (!memberDoc.exists) {
      sendJson(req, res, 404, {
        message: "The member linked to this mobile number no longer exists.",
        phone: verifiedPhone,
      });
      return;
    }

    const firebaseToken = await admin.auth().createCustomToken(memberUid, {
      signInMethod: "msg91",
      phone: verifiedPhone,
    });

    sendJson(req, res, 200, {
      ok: true,
      phone: verifiedPhone,
      memberUid,
      firebaseToken,
    });
  } catch (error) {
    logger.error("msg91VerifyAccessToken failed", error);
    sendJson(req, res, error.status || 500, {
      message: error.message || "Unable to complete MSG91 verification.",
      details: error.payload || null,
    });
  }
});
