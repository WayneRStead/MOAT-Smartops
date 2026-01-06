// core-backend/routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

function safeRequire(path) {
  try {
    return require(path);
  } catch (e) {
    console.warn(`[auth] Optional module not found: ${path} (${e.message})`);
    return null;
  }
}

const User    = safeRequire('../models/User');
const UserOrg = safeRequire('../models/UserOrg');
const Org     = safeRequire('../models/Org'); // optional, if you have an Org model

const { requireAuth } = require('../middleware/auth');
const mailer = safeRequire('../lib/mailer');

// If mailer not present, provide a safe fallback
const sendPasswordResetEmail =
  (mailer && typeof mailer.sendPasswordResetEmail === 'function')
    ? mailer.sendPasswordResetEmail
    : async ({ to, resetUrl, orgName }) => {
        console.warn('[auth] sendPasswordResetEmail not configured. Logging link instead:');
        console.warn(`  To: ${to}`);
        console.warn(`  Org: ${orgName || ''}`);
        console.warn(`  Reset URL: ${resetUrl}`);
      };

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is missing – tokens will not work correctly.');
}

const RESET_TOKEN_SECRET = process.env.RESET_TOKEN_SECRET || JWT_SECRET || 'changeme-reset';
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// Canonical token roles (auth-layer view)
const TOKEN_ROLES = ['user', 'group-leader', 'project-manager', 'manager', 'admin', 'superadmin'];

function canonRole(r) {
  const raw = String(r || '').trim().toLowerCase();
  let s = raw.replace(/\s+/g, '-');        // "Project Manager" -> "project-manager"

  // Map model aliases -> token aliases
  if (s === 'worker' || s === 'member') s = 'user';
  if (s === 'super-admin') s = 'superadmin';
  if (s === 'pm') s = 'project-manager';
  if (s === 'groupleader') s = 'group-leader';

  return TOKEN_ROLES.includes(s) ? s : 'user';
}

function makeToken({ user, orgId, roles, globalRole }) {
  const secret = JWT_SECRET;
  if (!secret) throw new Error('Server auth misconfigured: JWT_SECRET missing');

  const payload = {
    sub: String(user._id),
    email: user.email || undefined,
    name:  user.name  || undefined,
    orgId: orgId ? String(orgId) : undefined,
    roles: Array.isArray(roles) && roles.length
      ? roles.map(canonRole)
      : [canonRole(user.role || 'user')],
    globalRole: globalRole || user.globalRole || null,
  };

  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

/* =======================================================================
 *  LOGIN
 *  POST /auth/login
 *  body: { email, password }
 * =======================================================================
 */
router.post('/login', async (req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'Server missing User model.' });

    const { email, password } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return res.status(400).json({ error: 'email is required' });

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    // Password check (supports passwordHash or legacy hash fields)
    const hasHash = !!user.passwordHash || !!user.hash || !!user.password;
    if (hasHash) {
      if (!password) return res.status(401).json({ error: 'Password required' });
      const hash = user.passwordHash || user.hash || user.password;
      const ok = await bcrypt.compare(String(password), String(hash));
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    }
    // If no stored hash -> treat as passwordless account (magic link / SSO).

    // Org memberships via UserOrg
    let memberships = [];
    if (UserOrg) {
      memberships = await UserOrg.find({ userId: user._id }).lean();
    }

    let currentOrgId = null;
    let currentRoles = [];
    if (memberships.length === 1) {
      currentOrgId = memberships[0].orgId;
      currentRoles = Array.isArray(memberships[0].roles) ? memberships[0].roles : [];
    }

    const token = makeToken({
      user,
      orgId: currentOrgId,
      roles: currentRoles,
    });

    const orgs = memberships.map(m => ({
      orgId: String(m.orgId),
      roles: m.roles || [],
    }));

    // include roles in response too (helps frontends)
    const responseRoles =
      (Array.isArray(currentRoles) && currentRoles.length)
        ? currentRoles.map(canonRole)
        : [canonRole(user.role || 'user')];

    return res.json({
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        globalRole: user.globalRole || null,
        orgId: currentOrgId ? String(currentOrgId) : null,
        roles: responseRoles,
        role: responseRoles[0] || 'user',
      },
      orgs,
      currentOrgId: currentOrgId ? String(currentOrgId) : null,
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: err.message || 'Login failed' });
  }
});

