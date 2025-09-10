// core-backend/models/Vehicle.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

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
  reg:       { type: String, required: true, index: true },
  make:      String,
  model:     String,
  year:      Number,
  status:    { type: String, enum: ['active','workshop','retired'], default: 'active', index: true },

  // Project the vehicle belongs to (optional)
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    index: true,
    default: null,
    set: v => (v === '' || v === undefined ? null : v),
  },

  // Who is currently responsible for this vehicle (optional)
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

  // Service / compliance reminders (unchanged)
  reminders: [ReminderSchema],
}, { timestamps: true });

// Keep reg unique
VehicleSchema.index({ reg: 1 }, { unique: true });

// Helpful secondary indexes
VehicleSchema.index({ projectId: 1, status: 1 });
VehicleSchema.index({ driverId: 1 });
VehicleSchema.index({ taskId: 1 });

module.exports = mongoose.model('Vehicle', VehicleSchema);
