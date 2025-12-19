// core-backend/models/BillingUsage.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const BillingUsageSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', index: true, required: true },
  month: { type: String, index: true, required: true }, // 'YYYY-MM'
  meters: {
    mau_mobile:          { type: Number, default: 0 },
    events_clockings:    { type: Number, default: 0 },
    events_inspections:  { type: Number, default: 0 },
    automation_ocr:      { type: Number, default: 0 },
    automation_ai:       { type: Number, default: 0 },
    notifications_sms:   { type: Number, default: 0 },
    notifications_email: { type: Number, default: 0 },
    storage_gb_month:    { type: Number, default: 0 }
  },
  lines: [{
    code: String, qty: Number, unit: Number, subtotal: Number, meta: Object
  }],
  totals: {
    subtotal: { type: Number, default: 0 },
    tax:      { type: Number, default: 0 },
    total:    { type: Number, default: 0 }
  }
}, { timestamps: true });

module.exports = mongoose.model('BillingUsage', BillingUsageSchema);
