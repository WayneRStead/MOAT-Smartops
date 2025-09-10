// core-backend/models/Project.js
const mongoose = require("mongoose");

/* ---------- Subschemas ---------- */
const GeoFenceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["circle", "polygon"], required: true },
    // circle
    center: {
      lat: Number,
      lng: Number,
    },
    radius: Number, // meters
    // polygon
    polygon: {
      type: [[Number]], // [[lng, lat], ...] (KML/GeoJSON use [lng, lat] ordering)
      default: undefined,
    },
  },
  { _id: false }
);

/* ---------- Main schema ---------- */
const ProjectSchema = new mongoose.Schema(
  {
    orgId:       { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },

    name:        { type: String, required: true },
    description: { type: String },
    status:      { type: String, enum: ["active", "paused", "closed"], default: "active", index: true },

    startDate:   { type: Date },
    endDate:     { type: Date },

    manager:     { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    members:     [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    tags:        [{ type: String, index: true }],

    // soft-delete fields (optional)
    deletedAt:   { type: Date },
    deletedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // who created/updated (timestamps handled below)
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // NEW: reusable perimeters (tasks can inherit these)
    geoFences:   { type: [GeoFenceSchema], default: [] },
  },
  { timestamps: true } // adds createdAt/updatedAt automatically
);

/* ---------- Indexes ---------- */
// Text index (use schema.index, not path-level index: 'text')
ProjectSchema.index({ name: "text", description: "text", tags: "text" });

// Helpful compound indexes
ProjectSchema.index({ name: 1, status: 1 });
ProjectSchema.index({ tags: 1, status: 1 });

module.exports = mongoose.model("Project", ProjectSchema);
