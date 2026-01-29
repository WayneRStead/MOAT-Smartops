// core-backend/models/Task.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/* -------------------- Attachments -------------------- */
const AttachmentGeoSchema = new Schema(
  { lat: Number, lng: Number, accuracy: Number },
  { _id: false },
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
  { _id: true },
);

/* ----------------- Progress / Duration Log ----------------- */
const DurationLogSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["start", "pause", "resume", "complete", "photo", "fence"],
      required: true,
    },
    at: { type: Date, default: Date.now },

    userId: { type: Schema.Types.ObjectId, ref: "User" },

    // Optional metadata
    note: { type: String, default: "" },
    actorName: String,
    actorEmail: String,
    actorSub: String,

    // Milestone link
    milestoneId: {
      type: Schema.Types.ObjectId,
      ref: "TaskMilestone",
      index: true,
    },

    // Optional location
    lat: Number,
    lng: Number,
    accuracy: Number,

    // Edit audit
    editedAt: { type: Date },
    editedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: true },
);

/* ----------------------- Embedded Milestones (legacy) ----------------------- */
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
  { _id: true, timestamps: true },
);

/* ----------------------- Geo-fencing ----------------------- */
const GeoFenceSchema = new Schema(
  { lat: Number, lng: Number, radius: Number },
  { _id: false },
);

const GeoPointSchema = new Schema({ lat: Number, lng: Number }, { _id: false });

const GeoJSONSchema = new Schema(
  { type: { type: String }, coordinates: { type: Array } },
  { _id: false },
);

const KmlRefSchema = new Schema({ url: String, name: String }, { _id: false });

/* ------------------------- Helpers ------------------------- */
function normalizeStatus(v) {
  if (v == null) return v;
  const s = String(v).trim().toLowerCase();
  if (["done", "finish", "finished", "complete", "completed"].includes(s))
    return "completed";
  if (
    [
      "in progress",
      "in-progress",
      "inprogress",
      "started",
      "start",
      "resume",
      "resumed",
    ].includes(s)
  )
    return "in-progress";
  if (["pause", "paused"].includes(s)) return "paused";
  if (["open", "pending", "todo", "to-do", "planned", "plan"].includes(s))
    return "pending";
  if (
    [
      "paused - problem",
      "paused-problem",
      "problem",
      "blocked",
      "block",
      "issue",
    ].includes(s)
  )
    return "paused-problem";
  return v;
}

function normalizeTag(t) {
  return typeof t === "string" ? t.trim().toLowerCase() : "";
}

/**
 * Planning/analogue helpers:
 * - We store planning fields BUT keep startDate/dueAt as mirrors for older UI.
 */
function pickDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(+d) ? null : d;
}

