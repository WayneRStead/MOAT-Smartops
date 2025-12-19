// core-backend/models/Group.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const GroupSchema = new Schema({
  // Keep Mixed for backward compatibility with legacy data
  orgId: { type: Schema.Types.Mixed, index: true },

  name: { type: String, required: true, trim: true }, // removed global unique
  description: String,

  // Preferred leader field
  leaderUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

  // Legacy single-leader field (kept for compatibility)
  leaderUserId: { type: Schema.Types.ObjectId, ref: 'User' },

  memberUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

  isDeleted: { type: Boolean, default: false, index: true },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

// Org-scoped unique group names
// NOTE: you'll need to drop the old { name: 1 } unique index once (migration step).
GroupSchema.index({ orgId: 1, name: 1 }, { unique: true, partialFilterExpression: { name: { $type: 'string' } } });

/** Keep legacy and new leader fields in sync */
GroupSchema.pre('save', function(next){
  // If only legacy is set → seed the array
  if ((!this.leaderUserIds || this.leaderUserIds.length === 0) && this.leaderUserId) {
    this.leaderUserIds = [this.leaderUserId];
  }
  // Always mirror first array item back to legacy field
  if (Array.isArray(this.leaderUserIds) && this.leaderUserIds.length > 0) {
    this.leaderUserId = this.leaderUserIds[0];
  } else {
    this.leaderUserId = undefined;
  }
  next();
});

/** Helper: org-aware find-or-create */
GroupSchema.statics.findOrCreateByName = async function(orgIdValue, name, meta = {}) {
  const nameNorm = String(name || '').trim();
  if (!nameNorm) return null;
  const query = { orgId: orgIdValue, name: nameNorm, isDeleted: { $ne: true } };

  let g = await this.findOne(query);
  if (g) return g;

  g = new this({
    orgId: orgIdValue,
    name: nameNorm,
    description: meta.description || '',
    leaderUserIds: Array.isArray(meta.leaderUserIds) ? meta.leaderUserIds : [],
    memberUserIds: Array.isArray(meta.memberUserIds) ? meta.memberUserIds : [],
    createdBy: meta.createdBy || '',
    updatedBy: meta.updatedBy || '',
  });
  await g.save();
  return g;
};

module.exports = mongoose.model('Group', GroupSchema);
