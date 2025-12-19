// server/models/ManagerNote.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/**
 * ManagerNote
 * - One record per note/status update made by a manager on a task.
 * - Kept separate from Task to make reporting and pagination easy.
 */
const ManagerNoteSchema = new Schema(
  {
    taskId: { type: Types.ObjectId, ref: "Task", required: true, index: true },

    // optional denorms (nice for dashboards and faster filters)
    projectId: { type: Types.ObjectId, ref: "Project" },
    orgId: { type: Types.ObjectId, ref: "Org" },

    at: { type: Date, default: () => new Date(), index: true }, // when note was made
    status: {
      type: String,
      trim: true,
      default: "pending",
    }, // e.g. "pending", "started", "paused", "paused - problem", "finished"

    note: { type: String, trim: true, default: "" },

    author: {
      id: { type: Types.ObjectId, ref: "User" },
      name: { type: String, trim: true },
      email: { type: String, trim: true },
    },

    // soft delete (optional)
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
  }
);

// Helpful compound index for task detail screen
ManagerNoteSchema.index({ taskId: 1, at: -1 });

// If you plan org-wide reports later
ManagerNoteSchema.index({ projectId: 1, at: -1 });

module.exports = mongoose.models.ManagerNote || mongoose.model("ManagerNote", ManagerNoteSchema);
