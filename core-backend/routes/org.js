// core-backend/routes/org.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require('../middleware/auth');
const Org = require('../models/Org');

function safeRequire(p) {
  try {
    return require(p);
  } catch {
    return null;
  }
}

// Optional billing pieces – if not present, billing routes will return 500
const BillingUsage = safeRequire('../models/BillingUsage');
const BillingConfig = safeRequire('../models/BillingConfig');
const billingUtils = safeRequire('../utils/billing') || {};
const {
  getEffectivePricing,
  getPlanPricing,
  PLAN_CODES = [],
  monthKey,
  previewCost,
  DEFAULT_CURRENCY,
} = billingUtils;

// Trial configuration
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

const router = express.Router();

/**
 * Tenant-aware org routes
 * - All handlers run through: requireAuth → resolveOrgContext → requireOrg
 * - We always load/save the Org document for req.orgId (header: x-org-id)
 */
router.use(requireAuth, resolveOrgContext, requireOrg);

/* ------------------------------ uploads ------------------------------ */
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const ORG_DIR = path.join(UPLOADS_ROOT, 'org');
fs.mkdirSync(ORG_DIR, { recursive: true });

function cleanFilename(name) {
  return String(name || '').replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ORG_DIR),
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}_${cleanFilename(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});
const uploadEither = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'logo', maxCount: 1 },
]);

/* ------------------------------ helpers ------------------------------ */
function addDays(date, days) {
  const ms = Number(days) * 24 * 60 * 60 * 1000;
  return new Date(date.getTime() + ms);
}

async function getOrCreateOrgFor(orgId) {
  // Use the tenant id as the Org _id for simple, reliable lookups.
  let org = await Org.findById(orgId);
  if (!org) {
    const now = new Date();
    const trialEndsAt = addDays(now, TRIAL_DAYS);

    org = new Org({
      _id: orgId,
      // sensible defaults
      themeMode: 'system',
      accentColor: process.env.ORG_THEME_COLOR || '#2E86DE',
      // trial defaults
      status: 'trialing',
      plan: 'Trial',
      planCode: 'trial',
      trialEndsAt,
    });

    // keep legacy theme in sync if your schema has it
    org.theme = org.theme || {};
    org.theme.mode = org.themeMode;
    org.theme.color = org.accentColor;

    await org.save();
  }
  return org;
}

// Normalize shape returned to clients (with legacy fallbacks)
function presentOrg(org) {
  const o = org?.toObject ? org.toObject() : org;
  const themeMode = o.themeMode || o?.theme?.mode || 'system';
  const accentColor =
    o.accentColor ||
    o?.theme?.color ||
    process.env.ORG_THEME_COLOR ||
    '#2E86DE';
  return { ...o, themeMode, accentColor };
}

// Helper: compute trial metadata
function computeTrialMeta(org) {
  const isTrial =
    org &&
    org.status === 'trialing' &&
    String(org.planCode || '').toLowerCase() === 'trial';

  let trialEndsAt = org?.trialEndsAt || null;
  let trialDaysRemaining = null;

  if (isTrial && trialEndsAt instanceof Date && !Number.isNaN(trialEndsAt)) {
    const now = Date.now();
    const diffMs = trialEndsAt.getTime() - now;
    trialDaysRemaining = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  }

  return { isTrial, trialEndsAt, trialDaysRemaining };
}

