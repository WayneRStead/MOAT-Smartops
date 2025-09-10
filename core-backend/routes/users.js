// core-backend/routes/users.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

// List users (optional limit)
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    const users = await User.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(users);
  } catch (e) {
    console.error('GET /users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (accepts plain `password` and auto-hashes via model pre-save)
router.post('/', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const { name, email, username, role = 'worker', password, active } = req.body || {};

    if (!email && !username) return res.status(400).json({ error: 'email or username required' });
    const user = new User({
      name,
      email: email ? String(email).trim().toLowerCase() : undefined,
      username: username ? String(username).trim() : undefined,
      role,
      active: active !== undefined ? !!active : true, // default active
    });
    if (password) user.password = password; // <-- triggers pre-save hashing
    await user.save();

    res.status(201).json({
      _id: user._id, name: user.name, email: user.email, username: user.username,
      role: user.role, active: user.active, createdAt: user.createdAt
    });
  } catch (e) {
    console.error('POST /users error:', e);
    if (e.code === 11000) return res.status(400).json({ error: 'Email/username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (also accepts plain `password`)
router.put('/:id', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const { name, email, username, role, active, password } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = String(email).trim().toLowerCase();
    if (username !== undefined) user.username = String(username).trim();
    if (role !== undefined) user.role = role;
    if (active !== undefined) user.active = !!active;

    if (password) user.password = password; // <-- triggers pre-save hashing

    await user.save();
    res.json({
      _id: user._id, name: user.name, email: user.email, username: user.username,
      role: user.role, active: user.active, updatedAt: user.updatedAt
    });
  } catch (e) {
    console.error('PUT /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user
router.delete('/:id', requireAuth, requireRole('admin','superadmin'), async (req, res) => {
  try {
    const u = await User.findByIdAndDelete(req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
