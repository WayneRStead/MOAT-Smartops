// core-backend/models/Org.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/* ---------------------------- Allowed widgets --------------------------- */
/* Keep this list in sync with your frontend registry ids. */
const ALLOWED_WIDGETS = [
  'health.master',
  'roles',
  'namesList',
  'clockings.today',
  'projects.all',
  'tasks.all',
  'invoices',
  'assets',
  'vehicles',
  'inspections',
  'groups',
  'risk.summary',
  'date.range',
];

/* A sensible default set (order matters; shown in dashboard in this order). */
const DEFAULT_WIDGETS = [
  'health.master',
  'roles',
  'namesList',
  'clockings.today',
  'projects.all',
  'tasks.all',
  'invoices',
  'assets',
  'vehicles',
  'inspections',
  'groups',
  'risk.summary',
  'date.range',
];

/* --------------------------- Trial configuration ------------------------ */
/**
 * Default trial length in days for brand new orgs that are created in
 * "trialing" status on the "trial" planCode.
 *
 * You can override via env:
 *   ORG_TRIAL_DAYS=30
 */
const DEFAULT_TRIAL_DAYS = Number(process.env.ORG_TRIAL_DAYS || 14);

/* -------------------------------- Modules ------------------------------- */
const ModulesSchema = new Schema(
  {
    projects:    { type: Boolean, default: true },
    tasks:       { type: Boolean, default: true },
    users:       { type: Boolean, default: true },
    clockings:   { type: Boolean, default: true },
    assets:      { type: Boolean, default: true },
    vehicles:    { type: Boolean, default: true },
    invoices:    { type: Boolean, default: false },
    inspections: { type: Boolean, default: true },
    vault:       { type: Boolean, default: true },
  },
  { _id: false }
);

/* ------------------------------- Theme (legacy) ------------------------- */
const ThemeLegacySchema = new Schema(
  {
    mode:  { type: String, enum: ['light','dark','system'], default: 'system' },
    color: { type: String, default: '#2a7fff' },
  },
  { _id: false }
);