/* =======================================================================
 *  ME
 *  GET /auth/me
 *  Returns: { user, orgs, currentOrgId }
 *
 *  IMPORTANT:
 *  - Frontend permission checks rely on user.role/user.roles being present.
 *  - req.user is already built by middleware/auth.js and may include DB-merged role.
 * =======================================================================
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'Server missing User model.' });

    const userId = req.user.sub || req.user._id || req.user.id;
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    let memberships = [];
    if (UserOrg) {
      memberships = await UserOrg.find({ userId: user._id }).lean();
    }

    const orgs = memberships.map(m => ({
      orgId: String(m.orgId),
      roles: m.roles || [],
    }));

    // ✅ THIS IS THE FIX:
    // Always include role + roles exactly as middleware computed them.
    // These are what your UI should trust for gating.
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const role = req.user?.role || (roles[0] || 'user');

    return res.json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,

        // include org context & roles for UI permissions
        orgId: req.user.orgId ? String(req.user.orgId) : null,
        roles,
        role,

        // keep existing field for super/global cases
        globalRole: req.user.globalRole || user.globalRole || null,

        // optional flags if present (won't break anything)
        isGlobalSuperadmin: req.user.isGlobalSuperadmin === true,
      },
      orgs,
      currentOrgId: req.user.orgId ? String(req.user.orgId) : null,
    });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

/* =======================================================================
 *  SWITCH ORG
 *  POST /auth/switch-org
 *  body: { orgId }
 * =======================================================================
 */
router.post('/switch-org', requireAuth, async (req, res) => {
  try {
    if (!User || !UserOrg) {
      return res.status(500).json({ error: 'Server missing models.' });
    }
    const { orgId } = req.body || {};
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const userId = req.user.sub || req.user._id || req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const link = await UserOrg.findOne({ userId: user._id, orgId });
    if (!link) return res.status(403).json({ error: 'Not a member of that org' });

    const token = makeToken({
      user,
      orgId,
      roles: link.roles || [],
    });

    return res.json({
      token,
      currentOrgId: String(orgId),
      roles: (link.roles || []).map(canonRole),
      role: ((link.roles || []).map(canonRole)[0]) || 'user',
    });
  } catch (err) {
    console.error('[auth/switch-org]', err);
    res.status(500).json({ error: err.message || 'Failed to switch org' });
  }
});

/* =======================================================================
 *  FORGOT PASSWORD (request reset link)
 *  POST /auth/forgot-password
 *  body: { email }
 * =======================================================================
 */
router.post('/forgot-password', async (req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'Server missing User model.' });

    const rawEmail = String(req.body?.email || '').trim();
    if (!rawEmail) {
      return res.status(400).json({ error: 'email is required' });
    }

    const email = normalizeEmail(rawEmail);

    // We intentionally do NOT reveal whether the email exists
    const user = await User.findOne({
      email: new RegExp(`^${email}$`, 'i'),
      isDeleted: { $ne: true },
    }).lean();

    // Always behave the same on the wire
    if (!user) {
      return res.json({
        ok: true,
        message: 'If an account exists for this email, a reset link has been sent.',
      });
    }

    const payload = {
      sub: String(user._id),
      purpose: 'password-reset',
    };

    // 1 hour expiry
    const token = jwt.sign(payload, RESET_TOKEN_SECRET, { expiresIn: '1h' });

    const base = FRONTEND_BASE_URL.replace(/\/$/, '');
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    // 🔹 Always log the reset URL (especially helpful in dev)
    console.warn('[auth/forgot-password] Password reset link generated:');
    console.warn(`  To: ${user.email}`);
    console.warn(`  URL: ${resetUrl}`);

    // Optional org name for branding
    let orgName = '';
    try {
      if (Org && user.orgId) {
        const org = await Org.findById(user.orgId).lean();
        if (org?.name) orgName = org.name;
      }
    } catch (e) {
      console.warn('[auth/forgot-password] org lookup failed:', e.message);
    }

    // Try to send email, but NEVER break UX if SMTP fails
    try {
      await sendPasswordResetEmail({ to: user.email, resetUrl, orgName });
    } catch (mailErr) {
      console.warn('[auth/forgot-password] sendPasswordResetEmail failed:', mailErr.message);
    }

    return res.json({
      ok: true,
      message: 'If an account exists for this email, a reset link has been sent.',
    });
  } catch (err) {
    console.error('[auth/forgot-password]', err);
    // Still don't leak info; generic response
    res.status(200).json({
      ok: true,
      message: 'If an account exists for this email, a reset link has been sent.',
    });
  }
});

/* =======================================================================
 *  RESET PASSWORD (complete)
 *  POST /auth/reset-password
 *  body: { token, password }
 * =======================================================================
 */
router.post('/reset-password', async (req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'Server missing User model.' });

    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, RESET_TOKEN_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    if (payload.purpose !== 'password-reset' || !payload.sub) {
      return res.status(400).json({ error: 'Invalid reset token.' });
    }

    const userId = payload.sub;

    // Check that the user still exists and isn't deleted
    const user = await User.findById(userId).lean();
    if (!user || user.isDeleted) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    const hash = await bcrypt.hash(String(password), 12);

    // Update only password fields, skip full validation to avoid roles enum issues
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          passwordHash: hash,
          passwordResetAt: new Date(),
        },
        $unset: {
          password: "",
          hash: "",
        },
      },
      { runValidators: false }
    );

    return res.json({
      ok: true,
      message: 'Password has been reset. You can now sign in with your new password.',
    });
  } catch (err) {
    console.error('[auth/reset-password]', err);
    res.status(500).json({ error: err.message || 'Failed to reset password' });
  }
});

module.exports = router;