/* -------------------------------- GET -------------------------------- */
const GET_PATHS = ['/', '/org', '/organization', '/orgs/me'];
router.get(GET_PATHS, async (req, res, next) => {
  try {
    const org = await getOrCreateOrgFor(req.orgId);
    res.json(presentOrg(org));
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- PUT -------------------------------- */
const PUT_PATHS = ['/', '/org'];
router.put(PUT_PATHS, async (req, res, next) => {
  try {
    const {
      name,
      themeMode,
      accentColor,
      modules,
      dashboardWidgets,
      settings,
      logoUrl,
    } = req.body || {};
    const org = await getOrCreateOrgFor(req.orgId);

    // Basic fields
    if (typeof name === 'string') {
      const n = name.trim();
      if (n) org.name = n; // only set if non-empty
      // else ignore empty strings
    }

    if (themeMode) org.themeMode = themeMode;
    if (accentColor) org.accentColor = accentColor;
    if (logoUrl) org.logoUrl = logoUrl;

    // keep legacy theme in sync (if present on schema)
    org.theme = org.theme || {};
    if (org.themeMode) org.theme.mode = org.themeMode;
    if (org.accentColor) org.theme.color = org.accentColor;

    // Modules: accept array OR object; normalize to full object based on schema keys
    if (modules != null) {
      const schema = Org?.schema?.path?.('modules');
      if (schema && schema.schema && schema.schema.paths) {
        const keys = Object.keys(schema.schema.paths);
        const nextObj = {};
        if (Array.isArray(modules)) {
          const set = new Set(modules.map(String));
          keys.forEach((k) => {
            nextObj[k] = set.has(k);
          });
        } else if (typeof modules === 'object') {
          keys.forEach((k) => {
            nextObj[k] = !!modules[k];
          });
        }
        if (Object.keys(nextObj).length) org.modules = nextObj;
      }
    }

    // Dashboard widgets: store array of ids
    if (Array.isArray(dashboardWidgets)) {
      org.dashboardWidgets = dashboardWidgets.map(String);
    }

    // Arbitrary settings blob (merged)
    if (settings && typeof settings === 'object') {
      org.settings = { ...(org.settings || {}), ...settings };
    }

    await org.save();
    res.json(presentOrg(org));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- /logo -------------------------------- */
const LOGO_PATHS = ['/logo', '/org/logo'];
router.post(LOGO_PATHS, (req, res, next) => {
  uploadEither(req, res, async (err) => {
    if (err) return next(err);
    try {
      const file =
        (req.files?.file && req.files.file[0]) ||
        (req.files?.logo && req.files.logo[0]);
      if (!file) return res.status(400).json({ error: 'file required' });

      const org = await getOrCreateOrgFor(req.orgId);
      const relUrl = `/files/org/${path.basename(file.path)}`;
      org.logoUrl = relUrl;

      // keep theme in sync if needed
      org.theme = org.theme || {};
      if (org.accentColor && !org.theme.color) org.theme.color = org.accentColor;
      if (org.themeMode && !org.theme.mode) org.theme.mode = org.themeMode;

      await org.save();
      res.json(presentOrg(org));
    } catch (e) {
      next(e);
    }
  });
});

/* -------------------------- ORG BILLING API --------------------------- */
/**
 * GET /org/billing
 * Return current org billing view (plan, seats, effective pricing, trial meta).
 */
router.get('/billing', async (req, res) => {
  try {
    if (!getEffectivePricing) {
      return res
        .status(500)
        .json({ error: 'Billing utilities not configured on server' });
    }

    const org = await getOrCreateOrgFor(req.orgId);
    const effective = await getEffectivePricing(org);
    const currency =
      effective.currency || org.currency || DEFAULT_CURRENCY || 'ZAR';

    const seatCount =
      typeof org.seats === 'number' && org.seats >= 0 ? org.seats : 0;

    const trialMeta = computeTrialMeta(org);

    const out = {
      orgId: org._id,
      name: org.name,
      status: org.status || 'trialing',
      plan: org.plan || null,
      planCode: org.planCode || 'trial',
      seats: seatCount,
      currency,
      pricing: {
        basePrice:
          typeof effective.basePrice === 'number' ? effective.basePrice : null,
        includedSeats:
          typeof effective.includedSeats === 'number'
            ? effective.includedSeats
            : null,
        extraSeatPrice:
          typeof effective.extraSeatPrice === 'number'
            ? effective.extraSeatPrice
            : null,
        taxRate:
          typeof effective.taxRate === 'number' ? effective.taxRate : 0,
        currency,
      },
      trialEndsAt: trialMeta.trialEndsAt || null,
      trialDaysRemaining: trialMeta.trialDaysRemaining,
      isTrial: trialMeta.isTrial,
    };

    res.json(out);
  } catch (e) {
    console.error('[org] GET /billing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /org/billing
 * body: { planCode?, seats? }
 * - org admin can change plan
 * - org admin can increase seats, but not reduce below current value
 * - switching from trial → non-trial auto-activates and clears trialEndsAt
 */
router.put('/billing', async (req, res) => {
  try {
    if (!getEffectivePricing) {
      return res
        .status(500)
        .json({ error: 'Billing utilities not configured on server' });
    }

    const { planCode, seats } = req.body || {};
    const org = await getOrCreateOrgFor(req.orgId);

    let planCodeNormalized = null;
    if (typeof planCode === 'string' && planCode.trim()) {
      planCodeNormalized = planCode.trim().toLowerCase();
      org.planCode = planCodeNormalized;

      // Keep a human label if none is set
      if (!org.plan) {
        org.plan = org.planCode;
      }

      // Trial → non-trial = activate and clear trial end
      if (planCodeNormalized !== 'trial') {
        if (org.status === 'trialing' || org.status === 'suspended') {
          org.status = 'active';
        }
        org.trialEndsAt = null;
      } else {
        // Explicitly setting trial plan:
        org.status = 'trialing';
        if (!org.trialEndsAt) {
          org.trialEndsAt = addDays(new Date(), TRIAL_DAYS);
        }
      }
    }

    if (seats != null) {
      const num = Number(seats);
      const current =
        typeof org.seats === 'number' && org.seats >= 0 ? org.seats : 0;
      if (!Number.isFinite(num) || num < 0) {
        return res
          .status(400)
          .json({ error: 'Seats must be a non-negative number' });
      }
      if (num < current) {
        return res.status(400).json({
          error:
            'You cannot reduce seats via self-service. Please contact support.',
        });
      }
      org.seats = num;
    }

    await org.save();

    const effective = await getEffectivePricing(org);
    const currency =
      effective.currency || org.currency || DEFAULT_CURRENCY || 'ZAR';

    const seatCount =
      typeof org.seats === 'number' && org.seats >= 0 ? org.seats : 0;

    const trialMeta = computeTrialMeta(org);

    res.json({
      orgId: org._id,
      name: org.name,
      status: org.status || 'trialing',
      plan: org.plan || null,
      planCode: org.planCode || 'trial',
      seats: seatCount,
      currency,
      pricing: {
        basePrice:
          typeof effective.basePrice === 'number' ? effective.basePrice : null,
        includedSeats:
          typeof effective.includedSeats === 'number'
            ? effective.includedSeats
            : null,
        extraSeatPrice:
          typeof effective.extraSeatPrice === 'number'
            ? effective.extraSeatPrice
            : null,
        taxRate:
          typeof effective.taxRate === 'number' ? effective.taxRate : 0,
        currency,
      },
      trialEndsAt: trialMeta.trialEndsAt || null,
      trialDaysRemaining: trialMeta.trialDaysRemaining,
      isTrial: trialMeta.isTrial,
    });
  } catch (e) {
    console.error('[org] PUT /billing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /org/billing/plans
 * Returns high-level info about each available plan so org admins can compare.
 */
router.get('/billing/plans', async (_req, res) => {
  try {
    if (!getPlanPricing || !PLAN_CODES || !PLAN_CODES.length) {
      return res
        .status(500)
        .json({ error: 'Billing plans are not configured on server' });
    }

    const out = [];
    for (const code of PLAN_CODES) {
      // getPlanPricing returns merged defaults+plan overrides
      // (similar to the superadmin preview)
      // eslint-disable-next-line no-await-in-loop
      const effective = (await getPlanPricing(code)) || {};

      const currency =
        effective.currency || DEFAULT_CURRENCY || 'ZAR';

      const label =
        effective.label ||
        String(code)
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (ch) => ch.toUpperCase());

      out.push({
        planCode: code,
        label,
        currency,
        basePrice:
          typeof effective.basePrice === 'number'
            ? effective.basePrice
            : null,
        includedSeats:
          typeof effective.includedSeats === 'number'
            ? effective.includedSeats
            : null,
        extraSeatPrice:
          typeof effective.extraSeatPrice === 'number'
            ? effective.extraSeatPrice
            : null,
        taxRate:
          typeof effective.taxRate === 'number' ? effective.taxRate : 0,
      });
    }

    res.json(out);
  } catch (e) {
    console.error('[org] GET /billing/plans error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /org/billing/preview
 * Query: ?month=YYYY-MM (optional, defaults to current month)
 *
 * Returns a FLAT preview object:
 * {
 *   month, planCode, seats, currency,
 *   basePrice, includedSeats, extraSeatPrice, taxRate,
 *   subtotal, tax, total, lines: [...],
 *   trialEndsAt, trialDaysRemaining, isTrial
 * }
 * matching what OrgBilling.jsx expects (plus extra trial info).
 */
router.get('/billing/preview', async (req, res) => {
  try {
    if (!getEffectivePricing || !previewCost) {
      return res
        .status(500)
        .json({ error: 'Billing utilities not configured on server' });
    }
    if (!BillingUsage) {
      return res
        .status(500)
        .json({ error: 'BillingUsage model not available on server' });
    }

    let { month } = req.query || {};
    month = String(month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      month = monthKey ? monthKey() : monthKeyFallback();
    }

    const org = await getOrCreateOrgFor(req.orgId);

    const usageDoc = await BillingUsage.findOne({
      orgId: org._id,
      month,
    }).lean();

    const meters = usageDoc?.meters || {};
    const effective = await getEffectivePricing(org);
    const currency =
      effective.currency || org.currency || DEFAULT_CURRENCY || 'ZAR';

    const seatCount =
      typeof org.seats === 'number' && org.seats >= 0 ? org.seats : 0;

    const preview = previewCost({
      meters,
      rates: effective.rates || {},
      allowances: effective.allowances || {},
      taxRate:
        typeof effective.taxRate === 'number' ? effective.taxRate : 0,
      basePrice:
        typeof effective.basePrice === 'number' ? effective.basePrice : 0,
      seats: seatCount,
      includedSeats:
        typeof effective.includedSeats === 'number'
          ? effective.includedSeats
          : 0,
      extraSeatPrice:
        typeof effective.extraSeatPrice === 'number'
          ? effective.extraSeatPrice
          : 0,
    });

    const trialMeta = computeTrialMeta(org);

    res.json({
      orgId: org._id,
      name: org.name,
      status: org.status || 'trialing',
      plan: org.plan || null,
      planCode: org.planCode || 'trial',
      seats: seatCount,
      currency,
      month,
      basePrice:
        typeof effective.basePrice === 'number'
          ? effective.basePrice
          : null,
      includedSeats:
        typeof effective.includedSeats === 'number'
          ? effective.includedSeats
          : null,
      extraSeatPrice:
        typeof effective.extraSeatPrice === 'number'
          ? effective.extraSeatPrice
          : null,
      taxRate:
        typeof preview.taxRate === 'number'
          ? preview.taxRate
          : typeof effective.taxRate === 'number'
          ? effective.taxRate
          : 0,
      subtotal:
        typeof preview.subtotal === 'number' ? preview.subtotal : 0,
      tax: typeof preview.tax === 'number' ? preview.tax : 0,
      total: typeof preview.total === 'number' ? preview.total : 0,
      lines: Array.isArray(preview.lines) ? preview.lines : [],
      trialEndsAt: trialMeta.trialEndsAt || null,
      trialDaysRemaining: trialMeta.trialDaysRemaining,
      isTrial: trialMeta.isTrial,
    });
  } catch (e) {
    console.error('[org] GET /billing/preview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fallback monthKey if utils/billing didn't export it
function monthKeyFallback(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

module.exports = router;
