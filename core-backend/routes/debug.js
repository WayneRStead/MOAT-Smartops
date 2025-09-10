const express = require('express');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/whoami', requireAuth, (req, res) => {
  res.json({ user: req.user }); // { sub, role }
});

module.exports = router;
