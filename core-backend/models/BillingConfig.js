const mongoose = require('mongoose');

const BillingConfigSchema = new mongoose.Schema({
  // global default unit prices (placeholders)
  rates: {
    mau_mobile:           { type: Number, default: 30 },   // R per active mobile user
    events_clockings:     { type: Number, default: 0.2 },  // R/event
    events_inspections:   { type: Number, default: 1.0 },  // R/submission
    automation_ocr:       { type: Number, default: 0.8 },
    automation_ai:        { type: Number, default: 0.6 },
    notifications_sms:    { type: Number, default: 0.25 },
    notifications_email:  { type: Number, default: 0.02 },
    storage_gb_month:     { type: Number, default: 5 }
  },
  // global default included amounts per month
  allowances: {
    mau_mobile:           { type: Number, default: 10 },
    events_clockings:     { type: Number, default: 500 },
    events_inspections:   { type: Number, default: 50 },
    automation_ocr:       { type: Number, default: 0 },
    automation_ai:        { type: Number, default: 0 },
    notifications_sms:    { type: Number, default: 50 },
    notifications_email:  { type: Number, default: 500 },
    storage_gb_month:     { type: Number, default: 5 }
  },
  taxRate: { type: Number, default: 0.15 }
}, { timestamps: true });

module.exports = mongoose.model('BillingConfig', BillingConfigSchema);
