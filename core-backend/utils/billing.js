// core-backend/utils/billing.js
let BillingConfig = null;
try {
  BillingConfig = require('../models/BillingConfig');
} catch {
  // optional
}

/* ------------------------ Default pricing constants --------------------- */

const DEFAULT_CURRENCY = 'ZAR';
const DEFAULT_TAX_RATE = 0.15; // 15% VAT (South Africa style)

// You can tweak these as you wish; the superadmin UI can override them.
const DEFAULT_RATES = {
  mau_mobile:          0.0,
  events_clockings:    0.05,
  events_inspections:  0.50,
  automation_ocr:      0.30,
  automation_ai:       0.40,
  notifications_sms:   0.40,
  notifications_email: 0.02,
  storage_gb_month:    1.00,
};

const DEFAULT_ALLOWANCES = {
  mau_mobile:          5,
  events_clockings:    1000,
  events_inspections:  50,
  automation_ocr:      0,
  automation_ai:       0,
  notifications_sms:   0,
  notifications_email: 1000,
  storage_gb_month:    1,
};

// Base plans that can have their own pricing tables
const PLAN_CODES = ['starter', 'standard', 'pro', 'enterprise'];

/* ------------------------------- Helpers -------------------------------- */

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function normalizePlanCode(code) {
  const c = String(code || 'standard').toLowerCase().trim();
  if (PLAN_CODES.includes(c)) return c;
  return 'standard';
}

/* ------------------------ Cost preview from meters ---------------------- */
/**
 * previewCost(options)
 *
 * Required:
 *   - meters:      { code: count }
 *   - rates:       { code: unitPrice }
 *   - allowances:  { code: freePerMonth }
 *   - taxRate:     number (e.g. 0.15)
 *
 * Optional (for hybrid plan + usage billing):
 *   - basePrice:       fixed plan price per month
 *   - seats:           organisation seat count (org.seats)
 *   - includedSeats:   seats included in basePrice
 *   - extraSeatPrice:  price per seat above includedSeats
 */
function previewCost({
  meters,
  rates,
  allowances,
  taxRate,
  basePrice,
  seats,
  includedSeats,
  extraSeatPrice,
}) {
  const m = meters || {};
  const r = rates || {};
  const a = allowances || {};

  const lines = [];
  let subtotal = 0;

  /* -------- 1) Plan base price (optional) -------- */
  const base = typeof basePrice === 'number' ? basePrice : null;
  if (base && base > 0) {
    const lineSubtotal = base;
    lines.push({
      code: 'plan_base',
      label: 'Plan base price',
      count: 1,
      free: 0,
      billable: 1,
      unitPrice: base,
      subtotal: lineSubtotal,
    });
    subtotal += lineSubtotal;
  }

  /* -------- 2) Extra seats above includedSeats (optional) -------- */
  const seatCount = typeof seats === 'number' ? seats : null;
  const incSeats = typeof includedSeats === 'number' ? includedSeats : 0;
  const extraSeat = typeof extraSeatPrice === 'number' ? extraSeatPrice : 0;

  if (seatCount != null && extraSeat > 0 && seatCount > incSeats) {
    const extra = seatCount - incSeats;
    const lineSubtotal = extra * extraSeat;
    lines.push({
      code: 'extra_seats',
      label: 'Extra seats',
      count: extra,
      free: incSeats,
      billable: extra,
      unitPrice: extraSeat,
      subtotal: lineSubtotal,
    });
    subtotal += lineSubtotal;
  }

  /* -------- 3) Usage-based lines (existing behaviour) -------- */
  for (const [code, rawCount] of Object.entries(m)) {
    const count = Number(rawCount) || 0;
    if (count <= 0) continue;

    const unit = Number(r[code] ?? 0) || 0;
    const free = Number(a[code] ?? 0) || 0;
    const billable = Math.max(0, count - free);
    const lineSubtotal = billable * unit;

    lines.push({
      code,
      count,
      free,
      billable,
      unitPrice: unit,
      subtotal: lineSubtotal,
    });

    subtotal += lineSubtotal;
  }

  const tr = typeof taxRate === 'number' ? taxRate : DEFAULT_TAX_RATE;
  const tax = subtotal * tr;
  const total = subtotal + tax;

  return { lines, subtotal, taxRate: tr, tax, total };
}

/* ---------------------- Global default billing config ------------------- */
/**
 * Global defaults = code defaults + optional BillingConfig("default")
 */
