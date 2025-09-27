// core-backend/models/VehicleTrip.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Small reusable attachment (URL-first to avoid upload coupling)
const AttachmentSchema = new Schema(
  {
    filename: String,
    url: { type: String, required: true },
    mime: String,
    size: Number,
    note: String,
    uploadedBy: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const EditChangeSchema = new Schema(
  {
    field: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  },
  { _id: false }
);

const EditEntrySchema = new Schema(
  {
    editedAt: { type: Date, default: Date.now },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    note: String,
    changes: [EditChangeSchema],
  },
  { _id: false }
);

const VehicleTripSchema = new Schema(
  {
    // ----- tenancy -----
    orgId: { type: Schema.Types.ObjectId, index: true },

    // ----- core -----
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    driverUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: ['open', 'closed', 'cancelled'],
      default: 'open',
      index: true,
    },

    // time
    startedAt: { type: Date, default: Date.now, index: true },
    endedAt: { type: Date },

    // odometer + derived
    odoStart: { type: Number, required: true, min: 0 },
    odoEnd: { type: Number, min: 0 },
    distance: { type: Number, min: 0 }, // same unit as odo (usually km)

    // optional associations
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    tags: [{ type: String }], // e.g. ["general"] default set in route if none

    // evidence
    startPhoto: AttachmentSchema,
    endPhoto: AttachmentSchema,
    attachments: [AttachmentSchema],

    // notes
    notes: String,

    // audit
    createdBy: String,
    updatedBy: String,
    lastEditedAt: Date,
    lastEditedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editLog: [EditEntrySchema],

    // soft delete (optional, not used yet)
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// helpful compound index to find “open trip for a driver/vehicle”
VehicleTripSchema.index({ orgId: 1, vehicleId: 1, driverUserId: 1, status: 1 });

module.exports = mongoose.models.VehicleTrip || mongoose.model('VehicleTrip', VehicleTripSchema);
