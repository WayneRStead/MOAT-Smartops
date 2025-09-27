// core-backend/routes/users.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

/* ----------------------------- helpers ----------------------------- */
function asOid(x) {
  const s = String(x || '');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}
function wantsObjectId(model, pathName) {
  const p = model?.schema?.path(pathName);
  return p && p.instance === 'ObjectId';
}
function orgFilterFromReq(model, req) {
  if (!model?.schema?.path('orgId')) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  if (wantsObjectId(model, 'orgId')) {
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  return { orgId: s }; // String schema
}
function ensureOrgOnDoc(model, doc, req) {
  // If schema has orgId and it's empty on the doc, try to set it from token
  const p = model?.schema?.path('orgId');
  if (!p) return true; // model not org-scoped
  const has = doc.orgId != null && String(doc.orgId) !== '';
  if (has) return true;

  const raw = req.user?.orgId;
  if (!raw) return false;

  const s = String(raw);
  if (p.instance === 'ObjectId') {
    if (!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId = new mongoose.Types.ObjectId(s);
    return true;
  } else {
    doc.orgId = s;
    return true;
  }
}
function stripSecrets(u) {
  if (!u) return u;
  const { password, passwordHash, ...rest } = u;
  return rest;
}

/* ------------------------------- LIST ------------------------------- */
// Admins see all users in org; non-admins see only themselves
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    const q = (req.query.q || '').trim();

    const role = String(req.user?.role || '').toLowerCase();
    const isAdmin = role === 'admin' || role === 'superadmin';
    const scope = orgFilterFromReq(User, req);

    let find = { ...scope, isDeleted: { $ne: true } };

    if (!isAdmin) {
      const myId = asOid(req.user?._id) || req.user?._id;
      if (!myId) return res.status(401).json({ error: 'Unauthorized' });
      find._id = myId;
    }

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      find.$or = [{ name: rx }, { email: rx }, { username: rx }, { role: rx }];
    }

    const rows = await User.find(find).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows.map(stripSecrets));
  } catch (e) {
    console.error('GET /users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------------- READ ------------------------------- */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = asOid(req.params.id) || req.params.id;
    const doc = await User.findOne({ _id: id, ...orgFilterFromReq(User, req) }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(stripSecrets(doc));
  } catch (e) {
    console.error('GET /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- CREATE ------------------------------ */
// Admin/superadmin only; accepts plain `password` (relies on pre-save hashing)
router.post('/', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const { name, email, username, role = 'worker', password, active } = req.body || {};
    if (!email && !username) return res.status(400).json({ error: 'email or username required' });

    const doc = new User({
      name: name || '',
      email: email ? String(email).trim().toLowerCase() : undefined,
      username: username ? String(username).trim() : undefined,
      role,
      active: active !== undefined ? !!active : true
    });

    // Ensure orgId present per schema
    if (!ensureOrgOnDoc(User, doc, req)) {
      return res.status(400).json({ error: 'orgId is required on User; missing/invalid in token' });
    }

    if (password) doc.password = password; // pre-save should hash it

    await doc.save();
    res.status(201).json(stripSecrets(doc.toObject({ versionKey: false })));
  } catch (e) {
    console.error('POST /users error:', e);
    if (e.code === 11000) return res.status(400).json({ error: 'Email/username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- UPDATE ------------------------------ */
// Admin/superadmin only; also ensures orgId exists if schema requires it
router.put('/:id', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id) || req.params.id;
    const where = { _id: id, ...orgFilterFromReq(User, req) };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const { name, email, username, role, active, password } = req.body || {};

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = String(email).trim().toLowerCase();
    if (username !== undefined) user.username = String(username).trim();
    if (role !== undefined) user.role = role;
    if (active !== undefined) user.active = !!active;
    if (password) user.password = password; // pre-save should hash

    // If orgId is required by schema and absent on this legacy doc, set it now
    if (!ensureOrgOnDoc(User, user, req)) {
      return res.status(400).json({ error: 'orgId is required on User; missing/invalid in token' });
    }

    await user.save();
    res.json(stripSecrets(user.toObject({ versionKey: false })));
  } catch (e) {
    console.error('PUT /users/:id error:', e);
    if (e.code === 11000) return res.status(400).json({ error: 'Email/username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* --------------------------- RESET PASSWORD --------------------------- */
router.post('/:id/reset-password', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id) || req.params.id;
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'password required (min 6 chars)' });
    }

    const where = { _id: id, ...orgFilterFromReq(User, req) };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    // Ensure orgId exists on legacy docs too
    if (!ensureOrgOnDoc(User, user, req)) {
      return res.status(400).json({ error: 'orgId is required on User; missing/invalid in token' });
    }

    user.password = String(password); // rely on pre-save hashing
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /users/:id/reset-password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------------- DELETE ------------------------------ */
router.delete('/:id', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id) || req.params.id;
    const where = { _id: id, ...orgFilterFromReq(User, req) };
    const u = await User.findOne(where);
    if (!u) return res.status(404).json({ error: 'Not found' });

    await User.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