async function getGlobalBillingDefaults() {
  const base = {
    rates:      { ...DEFAULT_RATES },
    allowances: { ...DEFAULT_ALLOWANCES },
    taxRate:    DEFAULT_TAX_RATE,
    currency:   DEFAULT_CURRENCY,
  };

  if (!BillingConfig) return base;

  const doc = await BillingConfig.findOne({ key: 'default' }).lean();
  if (!doc) return base;

  return {
    rates:      { ...base.rates,      ...(doc.rates || {}) },
    allowances: { ...base.allowances, ...(doc.allowances || {}) },
    taxRate:    typeof doc.taxRate === 'number' ? doc.taxRate : base.taxRate,
    currency:   doc.currency || base.currency,
  };
}

/* ----------------------- Plan-level billing config ---------------------- */
/**
 * Returns raw config document for a plan code, or null.
 * key format: "plan:standard", "plan:starter", ...
 */
async function getPlanConfig(planCode) {
  if (!BillingConfig) return null;
  const key = `plan:${normalizePlanCode(planCode)}`;
  const doc = await BillingConfig.findOne({ key }).lean();
  return doc || null;
}

/**
 * getPlanPricing(planCode)
 *
 * Merges:
 *    global defaults (DEFAULT_* + BillingConfig("default"))
 * →  plan overrides (BillingConfig("plan:<code>"))
 *
 * Returns:
 *   {
 *     planCode,
 *     rates,
 *     allowances,
 *     taxRate,
 *     currency,
 *     basePrice?,       // from plan config
 *     includedSeats?,   // from plan config
 *     extraSeatPrice?,  // from plan config
 *     meta?,            // from plan config
 *   }
 */
async function getPlanPricing(planCodeRaw) {
  const planCode = normalizePlanCode(planCodeRaw);
  const base = await getGlobalBillingDefaults();

  if (!BillingConfig) {
    return { ...base, planCode };
  }

  const doc = await getPlanConfig(planCode);
  if (!doc) {
    return { ...base, planCode };
  }

  return {
    planCode,
    rates:      { ...base.rates,      ...(doc.rates || {}) },
    allowances: { ...base.allowances, ...(doc.allowances || {}) },
    taxRate:    typeof doc.taxRate === 'number' ? doc.taxRate : base.taxRate,
    currency:   doc.currency || base.currency,

    // NEW: plan-level base price + seats rules
    basePrice:      typeof doc.basePrice === 'number' ? doc.basePrice : undefined,
    includedSeats:  typeof doc.includedSeats === 'number' ? doc.includedSeats : undefined,
    extraSeatPrice: typeof doc.extraSeatPrice === 'number' ? doc.extraSeatPrice : undefined,
    meta:           doc.meta || {},
  };
}

/* ------------------------- Effective pricing per org -------------------- */
/**
 * getEffectivePricing(org)
 *
 * Merges:
 *   1) global defaults
 *   2) plan-level overrides (by org.planCode)
 *   3) per-org overrides (org.billingOverrides.* + org.currency)
 *
 * "custom" planCode:
 *   - treated as "standard" for base prices/rates/allowances
 *   - you typically rely on org.billingOverrides for bespoke plans.
 */
async function getEffectivePricing(org) {
  const rawPlanCode = org?.planCode || 'standard';
  const isCustom = String(rawPlanCode).toLowerCase().trim() === 'custom';

  // Base plan to use for pricing tables
  const basePlanCode = isCustom ? 'standard' : rawPlanCode;
  const base = await getPlanPricing(basePlanCode);

  const overrides = org?.billingOverrides || {};

  const effective = {
    planCode: rawPlanCode,
    rates:      { ...base.rates },
    allowances: { ...base.allowances },
    taxRate:    base.taxRate,
    currency:   org?.currency || base.currency,

    // carry through plan-level seat/base information (no per-org override yet)
    basePrice:      base.basePrice,
    includedSeats:  base.includedSeats,
    extraSeatPrice: base.extraSeatPrice,
    meta:           base.meta || {},
  };

  if (overrides.rates && typeof overrides.rates === 'object') {
    effective.rates = { ...effective.rates, ...overrides.rates };
  }
  if (overrides.allowances && typeof overrides.allowances === 'object') {
    effective.allowances = { ...effective.allowances, ...overrides.allowances };
  }
  if (typeof overrides.taxRate === 'number') {
    effective.taxRate = overrides.taxRate;
  }

  // NOTE:
  // For now we do NOT support per-org overrides of basePrice / includedSeats /
  // extraSeatPrice; those are intended to be per-plan. If in future you want
  // bespoke seat pricing per org, we can extend org.billingOverrides to carry
  // those fields and merge them here.

  return effective;
}

/* ----------------------------- Exports ---------------------------------- */

module.exports = {
  monthKey,
  previewCost,
  getGlobalBillingDefaults,
  getPlanConfig,
  getPlanPricing,
  getEffectivePricing,
  DEFAULT_RATES,
  DEFAULT_ALLOWANCES,
  DEFAULT_TAX_RATE,
  DEFAULT_CURRENCY,
  PLAN_CODES,
};
