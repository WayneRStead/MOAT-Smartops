// core-backend/models/Task.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/* -------------------- Attachments -------------------- */
const AttachmentGeoSchema = new Schema(
  { lat: Number, lng: Number, accuracy: Number },
  { _id: false }
);

const AttachmentSchema = new Schema(
  {
    filename: String,
    url: String,
    mime: String,
    size: Number,
    note: { type: String, default: "" },
    geo: { type: AttachmentGeoSchema, default: undefined },
    uploadedBy: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/* ----------------- Progress / Duration Log ----------------- */
const DurationLogSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["start", "pause", "resume", "complete", "photo", "fence"], // include "fence"
      required: true,
    },
    at: { type: Date, default: Date.now },

    userId: { type: Schema.Types.ObjectId, ref: "User" },

    // Optional metadata
    note: { type: String, default: "" },
    actorName: String,
    actorEmail: String,
    actorSub: String,

    // Milestone link (NEW)
    milestoneId: { type: Schema.Types.ObjectId, ref: "TaskMilestone", index: true },

    // Optional location (NEW)
    lat: Number,
    lng: Number,
    accuracy: Number,

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
  { lat: Number, lng: Number, radius: Number },
  { _id: false }
);

const GeoPointSchema = new Schema(
  { lat: Number, lng: Number },
  { _id: false }
);

const GeoJSONSchema = new Schema(
  { type: { type: String }, coordinates: { type: Array } },
  { _id: false }
);

const KmlRefSchema = new Schema(
  { url: String, name: String },
  { _id: false }
);

/* ------------------------- Helpers ------------------------- */
function normalizeStatus(v) {
  if (v == null) return v;
  const s = String(v).trim().toLowerCase();
  // friendly aliases
  if (["done", "finish", "finished", "complete", "completed"].includes(s)) return "completed";
  if (["in progress", "in-progress", "inprogress", "started", "start", "resume", "resumed"].includes(s)) return "in-progress";
  if (["pause", "paused"].includes(s)) return "paused";
  if (["open", "pending", "todo", "to-do"].includes(s)) return "pending";
  // fall through to original value so enum validation can decide
  return v;
}

/* ------------------------- Task ------------------------- */
const TaskSchema = new Schema(
  {
    // ORG SCOPE — allow string OR ObjectId
    orgId: { type: Schema.Types.Mixed, index: true },

    title: { type: String, required: true, index: "text" },
    description: { type: String, default: "" },

    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    groupId:   { type: Schema.Types.ObjectId, ref: "Group", index: true },

    // Business assignment list
    assignedTo: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],

    // Singular mirror for UI
    assignee: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },

    // Timeline dates
    startDate: { type: Date, index: true },
    dueDate:   { type: Date, index: true }, // legacy mirror
    dueAt:     { type: Date, index: true }, // canonical

    status: {
      type: String,
      enum: ["pending", "in-progress", "paused", "completed"],
      default: "pending",
      index: true,
      set: normalizeStatus, // <-- normalize incoming values
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },

    tags: [{ type: String, index: true }],

    dependentTaskIds: [{ type: Schema.Types.ObjectId, ref: "Task" }],

    // Enforcement flags
    enforceQRScan: { type: Boolean, default: false },
    enforceLocationCheck: { type: Boolean, default: false },

    locationGeoFence: { type: GeoFenceSchema, default: undefined },

    geoMode: { type: String, enum: ["off", "circle", "polygon", "kml"], default: "off" },

    geoPolygon: { type: [GeoPointSchema], default: undefined },
    geoJSON: { type: GeoJSONSchema, default: undefined },
    kmlRef: { type: KmlRefSchema, default: undefined },

    triggerOnEnterFence: { type: Boolean, default: false },

    estimatedDuration: { type: Number },      // minutes
    actualDurationLog: [DurationLogSchema],   // start/pause/resume/complete/photo/fence sequence

    milestones: { type: [MilestoneSchema], default: [] },

    attachments: [AttachmentSchema],

    /* ------------ Visibility Model ------------ */
    visibilityMode: {
      type: String,
      enum: ["org", "assignees", "groups", "assignees+groups", "restricted", "admins"],
      default: "org",
      index: true,
    },

    assignedUserIds:  [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    assignedGroupIds: [{ type: Schema.Types.ObjectId, ref: "Group", index: true }],

    // Soft delete
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

// Normalize tags & mirrors before validation
function normalizeTag(t) { return typeof t === "string" ? t.trim().toLowerCase() : ""; }

TaskSchema.pre("validate", function normalize(next) {
  if (typeof this.title === "string") this.title = this.title.trim();
  if (typeof this.description === "string") this.description = this.description.trim();

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

  // Keep dueAt <-> dueDate mirrored (prefer dueAt)
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
TaskSchema.index({ projectId: 1, groupId: 1, status: 1, dueDate: 1, updatedAt: -1 });
TaskSchema.index({ projectId: 1, startDate: 1, dueAt: 1 });
TaskSchema.index({ orgId: 1, visibilityMode: 1 });
TaskSchema.index({ orgId: 1, assignedUserIds: 1 });
TaskSchema.index({ orgId: 1, assignedGroupIds: 1 });
TaskSchema.index({ geoJSON: "2dsphere" }, { sparse: true });
TaskSchema.index({ "milestones.status": 1 });
TaskSchema.index({ "milestones.dueAt": 1 });

module.exports = mongoose.models.Task || mongoose.model("Task", TaskSchema);
