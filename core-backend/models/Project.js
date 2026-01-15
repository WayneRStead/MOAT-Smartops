// core-backend/models/Project.js
const mongoose = require("mongoose");

/* ---------- Back-compat UI-style fences (kept) ---------- */
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
    type: { type: String }, // "Polygon" | "MultiPolygon"
    coordinates: { type: Array }, // standard GeoJSON coordinates array
  },
  { _id: false }
);

const KmlRefSchema = new mongoose.Schema(
  {
    url: String, // e.g. /files/fences/projects/<projectId>/<ts>/fence.kmz
    name: String, // original filename for display
  },
  { _id: false }
);

/* ------------------------------------------------------------------ */
/* ---------------------- NEW: Project Planning ---------------------- */
/* ------------------------------------------------------------------ */
/**
 * Planning items live on the Project so the Gantt can be used as the planning tool
 * BEFORE generating “real” tasks and deliverables.
 *
 * types:
 *  - task: generates a Task
 *  - deliverable: generates a TaskMilestone under a parent task
 *
 * dependencies:
 *  - dependsOnPlanningIds: references other PlanningItem _id values
 */
const PlanningItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["task", "deliverable"], required: true, index: true },

    title: { type: String, required: true, trim: true },

    // Optional detail / notes used for the created Task.description (or milestone notes later)
    description: { type: String, default: "" },

    // Planned dates (Gantt)
    startPlanned: { type: Date, required: true, index: true },
    endPlanned: { type: Date, required: true, index: true },

    // Hierarchy: deliverable belongs to a task planning item
    parentPlanningId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Dependencies between planning items (by planning ids)
    dependsOnPlanningIds: [{ type: mongoose.Schema.Types.ObjectId, default: [] }],

    // Optional assignment hints (used when generating Tasks)
    assigneeUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", default: null },

    // Optional planning metadata
    tags: [{ type: String, default: [] }],
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },

    // Optional ordering (for consistent UI display)
    order: { type: Number, default: 0 },

    // Planning-only status (does NOT replace Task status once generated)
    status: { type: String, enum: ["planned", "active", "done"], default: "planned" },

    // Optional external fields (safe placeholders; ignored unless you use them)
    wbsCode: { type: String, default: "" }, // e.g. "1.2.3"
    costEstimate: { type: Number }, // optional
  },
  { _id: true, timestamps: true }
);

const ProjectPlanningSchema = new mongoose.Schema(
  {
    // all planning items for this project
    items: { type: [PlanningItemSchema], default: [] },

    // generation audit
    generatedAt: { type: Date, default: null },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // mapping of planning item -> created record (for UI feedback)
    // example: { "<planningId>": { taskId, milestoneId } }
    lastGeneratedMap: { type: Object, default: {} },

    // helpful: track last plan edit time (optional)
    lastEditedAt: { type: Date, default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

/* ---------- Main schema ---------- */
const ProjectSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },

    name: { type: String, required: true },
    description: { type: String },
    status: {
      type: String,
      enum: ["active", "paused", "closed"],
      default: "active",
      index: true,
    },

    startDate: { type: Date },
    endDate: { type: Date },

    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    tags: [{ type: String, index: true }],

    // soft-delete fields (optional)
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // who created/updated (timestamps handled below)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    /* ---------- Geofencing ---------- */
    geoMode: {
      type: String,
      enum: ["off", "circle", "polygon", "kml"],
      default: "off",
    },
    locationGeoFence: { type: CircleFenceSchema, default: undefined }, // simple circle
    geoPolygon: { type: [GeoPointSchema], default: undefined }, // legacy polygon points
    geoJSON: { type: GeoJSONSchema, default: undefined }, // canonical polygons/multipolygons
    kmlRef: { type: KmlRefSchema, default: undefined }, // stored KML/KMZ reference

    // Back-compat array
    geoFences: { type: [UiGeoFenceSchema], default: [] },

    /* ---------- NEW: Planning ---------- */
    planning: { type: ProjectPlanningSchema, default: undefined },
  },
  { timestamps: true }
);

/* ---------- Indexes ---------- */
ProjectSchema.index({ name: "text", description: "text", tags: "text" });
ProjectSchema.index({ name: 1, status: 1 });
ProjectSchema.index({ tags: 1, status: 1 });
ProjectSchema.index({ geoJSON: "2dsphere" }, { sparse: true });

// Planning helpful indexes (safe)
ProjectSchema.index({ "planning.items.type": 1 });
ProjectSchema.index({ "planning.items.startPlanned": 1 });
ProjectSchema.index({ "planning.items.endPlanned": 1 });

/* ---------- Safety: normalize planning titles ---------- */
ProjectSchema.pre("validate", function (next) {
  try {
    if (this.planning?.items?.length) {
      for (const it of this.planning.items) {
        if (typeof it.title === "string") it.title = it.title.trim();
        if (typeof it.description === "string") it.description = it.description.trim();
      }
    }
  } catch {}
  next();
});

module.exports = mongoose.models.Project || mongoose.model("Project", ProjectSchema);
