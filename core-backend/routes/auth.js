const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// User model is optional; if missing, we still support ENV-based login
let User = null;
try { User = require('../models/User'); } catch (_) { /* optional */ }

// -------- helpers --------
const normalizeEmail = (s) => String(s || '').trim().toLowerCase();
const isBcryptHash = (s) => typeof s === 'string' && s.startsWith('$2');

function signToken({ _id, orgId, role, email }) {
  const secret = process.env.JWT_SECRET || 'super_secret_change_me';
  return jwt.sign(
    { _id, sub: _id, orgId, role, email },
    secret,
    { expiresIn: '8h' }
  );
}

async function verifyDbPassword(plain, userDoc) {
  // Prefer passwordHash if present
  if (userDoc && userDoc.passwordHash) {
    return bcrypt.compare(plain, userDoc.passwordHash);
  }
  // If there's a `password` field, handle bcrypt or plain
  if (userDoc && typeof userDoc.password === 'string') {
    if (isBcryptHash(userDoc.password)) {
      return bcrypt.compare(plain, userDoc.password);
    }
    // As a last resort, allow plain compare in dev environments
    return plain === userDoc.password;
  }
  return null; // no password stored on user
}

async function tryDbLogin(email, password) {
  if (!User) return null;

  // Try to find by email; support mixed casing in stored data
  const e = normalizeEmail(email);
  const u =
    (await User.findOne({ email: e }).lean()) ||
    (await User.findOne({ email }).lean()) ||
    null;

  if (!u) return null;

  // If user has a stored password, verify it; otherwise fall through to env
  const verified = await verifyDbPassword(password, u);
  if (verified === true) {
    const payload = {
      _id: String(u._id),
      orgId: String(u.orgId || process.env.AUTH_ORG_ID || '650000000000000000000099'),
      role: String(u.role || 'user'),
      email: u.email,
    };
    const token = signToken(payload);
    return {
      token,
      user: {
        _id: payload._id,
        orgId: payload.orgId,
        role: payload.role,
        email: payload.email,
        name: u.name || u.email,
      },
    };
  }

  // If not verified (or user has no stored password), return null to allow env login
  return null;
}

async function tryEnvLogin(email, password) {
  const envUser = process.env.AUTH_USER;
  const passHash = process.env.AUTH_PASS_BCRYPT; // bcrypt hash
  const passPlain = process.env.AUTH_PASS;       // plain text (dev only)

  if (!envUser) return null;
  if (normalizeEmail(email) !== normalizeEmail(envUser)) return null;

  let ok = false;
  if (passHash) ok = await bcrypt.compare(password, passHash);
  else if (passPlain) ok = password === passPlain;

  if (!ok) return null;

  const userId = process.env.AUTH_USER_ID || '650000000000000000000001';
  const orgId  = process.env.AUTH_ORG_ID  || '650000000000000000000099';
  const role   = process.env.AUTH_ROLE    || 'admin';

  const token = signToken({ _id: userId, orgId, role, email: envUser });

  return {
    token,
    user: { _id: userId, orgId, role, email: envUser, name: 'Admin' },
  };
}

// Shared handler so /login and /dev-login behave the same
async function loginHandler(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // 1) Try database login (if User model exists)
    const dbResult = await tryDbLogin(email, password);
    if (dbResult) return res.json(dbResult);

    // 2) Fallback to ENV login
    const envResult = await tryEnvLogin(email, password);
    if (envResult) return res.json(envResult);

    // Otherwise invalid
    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) {
    console.error('[auth/login] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// -------- routes --------

// Login (primary)
router.post('/login', loginHandler);

// Dev alias (optional; same behavior)
router.post('/dev-login', loginHandler);

// Who am I? (requires Bearer token)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Optional logout endpoint (stateless JWTs; frontend should just delete the token)
router.post('/logout', (_req, res) => res.json({ ok: true }));

module.exports = router;
