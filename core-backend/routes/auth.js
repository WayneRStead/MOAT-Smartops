// core-backend/routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');

// ---------- Helpers ----------
const isDev = process.env.NODE_ENV !== 'production';

function normalizeEmail(s) {
  return (s || '').trim().toLowerCase();
}

function isEnvAdminIdentity(login) {
  const authUser = (process.env.AUTH_USER || '').trim();
  const adminEmail = (process.env.ADMIN_EMAIL || process.env.SUPERADMIN_EMAIL || '').trim();

  const input = (login || '').trim();
  return (
    (!!authUser && input.toLowerCase() === authUser.toLowerCase()) ||
    (!!adminEmail && input.toLowerCase() === adminEmail.toLowerCase())
  );
}

async function checkEnvAdminPassword(password) {
  const bcryptHash =
    process.env.AUTH_PASS_BCRYPT ||
    process.env.ADMIN_PASSWORD_BCRYPT ||
    process.env.SUPERADMIN_PASSWORD_BCRYPT;

  const plain =
    process.env.AUTH_PASS ||
    process.env.ADMIN_PASSWORD ||
    process.env.SUPERADMIN_PASSWORD;

  if (bcryptHash) {
    try { return await bcrypt.compare(password || '', bcryptHash); }
    catch { return false; }
  }
  return !!(plain && password === plain);
}

function getEnvAdminProfile() {
  const email =
    process.env.AUTH_USER ||
    process.env.ADMIN_EMAIL ||
    process.env.SUPERADMIN_EMAIL ||
    'admin@smartops';

  const role =
    process.env.AUTH_ROLE ||
    process.env.ADMIN_ROLE ||
    process.env.SUPERADMIN_ROLE ||
    'superadmin';

  const orgId =
    process.env.AUTH_ORG_ID ||
    process.env.ADMIN_ORG_ID ||
    'root';

  return { sub: email, email, role, orgId, name: 'Super Admin' };
}

function signToken(payload) {
  const secret = process.env.JWT_SECRET || 'dev_secret';
  return jwt.sign(payload, secret, { expiresIn: '12h' });
}

// ---------- Routes ----------

// POST /auth/login  (ENV super admin + DB users)
router.post('/auth/login', async (req, res) => {
  try {
    const { email, username, password } = req.body || {};
    const loginId = email || username;

    if (!loginId || !password) {
      return res.status(400).json({ error: 'email/username and password required' });
    }

    // ENV Super Admin
    if (isEnvAdminIdentity(loginId)) {
      const ok = await checkEnvAdminPassword(password);
      if (isDev) console.log('[auth] ENV login attempt:', loginId, 'ok?', ok);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

      const env = getEnvAdminProfile();
      const token = signToken({ sub: env.sub, role: env.role, orgId: env.orgId });
      return res.json({
        token,
        user: { id: env.sub, name: env.name, role: env.role, email: env.email },
      });
    }

    // DB user path
    const query = email
      ? { email: normalizeEmail(email), active: { $ne: false } }
      : { username: (username || '').trim(), active: { $ne: false } };

    const user = await User.findOne(query);
    if (isDev) console.log('[auth] DB login attempt for', loginId, 'found?', !!user);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await user.verifyPassword
      ? await user.verifyPassword(password)
      : await bcrypt.compare(password, user.passwordHash || '');

    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ sub: user._id, orgId: user.orgId, role: user.role });
    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name || user.email || user.username,
        role: user.role,
        email: user.email,
      },
    });
  } catch (e) {
    console.error('POST /auth/login failed:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/admin/reset-password
// Uses the User model's auto-hash by setting `user.password`
router.post('/auth/admin/reset-password', requireAuth, async (req, res) => {
  try {
    const actorRole = req.user.role || '';
    if (!['admin', 'superadmin'].includes(actorRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId, email, username, newPassword } = req.body || {};
    if (!newPassword) {
      return res.status(400).json({ error: 'newPassword required' });
    }

    let user = null;
    if (userId) user = await User.findById(userId);
    else if (email) user = await User.findOne({ email: normalizeEmail(email) });
    else if (username) user = await User.findOne({ username: (username || '').trim() });

    if (!user) return res.status(404).json({ error: 'User not found' });

    user.password = newPassword;   // <- triggers pre-save hashing
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /auth/admin/reset-password failed:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Optional debug
router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