/* ------------------------- Task ------------------------- */
const TaskSchema = new Schema(
  {
    // ORG SCOPE — allow string OR ObjectId
    orgId: { type: Schema.Types.Mixed, index: true },

    title: { type: String, required: true, index: "text" },
    description: { type: String, default: "" },

    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    groupId: { type: Schema.Types.ObjectId, ref: "Group", index: true },

    /* ===================== Planning / "Analogue" Fields (NEW) ===================== */

    // Optional "lane"/workstream concept (like left-hand responsibility rows in their sheet)
    workstreamId: {
      type: Schema.Types.ObjectId,
      ref: "Workstream",
      index: true,
      default: null,
    },
    workstreamName: { type: String, default: "" }, // fallback if you don't create a Workstream model yet

    // Ordering for Gantt display and "analogue" sequencing
    rowOrder: { type: Number, default: 0, index: true }, // global within project
    laneOrder: { type: Number, default: 0, index: true }, // within workstream
    wbs: { type: String, default: "" }, // e.g. "2.1.3" if they plan like that
    phase: { type: String, default: "" }, // optional (e.g. "Concept", "Design", "Build")
    discipline: { type: String, default: "" }, // optional (e.g. "Civil", "Ecology")

    // Planning dates (keep separate so later you can show planned vs actual)
    plannedStartAt: { type: Date, index: true },
    plannedEndAt: { type: Date, index: true },

    // Actual dates (optional; can be set by mobile workflow later)
    actualStartAt: { type: Date, index: true },
    actualEndAt: { type: Date, index: true },

    // Optional quick flag: created from plan vs ad-hoc task
    createdFromPlan: { type: Boolean, default: false, index: true },

    /* ===================== Assignment ===================== */

    assignedTo: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],

    // Singular mirror for UI
    assignee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },

    /* ===================== Timeline (existing fields kept) ===================== */

    // Legacy timeline dates (kept for compatibility)
    startDate: { type: Date, index: true },
    dueDate: { type: Date, index: true },
    dueAt: { type: Date, index: true },

    status: {
      type: String,
      enum: ["pending", "in-progress", "paused", "completed"],
      default: "pending",
      index: true,
      set: normalizeStatus,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },

    tags: [{ type: String, index: true }],

    // Existing dependency list (kept)
    dependentTaskIds: [{ type: Schema.Types.ObjectId, ref: "Task" }],

    // NEW: dependency-ready structure (optional; doesn’t break anything)
    // lets you depend on tasks OR deliverables later without schema hacks
    dependsOn: [
      {
        kind: {
          type: String,
          enum: ["task", "milestone", "deliverable"],
          default: "task",
        },
        id: { type: Schema.Types.ObjectId },
        type: { type: String, enum: ["FS", "SS", "FF", "SF"], default: "FS" }, // finish-start default
      },
    ],

    // Enforcement flags
    enforceQRScan: { type: Boolean, default: false },
    enforceLocationCheck: { type: Boolean, default: false },

    locationGeoFence: { type: GeoFenceSchema, default: undefined },

    geoMode: {
      type: String,
      enum: ["off", "circle", "polygon", "kml"],
      default: "off",
    },

    geoPolygon: { type: [GeoPointSchema], default: undefined },
    geoJSON: { type: GeoJSONSchema, default: undefined },
    kmlRef: { type: KmlRefSchema, default: undefined },

    triggerOnEnterFence: { type: Boolean, default: false },

    estimatedDuration: { type: Number }, // minutes
    actualDurationLog: [DurationLogSchema], // sequence

    // Legacy embedded milestones (you can keep using this OR migrate fully to TaskMilestone docs)
    milestones: { type: [MilestoneSchema], default: [] },

    attachments: [AttachmentSchema],

    /* ------------ Visibility Model ------------ */
    visibilityMode: {
      type: String,
      enum: [
        "org",
        "assignees",
        "groups",
        "assignees+groups",
        "restricted",
        "admins",
      ],
      default: "org",
      index: true,
    },

    assignedUserIds: [
      { type: Schema.Types.ObjectId, ref: "User", index: true },
    ],
    assignedGroupIds: [
      { type: Schema.Types.ObjectId, ref: "Group", index: true },
    ],

    // Soft delete
    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);

        // Ensure old clients always see these mirrors:
        if (!ret.dueAt && ret.dueDate) ret.dueAt = ret.dueDate;

        // Planning mirrors (for frontends that only know startDate/dueAt)
        if (!ret.startDate && ret.plannedStartAt)
          ret.startDate = ret.plannedStartAt;
        if (!ret.dueAt && ret.plannedEndAt) ret.dueAt = ret.plannedEndAt;

        // Mirror assignee from assignedTo[0] if needed
        if (
          !ret.assignee &&
          Array.isArray(ret.assignedTo) &&
          ret.assignedTo.length
        ) {
          ret.assignee = ret.assignedTo[0];
        }

        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

/* ---------------------- Virtuals & Validators ---------------------- */

// Friendly alias for start date (lets old clients use startAt)
TaskSchema.virtual("startAt")
  .get(function () {
    return this.startDate;
  })
  .set(function (v) {
    this.startDate = v;
  });

// Friendly aliases for planning fields (defensive)
TaskSchema.virtual("planStartAt")
  .get(function () {
    return this.plannedStartAt;
  })
  .set(function (v) {
    this.plannedStartAt = v;
  });

TaskSchema.virtual("planEndAt")
  .get(function () {
    return this.plannedEndAt;
  })
  .set(function (v) {
    this.plannedEndAt = v;
  });

/**
 * Normalize tags & keep mirrors in sync before validation.
 * Key rule:
 * - plannedStartAt/plannedEndAt mirror into startDate/dueAt (so existing UI works)
 * - startDate/dueAt mirror back into planned fields (so older writes still populate planning)
 */
