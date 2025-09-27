const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    // Using String to match your current orgId usage across collections
    orgId: { type: String, index: true },

    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    // Point at users by ObjectId
    leaderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    memberUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    isDeleted: { type: Boolean, default: false },

    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Unique name per org among non-deleted groups
GroupSchema.index(
  { orgId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);