/* -------------------------------- Org ---------------------------------- */
const OrgSchema = new Schema(
  {
    /* Basic identity */
    name:    { type: String, default: 'Your Organization' },
    logoUrl: { type: String, default: '' },

    /* Canonical theme */
    themeMode:   { type: String, enum: ['light','dark','system'], default: 'system' },
    accentColor: { type: String, default: '#2a7fff' },

    /* Legacy theme blob (kept in sync) */
    theme:       { type: ThemeLegacySchema, default: () => ({ mode: 'system', color: '#2a7fff' }) },

    /* Feature flags (modules) */
    modules:     { type: ModulesSchema, default: () => ({}) },

    /* Per-org dashboard widget selection (order matters) */
    dashboardWidgets: {
      type: [String],
      default: () => DEFAULT_WIDGETS.slice(),
      validate: {
        validator: function (arr) {
          if (!Array.isArray(arr)) return false;
          return arr.every(id => ALLOWED_WIDGETS.includes(String(id)));
        },
        message: 'dashboardWidgets contains an unknown widget id.',
      },
    },

    /* ---------- Org lifecycle + billing summary ---------- */

    // Overall lifecycle for this org (used by global cockpit + enforcement)
    status: {
      type: String,
      enum: ['trialing', 'active', 'suspended', 'cancelled'],
      default: 'trialing',
      index: true,
    },

    // Contact / owner email (for billing & comms)
    ownerEmail: { type: String, trim: true, lowercase: true },

    // Seats / licensed users for this org (soft cap; enforcement is app logic)
    seats: { type: Number, default: 5, min: 0 },

    // Human-friendly plan label (e.g. "Starter", "Pro", "Enterprise")
    // For trials we usually show something like "Trial" to the org.
    plan: { type: String, default: 'Trial' },

    // Machine-readable plan code
    // For trials we use "trial" so that middleware/enforcement can key off this.
    planCode: { type: String, default: 'trial', index: true },

    // Billing integration
    billingProvider: { type: String, default: 'internal' }, // e.g. "internal", "stripe"
    billingExternalId: { type: String, trim: true },        // e.g. Stripe customer ID

    // Per-org billing overrides (applied on top of global + plan defaults)
    billingOverrides: {
      rates:      { type: Schema.Types.Mixed },
      allowances: { type: Schema.Types.Mixed },
      taxRate:    { type: Number },
    },

    // Currency + simple MRR estimate (optional, for cockpit)
    currency: { type: String, default: 'ZAR' },
    mrr:      { type: Number, default: 0 }, // monthly recurring revenue estimate

    // Important billing dates
    trialEndsAt:          { type: Date },
    subscriptionRenewsAt: { type: Date },
    lastInvoiceAt:        { type: Date },

    // Activity tracking (used in super admin cockpit)
    lastActiveAt: { type: Date },

    // Arbitrary per-org settings blob (used by routes/org.js)
    settings: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

/* ------------------------ Keep legacy theme in sync --------------------- */
OrgSchema.pre('save', function(next) {
  if (!this.theme) this.theme = {};
  if (this.isModified('themeMode'))   this.theme.mode  = this.themeMode;
  if (this.isModified('accentColor')) this.theme.color = this.accentColor;
  next();
});

/* -------------------- Trial defaults & automation hooks ------------------ */
/**
 * For brand new orgs:
 *  - default status → "trialing" (if not explicitly set)
 *  - default planCode → "trial" (if status is trialing and code isn't overridden)
 *  - default plan label → "Trial" (if status is trialing and label isn't overridden)
 *  - automatically set trialEndsAt using ORG_TRIAL_DAYS
 *
 * For orgs that are switched TO the "trial" plan later:
 *  - if status is trialing AND planCode just became "trial" AND trialEndsAt is missing,
 *    we set a fresh trialEndsAt (this lets superadmin re-grant a trial deliberately).
 */
OrgSchema.pre('save', function(next) {
  const now = new Date();

  // New org bootstrap
  if (this.isNew) {
    if (!this.status) {
      this.status = 'trialing';
    }

    if (this.status === 'trialing') {
      // Default to "trial" code if not explicitly set or still on old "standard" default
      if (!this.planCode || this.planCode === 'standard') {
        this.planCode = 'trial';
      }
      // Default human label for trial
      if (!this.plan || this.plan === 'standard') {
        this.plan = 'Trial';
      }
      // Set trial end if missing
      if (!this.trialEndsAt) {
        const d = new Date(now);
        d.setDate(d.getDate() + DEFAULT_TRIAL_DAYS);
        this.trialEndsAt = d;
      }
    }
  } else {
    // Existing org being updated:
    // If someone moves org back onto "trial" with status "trialing" and no trialEndsAt,
    // grant a fresh trial (explicit superadmin action).
    const statusIsTrialing = this.status === 'trialing';
    const becameTrialPlan =
      this.isModified('planCode') &&
      this.planCode === 'trial';

    if (statusIsTrialing && becameTrialPlan && !this.trialEndsAt) {
      const d = new Date(now);
      d.setDate(d.getDate() + DEFAULT_TRIAL_DAYS);
      this.trialEndsAt = d;
    }
  }

  next();
});

/* --------------- Normalize dashboardWidgets before validation ----------- */
OrgSchema.pre('validate', function(next) {
  let list = Array.isArray(this.dashboardWidgets)
    ? this.dashboardWidgets.map(String)
    : [];

  if (!list.length) {
    this.dashboardWidgets = DEFAULT_WIDGETS.slice();
    return next();
  }

  const seen = new Set();
  const cleaned = [];
  for (const id of list) {
    if (!ALLOWED_WIDGETS.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }

  this.dashboardWidgets = cleaned.length ? cleaned : DEFAULT_WIDGETS.slice();
  next();
});

/* ------------------------------- Indexes -------------------------------- */
OrgSchema.index({ status: 1 });
OrgSchema.index({ planCode: 1 });
OrgSchema.index({ ownerEmail: 1 });

module.exports =
  mongoose.models.Org || mongoose.model('Org', OrgSchema);
