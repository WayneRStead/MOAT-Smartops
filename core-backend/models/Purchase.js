// core-backend/models/Purchase.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Single image attachment for a receipt
const ReceiptPhotoSchema = new Schema(
  {
    url: { type: String, required: true },
    filename: String,
    mime: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PurchaseSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true, required: true },
    vendorId:  { type: Schema.Types.ObjectId, ref: 'Vendor',  index: true, default: undefined },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true, default: undefined },
    taskId:    { type: Schema.Types.ObjectId, ref: 'Task',    index: true, default: undefined },

    // When it happened + bookkeeping
    date:  { type: Date, required: true, index: true },
    cost:  { type: Number, default: 0, min: 0 },
    type:  { type: String, trim: true, default: 'other' }, // e.g. service, repair, tyres, parts, fuel, toll, registration, other
    notes: { type: String, trim: true, default: '' },

    docUrls: [{ type: String }], // optional invoice/receipt links

    // IMPORTANT: keep String to match routes/purchases buildOrgFilter()
    orgId: { type: String, index: true, default: undefined },
  },
  { timestamps: true }
);

// Normalize `type` to lowercase and restrict empty strings
PurchaseSchema.pre('validate', function() {
  if (typeof this.type === 'string') {
    this.type = this.type.trim().toLowerCase() || 'other';
  } else {
    this.type = 'other';
  }
  if (!Array.isArray(this.docUrls)) this.docUrls = [];
});

PurchaseSchema.index({ vehicleId: 1, date: -1 });

module.exports = mongoose.models.Purchase || mongoose.model('Purchase', PurchaseSchema);
