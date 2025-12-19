// core-backend/models/VehicleTrip.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* ------------------------- Reusable sub-schemas ------------------------- */

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

// Flat lat/lng capture
const GeoSchema = new Schema(
  {
    lat: Number,
    lng: Number,
    acc: Number, // accuracy (m)
  },
  { _id: false }
);

// Proper GeoJSON Point
const PointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    // [lng, lat]
    coordinates: { type: [Number] },
  },
  { _id: false }
);

/* ------------------------------ Main schema ---------------------------- */

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

    // geo capture (flat lat/lng + GeoJSON)
    startGeo: GeoSchema,
    endGeo: GeoSchema,

    // GeoJSON points (single, canonical definition)
    startLocation: PointSchema,
    endLocation: PointSchema,

    // purpose (Business | Private)
    purpose: {
      type: String,
      enum: ['Business', 'Private'],
      default: 'Business',
      index: true,
    },

    // optional associations
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    tags: [{ type: String }],

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

    // soft delete
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* -------------------------------- Indexes ------------------------------ */

// helpful compound index to find “open trip for a driver/vehicle”
VehicleTripSchema.index({ orgId: 1, vehicleId: 1, driverUserId: 1, status: 1 });

// Geo indexes (sparse so docs without coordinates are ignored)
VehicleTripSchema.index({ startLocation: '2dsphere' }, { sparse: true });
VehicleTripSchema.index({ endLocation: '2dsphere' }, { sparse: true });

/* --------------------------- Geo sync & guard --------------------------- */

function toPoint(geo) {
  const lat = Number(geo?.lat);
  const lng = Number(geo?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
}

function sanitizePoint(p) {
  const coords = p?.coordinates;
  const lng = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  return (Number.isFinite(lat) && Number.isFinite(lng))
    ? { type: 'Point', coordinates: [lng, lat] }
    : undefined;
}

// Ensure we never save an invalid {type:'Point'} without valid coordinates
VehicleTripSchema.pre('validate', function () {
  // startLocation from startGeo if valid; otherwise sanitize/clear
  const sPoint = toPoint(this.startGeo);
  if (sPoint) this.startLocation = sPoint;
  else if (this.startLocation) this.startLocation = sanitizePoint(this.startLocation);
  if (!this.startLocation) this.startLocation = undefined;

  // endLocation from endGeo if valid; otherwise sanitize/clear
  const ePoint = toPoint(this.endGeo);
  if (ePoint) this.endLocation = ePoint;
  else if (this.endLocation) this.endLocation = sanitizePoint(this.endLocation);
  if (!this.endLocation) this.endLocation = undefined;
});

module.exports = mongoose.models.VehicleTrip || mongoose.model('VehicleTrip', VehicleTripSchema);
