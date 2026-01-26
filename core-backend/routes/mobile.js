// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const User = require("../models/User");
const { getFirebaseAdmin } = require("../firebaseAdmin");

// Existing org-scoped middleware for the rest
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

// Optional Org model (safe)
let Org = null;
try {
  Org = require("../models/Org");
} catch {
  Org = null;
}

/* ------------------------------ helpers ------------------------------ */
function getTokenFrom(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h) return null;
  const [scheme, token] = String(h).split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

/**
 * ✅ Firebase-only auth for bootstrap (NO org header required)
 * Attaches: req.bootstrapUser (mongoose user doc, lean)
 */
async function requireFirebaseOnly(req, res, next) {
  try {
    const token = getTokenFrom(req);
    if (!token) return res.status(401).json({ error: "Missing token" });

    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);

    const firebaseUid = decoded.uid;
    const email = decoded.email
      ? String(decoded.email).trim().toLowerCase()
      : "";

    // Find user WITHOUT org scoping (bootstrap purpose)
    const user = await User.findOne({
      isDeleted: { $ne: true },
      $or: [{ firebaseUid }, ...(email ? [{ email }] : [])],
    }).lean();

    if (!user) {
      return res.status(401).json({
        error: "User not found (not linked in backend database yet)",
      });
    }

    // If firebaseUid missing on backend user but email matched, bind it
    if (!user.firebaseUid && firebaseUid) {
      try {
        await User.updateOne({ _id: user._id }, { $set: { firebaseUid } });
      } catch {
        // don't block bootstrap if bind fails
      }
    }

    req.bootstrapUser = user;
    req.bootstrapFirebase = { firebaseUid, email };
    return next();
  } catch (e) {
    console.log("[mobile/bootstrap] firebase verify failed:", e?.message || e);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* -------------------- Offline Events collection -------------------- */
const OfflineEventSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventType: { type: String, index: true },
    entityRef: { type: String },
    payload: { type: Object },
    fileUris: { type: [String], default: [] },
    createdAtClient: { type: String },
    receivedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

const OfflineEvent =
  mongoose.models.OfflineEvent ||
  mongoose.model("OfflineEvent", OfflineEventSchema);

/* ------------------------------------------------------------------ */
/*  ✅ BOOTSTRAP (NO org header required)                               */
/* ------------------------------------------------------------------ */
/**
 * GET /mobile/bootstrap
 * GET /api/mobile/bootstrap
 *
 * Returns org choices for current user (even if only one).
 * This is used BEFORE x-org-id exists on device.
 */
router.get("/bootstrap", requireFirebaseOnly, async (req, res) => {
  const user = req.bootstrapUser;

  // In your current system, user.orgId is typically a single ObjectId
  const orgIds = [];
  if (user?.orgId) orgIds.push(String(user.orgId));

  let orgs = orgIds.map((id) => ({ _id: id, name: "Organisation" }));

  // If Org model exists, enrich names
  if (Org && orgIds.length) {
    try {
      const docs = await Org.find({ _id: { $in: orgIds } })
        .select("_id name orgName title")
        .lean();

      const byId = new Map(docs.map((d) => [String(d._id), d]));
      orgs = orgIds.map((id) => {
        const d = byId.get(id);
        return {
          _id: id,
          name: d?.name || d?.orgName || d?.title || "Organisation",
        };
      });
    } catch (e) {
      console.warn("[mobile/bootstrap] Org lookup failed:", e?.message || e);
    }
  }

  return res.json({
    ok: true,
    user: {
      _id: String(user._id),
      name: user.name || "",
      email: user.email || "",
    },
    orgs,
  });
});

/* ------------------------------------------------------------------ */
/*  ✅ Everything below requires org header (normal API rules)          */
/* ------------------------------------------------------------------ */
router.use(requireAuth, resolveOrgContext, requireOrg);

/**
 * POST /mobile/offline-events
 * POST /api/mobile/offline-events
 */
router.post("/offline-events", async (req, res) => {
  const body = req.body || {};

  const orgId = req.orgObjectId || req.user?.orgId;
  const userId = req.user?._id || null;

  const doc = await OfflineEvent.create({
    orgId,
    userId,
    eventType: body.eventType || "unknown",
    entityRef: body.entityRef || null,
    payload: body.payload || {},
    fileUris: Array.isArray(body.fileUris) ? body.fileUris : [],
    createdAtClient: body.createdAt || null,
  });

  res.json({ ok: true, id: doc._id });
});

module.exports = router;
