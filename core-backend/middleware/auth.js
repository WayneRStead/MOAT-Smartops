// core-backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

function getTokenFrom(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h) return null;
  const [scheme, token] = String(h).split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.trim();
}

const attachUserIdEnabled = (process.env.AUTH_ATTACH_USER_ID ?? 'true').toLowerCase() !== 'false';
const autoProvisionEnabled = (process.env.AUTH_AUTOPROVISION ?? 'true').toLowerCase() !== 'false';

/* ---------------------------- Role helpers ---------------------------- */
const CANON_ROLES = ['user','group-leader','project-manager','manager','admin','superadmin'];

// map common synonyms -> canonical
function normalizeRole(r) {
  if (!r) return '';
  let s = String(r).trim().toLowerCase();
  s = s.replace(/\s+/g, '-');           // "Project Manager" -> "project-manager"
  if (s === 'worker' || s === 'member') s = 'user';
  if (s === 'groupleader') s = 'group-leader';
  if (s === 'pm') s = 'project-manager';
  if (s === 'super-admin') s = 'superadmin';
  return CANON_ROLES.includes(s) ? s : '';
}

function rolesFromPayload(payload) {
  const raw = Array.isArray(payload?.roles)
    ? payload.roles
    : (payload?.role ? [payload.role] : []);
  const canon = raw.map(normalizeRole).filter(Boolean);
  return canon.length ? canon : ['user'];
}

// rank for “at least this level” checks
const ROLE_RANK = {
  'user': 1,
  'group-leader': 2,
  'project-manager': 3,
  'manager': 4,
  'admin': 5,
  'superadmin': 6,
};
function rankOf(role) { return ROLE_RANK[normalizeRole(role)] || 0; }

/* ------------------------- Org header helpers -------------------------- */
function readOrgIdFrom(req) {
  // Preferred: header
  const headerOrg = req.headers['x-org-id'] || req.headers['x-org'];
  // Fallbacks: query/body (useful for tools/tests; avoid in browsers)
  const queryOrg = req.query?.orgId || req.query?.org || undefined;
  const bodyOrg  = req.body?.orgId || undefined;

  const chosen = String(headerOrg || queryOrg || bodyOrg || '').trim();
  if (!chosen) return '';

  // Accept any non-empty string; if it *is* a valid ObjectId, also expose object form
  const asObjectId = mongoose.isValidObjectId(chosen) ? new mongoose.Types.ObjectId(chosen) : null;
  return { id: chosen, objectId: asObjectId };
}

/* ------------------------- Org helper for User ------------------------ */
// Safely determine an orgId value that matches the User schema (if any)
function pickOrgIdForNewUser(payload) {
  const orgPath = User?.schema?.path?.('orgId');
  if (!orgPath) return undefined; // User schema has no orgId field
  const instance = orgPath.instance; // 'ObjectID' | 'String' | etc.

  if (instance === 'ObjectID') {
    if (payload?.orgId && mongoose.isValidObjectId(payload.orgId)) {
      return new mongoose.Types.ObjectId(payload.orgId);
    }
    return undefined;
  }
  if (instance === 'String') {
    return payload?.orgId || 'root';
  }
  return undefined;
}

/* -------------------- Attach Mongo _id (best-effort) ------------------- */
async function attachMongoUserId(req, payload) {
  if (!attachUserIdEnabled) return;

  const identity = (payload.email || payload.sub || '').trim();
  if (!identity) return;

  try {
    // include orgId so we can backfill req.user.orgId when token doesn't carry it
    let user = await User.findOne({
      $or: [
        ...(payload.email ? [{ email: payload.email }] : []),
        { username: identity },
        ...(payload.sub ? [{ _id: payload.sub }] : []),
      ],
    }).select({ _id: 1, name: 1, email: 1, role: 1, orgId: 1, globalRole: 1, isGlobalSuperadmin: 1 });

    // Auto-provision if enabled
    if (!user && autoProvisionEnabled) {
      const newUserData = {
        email: payload.email || undefined,
        username: payload.email ? undefined : identity,
        name: payload.name || identity,
        role: normalizeRole(payload.role) || 'user', // safe default
        sub: payload.sub || undefined,
        isActive: true,
      };
      const orgIdPicked = pickOrgIdForNewUser(payload);
      if (orgIdPicked !== undefined) newUserData.orgId = orgIdPicked;

      user = new User(newUserData);
      await user.save();
    }

    if (user) {
      req.user._id = user._id;
      req.user.id = user._id;       // aliases
      req.user.userId = user._id;

      // prefer DB values where missing
      req.user.name = req.user.name || user.name || undefined;
      req.user.email = req.user.email || user.email || undefined;

      // Global role (support/superadmin) if you store it on User
      if (!req.user.globalRole && user.globalRole) {
        req.user.globalRole = user.globalRole;
      }

      // Global flag
      if (user.isGlobalSuperadmin) {
        req.user.isGlobalSuperadmin = true;
      }

      if (!req.user.orgId && user.orgId) {
        // backfill tenant id for downstream org filtering
        req.user.orgId = user.orgId;
      }

      // Merge roles: payload + DB role (normalized), unique, then recompute primary
      const dbRole = normalizeRole(user.role);
      const merged = new Set([...(req.user.roles || []), ...(dbRole ? [dbRole] : [])]);
      req.user.roles = Array.from(merged);
      req.user.role = req.user.roles.sort((a,b)=>rankOf(b)-rankOf(a))[0] || 'user';
    }
  } catch (err) {
    console.warn('auth: failed to attach Mongo user id:', err?.message || err);
  }
}

