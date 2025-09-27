// core-backend/models/Task.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/* -------------------- Attachments -------------------- */
const AttachmentGeoSchema = new Schema(
  {
    lat: Number,
    lng: Number,
    accuracy: Number, // meters if available
  },
  { _id: false }
);

const AttachmentSchema = new Schema(
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
const DurationLogSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["start", "pause", "resume", "complete", "photo"],
      required: true,
    },
    at: { type: Date, default: Date.now },
    userId: { type: Schema.Types.ObjectId, ref: "User" },

    // Optional metadata (populated by routes)
    note: { type: String, default: "" },
    actorName: String,
    actorEmail: String,
    actorSub: String,

    // Edit audit
    editedAt: { type: Date },
    editedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: true }
);

/* ----------------------- Milestones ----------------------- */
const MilestoneSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    dueAt: { type: Date },
    status: { type: String, enum: ["open", "done"], default: "open" },
    completedAt: { type: Date },
    assignee: { type: Schema.Types.ObjectId, ref: "User" },
    notes: { type: String },
    order: { type: Number, default: 0 },
  },
  { _id: true, timestamps: true }
);

/* ----------------------- Geo-fencing ----------------------- */
const GeoFenceSchema = new Schema(
  {
    lat: Number,
    lng: Number,
    radius: Number, // meters
  },
  { _id: false }
);

const GeoPointSchema = new Schema(
  { lat: Number, lng: Number },
  { _id: false }
);

const GeoJSONSchema = new Schema(
  {
    type: { type: String }, // "Point" | "Polygon" | "MultiPolygon"
    coordinates: { type: Array }, // follows GeoJSON spec
  },
  { _id: false }
);

const KmlRefSchema = new Schema(
  {
    url: String,   // storage URL to the KML file
    name: String,  // display name
  },
  { _id: false }
);

/* ------------------------- Task ------------------------- */
const TaskSchema = new Schema(
  {
    // ORG SCOPE — allow string OR ObjectId; not required to avoid legacy data crashes
    orgId: { type: Schema.Types.Mixed, index: true },

    title: { type: String, required: true, index: "text" },
    description: { type: String, default: "" },

    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    groupId:   { type: Schema.Types.ObjectId, ref: "Group", index: true }, // owning/primary group (kept)

    // Business assignment list (kept as-is)
    assignedTo: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],

    // NEW: singular mirror of first assignee for UI compatibility
    assignee: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },

    // --- Timeline dates ---
    startDate: { type: Date, index: true },               // NEW: optional task start
    dueDate:   { type: Date, index: true },               // legacy mirror
    dueAt:     { type: Date, index: true },               // primary due used by UI

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
    dependentTaskIds: [{ type: Schema.Types.ObjectId, ref: "Task" }],

    // QR / geofence enforcement (existing flags retained)
    enforceQRScan: { type: Boolean, default: false },
    enforceLocationCheck: { type: Boolean, default: false },

    // LEGACY / SIMPLE CIRCLE FENCE
    locationGeoFence: { type: GeoFenceSchema, default: undefined },

    // richer geofence mode declaration
    geoMode: {
      type: String,
      enum: ["off", "circle", "polygon", "kml"],
      default: "off",
    },

    // polygon ring
    geoPolygon: { type: [GeoPointSchema], default: undefined },

    // GeoJSON geometry (optional)
    geoJSON: { type: GeoJSONSchema, default: undefined },

    // KML reference (optional)
    kmlRef: { type: KmlRefSchema, default: undefined },

    // behavior flags
    triggerOnEnterFence: { type: Boolean, default: false },

    estimatedDuration: { type: Number },              // minutes
    actualDurationLog: [DurationLogSchema],           // start/pause/resume/complete/photo sequence

    // NEW: milestones
    milestones: { type: [MilestoneSchema], default: [] },

    attachments: [AttachmentSchema],                  // now includes note + geo

    /* ------------ Visibility Model ------------ */
    // - 'org'                      : everyone in org
    // - 'assignees'                : assigned users only
    // - 'groups'                   : assigned groups only
    // - 'assignees+groups'         : user OR group
    // - 'restricted'               : (legacy) admins OR assigned users/groups
    // - 'admins'                   : admins only
    visibilityMode: {
      type: String,
      enum: ["org", "assignees", "groups", "assignees+groups", "restricted", "admins"],
      default: "org",
      index: true,
    },

    // For visibility checks (separate from business `assignedTo`)
    assignedUserIds:  [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    assignedGroupIds: [{ type: Schema.Types.ObjectId, ref: "Group", index: true }],

    // Soft delete (optional)
    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);

        // Ensure UI consumers always see these mirrors:
        if (!ret.dueAt && ret.dueDate) ret.dueAt = ret.dueDate;

        // Mirror assignee from assignedTo[0] if needed
        if (!ret.assignee && Array.isArray(ret.assignedTo) && ret.assignedTo.length) {
          ret.assignee = ret.assignedTo[0];
        }

        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* ---------------------- Virtuals & Validators ---------------------- */

