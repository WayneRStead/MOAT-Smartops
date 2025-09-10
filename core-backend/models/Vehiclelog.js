// core-backend/models/VehicleLog.js
const mongoose = require('mongoose');

const VehicleLogSchema = new mongoose.Schema({
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  title:     { type: String, required: true, index: 'text' },
  notes:     { type: String, default: '' },
  tags:      [{ type: String, index: true }],
  ts:        { type: Date, default: Date.now }, // when the log entry happened

  // Odometer fields (km)
  odometerStart: { type: Number, min: 0 },
  odometerEnd:   { type: Number, min: 0 },
  distance:      { type: Number, min: 0 },      // auto-computed when both present

  createdBy: { type: String, index: true },     // req.user.sub or email
}, { timestamps: true });

VehicleLogSchema.index({ vehicleId: 1, ts: -1 });
VehicleLogSchema.index({ tags: 1 });

module.exports = mongoose.model('VehicleLog', VehicleLogSchema);