/* ------------------------------- requireAuth ------------------------------- */
async function requireAuth(req, res, next) {
  try {
    const token = getTokenFrom(req);
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server auth misconfigured' });

    const payload = jwt.verify(token, secret); // { sub, role|roles, email, name, orgId?, globalRole? ... }

    const roles = rolesFromPayload(payload);
    const primary = roles.sort((a,b)=>rankOf(b)-rankOf(a))[0] || 'user';

    req.user = {
      sub: payload.sub,
      role: primary,
      roles,
      email: payload.email || undefined,
      name: payload.name || undefined,
      orgId: payload.orgId || undefined,
      globalRole: payload.globalRole || undefined,
    };

    await attachMongoUserId(req, payload);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* -------------------------- Org context middlewares ------------------------ */
// Lightweight resolver (does not enforce presence)
function resolveOrgContext(req, res, next) {
  // Already set upstream? Keep it.
  if (req.orgId) return next();

  const got = readOrgIdFrom(req);
  if (got && got.id) {
    req.orgId = got.id;
    req.orgObjectId = got.objectId || undefined;
    // Also backfill on user for convenience, but do NOT rely on this for security
    if (req.user && !req.user.orgId) req.user.orgId = got.objectId || got.id;
  }
  return next();
}

// Hard guard: require an org to be specified
function requireOrg(req, res, next) {
  // ensure resolveOrgContext ran
  if (!req.orgId) {
    const hint = 'Missing organization context. Send header "x-org-id: <orgId>".';
    return res.status(400).json({ error: hint });
  }
  return next();
}

/* ------------------------------ requireRole ------------------------------- */
// Accepts one or more roles; user passes if their primary rank >= the minimum
function requireRole(...allowed) {
  // If no roles specified, treat as authenticated-only
  if (!allowed || allowed.length === 0) {
    return (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not authenticated' }));
  }

  const requiredRank = Math.min(...allowed.map(r => rankOf(r) || Infinity));
  const allowedCanon = allowed.map(normalizeRole);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    // Global override: superadmin always allowed
    if (
      normalizeRole(req.user.globalRole) === 'superadmin' ||
      normalizeRole(req.user.role) === 'superadmin' ||
      req.user.isGlobalSuperadmin === true
    ) {
      return next();
    }

    // Primary rank (role hierarchy)
    const haveRank = rankOf(req.user.role);

    // Also allow explicit membership in any allowed role (in case of non-linear needs)
    const hasExplicit = (req.user.roles || []).some(r => allowedCanon.includes(r));

    if (haveRank >= requiredRank || hasExplicit) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

/* ------------------------------ requireGlobal ------------------------------ */
// Generic global gate (used if you ever want multiple global roles like "support", etc.)
function requireGlobal(...globals /* 'superadmin','support' */) {
  const set = new Set(globals.map(g => String(g).toLowerCase()));
  return (req, res, next) => {
    const g = String(req.user?.globalRole || '').toLowerCase();
    if (set.has(g)) return next();
    return res.status(403).json({ error: 'Global access required' });
  };
}

/* -------------------------- requireGlobalSuperadmin ------------------------ */
// Specific global-superadmin gate for /admin/super.
// Accepts ANY of:
//   - user.globalRole === 'superadmin'
//   - user.isGlobalSuperadmin === true
//   - user.role === 'superadmin' (what your current JWT has)
function requireGlobalSuperadmin(req, res, next) {
  const globalRole = normalizeRole(req.user?.globalRole);
  const primaryRole = normalizeRole(req.user?.role);
  const flag = req.user?.isGlobalSuperadmin === true;

  console.log('[requireGlobalSuperadmin] req.user =', {
    role: req.user?.role,
    roles: req.user?.roles,
    globalRole: req.user?.globalRole,
    isGlobalSuperadmin: req.user?.isGlobalSuperadmin,
    orgId: req.user?.orgId,
  });

  if (globalRole === 'superadmin' || primaryRole === 'superadmin' || flag) {
    console.log('[requireGlobalSuperadmin] PASS');
    return next();
  }
  console.log('[requireGlobalSuperadmin] FAIL');
  return res.status(403).json({ error: 'Global access required' });
}


/* --------------------------------- helpers -------------------------------- */
function getUser(req) { return req.user || null; }
function getOrgId(req) { return req.orgId || req.user?.orgId || null; }

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
