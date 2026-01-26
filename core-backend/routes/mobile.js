// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();

const mongoose = require("mongoose");
const Org = require("../models/Org"); // <-- required for bootstrap org list

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

/* ------------------------------------------------------------------ */
/* Offline event ingestion model                                       */
/* ------------------------------------------------------------------ */

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
/* 1) BOOTSTRAP (AUTH ONLY — NO ORG REQUIRED)                          */
/* ------------------------------------------------------------------ */
/**
 * Returns the orgs available to the signed-in Firebase user.
 * This endpoint MUST NOT require x-org-id, because the user may not have chosen one yet.
 */
router.get("/bootstrap", requireAuth, async (req, res) => {
  // Your requireAuth attaches req.user from Mongo User record
  const user = req.user;

  // We support a few possible shapes because different seeds/schemas exist:
  // - user.orgId (single org)
  // - user.orgIds (array)
  // - user.orgs (array of ids or objects)
  const ids = [];

  if (user?.orgId) ids.push(String(user.orgId));

  if (Array.isArray(user?.orgIds)) {
    for (const x of user.orgIds) if (x) ids.push(String(x));
  }

  if (Array.isArray(user?.orgs)) {
    for (const x of user.orgs) {
      if (!x) continue;
      // may be populated org object or just id
      if (typeof x === "string") ids.push(String(x));
      else if (x?._id) ids.push(String(x._id));
      else if (mongoose.isValidObjectId(x)) ids.push(String(x));
    }
  }

  const uniqIds = [...new Set(ids)].filter((x) => mongoose.isValidObjectId(x));

  // If user only has one orgId in schema, this will return that org.
  // If user has multiple orgs, we return them all for org-select.
  let orgs = [];
  if (uniqIds.length) {
    orgs = await Org.find({ _id: { $in: uniqIds } })
      .select("_id name status planCode")
      .sort({ name: 1 })
      .lean();
  }

  return res.json({
    ok: true,
    orgs,
    // Optional convenience: backend may already know a "current" org
    currentOrgId: user?.orgId ? String(user.orgId) : null,
    user: {
      id: String(user?._id || ""),
      email: user?.email || "",
      name: user?.name || "",
      role: user?.role || "",
    },
  });
});

/* ------------------------------------------------------------------ */
/* 2) EVERYTHING BELOW REQUIRES ORG CONTEXT                             */
/* ------------------------------------------------------------------ */
router.use(requireAuth, resolveOrgContext, requireOrg);

/**
 * Raw ingestion endpoint for outbox events
 */
router.post("/offline-events", async (req, res) => {
  const body = req.body || {};

  // orgId from header context (already validated by requireOrg)
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
