// core-backend/models/TaskCoverage.js
const mongoose = require('mongoose');

const TaskCoverageSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.Mixed, index: true }, // string or ObjectId (to match your org model flexibility)
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },

    // When this coverage applies (day bucket). If not provided, server can derive from createdAt.
    date: { type: Date, index: true },

    // A normalized GeoJSON payload representing the “productivity” area/track for that day.
    // We’ll usually store MultiPolygon for areas; may also accept LineString (tracks) and compute area server-side.
    geometry: {
      type: { type: String, enum: ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'], required: true },
      coordinates: { type: Array, required: true },
    },

    // Optional stats the uploader/parser computed (helps quick listing)
    stats: {
      areaSqM: { type: Number },     // computed area in square meters (if polygon)
      lengthM: { type: Number },     // computed length in meters (if line)
      points:  { type: Number },     // raw vertex count
      fences:  { type: Number },     // number of rings/tracks parsed
    },

    // Where it came from and who did it
    source: { type: String, enum: ['mobile-track', 'file-upload', 'inspection', 'manual', 'api'], default: 'file-upload', index: true },
    uploadedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
      name: String,
      email: String,
    },

    // Keep a reference to original file if any (for audit/download)
    fileRef: {
      url: String,     // e.g. /files/coverage/tasks/<...>.kml|kmz|geojson
      name: String,    // original filename
      mime: String,
      size: Number,
    },

    // Small free-form note
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

// Helpful compound indexes for fast lookups in UI
TaskCoverageSchema.index({ orgId: 1, taskId: 1, date: -1, createdAt: -1 });
TaskCoverageSchema.index({ orgId: 1, projectId: 1, date: -1 });
TaskCoverageSchema.index({ createdAt: -1 });

module.exports = mongoose.models.TaskCoverage || mongoose.model('TaskCoverage', TaskCoverageSchema);
