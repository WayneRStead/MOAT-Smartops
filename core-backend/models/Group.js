// models/group.js
const mongoose = require('mongoose');
const { Schema } = mongoose;


const GroupSchema = new Schema(
{
orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
name: { type: String, required: true, trim: true },
description: { type: String, default: '' },
// Store membership on the group; we can optionally denormalize onto User later for faster lookups
memberUserIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
isDeleted: { type: Boolean, default: false, index: true },
createdByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
},
{ timestamps: true }
);


GroupSchema.index({ orgId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });


module.exports = mongoose.model('Group', GroupSchema);