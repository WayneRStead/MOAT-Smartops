// core-backend/middleware/auth.js
// Drop-in replacement that supports BOTH:
// 1) Firebase ID tokens (mobile / new auth)
// 2) Legacy backend JWT tokens (existing web frontend) as a temporary fallback
//
// IMPORTANT:
// - Keep JWT_SECRET in Render for now (legacy fallback needs it).
// - Keep FIREBASE_SERVICE_ACCOUNT_JSON in Render (Firebase verify needs it).
// - Your API still requires x-org-id header (tenant scoping).

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const { getFirebaseAdmin } = require("../firebaseAdmin");

/* ------------------------------ token helper ------------------------------ */
function getTokenFrom(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h) return null;
  const [scheme, token] = String(h).split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

/* ---------------------------- Role helpers ---------------------------- */
const CANON_ROLES = [
  "worker",
  "group-leader",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
];

function normalizeRole(r) {
  if (!r) return "worker";
  let s = String(r).trim().toLowerCase().replace(/\s+/g, "-");
  if (s === "user" || s === "member") s = "worker";
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin") s = "superadmin";
  return CANON_ROLES.includes(s) ? s : "worker";
}

const ROLE_RANK = {
  worker: 1,
  "group-leader": 2,
  "project-manager": 3,
  manager: 4,
  admin: 5,
  superadmin: 6,
};

function rankOf(role) {
  return ROLE_RANK[normalizeRole(role)] || 0;
}

/* ------------------------- Global role helpers ------------------------- */
function normalizeGlobalRole(r) {
  if (!r) return "";
  const s = String(r).trim().toLowerCase();
  if (s === "super-admin") return "superadmin";
  if (s === "support") return "support";
  if (s === "superadmin") return "superadmin";
  return "";
}

function isGlobalSuperadmin(reqUser) {
  return (
    normalizeGlobalRole(reqUser?.globalRole) === "superadmin" ||
    reqUser?.isGlobalSuperadmin === true
  );
}

/* ------------------------- Org header helpers -------------------------- */
function readOrgIdFrom(req) {
  const headerOrg = req.headers["x-org-id"] || req.headers["x-org"];
  const queryOrg = req.query?.orgId || req.query?.org || undefined;
  const bodyOrg = req.body?.orgId || undefined;

  const chosen = String(headerOrg || queryOrg || bodyOrg || "").trim();
  if (!chosen) return null;

  const asObjectId = mongoose.isValidObjectId(chosen)
    ? new mongoose.Types.ObjectId(chosen)
    : null;

  return { id: chosen, objectId: asObjectId };
}

/* -------------------------- Org context middlewares ------------------------ */
function resolveOrgContext(req, _res, next) {
  if (req.orgId) return next();

  const got = readOrgIdFrom(req);
  if (got?.id) {
    req.orgId = got.id;
    req.orgObjectId = got.objectId || undefined;
  }
  return next();
}

function requireOrg(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({
      error: 'Missing organization context. Send header "x-org-id: <orgId>".',
    });
  }
  return next();
}

/* -------------------------- shared: build orgWhere -------------------------- */
function buildOrgWhereOrThrow(req, got) {
  // Your User model uses ObjectId orgId (per models/User.js you shared)
  const orgPath = User?.schema?.path?.("orgId");
  if (!orgPath) return {};

  if (orgPath.instance === "ObjectId") {
    if (!got?.objectId) {
      const err = new Error(
        "Invalid orgId for this tenant. Send a valid ObjectId in x-org-id.",
      );
      err.status = 400;
      throw err;
    }
    return { orgId: got.objectId };
  }

  // fallback if schema ever changes to String orgId
  return { orgId: got?.id };
}

/* -------------------------- shared: attach req.user -------------------------- */
function attachReqUser(req, user) {
  const roles =
    Array.isArray(user.roles) && user.roles.length
      ? user.roles.map(normalizeRole)
      : [normalizeRole(user.role || "worker")];

  const primary = roles.sort((a, b) => rankOf(b) - rankOf(a))[0] || "worker";

  req.user = {
    _id: user._id,
    id: user._id,
    userId: user._id,
    firebaseUid: user.firebaseUid,
    email: user.email,
    name: user.name,
    role: primary,
    roles,
    orgId: user.orgId,
    globalRole: user.globalRole || undefined,
    isGlobalSuperadmin: user.isGlobalSuperadmin === true,
  };
}

