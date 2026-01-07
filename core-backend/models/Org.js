// core-backend/models/Org.js
const mongoose = require("mongoose");

const { Schema } = mongoose;

/* ---------------------------- Allowed widgets --------------------------- */
/* Keep this list in sync with your frontend registry ids. */
const ALLOWED_WIDGETS = [
  "health.master",
  "roles",
  "namesList",
  "clockings.today",
  "projects.all",
  "tasks.all",
  "invoices",
  "assets",
  "vehicles",
  "inspections",
  "groups",
  "risk.summary",
  "date.range",
];

/* A sensible default set (order matters; shown in dashboard in this order). */
const DEFAULT_WIDGETS = [
  "health.master",
  "roles",
  "namesList",
  "clockings.today",
  "projects.all",
  "tasks.all",
  "invoices",
  "assets",
  "vehicles",
  "inspections",
  "groups",
  "risk.summary",
  "date.range",
];

/* --------------------------- Trial configuration ------------------------ */
const DEFAULT_TRIAL_DAYS = Number(process.env.ORG_TRIAL_DAYS || 14);

/* -------------------------------- Modules ------------------------------- */
const ModulesSchema = new Schema(
  {
    projects: { type: Boolean, default: true },
    tasks: { type: Boolean, default: true },
    users: { type: Boolean, default: true },
    clockings: { type: Boolean, default: true },
    assets: { type: Boolean, default: true },
    vehicles: { type: Boolean, default: true },
    invoices: { type: Boolean, default: false },
    inspections: { type: Boolean, default: true },
    vault: { type: Boolean, default: true },
  },
  { _id: false }
);

/* ------------------------------- Theme (legacy) ------------------------- */
const ThemeLegacySchema = new Schema(
  {
    mode: { type: String, enum: ["light", "dark", "system"], default: "system" },
    color: { type: String, default: "#2a7fff" },
  },
  { _id: false }
);

/* -------------------------------- Org ---------------------------------- */
const OrgSchema = new Schema(
  {
    /* Basic identity */
    name: { type: String, default: "Your Organization" },

    /**
     * Logo URL used by the frontend.
     * With GridFS Option A we store: /files/org/:fileId
     */
    logoUrl: { type: String, default: "" },

    /**
     * ✅ GridFS-backed logo metadata (Option A)
     * Stored file lives in bucket: org.files/org.chunks
     */
    logoFileId: { type: Schema.Types.ObjectId, default: null, index: true },
    logoFileName: { type: String, default: "" },
    logoFileType: { type: String, default: "" },
    logoFileSize: { type: Number, default: 0 },
    logoUpdatedAt: { type: Date, default: null },

    /* Canonical theme */
    themeMode: { type: String, enum: ["light", "dark", "system"], default: "system" },
    accentColor: { type: String, default: "#2a7fff" },

    /* Legacy theme blob (kept in sync) */
    theme: { type: ThemeLegacySchema, default: () => ({ mode: "system", color: "#2a7fff" }) },

    /* Feature flags (modules) */
    modules: { type: ModulesSchema, default: () => ({}) },

    /* Per-org dashboard widget selection (order matters) */
    dashboardWidgets: {
      type: [String],
      default: () => DEFAULT_WIDGETS.slice(),
      validate: {
        validator: function (arr) {
          if (!Array.isArray(arr)) return false;
          return arr.every((id) => ALLOWED_WIDGETS.includes(String(id)));
        },
        message: "dashboardWidgets contains an unknown widget id.",
      },
    },

    /* ---------- Org lifecycle + billing summary ---------- */

    status: {
      type: String,
      enum: ["trialing", "active", "suspended", "cancelled"],
      default: "trialing",
      index: true,
    },

    ownerEmail: { type: String, trim: true, lowercase: true },

    seats: { type: Number, default: 5, min: 0 },

    plan: { type: String, default: "Trial" },

    planCode: { type: String, default: "trial", index: true },

    billingProvider: { type: String, default: "internal" },
    billingExternalId: { type: String, trim: true },

    billingOverrides: {
      rates: { type: Schema.Types.Mixed },
      allowances: { type: Schema.Types.Mixed },
      taxRate: { type: Number },
    },

    currency: { type: String, default: "ZAR" },
    mrr: { type: Number, default: 0 },

    trialEndsAt: { type: Date },
    subscriptionRenewsAt: { type: Date },
    lastInvoiceAt: { type: Date },

    lastActiveAt: { type: Date },

    settings: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

/* ------------------------ Keep legacy theme in sync --------------------- */
OrgSchema.pre("save", function (next) {
  if (!this.theme) this.theme = {};
  if (this.isModified("themeMode")) this.theme.mode = this.themeMode;
  if (this.isModified("accentColor")) this.theme.color = this.accentColor;
  next();
});

/* -------------------- Trial defaults & automation hooks ------------------ */
OrgSchema.pre("save", function (next) {
  const now = new Date();

  // New org bootstrap
  if (this.isNew) {
    if (!this.status) {
      this.status = "trialing";
    }

    if (this.status === "trialing") {
      if (!this.planCode || this.planCode === "standard") {
        this.planCode = "trial";
      }
      if (!this.plan || this.plan === "standard") {
        this.plan = "Trial";
      }
      if (!this.trialEndsAt) {
        const d = new Date(now);
        d.setDate(d.getDate() + DEFAULT_TRIAL_DAYS);
        this.trialEndsAt = d;
      }
    }
  } else {
    const statusIsTrialing = this.status === "trialing";
    const becameTrialPlan = this.isModified("planCode") && this.planCode === "trial";

    if (statusIsTrialing && becameTrialPlan && !this.trialEndsAt) {
      const d = new Date(now);
      d.setDate(d.getDate() + DEFAULT_TRIAL_DAYS);
      this.trialEndsAt = d;
    }
  }

  next();
});

/* --------------- Normalize dashboardWidgets before validation ----------- */
OrgSchema.pre("validate", function (next) {
  let list = Array.isArray(this.dashboardWidgets) ? this.dashboardWidgets.map(String) : [];

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

// Helpful for loading the org logo fast in cockpits/UI
OrgSchema.index({ logoFileId: 1 });

module.exports = mongoose.models.Org || mongoose.model("Org", OrgSchema);
