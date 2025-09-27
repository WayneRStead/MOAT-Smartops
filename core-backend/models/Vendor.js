// core-backend/models/Vendor.js
const mongoose = require('mongoose');

const VendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    contact: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    notes: { type: String, trim: true },
    orgId: { type: String, index: true }, // matches vehicles.js default style
  },
  { timestamps: true }
);

VendorSchema.index({ name: 1, orgId: 1 }, { unique: false });

module.exports = mongoose.models.Vendor || mongoose.model('Vendor', VendorSchema);
