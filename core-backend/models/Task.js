// core-backend/models/Task.js
const mongoose = require("mongoose");

/* -------------------- Attachments -------------------- */
// now supports note + optional geo (for photo EXIF / device location)
const AttachmentGeoSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    accuracy: Number, // meters if available
  },
  { _id: false }
);

const AttachmentSchema = new mongoose.Schema(
  {
    filename: String,
    url: String,
    mime: String,
    size: Number,
    note: { type: String, default: "" },                     // store note with the file
    geo: { type: AttachmentGeoSchema, default: undefined },  // optional photo geolocation
    uploadedBy: String,                                      // display name/email of uploader
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true } // keep ids on attachments
);

/* ----------------- Progress / Duration Log ----------------- */
// includes "photo" entry + edit audit + actor info
const DurationLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["start", "pause", "resume", "complete", "photo"],
      required: true,
    },
    at: { type: Date, default: Date.now },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Optional metadata (populated by routes)
    note: { type: String, default: "" },
    actorName: String,
    actorEmail: String,
    actorSub: String,

    // Edit audit
    editedAt: { type: Date },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: true }
);

/* ----------------------- Geo-fencing ----------------------- */
// Backward-compatible circle fence (what you already had)
const GeoFenceSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    radius: Number, // meters
  },
  { _id: false }
);

// Optional polygon fence (simple lat/lng ring). Use either this OR GeoJSON below.
// Kept simple for easy rendering/editing; if you prefer GeoJSON only, you can remove this.
const GeoPointSchema = new mongoose.Schema(
  { lat: Number, lng: Number },
  { _id: false }
);

// Optional GeoJSON geometry (Polygon/MultiPolygon/Point) for map libs & 2dsphere queries
// Not required; kept flexible so you can store KML-converted geometry later.
const GeoJSONSchema = new mongoose.Schema(
  {
    type: { type: String }, // "Point" | "Polygon" | "MultiPolygon"
    coordinates: { type: Array }, // follows GeoJSON spec
  },
  { _id: false }
);

// Optional KML reference (if you store uploaded KML somewhere)
const KmlRefSchema = new mongoose.Schema(
  {
    url: String,   // storage URL to the KML file
    name: String,  // display name
  },
  { _id: false }
);

/* ------------------------- Task ------------------------- */
const TaskSchema = new mongoose.Schema(
  {
    // ORG SCOPE (NEW)
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", required: true, index: true },

    title: { type: String, required: true, index: "text" },
    description: { type: String, default: "" },

    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", index: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", index: true }, // owning/primary group (kept)

    // Business assignment list (kept as-is)
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    dueDate: { type: Date, index: true },

    status: {
      type: String,
      enum: ["pending", "in-progress", "paused", "completed"],
      default: "pending",
      index: true,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },
    tags: [{ type: String, index: true }],

    // dependencies & enforcement
    dependentTaskIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Task" }],

    // QR / geofence enforcement (existing flags retained)
    enforceQRScan: { type: Boolean, default: false },
    enforceLocationCheck: { type: Boolean, default: false },

    // LEGACY / SIMPLE CIRCLE FENCE (kept for compatibility)
    locationGeoFence: { type: GeoFenceSchema, default: undefined },

    // NEW: richer geofence mode declaration (optional)
    // - "off"       : no geofence
    // - "circle"    : use locationGeoFence (backward-compatible)
    // - "polygon"   : use geoPolygon or geoJSON
    // - "kml"       : use kmlRef (optionally also write its geometry to geoJSON)
    geoMode: {
      type: String,
      enum: ["off", "circle", "polygon", "kml"],
      default: "off",
    },

    // NEW: polygon (array of {lat,lng}) — easier to edit on simple UIs
    geoPolygon: { type: [GeoPointSchema], default: undefined },

    // NEW: optional GeoJSON geometry for map libs / precise queries
    geoJSON: { type: GeoJSONSchema, default: undefined },

    // NEW: optional KML reference (if you upload KML files)
    kmlRef: { type: KmlRefSchema, default: undefined },

    // NEW: behavior flags (purely optional)
    // - when true, mobile UIs can auto-enable the Start button if the user is within the fence
    // - enforceLocationCheck still guards the server-side "action" endpoint
    triggerOnEnterFence: { type: Boolean, default: false },

    estimatedDuration: { type: Number },              // minutes
    actualDurationLog: [DurationLogSchema],           // start/pause/resume/complete/photo sequence

    attachments: [AttachmentSchema],                  // now includes note + geo

    /* ------------ Visibility Model (NEW) ------------ */
    // Visibility semantics:
    // - 'org'        : visible to all users in the same org
    // - 'restricted' : visible to admins OR users in assignedUserIds OR members of assignedGroupIds
    // - 'admins'     : visible to admins only
    visibilityMode: {
      type: String,
      enum: ["org", "restricted", "admins"],
      default: "org",
      index: true,
    },

    // For visibility checks (separate from business `assignedTo`)
    assignedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],
    assignedGroupIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Group", index: true }],

    // Soft delete (optional)
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Handy compound index for common list queries
TaskSchema.index({ projectId: 1, groupId: 1, status: 1, dueDate: 1, updatedAt: -1 });

// Org + visibility fast-paths
TaskSchema.index({ orgId: 1, visibilityMode: 1 });
TaskSchema.index({ orgId: 1, "assignedUserIds": 1 });
TaskSchema.index({ orgId: 1, "assignedGroupIds": 1 });

// Optional: enable geospatial index if you plan to store Point/Polygon in geoJSON
// (safe even if many docs don't have geoJSON yet)
// NOTE: 2dsphere supports Point/LineString/Polygon/MultiPolygon etc.
TaskSchema.index({ geoJSON: "2dsphere" }, { sparse: true });

module.exports = mongoose.model("Task", TaskSchema);
