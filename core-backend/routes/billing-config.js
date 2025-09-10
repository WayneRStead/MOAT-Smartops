const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const BillingConfig = require('../models/BillingConfig');
const router = express.Router();

// GET global config (superadmin)
router.get('/', requireAuth, requireRole('superadmin'), async (req, res, next) => {
  try {
    const cfg = await BillingConfig.findOne().lean();
    res.json(cfg || {});
  } catch (e) { next(e); }
});

// PUT global config (superadmin)
router.put('/', requireAuth, requireRole('superadmin'), async (req, res, next) => {
  try {
    const doc = await BillingConfig.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    res.json(doc);
  } catch (e) { next(e); }
});

module.exports = router;
