// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

let Org = null;
try {
  Org = require("../models/Org");
} catch {}

/**
 * IMPORTANT:
 * - requireAuth must NOT require org
 * - resolveOrgContext is safe (it only attaches orgId if present)
 */
router.use(requireAuth, resolveOrgContext);

/**
 * ✅ BOOTSTRAP (NO ORG REQUIRED)
 * Called BEFORE org selection.
 * Returns orgs for this user so the app can set AsyncStorage ORG_KEY.
 */
router.get("/bootstrap", async (req, res) => {
  try {
    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Not authenticated" });

    // Your User model has a REQUIRED single orgId, so bootstrap can just return that.
    const orgId = user.orgId ? String(user.orgId) : null;

    if (!orgId) {
      return res.json({ ok: true, orgs: [] });
    }

    // Optionally fetch org name
    let orgDoc = null;
    if (Org?.findById && mongoose.isValidObjectId(orgId)) {
      orgDoc = await Org.findById(orgId).select({ name: 1 }).lean();
    }

    return res.json({
      ok: true,
      orgs: [
        {
          _id: orgId,
          name: orgDoc?.name || "Organisation",
        },
      ],
    });
  } catch (e) {
    console.error("[mobile/bootstrap] error", e);
    return res.status(500).json({ error: "Bootstrap failed" });
  }
});

/**
 * Everything below here REQUIRES an org header.
 * This is correct because these routes should only be used AFTER org select.
 */
router.use(requireOrg);

/* ------------------ Offline events ingestion ------------------ */
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
