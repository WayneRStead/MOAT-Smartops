// core-backend/models/BillingConfig.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Generic billing configuration document.
 *
 * key:
 *   - "default"            → global defaults for all orgs
 *   - "plan:standard"      → defaults for the "standard" plan
 *   - "plan:starter"       → defaults for the "starter" plan
 *   - "plan:pro"           → defaults for the "pro" plan
 *   - "plan:enterprise"    → defaults for the "enterprise" plan
 *
 * NOTE:
 *   - Per-org overrides still live on the Org document itself (org.billingOverrides).
 *   - Plan-level base prices and seat rules are defined here when key starts with "plan:".
 */
const BillingConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },

    /**
     * Per-meter unit prices, e.g.
     *   { "events_clockings": 0.10, "events_inspections": 0.50, ... }
     *
     * For key="default", this is the global master price list.
     * For key="plan:*", these override the global defaults for orgs on that plan.
     */
    rates: {
      type: Schema.Types.Mixed,
      default: undefined,
    },

    /**
     * Per-meter free allowances per month, e.g.
     *   { "events_clockings": 1000, "events_inspections": 100, ... }
     *
     * For key="default", this is the global default allowance.
     * For key="plan:*", these override the defaults for that plan.
     */
    allowances: {
      type: Schema.Types.Mixed,
      default: undefined,
    },

    /**
     * Optional tax rate override (e.g. 0.15 for 15%).
     * Falls back to DEFAULT_TAX_RATE when not set.
     */
    taxRate: { type: Number },

    /**
     * Optional currency override (e.g. "ZAR", "USD").
     * Falls back to DEFAULT_CURRENCY when not set.
     */
    currency: { type: String },

    /* -------------------------------------------------------------------
     * NEW: Plan-level base pricing & seat rules
     * -------------------------------------------------------------------
     * These fields are mainly meaningful when key starts with "plan:".
     * For key="default" they are usually left undefined / ignored.
     */

    /**
     * Fixed monthly base price for this plan (before tax), in "currency".
     * Example:
     *   - Starter:  500
     *   - Standard: 1500
     *   - Pro:      3500
     */
    basePrice: { type: Number },

    /**
     * Number of user seats included in the basePrice.
     * If an Org has more seats than this, extraSeatPrice may be applied
     * per additional seat (depending on your billing logic).
     */
    includedSeats: { type: Number },

    /**
     * Optional per-seat price for seats above includedSeats.
     * Example:
     *   includedSeats = 10, extraSeatPrice = 75
     *   org.seats = 15 → 5 extra seats → 5 * 75 additional per month.
     */
    extraSeatPrice: { type: Number },

    /**
     * Flexible metadata bucket for future per-plan flags, descriptions, etc.
     * e.g.:
     *   meta: {
     *     label: "Starter",
     *     description: "Up to 10 staff, basic reporting",
     *     maxProjects: 20
     *   }
     */
    meta: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.BillingConfig ||
  mongoose.model('BillingConfig', BillingConfigSchema);
