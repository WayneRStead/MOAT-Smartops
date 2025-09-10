// core-backend/utils/billing.js
const BillingUsage = require('../models/BillingUsage');
const BillingConfig = require('../models/BillingConfig');
const Org = require('../models/Org');

/** 'YYYY-MM' key for a given date (defaults: now) */
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Increment a usage meter for the current org+month.
 * @param {ObjectId} orgId
 * @param {string} code   e.g. 'events_clockings'
 * @param {number} qty    default 1
 * @param {Date}   at     date for month bucketing (default now)
 */
async function increment(orgId, code, qty = 1, at = new Date()) {
  if (!orgId || !code) return;
  const key = monthKey(at);
  await BillingUsage.updateOne(
    { orgId, month: key },
    { $inc: { [`meters.${code}`]: qty } },
    { upsert: true }
  );
}

/** Resolve the singleton Org id (single-tenant for now) */
async function getSingletonOrgId() {
  const org = await Org.findOne().select('_id').lean();
  return org?._id;
}

/**
 * Merge global defaults with per-org overrides to produce effective pricing.
 * @param {Object} org full org document (or null)
 * @returns {{rates:Object, allowances:Object, taxRate:number}}
 */
async function getEffectivePricing(org) {
  const cfg = await BillingConfig.findOne().lean();
  const defaults = cfg || { rates: {}, allowances: {}, taxRate: 0.15 };
  const o = org?.billing || {};
  return {
    rates: { ...(defaults.rates || {}), ...(o.rates || {}) },
    allowances: { ...(defaults.allowances || {}), ...(o.allowances || {}) },
    taxRate: typeof o.taxRate === 'number' ? o.taxRate : (defaults.taxRate || 0)
  };
}

/**
 * Compute a cost preview from meters + pricing (no persistence).
 * @param {Object} input
 * @param {Object} input.meters     usage meters {code:number}
 * @param {Object} input.rates      unit prices  {code:number}
 * @param {Object} input.allowances included qty {code:number}
 * @param {number} input.taxRate    0..1
 * @returns {{lines:Array, subtotal:number, tax:number, total:number, taxRate:number}}
 */
function previewCost({ meters = {}, rates = {}, allowances = {}, taxRate = 0 }) {
  const lines = [];
  let subtotal = 0;

  const codes = new Set([
    ...Object.keys(meters || {}),
    ...Object.keys(rates || {}),
    ...Object.keys(allowances || {}),
  ]);

  for (const code of codes) {
    const used = Number(meters[code] || 0);
    const allow = Number(allowances[code] || 0);
    const unit = Number(rates[code] || 0);
    const over = Math.max(0, used - allow);
    const lineSubtotal = over * unit;

    // Include line if any relevant value exists (useful for transparency)
    if (unit || used || allow) {
      lines.push({ code, used, allow, over, unit, subtotal: +lineSubtotal.toFixed(2) });
    }
    subtotal += lineSubtotal;
  }

  subtotal = +subtotal.toFixed(2);
  const tax = +(subtotal * (taxRate || 0)).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  return { lines, subtotal, tax, total, taxRate };
}

module.exports = {
  // usage + org helpers
  monthKey,
  increment,
  getSingletonOrgId,
  // pricing
  getEffectivePricing,
  previewCost,
};
