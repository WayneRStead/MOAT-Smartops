// core-backend/models/TaskCoverage.js
const mongoose = require("mongoose");

const TaskCoverageSchema = new mongoose.Schema(
  {
    // orgId can be either string or ObjectId depending on how the org model evolved
    orgId: { type: mongoose.Schema.Types.Mixed, index: true },

    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      index: true,
    },

    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      index: true,
    },

    // ✅ Link back to the offline event so re-sync doesn't duplicate coverage docs
    sourceOfflineEventId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },

    // When this coverage applies (day bucket). If not provided, UI can fall back to createdAt.
    date: { type: Date, index: true },

    // Normalized GeoJSON-like geometry
    geometry: {
      type: {
        type: String,
        enum: ["Polygon", "MultiPolygon", "LineString", "MultiLineString"],
        required: true,
      },
      coordinates: { type: Array, required: true },
    },

    // Optional stats for quick UI listing
    stats: {
      areaSqM: { type: Number },
      lengthM: { type: Number },
      points: { type: Number },
      fences: { type: Number },
    },

    // Where it came from
    source: {
      type: String,
      enum: ["mobile-track", "file-upload", "inspection", "manual", "api"],
      default: "file-upload",
      index: true,
    },

    uploadedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
      },
      name: String,
      email: String,
    },

    // Original file reference (for audit / download)
    fileRef: {
      url: String,
      name: String,
      mime: String,
      size: Number,
    },

    // Small free-form note
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

// Helpful compound indexes for fast lookups in UI
TaskCoverageSchema.index({ orgId: 1, taskId: 1, date: -1, createdAt: -1 });
TaskCoverageSchema.index({ orgId: 1, projectId: 1, date: -1 });
TaskCoverageSchema.index({ createdAt: -1 });

// ✅ Prevent duplicates on re-sync of the same offline event
TaskCoverageSchema.index(
  { orgId: 1, taskId: 1, sourceOfflineEventId: 1 },
  { unique: true, sparse: true },
);

module.exports =
  mongoose.models.TaskCoverage ||
  mongoose.model("TaskCoverage", TaskCoverageSchema);
