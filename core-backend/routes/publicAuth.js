// core-backend/routes/publicAuth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const router = express.Router();

// Collections (work even if your Mongoose models differ)
function col(name) {
  return mongoose.connection.collection(name);
}

// Helpers
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 60);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

/**
 * POST /public/signup
 * Body: { orgName, name, email, password }
 * Creates Organization + User + UserOrg and returns { token, orgId, user, org }
 */
router.post('/signup', async (req, res) => {
  try {
    const { orgName, name, email, password } = req.body || {};
    if (!orgName || !name || !email || !password) {
      return res.status(400).json({ error: 'orgName, name, email, password are required' });
    }

    const JWT_SECRET = requireEnv('JWT_SECRET');

    const users = col('users');
    const orgs = col('organizations');
    const userorgs = col('userorgs');

    const now = new Date();
    const emailNorm = String(email).toLowerCase().trim();

    // Check if email already exists (in any org)
    const existingUser = await users.findOne({ email: emailNorm });
    if (existingUser) {
      // You can relax this if you want duplicate emails across orgs.
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    // Create org first
    const slug = slugify(orgName);
    const orgDoc = {
      name: orgName,
      slug,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      settings: {},
    };
    const orgIns = await orgs.insertOne(orgDoc);
    const orgId = orgIns.insertedId;
    orgDoc._id = orgId;

    // Create user (owner/admin)
    const passwordHash = await bcrypt.hash(String(password), 10);
    const userDoc = {
      name,
      email: emailNorm,
      passwordHash,
      role: 'admin',         // primary role
      roles: ['admin','user'],
      isActive: true,
      orgId,                 // convenience for your existing code paths
      createdAt: now,
      updatedAt: now,
    };
    const userIns = await users.insertOne(userDoc);
    const userId = userIns.insertedId;
    userDoc._id = userId;

    // Link user to org
    const uoDoc = {
      userId,
      orgId,
      roles: ['owner','admin','user'],
      invitedBy: null,
      invitedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await userorgs.insertOne(uoDoc);

    // Backfill org.ownerUserId
    await orgs.updateOne({ _id: orgId }, { $set: { ownerUserId: userId } });

    // Sign JWT carrying orgId
    const token = jwt.sign(
      {
        sub: String(userId),
        email: emailNorm,
        name,
        role: 'admin',
        roles: ['admin','user'],
        orgId: String(orgId),
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      ok: true,
      token,
      orgId: String(orgId),
      user: {
        _id: String(userId),
        name,
        email: emailNorm,
        role: 'admin',
        roles: ['admin','user'],
      },
      org: {
        _id: String(orgId),
        name: orgName,
        slug,
        status: 'active',
      },
    });
  } catch (err) {
    console.error('[public/signup] error:', err);
    const msg = err?.message || 'Signup failed';
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /public/login
 * Body: { email, password }
 * Returns { token, orgId, user }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const JWT_SECRET = requireEnv('JWT_SECRET');

    const users = col('users');

    const emailNorm = String(email).toLowerCase().trim();
    const user = await users.findOne({ email: emailNorm });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!user.passwordHash) return res.status(401).json({ error: 'Password login not available for this user' });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Determine orgId. Prefer user.orgId, else pick first membership
    let orgId = user.orgId;
    if (!orgId) {
      const userorgs = col('userorgs');
      const link = await userorgs.findOne({ userId: user._id });
      orgId = link?.orgId;
    }
    if (!orgId) {
      return res.status(400).json({ error: 'User has no organization linked' });
    }

    const token = jwt.sign(
      {
        sub: String(user._id),
        email: user.email,
        name: user.name,
        role: user.role || 'user',
        roles: Array.isArray(user.roles) ? user.roles : [user.role || 'user'],
        orgId: String(orgId),
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      ok: true,
      token,
      orgId: String(orgId),
      user: {
        _id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        roles: Array.isArray(user.roles) ? user.roles : [user.role || 'user'],
      },
    });
  } catch (err) {
    console.error('[public/login] error:', err);
    const msg = err?.message || 'Login failed';
    res.status(500).json({ error: msg });
  }
});

// Optional stubs to avoid 404 noise while we build the flows
router.post('/magic-link', (_req, res) => res.status(501).json({ error: 'Not implemented yet' }));
router.post('/verify-email', (_req, res) => res.status(204).json({ ok: true }));

module.exports = router;
