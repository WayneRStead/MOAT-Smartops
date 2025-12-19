// core-backend/routes/admin.super.js
const express = require('express');
const { requireAuth, requireGlobal } = require('../middleware/auth');

function safeRequire(p) {
  try {
    return require(p);
  } catch {
    return null;
  }
}

const Org           = safeRequire('../models/Org');
const User          = safeRequire('../models/User');
const UsageEvent    = safeRequire('../models/UsageEvent');   // optional
const BillingConfig = safeRequire('../models/BillingConfig');
const BillingUsage  = safeRequire('../models/BillingUsage'); // optional, used for previews

const {
  DEFAULT_RATES,
  DEFAULT_ALLOWANCES,
  DEFAULT_TAX_RATE,
  DEFAULT_CURRENCY,
  getGlobalBillingDefaults,
  PLAN_CODES,
  getPlanPricing,
  getEffectivePricing,  // for per-org effective pricing
  monthKey,             // to derive YYYY-MM from current date
  previewCost,          // to build billing preview lines + totals
} = require('../utils/billing');

const router = express.Router();

// Global cockpit: must have globalRole === 'superadmin'
router.use(requireAuth, requireGlobal('superadmin')); // NOTE: no resolveOrgContext, no requireOrg

/* ----------------------------- Overview ----------------------------- */
router.get('/overview', async (_req, res) => {
  try {
    if (!Org) return res.status(500).json({ error: 'Org model not available' });

    const [totalOrgs, activeOrgs] = await Promise.all([
      Org.countDocuments({}),
      Org.countDocuments({ status: { $in: ['active', 'trialing'] } }),
    ]);

    res.json({ totalOrgs, activeOrgs });
  } catch (e) {
    console.error('[admin.super] GET /overview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ----------------------------- Orgs list ---------------------------- */
/**
 * GET /admin/super/orgs
 * List all orgs with key metadata + basic billing summary.
 * If ownerEmail is missing, we *try* to infer it from an admin/superadmin user.
 * Money-ish fields:
 *  - mrr (from Org or fallback to latest BillingUsage.totals.total)
 *  - lastInvoiceAt (from Org or fallback to BillingUsage.createdAt)
 *  - lastBillMonth / lastBillTotal (from latest BillingUsage)
 */
router.get('/orgs', async (_req, res) => {
  try {
    if (!Org) return res.status(500).json({ error: 'Org model not available' });

    // Base org rows (now including mrr + lastInvoiceAt if present on schema)
    const orgs = await Org.find({})
      .select(
        'name status ownerEmail createdAt plan planCode seats lastActiveAt currency mrr lastInvoiceAt'
      )
      .sort({ createdAt: -1 })
      .lean();

    // If we have User model, attempt to infer an owner email per org
    if (User && orgs.length) {
      const orgIds = orgs.map((o) => o._id);
      const users = await User.find({
        orgId: { $in: orgIds },
        role: { $in: ['admin', 'superadmin'] },
      })
        .select('orgId email')
        .lean();

      const adminByOrg = {};
      for (const u of users) {
        const key = String(u.orgId);
        // First admin/superadmin we see becomes the "owner" candidate
        if (!adminByOrg[key]) adminByOrg[key] = u;
      }

      for (const o of orgs) {
        if (!o.ownerEmail) {
          const candidate = adminByOrg[String(o._id)];
          if (candidate?.email) {
            o.ownerEmail = candidate.email;
          }
        }
      }
    }

    // Attach last billing totals (and fallback MRR / lastInvoiceAt) from BillingUsage (if model is available)
    if (BillingUsage && orgs.length) {
      const orgIds = orgs.map((o) => o._id);

      // Get latest usage per org (by month & createdAt)
      const usageRows = await BillingUsage.find({
        orgId: { $in: orgIds },
      })
        .select('orgId month totals createdAt')
        .sort({ month: -1, createdAt: -1 })
        .lean();

      const latestByOrg = {};
      for (const row of usageRows) {
        const key = String(row.orgId);
        if (!latestByOrg[key]) {
          latestByOrg[key] = row; // first one hit per org is the newest due to sort
        }
      }

      for (const o of orgs) {
        const key = String(o._id);
        const u = latestByOrg[key];
        if (u) {
          o.lastBillMonth = u.month;
          const total =
            u.totals && typeof u.totals.total === 'number'
              ? u.totals.total
              : 0;
          o.lastBillTotal = total;

          // If Org doesn't have its own mrr set, fall back to total
          if (o.mrr == null) {
            o.mrr = total;
          }

          // If Org doesn't have lastInvoiceAt, fall back to usage createdAt
          if (!o.lastInvoiceAt && u.createdAt) {
            o.lastInvoiceAt = u.createdAt;
          }
        }
      }
    }

    res.json(orgs);
  } catch (e) {
    console.error('[admin.super] GET /orgs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ----------------------------- Users list --------------------------- */
router.get('/users', async (_req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'User model not available' });

    const rows = await User.find({})
      .select('name email orgId globalRole isGlobalSuperadmin role active createdAt')
      .lean();

    res.json(rows);
  } catch (e) {
    console.error('[admin.super] GET /users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------ Promote / demote global superadmin --------------- */
router.post('/users/:id/global-super', async (req, res) => {
  try {
    if (!User) return res.status(500).json({ error: 'User model not available' });

    const ROOT_GLOBAL_EMAIL = (process.env.SUPERADMIN_EMAIL || '')
      .toLowerCase()
      .trim();

    const { id } = req.params;
    const { on } = req.body || {};

    const u = await User.findById(id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const email = (u.email || '').toLowerCase().trim();
    if (!on && ROOT_GLOBAL_EMAIL && email === ROOT_GLOBAL_EMAIL) {
      return res
        .status(400)
        .json({ error: 'Root global admin cannot be removed via UI' });
    }

    u.globalRole = on ? 'superadmin' : null;
    u.isGlobalSuperadmin = !!on;
    await u.save();

    res.json({
      ok: true,
      globalRole: u.globalRole,
      isGlobalSuperadmin: u.isGlobalSuperadmin,
    });
  } catch (e) {
    console.error('[admin.super] POST /users/:id/global-super error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------- Global billing defaults (singleton) ------------- */
/**
 * GET /admin/super/billing-defaults
 * Returns merged view of:
 *  - code defaults (DEFAULT_RATES/ALLOWANCES)
 *  - DB overrides (BillingConfig key="default")
 */
router.get('/billing-defaults', async (_req, res) => {
  try {
    const merged = await getGlobalBillingDefaults();
    res.json(merged);
  } catch (e) {
    console.error('[admin.super] GET /billing-defaults error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /admin/super/billing-defaults
 * body: { rates?, allowances?, taxRate?, currency? }
 */
router.put('/billing-defaults', async (req, res) => {
  try {
    if (!BillingConfig) {
      return res
        .status(500)
        .json({ error: 'BillingConfig model not available' });
    }
    const { rates, allowances, taxRate, currency } = req.body || {};

    const update = {};
    if (rates && typeof rates === 'object') update.rates = rates;
    if (allowances && typeof allowances === 'object')
      update.allowances = allowances;
    if (typeof taxRate === 'number') update.taxRate = taxRate;
    if (currency && typeof currency === 'string') update.currency = currency;

    const doc = await BillingConfig.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

    const merged = {
      rates: { ...DEFAULT_RATES, ...(doc.rates || {}) },
      allowances: { ...DEFAULT_ALLOWANCES, ...(doc.allowances || {}) },
      taxRate:
        typeof doc.taxRate === 'number' ? doc.taxRate : DEFAULT_TAX_RATE,
      currency: doc.currency || DEFAULT_CURRENCY,
    };

    res.json(merged);
  } catch (e) {
    console.error('[admin.super] PUT /billing-defaults error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------- Per-org billing config --------------------- */
/**
 * GET /admin/super/orgs/:id/billing
 * Returns plan/seats/status + current overrides.
 */
router.get('/orgs/:id/billing', async (req, res) => {
  try {
    if (!Org) return res.status(500).json({ error: 'Org model not available' });

    const { id } = req.params;
    const org = await Org.findById(id).lean();
    if (!org) return res.status(404).json({ error: 'Org not found' });

    res.json({
      orgId: org._id,
      name: org.name,
      status: org.status,
      plan: org.plan,
      planCode: org.planCode,
      seats: org.seats,
      currency: org.currency,
      billingOverrides: org.billingOverrides || {},
    });
  } catch (e) {
    console.error('[admin.super] GET /orgs/:id/billing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /admin/super/orgs/:id/billing
 * body: {
 *   status?,
 *   plan?, planCode?,
 *   seats?, currency?,
 *   billingOverrides?: { rates?, allowances?, taxRate? }
 * }
 */
router.put('/orgs/:id/billing', async (req, res) => {
  try {
    if (!Org) return res.status(500).json({ error: 'Org model not available' });

    const { id } = req.params;
    const { status, plan, planCode, seats, currency, billingOverrides } =
      req.body || {};

    const org = await Org.findById(id);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    if (status && ['trialing', 'active', 'suspended', 'cancelled'].includes(status)) {
      org.status = status;
    }
    if (typeof plan === 'string') org.plan = plan;
    if (typeof planCode === 'string') org.planCode = planCode;
    if (typeof seats === 'number' && seats >= 0) org.seats = seats;
    if (typeof currency === 'string') org.currency = currency;

    if (billingOverrides && typeof billingOverrides === 'object') {
      org.billingOverrides = org.billingOverrides || {};
      if (billingOverrides.rates && typeof billingOverrides.rates === 'object') {
        org.billingOverrides.rates = billingOverrides.rates;
      }
      if (
        billingOverrides.allowances &&
        typeof billingOverrides.allowances === 'object'
      ) {
        org.billingOverrides.allowances = billingOverrides.allowances;
      }
      if (typeof billingOverrides.taxRate === 'number') {
        org.billingOverrides.taxRate = billingOverrides.taxRate;
      }
    }

    await org.save();
    res.json({
      ok: true,
      orgId: org._id,
      status: org.status,
      plan: org.plan,
      planCode: org.planCode,
      seats: org.seats,
      currency: org.currency,
      billingOverrides: org.billingOverrides || {},
    });
  } catch (e) {
    console.error('[admin.super] PUT /orgs/:id/billing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------- Per-org billing preview --------------------- */
/**
 * GET /admin/super/orgs/:id/billing-preview
 *
 * Query:
 *   ?month=YYYY-MM  (optional; defaults to current month)
 *
 * Returns a billing preview for the given org + month:
 *   - uses BillingUsage.meters as input
 *   - applies effective pricing via getEffectivePricing(org)
 *   - includes plan base price + extra seats + usage lines
 */
router.get('/orgs/:id/billing-preview', async (req, res) => {
  try {
    if (!Org) {
      return res.status(500).json({ error: 'Org model not available' });
    }
    if (!BillingUsage) {
      return res
        .status(500)
        .json({ error: 'BillingUsage model not available' });
    }

    const { id } = req.params;
    let month = String(req.query.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      // fallback to current year-month if not provided or invalid
      month = monthKey();
    }

    const org = await Org.findById(id).lean();
    if (!org) {
      return res.status(404).json({ error: 'Org not found' });
    }

    // Load metered usage for this org + month (if any)
    const usageDoc = await BillingUsage.findOne({
      orgId: org._id,
      month,
    }).lean();

    const meters = usageDoc?.meters || {};

    // Effective pricing for this org (global + plan + org overrides)
    const effective = await getEffectivePricing(org);

    // Compute preview lines + totals (plan base, extra seats, usage)
    const preview = previewCost({
      meters,
      rates: effective.rates,
      allowances: effective.allowances,
      taxRate: effective.taxRate,
      basePrice: effective.basePrice,
      seats: org.seats,
      includedSeats: effective.includedSeats,
      extraSeatPrice: effective.extraSeatPrice,
    });

    res.json({
      orgId: org._id,
      name: org.name,
      status: org.status,
      plan: org.plan,
      planCode: org.planCode,
      seats: org.seats,
      currency: effective.currency,
      month,
      pricing: {
        basePrice: effective.basePrice ?? null,
        includedSeats: effective.includedSeats ?? null,
        extraSeatPrice: effective.extraSeatPrice ?? null,
        taxRate: effective.taxRate,
      },
      meters,   // raw meter counts
      preview,  // { lines, subtotal, taxRate, tax, total }
    });
  } catch (e) {
    console.error('[admin.super] GET /orgs/:id/billing-preview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------- Plan-level billing config -------------------- */
/**
 * GET /admin/super/billing-plans
 * Returns raw per-plan overrides for each known base plan.
 * (UI then shows basePrice / seats / etc and counts of rates/allowances.)
 */
router.get('/billing-plans', async (_req, res) => {
  try {
    if (!BillingConfig) {
      return res
        .status(500)
        .json({ error: 'BillingConfig model not available' });
    }

    const out = [];
    for (const code of PLAN_CODES) {
      const key = `plan:${code}`;
      const doc = await BillingConfig.findOne({ key }).lean();

      out.push({
        planCode: code,
        currency: doc?.currency ?? null,
        taxRate: typeof doc?.taxRate === 'number' ? doc.taxRate : null,
        basePrice: typeof doc?.basePrice === 'number' ? doc.basePrice : null,
        includedSeats:
          typeof doc?.includedSeats === 'number' ? doc.includedSeats : null,
        extraSeatPrice:
          typeof doc?.extraSeatPrice === 'number' ? doc.extraSeatPrice : null,
        rates: doc?.rates || {},
        allowances: doc?.allowances || {},
      });
    }

    res.json(out);
  } catch (e) {
    console.error('[admin.super] GET /billing-plans error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /admin/super/billing-plans/:code
 * Returns RAW overrides for a single plan code (not merged with defaults),
 * so the UI can edit exactly what is stored in BillingConfig.
 */
router.get('/billing-plans/:code', async (req, res) => {
  try {
    if (!BillingConfig) {
      return res
        .status(500)
        .json({ error: 'BillingConfig model not available' });
    }

    const raw = String(req.params.code || '').toLowerCase().trim();
    if (!PLAN_CODES.includes(raw)) {
      return res.status(400).json({ error: 'Unknown plan code' });
    }

    const key = `plan:${raw}`;
    const doc = await BillingConfig.findOne({ key }).lean();

    res.json({
      planCode: raw,
      currency: doc?.currency ?? '',
      taxRate: typeof doc?.taxRate === 'number' ? doc.taxRate : '',
      basePrice: typeof doc?.basePrice === 'number' ? doc.basePrice : '',
      includedSeats:
        typeof doc?.includedSeats === 'number' ? doc.includedSeats : '',
      extraSeatPrice:
        typeof doc?.extraSeatPrice === 'number' ? doc.extraSeatPrice : '',
      rates: doc?.rates || {},
      allowances: doc?.allowances || {},
    });
  } catch (e) {
    console.error('[admin.super] GET /billing-plans/:code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /admin/super/billing-plans/:code
 * body: {
 *   rates?, allowances?,
 *   taxRate?, currency?,
 *   basePrice?, includedSeats?, extraSeatPrice?
 * }
 *
 * Stores overrides in BillingConfig(key="plan:<code>").
 * Effective prices at runtime are:
 *   global defaults + plan overrides (+ org overrides).
 */
router.put('/billing-plans/:code', async (req, res) => {
  try {
    if (!BillingConfig) {
      return res
        .status(500)
        .json({ error: 'BillingConfig model not available' });
    }

    const raw = String(req.params.code || '').toLowerCase().trim();
    if (!PLAN_CODES.includes(raw)) {
      return res.status(400).json({ error: 'Unknown plan code' });
    }

    const {
      rates,
      allowances,
      taxRate,
      currency,
      basePrice,
      includedSeats,
      extraSeatPrice,
    } = req.body || {};

    const update = {};
    if (rates && typeof rates === 'object') update.rates = rates;
    if (allowances && typeof allowances === 'object')
      update.allowances = allowances;
    if (typeof taxRate === 'number') update.taxRate = taxRate;
    if (currency && typeof currency === 'string') update.currency = currency;
    if (typeof basePrice === 'number') update.basePrice = basePrice;
    if (typeof includedSeats === 'number') update.includedSeats = includedSeats;
    if (typeof extraSeatPrice === 'number')
      update.extraSeatPrice = extraSeatPrice;

    const key = `plan:${raw}`;
    const doc = await BillingConfig.findOneAndUpdate(
      { key },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

    // Return the raw stored overrides so the UI reflects exactly what is saved
    res.json({
      planCode: raw,
      currency: doc?.currency ?? '',
      taxRate: typeof doc?.taxRate === 'number' ? doc.taxRate : '',
      basePrice: typeof doc?.basePrice === 'number' ? doc.basePrice : '',
      includedSeats:
        typeof doc?.includedSeats === 'number' ? doc.includedSeats : '',
      extraSeatPrice:
        typeof doc?.extraSeatPrice === 'number' ? doc.extraSeatPrice : '',
      rates: doc?.rates || {},
      allowances: doc?.allowances || {},
    });
  } catch (e) {
    console.error('[admin.super] PUT /billing-plans/:code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
