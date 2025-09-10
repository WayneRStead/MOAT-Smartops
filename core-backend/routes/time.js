const express = require('express');
const router = express.Router();

// Example: return the current server time
router.get('/', (req, res) => {
  res.json({ serverTime: new Date().toISOString() });
});

module.exports = router;
