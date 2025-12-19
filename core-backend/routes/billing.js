// core-backend/routes/billing.js
const express = require("express");
const BillingUsage = require("../models/BillingUsage");
const Org = require("../models/Org");
const { requireAuth } = require("../middleware/auth");
const {
  monthKey,
  getEffectivePricing,
  previewCost,
} = require("../utils/billing");

const router = express.Router();

/**
 * GET /api/billing/usage?month=YYYY-MM
 * Returns usage meters for the current org for the requested month (defaults to current).
 */
router.get("/usage", requireAuth, async (req, res, next) => {
  try {
    const month = (req.query.month && String(req.query.month)) || monthKey();

    const orgId = req.user?.orgId;
    if (!orgId) {
      return res.status(400).json({ error: "No org context on token" });
    }

    const usage = await BillingUsage.findOne({ orgId, month }).lean();
    return res.json({
      month,
      meters: usage?.meters || {},
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/billing/preview?month=YYYY-MM
 * Combines usage + effective pricing + plan base & seats to produce a cost preview
 * for the **current org**.
 */
router.get("/preview", requireAuth, async (req, res, next) => {
  try {
    const month = (req.query.month && String(req.query.month)) || monthKey();

    const orgId = req.user?.orgId;
    if (!orgId) {
      return res.status(400).json({ error: "No org context on token" });
    }

    const org = await Org.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: "Org not found" });

    const usageDoc = await BillingUsage.findOne({ orgId, month }).lean();
    const meters = { ...(usageDoc?.meters || {}) };

    // Seats come from the org
    const seats = typeof org.seats === "number" ? org.seats : 0;

    // Pull full effective pricing for this org (including plan base + seat rules)
    const pricing = await getEffectivePricing(org);

    const cost = previewCost({
      meters,
      rates: pricing.rates,
      allowances: pricing.allowances || {},
      taxRate: pricing.taxRate,

      // HYBRID bits:
      basePrice: pricing.basePrice,
      seats,
      includedSeats: pricing.includedSeats,
      extraSeatPrice: pricing.extraSeatPrice,
    });

    return res.json({
      month,
      org: { _id: org._id, name: org.name, seats },
      meters,
      rates: pricing.rates,
      allowances: pricing.allowances || {},
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
