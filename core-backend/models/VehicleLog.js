// core-backend/models/VehicleLog.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Reusable attachment schema (GridFS metadata stored on document)
const AttachmentSchema = new Schema(
  {
    fileId: String, // GridFS _id (stringified)
    filename: String,
    url: { type: String, required: true }, // e.g. /files/logbook/<fileId>
    mime: String,
    size: Number,
    note: String,
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const VehicleLogSchema = new Schema(
  {
    // tenancy (recommended)
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true },

    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      index: true,
    },
    title: { type: String, required: true, index: "text" },
    type: { type: String, default: "other", index: true },
    vendor: { type: String, default: "" },
    cost: { type: Number, min: 0, default: undefined },
    notes: { type: String, default: "" },
    tags: [{ type: String, index: true }],
    ts: { type: Date, default: Date.now },

    odometer: { type: Number, min: 0 },
    odometerStart: { type: Number, min: 0 },
    odometerEnd: { type: Number, min: 0 },
    distance: { type: Number, min: 0 },

    sourceOfflineEventId: {
      type: Schema.Types.ObjectId,
      index: true,
      default: undefined,
    },

    // NEW: attachments
    attachments: [AttachmentSchema],

    createdBy: { type: String, index: true },
  },
  { timestamps: true },
);

VehicleLogSchema.index({ orgId: 1, vehicleId: 1, ts: -1 });
VehicleLogSchema.index({ vehicleId: 1, ts: -1 });
VehicleLogSchema.index({ tags: 1 });
VehicleLogSchema.index(
  { orgId: 1, sourceOfflineEventId: 1 },
  { unique: true, sparse: true },
);

module.exports =
  mongoose.models.VehicleLog || mongoose.model("VehicleLog", VehicleLogSchema);
