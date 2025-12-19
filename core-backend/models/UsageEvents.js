// core-backend/models/UsageEvent.js
const mongoose = require('mongoose');
const UsageEventSchema = new mongoose.Schema({
  kind: { type: String, required: true }, // 'org.created','user.invited','trip.created','purchase.created','inspection.submitted'
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  meta:  { type: Object },
}, { timestamps: true });

UsageEventSchema.index({ kind: 1, createdAt: -1 });
UsageEventSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model('UsageEvent', UsageEventSchema);
