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

// Safely determine an orgId value that matches the User schema (if any)
function pickOrgIdForNewUser(payload) {
  const orgPath = User?.schema?.path?.('orgId');
  if (!orgPath) return undefined; // User schema has no orgId field
  const instance = orgPath.instance; // 'ObjectID' | 'String' | etc.

  // If schema expects ObjectId, only set when payload.orgId is a valid ObjectId
  if (instance === 'ObjectID') {
    if (payload?.orgId && mongoose.isValidObjectId(payload.orgId)) {
      return new mongoose.Types.ObjectId(payload.orgId);
    }
    // No valid ObjectId provided -> omit orgId so validation passes (if not required)
    return undefined;
  }

  // If schema expects String, use token orgId or fallback "root"
  if (instance === 'String') {
    return payload?.orgId || 'root';
  }

  // Other types: don’t set
  return undefined;
}

async function attachMongoUserId(req, payload) {
  if (!attachUserIdEnabled) return;

  // Prefer explicit email, else fallback to sub
  const identity = (payload.email || payload.sub || '').trim();
  if (!identity) return;

  try {
    // Try find by common identity fields
    let user = await User.findOne({
      $or: [
        ...(payload.email ? [{ email: payload.email }] : []),
        { username: identity },
        ...(payload.sub ? [{ sub: payload.sub }] : []),
      ],
    }).select({ _id: 1, name: 1, email: 1, role: 1 });

    // Auto-provision minimal user if enabled and none found
    if (!user && autoProvisionEnabled) {
      const newUserData = {
        // prefer email if present; otherwise store identity as username
        email: payload.email || undefined,
        username: payload.email ? undefined : identity,
        name: payload.name || identity,
        role: (payload.role || payload.roles || 'admin'), // default suitable for console admins; adjust if needed
        sub: payload.sub || undefined,
        isActive: true,
      };

      const orgIdPicked = pickOrgIdForNewUser(payload);
      if (orgIdPicked !== undefined) {
        newUserData.orgId = orgIdPicked;
      }

      user = new User(newUserData);
      await user.save();
    }

    if (user) {
      // Attach IDs so downstream routes (audit) can reference editor
      req.user._id = user._id;
      req.user.id = user._id;
      req.user.userId = user._id;
      // Also bubble up friendly info
      req.user.name = req.user.name || user.name || undefined;
      req.user.email = req.user.email || user.email || undefined;
      // Normalize role from DB if present
      if (user.role) req.user.role = user.role;
    }
  } catch (err) {
    // Non-fatal — routes can still decide what to do (e.g., reject audited updates)
    console.warn('auth: failed to attach Mongo user id:', err?.message || err);
  }
}

async function requireAuth(req, res, next) {
  try {
    const token = getTokenFrom(req);
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server auth misconfigured' });

    const payload = jwt.verify(token, secret); // { sub, role, email, name, orgId?, iat, exp, ... }

    // Base shape (compatible with your existing code)
    req.user = {
      sub: payload.sub,
      role: payload.role || payload.roles || 'user',
      email: payload.email || undefined,
      name: payload.name || undefined,
      orgId: payload.orgId || undefined,
    };

    // Best-effort: attach a Mongo User._id for auditing
    await attachMongoUserId(req, payload);

    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// role hierarchy: higher ranks satisfy lower requirements
const ROLE_RANK = { worker: 1, manager: 2, admin: 3, superadmin: 4 };

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const role = String(req.user.role || '').toLowerCase();
    const have = ROLE_RANK[role] || 0;

    // If multiple roles are passed, require the lowest acceptable rank among them
    const required = Math.min(
      ...allowed.map(r => ROLE_RANK[String(r).toLowerCase()] || Infinity)
    );

    if (have >= required) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

module.exports = { requireAuth, requireRole };
