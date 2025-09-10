// routes/account.js
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const { hash, verify } = require('../utils/passwords');
const router = express.Router();

// PUT /api/account/password  { current, next }
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { current, next } = req.body || {};
    if (!next) return res.status(400).json({ error: 'Missing next password' });
    const user = await User.findOne({ email: req.user.sub }).select('+passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.passwordHash) {
      const ok = await verify(current || '', user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    }
    user.passwordHash = await hash(next);
    await user.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
