const mongoose = require('mongoose');

const InvoiceSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  amount: { type: Number, required: true },
  status: { type: String, default: 'draft' }
}, { timestamps: true });

module.exports = mongoose.model('Invoice', InvoiceSchema);
