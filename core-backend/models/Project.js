// core-backend/models/Project.js
const mongoose = require("mongoose");

/* ---------- Back-compat UI-style fences (kept) ---------- */
// This is your existing format used by older code & data:
// [{ type: 'circle'|'polygon', center:{lat,lng}, radius, polygon:[[lng,lat], ...] }]
const UiGeoFenceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["circle", "polygon"], required: true },
    // circle
    center: { lat: Number, lng: Number },
    radius: Number, // meters
    // polygon (outer ring, [lng,lat] pairs)
    polygon: {
      type: [[Number]],
      default: undefined,
    },
  },
  { _id: false }
);

/* ---------- Canonical geofence field pieces (match Task) ---------- */
const CircleFenceSchema = new mongoose.Schema(
  { lat: Number, lng: Number, radius: Number },
  { _id: false }
);

const GeoPointSchema = new mongoose.Schema(
  { lat: Number, lng: Number },
  { _id: false }
);

const GeoJSONSchema = new mongoose.Schema(
  {
    type: { type: String },     // "Polygon" | "MultiPolygon"
    coordinates: { type: Array } // standard GeoJSON coordinates array
  },
  { _id: false }
);

const KmlRefSchema = new mongoose.Schema(
  {
    url: String,   // e.g. /files/fences/projects/<projectId>/<ts>/fence.kmz
    name: String,  // original filename for display
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

    /* ---------- Geofencing ---------- */
    // New canonical fields (routes/projects-geofences.js writes these):
    geoMode: {
      type: String,
      enum: ["off", "circle", "polygon", "kml"],
      default: "off",
    },
    locationGeoFence: { type: CircleFenceSchema, default: undefined }, // simple circle
    geoPolygon:       { type: [GeoPointSchema], default: undefined },  // legacy polygon points
    geoJSON:          { type: GeoJSONSchema, default: undefined },     // canonical polygons/multipolygons
    kmlRef:           { type: KmlRefSchema, default: undefined },      // stored KML/KMZ reference

    // Back-compat array (kept so older data still loads & older readers don’t crash)
    geoFences:        { type: [UiGeoFenceSchema], default: [] },
  },
  { timestamps: true }
);

/* ---------- Indexes ---------- */
// Text index (schema-level)
ProjectSchema.index({ name: "text", description: "text", tags: "text" });

// Helpful compound indexes
ProjectSchema.index({ name: 1, status: 1 });
ProjectSchema.index({ tags: 1, status: 1 });

// If you store GeoJSON polygons, this helps; safe to add.
ProjectSchema.index({ geoJSON: "2dsphere" }, { sparse: true });

/* ---------- Export (dev-safe) ---------- */
module.exports = mongoose.models.Project || mongoose.model("Project", ProjectSchema);