TaskSchema.pre("validate", function normalize(next) {
  if (typeof this.title === "string") this.title = this.title.trim();
  if (typeof this.description === "string")
    this.description = this.description.trim();
  if (typeof this.workstreamName === "string")
    this.workstreamName = this.workstreamName.trim();
  if (typeof this.wbs === "string") this.wbs = this.wbs.trim();
  if (typeof this.phase === "string") this.phase = this.phase.trim();
  if (typeof this.discipline === "string")
    this.discipline = this.discipline.trim();

  if (Array.isArray(this.tags)) {
    const dedup = Array.from(
      new Set(this.tags.map(normalizeTag).filter(Boolean)),
    );
    this.tags = dedup;
  }

  // Keep assignee <-> assignedTo[0] mirrored
  if (this.assignee && (!this.assignedTo || !this.assignedTo.length)) {
    this.assignedTo = [this.assignee];
  } else if (
    !this.assignee &&
    Array.isArray(this.assignedTo) &&
    this.assignedTo.length
  ) {
    this.assignee = this.assignedTo[0];
  } else if (
    this.assignee &&
    Array.isArray(this.assignedTo) &&
    this.assignedTo.length
  ) {
    const a = String(this.assignee);
    if (String(this.assignedTo[0]) !== a) this.assignedTo[0] = this.assignee;
  }

  // Keep dueAt <-> dueDate mirrored (prefer dueAt)
  if (this.dueAt && !this.dueDate) this.dueDate = this.dueAt;
  if (!this.dueAt && this.dueDate) this.dueAt = this.dueDate;
  if (this.dueAt && this.dueDate && +this.dueAt !== +this.dueDate) {
    this.dueDate = this.dueAt;
  }

  // Planning mirrors: plannedStartAt/plannedEndAt <-> startDate/dueAt
  const pS = pickDate(this.plannedStartAt);
  const pE = pickDate(this.plannedEndAt);
  const sD = pickDate(this.startDate);
  const dA = pickDate(this.dueAt || this.dueDate);

  if (pS && !sD) this.startDate = pS;
  if (pE && !dA) this.dueAt = pE;

  if (!pS && sD) this.plannedStartAt = sD;
  if (!pE && dA) this.plannedEndAt = dA;

  // Ensure plannedEndAt always exists if dueAt exists (helps Gantt spans)
  if (!this.plannedEndAt && this.dueAt) this.plannedEndAt = this.dueAt;
  if (!this.plannedStartAt && this.startDate)
    this.plannedStartAt = this.startDate;

  // If planned dates exist and legacy differs, trust planning (so Gantt wins)
  if (
    this.plannedStartAt &&
    this.startDate &&
    +this.plannedStartAt !== +this.startDate
  ) {
    this.startDate = this.plannedStartAt;
  }
  if (this.plannedEndAt && this.dueAt && +this.plannedEndAt !== +this.dueAt) {
    this.dueAt = this.plannedEndAt;
    this.dueDate = this.plannedEndAt;
  }

  next();
});

// Guard: startDate must not be after dueAt (if both provided)
TaskSchema.path("startDate").validate(function (value) {
  if (!value) return true;
  const due = this.dueAt || this.dueDate;
  if (due && value > due) return false;
  return true;
}, "startDate cannot be after due date");

// Guard: plannedStartAt must not be after plannedEndAt (if both provided)
TaskSchema.path("plannedStartAt").validate(function (value) {
  if (!value) return true;
  if (!this.plannedEndAt) return true;
  return value <= this.plannedEndAt;
}, "plannedStartAt cannot be after plannedEndAt");

/* --------------------------- Indexes --------------------------- */
TaskSchema.index({
  projectId: 1,
  groupId: 1,
  status: 1,
  dueDate: 1,
  updatedAt: -1,
});
TaskSchema.index({ projectId: 1, startDate: 1, dueAt: 1 });
TaskSchema.index({ projectId: 1, workstreamId: 1, rowOrder: 1, laneOrder: 1 });
TaskSchema.index({ projectId: 1, plannedStartAt: 1, plannedEndAt: 1 });
TaskSchema.index({ orgId: 1, visibilityMode: 1 });
TaskSchema.index({ orgId: 1, assignedUserIds: 1 });
TaskSchema.index({ orgId: 1, assignedGroupIds: 1 });
TaskSchema.index({ geoJSON: "2dsphere" }, { sparse: true });
TaskSchema.index({ "milestones.status": 1 });
TaskSchema.index({ "milestones.dueAt": 1 });

module.exports = mongoose.models.Task || mongoose.model("Task", TaskSchema);
