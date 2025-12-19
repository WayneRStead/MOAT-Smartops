// models/TaskMilestone.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUS = ['pending', 'started', 'paused', 'paused - problem', 'finished'];

function normalizeStatus(v) {
  if (v == null) return v;
  const s = String(v).toLowerCase();
  // map a few common aliases
  if (s === 'planned' || s === 'plan') return 'pending';
  if (s === 'complete' || s === 'completed') return 'finished';
  return v;
}

const TaskMilestoneSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },

    // server requires these:
    startPlanned: { type: Date, required: true },
    endPlanned:   { type: Date, required: true },

    // enum + safe mapper + safe default
    status: {
      type: String,
      enum: STATUS,
      default: 'pending',
      set: normalizeStatus,
    },

    // optional fields
    actualEndAt: { type: Date },
    roadblock: { type: Boolean, default: false },
    requires: [{ type: Schema.Types.ObjectId, ref: 'TaskMilestone' }],

    // multi-tenant (optional but recommended)
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
  },
  { timestamps: true }
);

// If any legacy docs have status:"planned", fix them as they’re loaded for update
TaskMilestoneSchema.pre('validate', function (next) {
  if (this.status == null) return next(); // default will apply
  this.status = normalizeStatus(this.status);
  next();
});

// Optional: alias setter (defensive)
TaskMilestoneSchema.virtual('endActual')
  .set(function (v) { this.actualEndAt = v; })
  .get(function () { return this.actualEndAt; });

module.exports = mongoose.model('TaskMilestone', TaskMilestoneSchema);