/* ------------------------------- requireAuth ------------------------------- */
async function requireAuth(req, res, next) {
  const token = getTokenFrom(req);
  if (!token) return res.status(401).json({ error: "Missing token" });

  // Tenant scoping is required in your API
  const got = readOrgIdFrom(req);
  if (!got?.id) {
    return res.status(400).json({
      error: 'Missing organization context. Send header "x-org-id: <orgId>".',
    });
  }

  // Always set org fields used elsewhere
  req.orgId = got.id;
  req.orgObjectId = got.objectId || undefined;

  // ---------- 1) Try Firebase ID token ----------
  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);

    const firebaseUid = decoded.uid;
    const email = decoded.email
      ? String(decoded.email).trim().toLowerCase()
      : "";

    const orgWhere = buildOrgWhereOrThrow(req, got);

    // Find user: prefer firebaseUid, fallback to email link
    let user = await User.findOne({
      ...orgWhere,
      isDeleted: { $ne: true },
      $or: [{ firebaseUid }, ...(email ? [{ email }] : [])],
    });

    if (!user) {
      return res
        .status(401)
        .json({ error: "User not found in this organisation" });
    }

    // One-time “bind” firebaseUid on first match via email
    if (!user.firebaseUid) {
      user.firebaseUid = firebaseUid;
      await user.save();
    }

    if (user.active === false) {
      return res.status(403).json({ error: "User account is inactive" });
    }

    attachReqUser(req, user);
    return next();
  } catch (_firebaseErr) {
    // fall through to legacy JWT verification
  }

  // ---------- 2) Fallback: legacy backend JWT ----------
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const payload = jwt.verify(token, secret);

    const orgWhere = buildOrgWhereOrThrow(req, got);

    const email = payload.email
      ? String(payload.email).trim().toLowerCase()
      : "";

    const sub = payload.sub ? String(payload.sub).trim() : "";

    // Find a matching user in the org
    const or = [];
    if (email) or.push({ email });
    if (sub && mongoose.isValidObjectId(sub))
      or.push({ _id: new mongoose.Types.ObjectId(sub) });
    if (sub && !mongoose.isValidObjectId(sub)) or.push({ username: sub });

    if (or.length === 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await User.findOne({
      ...orgWhere,
      isDeleted: { $ne: true },
      $or: or,
    });

    if (!user) {
      return res
        .status(401)
        .json({ error: "User not found in this organisation" });
    }

    if (user.active === false) {
      return res.status(403).json({ error: "User account is inactive" });
    }

    attachReqUser(req, user);
    return next();
  } catch (err) {
    console.log("[auth] verify failed:", err?.message || err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ------------------------------ requireRole ------------------------------- */
function requireRole(...allowed) {
  if (!allowed || allowed.length === 0) {
    return (req, res, next) =>
      req.user ? next() : res.status(401).json({ error: "Not authenticated" });
  }

  const requiredRank = Math.min(...allowed.map((r) => rankOf(r) || Infinity));
  const allowedCanon = allowed.map(normalizeRole);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    // Global override: global superadmin always allowed
    if (
      isGlobalSuperadmin(req.user) ||
      normalizeRole(req.user.role) === "superadmin"
    ) {
      return next();
    }

    const haveRank = rankOf(req.user.role);
    const hasExplicit = (req.user.roles || []).some((r) =>
      allowedCanon.includes(normalizeRole(r)),
    );

    if (haveRank >= requiredRank || hasExplicit) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

/* ------------------------------ requireGlobal ------------------------------ */
function requireGlobal(...globals) {
  const set = new Set(globals.map((g) => String(g).toLowerCase()));
  return (req, res, next) => {
    const g = normalizeGlobalRole(req.user?.globalRole);
    if (set.has(g)) return next();
    return res.status(403).json({ error: "Global access required" });
  };
}

function requireGlobalSuperadmin(req, res, next) {
  if (
    isGlobalSuperadmin(req.user) ||
    normalizeRole(req.user?.role) === "superadmin"
  ) {
    return next();
  }
  return res.status(403).json({ error: "Global access required" });
}

function getUser(req) {
  return req.user || null;
}

function getOrgId(req) {
  return req.orgId || req.user?.orgId || null;
}

module.exports = {
  requireAuth,
  resolveOrgContext,
  requireOrg,
  requireRole,
  requireGlobal,
  requireGlobalSuperadmin,
  getUser,
  getOrgId,
};
