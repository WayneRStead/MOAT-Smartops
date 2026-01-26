// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

const User = require("../models/User");
let Org = null;
try {
  Org = require("../models/Org");
} catch {}

/* ----------------------------- helpers ----------------------------- */
function uniqObjectIdStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = String(v || "").trim();
    if (!s) continue;
    if (!mongoose.isValidObjectId(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function getUserOrgIds(user) {
  // support a few possible shapes:
  // - user.orgId (single org)
  // - user.orgs (array of org ids)
  // - user.organisations (array)
  // - user.memberships [{ orgId }]
  const ids = [];

  if (user?.orgId) ids.push(String(user.orgId));

  if (Array.isArray(user?.orgs)) {
    for (const o of user.orgs) ids.push(String(o?._id || o));
  }

  if (Array.isArray(user?.organisations)) {
    for (const o of user.organisations) ids.push(String(o?._id || o));
  }

  if (Array.isArray(user?.memberships)) {
    for (const m of user.memberships)
      ids.push(String(m?.orgId || m?.org || ""));
  }

  return uniqObjectIdStrings(ids);
}

/* ------------------------- OfflineEvent model ------------------------- */
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

/* ===================================================================== */
/*  1) BOOTSTRAP (NO ORG HEADER REQUIRED)                                 */
/* ===================================================================== */
// Auth required, but NOT org context required.
router.get("/bootstrap", requireAuth, async (req, res) => {
  // req.user is already attached by requireAuth (from your middleware/auth.js)
  const userId = req.user?._id;

  const freshUser = await User.findById(userId).lean();
  if (!freshUser) {
    return res.status(401).json({ error: "User not found" });
  }

  const orgIds = await getUserOrgIds(freshUser);

  // If there are no orgs linked, return empty list
  if (!orgIds.length) {
    return res.json({
      ok: true,
      user: {
        _id: String(freshUser._id),
        email: freshUser.email || "",
        name: freshUser.name || "",
        role: freshUser.role || "",
        roles: freshUser.roles || [],
      },
      orgs: [],
    });
  }

  // Prefer Org model if available
  let orgs = orgIds.map((id) => ({ _id: id, name: "Organisation" }));

  if (Org) {
    const docs = await Org.find({ _id: { $in: orgIds } })
      .select("_id name")
      .lean();
    orgs = (docs || []).map((o) => ({
      _id: String(o._id),
      name: o.name || "Organisation",
    }));
  }

  return res.json({
    ok: true,
    user: {
      _id: String(freshUser._id),
      email: freshUser.email || "",
      name: freshUser.name || "",
      role: freshUser.role || "",
      roles: freshUser.roles || [],
      firebaseUid: freshUser.firebaseUid || null,
    },
    orgs,
  });
});

/* ===================================================================== */
/*  2) EVERYTHING ELSE (ORG REQUIRED)                                     */
/* ===================================================================== */
router.use(requireAuth, resolveOrgContext, requireOrg);

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
