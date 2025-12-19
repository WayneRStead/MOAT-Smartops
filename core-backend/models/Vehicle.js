// core-backend/models/Vehicle.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Simple VIN validator:
 * - 17 chars
 * - Alphanumeric, excluding I, O, Q
 */
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

const normalizeUpper = v =>
  typeof v === 'string' ? v.trim().toUpperCase() : v;

const ReminderSchema = new Schema({
  kind: { type: String, enum: ['date', 'odometer'], required: true },
  dueDate: Date,                // for kind=date
  dueOdometer: Number,          // for kind=odometer (km)
  notes: { type: String, default: '' },
  active: { type: Boolean, default: true },
  lastNotifiedAt: Date,
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const VehicleSchema = new Schema({
  /* ---------- tenancy ---------- */
  orgId: { type: Schema.Types.ObjectId, ref: 'Org', index: true },

  /* ---------- core fields ---------- */
  // Registration (plate)
  reg: {
    type: String,
    required: true,
    index: true,
    set: normalizeUpper,
  },

  // Optional VIN (unique when present)
  vin: {
    type: String,
    default: null,
    set: v => (v === '' || v === undefined || v === null ? null : normalizeUpper(v)),
    validate: {
      validator: v => v == null || VIN_REGEX.test(v),
      message: 'VIN must be 17 characters (A–Z, 0–9), excluding I, O, Q.',
    },
  },

  // Vehicle type/category (free text)
  vehicleType: {
    type: String,
    default: '',
    set: v => (v === '' || v === undefined || v === null ? '' : String(v).trim()),
    index: true,
  },

  make:  String,
  model: String,
  year:  Number,

  // Status
  status: {
    type: String,
    enum: ['active','workshop','retired','stolen'],
    default: 'active',
    index: true,
  },

  // Project the vehicle belongs to (optional)
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    index: true,
    default: null,
    set: v => (v === '' || v === undefined ? null : v),
  },

  // Who is currently responsible (optional)
  driverId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    default: null,
    set: v => (v === '' || v === undefined ? null : v),
  },

  // Allocated task (optional)
  taskId: {
    type: Schema.Types.ObjectId,
    ref: 'Task',
    index: true,
    default: null,
    set: v => (v === '' || v === undefined ? null : v),
  },

  // Service / compliance reminders
  reminders: [ReminderSchema],
}, { timestamps: true });

/* ---------- INDEXES ---------- */
/** Uniqueness must be org-scoped */
VehicleSchema.index({ orgId: 1, reg: 1 }, { unique: true });
VehicleSchema.index(
  { orgId: 1, vin: 1 },
  { unique: true, partialFilterExpression: { vin: { $type: 'string' } } }
);

/** Helpful secondary indexes for lists */
VehicleSchema.index({ orgId: 1, updatedAt: -1 });
VehicleSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
VehicleSchema.index({ orgId: 1, projectId: 1, status: 1 });
VehicleSchema.index({ orgId: 1, driverId: 1 });
VehicleSchema.index({ orgId: 1, taskId: 1 });
VehicleSchema.index({ orgId: 1, vehicleType: 1, status: 1 });

module.exports = mongoose.model('Vehicle', VehicleSchema);
