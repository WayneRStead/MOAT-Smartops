// core-backend/routes/billing.js
const express = require('express');
const BillingUsage = require('../models/BillingUsage');
const Org = require('../models/Org');
const { requireAuth } = require('../middleware/auth');
const { monthKey, getEffectivePricing, previewCost } = require('../utils/billing');

const router = express.Router();

/**
 * GET /api/billing/usage?month=YYYY-MM
 * Returns usage meters for the (single) org for the requested month (defaults to current month).
 */
router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const month = req.query.month || monthKey();
    const org = await Org.findOne().select('_id').lean();
    if (!org) return res.status(404).json({ error: 'Org not found' });

    const usage = await BillingUsage.findOne({ orgId: org._id, month }).lean();
    return res.json({ month, meters: usage?.meters || {} });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/billing/preview?month=YYYY-MM
 * Combines usage + effective pricing (defaults + per-org overrides) to produce a cost preview.
 */
router.get('/preview', requireAuth, async (req, res, next) => {
  try {
    const month = req.query.month || monthKey();

    const org = await Org.findOne().lean();
    if (!org) return res.status(404).json({ error: 'Org not found' });

    const usage = await BillingUsage.findOne({ orgId: org._id, month }).lean();
    const pricing = await getEffectivePricing(org);

    const cost = previewCost({
      meters: usage?.meters || {},
      rates: pricing.rates,
      allowances: pricing.allowances,
      taxRate: pricing.taxRate,
    });

    return res.json({
      month,
      org: { _id: org._id, name: org.name },
      meters: usage?.meters || {},
      rates: pricing.rates,
      allowances: pricing.allowances,
      taxRate: cost.taxRate,
      lines: cost.lines,
      subtotal: cost.subtotal,
      tax: cost.tax,
      total: cost.total,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
