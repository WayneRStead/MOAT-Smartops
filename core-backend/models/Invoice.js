// core-backend/models/Invoice.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const InvoiceSchema = new Schema({
  orgId: { type: Schema.Types.Mixed, index: true }, // allow string or ObjectId
  number: String,
  customerName: String,
  customerEmail: String,
  status: { type: String, index: true }, // e.g. 'open' | 'paid' | 'void'
  issuedAt: Date,
  dueAt: Date,
  items: { type: Array, default: [] },
  subtotal: Number,
  tax: Number,
  total: Number,
  notes: String,
}, { timestamps: true });

const modelName = 'Invoice';
module.exports = mongoose.models[modelName] || mongoose.model(modelName, InvoiceSchema);