// Friendly alias for start date (lets old clients use startAt)
TaskSchema.virtual('startAt')
  .get(function () { return this.startDate; })
  .set(function (v) { this.startDate = v; });

// Keep dueAt <-> dueDate mirrored (prefer dueAt from API) + tag normalization + assignee mirroring
function normalizeTag(t) { return typeof t === "string" ? t.trim().toLowerCase() : ""; }

TaskSchema.pre("validate", function normalize(next) {
  // Trim title/description
  if (typeof this.title === "string") this.title = this.title.trim();
  if (typeof this.description === "string") this.description = this.description.trim();

  // Tags: normalize & dedupe
  if (Array.isArray(this.tags)) {
    const dedup = Array.from(new Set(this.tags.map(normalizeTag).filter(Boolean)));
    this.tags = dedup;
  }

  // Keep assignee <-> assignedTo[0] mirrored
  if (this.assignee && (!this.assignedTo || !this.assignedTo.length)) {
    this.assignedTo = [this.assignee];
  } else if (!this.assignee && Array.isArray(this.assignedTo) && this.assignedTo.length) {
    this.assignee = this.assignedTo[0];
  } else if (this.assignee && Array.isArray(this.assignedTo) && this.assignedTo.length) {
    const a = String(this.assignee);
    if (String(this.assignedTo[0]) !== a) this.assignedTo[0] = this.assignee;
  }

  // Keep dueAt <-> dueDate mirrored (prefer dueAt from API)
  if (this.dueAt && !this.dueDate) this.dueDate = this.dueAt;
  if (!this.dueAt && this.dueDate) this.dueAt = this.dueDate;
  if (this.dueAt && this.dueDate && +this.dueAt !== +this.dueDate) {
    this.dueDate = this.dueAt;
  }

  next();
});

// Guard: startDate must not be after dueAt (if both provided)
TaskSchema.path('startDate').validate(function (value) {
  if (!value) return true;
  const due = this.dueAt || this.dueDate;
  if (due && value > due) return false;
  return true;
}, 'startDate cannot be after due date');

/* --------------------------- Indexes --------------------------- */
// Handy compound indexes for common list queries and timelines
TaskSchema.index({ projectId: 1, groupId: 1, status: 1, dueDate: 1, updatedAt: -1 });
TaskSchema.index({ projectId: 1, startDate: 1, dueAt: 1 }); // NEW: timeline-friendly

// Org + visibility fast-paths
TaskSchema.index({ orgId: 1, visibilityMode: 1 });
TaskSchema.index({ orgId: 1, assignedUserIds: 1 });
TaskSchema.index({ orgId: 1, assignedGroupIds: 1 });

// Optional 2dsphere index (sparse) if you store geoJSON
TaskSchema.index({ geoJSON: "2dsphere" }, { sparse: true });

// Helpful queries for milestones (optional)
TaskSchema.index({ "milestones.status": 1 });
TaskSchema.index({ "milestones.dueAt": 1 });

module.exports = mongoose.models.Task || mongoose.model("Task", TaskSchema);
