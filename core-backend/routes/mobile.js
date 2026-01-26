// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();

const mongoose = require("mongoose");
const User = require("../models/User");

// middleware
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
/*  IMPORTANT: Bootstrap must NOT require org header                   */
/* ------------------------------------------------------------------ */

// Auth only (no requireOrg yet)
router.use(requireAuth, resolveOrgContext);

/**
 * GET /mobile/bootstrap
 * GET /api/mobile/bootstrap
 *
 * Returns org choices for current user (even if only one).
 * This runs BEFORE x-org-id exists on device.
 */
router.get("/bootstrap", async (req, res) => {
  const userId = req.user?._id;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Load the full user (so we can safely access orgId, name, etc.)
  const user = await User.findById(userId).lean();
  if (!user) return res.status(401).json({ error: "User not found" });

  // In your current system, user.orgId appears to be a single org ObjectId.
  const orgIds = [];
  if (user.orgId) orgIds.push(String(user.orgId));

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
      // keep fallback org names
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
/*  Everything below here DOES require org context                     */
/* ------------------------------------------------------------------ */
router.use(requireOrg);

router.post("/offline-events", async (req, res) => {
  const body = req.body || {};

  // orgId from header context (validated by requireOrg)
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
