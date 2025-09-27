// core-backend/models/Purchase.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const PurchaseSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true, required: true },
    vendorId:  { type: Schema.Types.ObjectId, ref: 'Vendor',  index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    taskId:    { type: Schema.Types.ObjectId, ref: 'Task',    index: true },

    // When it happened + bookkeeping
    date: { type: Date, required: true, index: true },
    cost: { type: Number, default: 0 },
    type: { type: String, trim: true, default: 'other' }, // e.g. service, repair, tyres, parts, fuel, toll, registration, other
    notes: { type: String, trim: true },

    docUrls: [{ type: String }], // optional invoice/receipt links
    orgId: { type: String, index: true }, // same style as vehicles.js
  },
  { timestamps: true }
);

PurchaseSchema.index({ vehicleId: 1, date: -1 });

module.exports = mongoose.models.Purchase || mongoose.model('Purchase', PurchaseSchema);
