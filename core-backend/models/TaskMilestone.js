// core-backend/models/TaskMilestone.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const STATUS = ["pending", "started", "paused", "paused - problem", "finished"];

function normalizeStatus(v) {
  if (v == null) return v;
  const s = String(v).trim().toLowerCase();
  if (s === "planned" || s === "plan") return "pending";
  if (s === "complete" || s === "completed" || s === "done") return "finished";
  return v;
}

// NEW: milestone “type” (deliverable/reporting/milestone)
const KIND = ["milestone", "deliverable", "reporting"];

function normalizeKind(v) {
  if (!v) return "milestone";
  const s = String(v).trim().toLowerCase();
  if (["deliverable", "deliverables", "output"].includes(s)) return "deliverable";
  if (["report", "reporting", "reporting-point", "reporting point"].includes(s)) return "reporting";
  return "milestone";
}

function pickDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(+d) ? null : d;
}

const TaskMilestoneSchema = new Schema(
  {
    // NOTE: keep name for compatibility, but also support title as alias via virtual
    name: { type: String, required: true, trim: true },

    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },

    // OPTIONAL but very useful for fast “planning pack by project”
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },

    // Multi-tenant (make Mixed so it works with legacy + new orgs)
    orgId: { type: Schema.Types.Mixed, index: true },

    /* ===================== Planning / Analogue Fields (NEW) ===================== */

    kind: { type: String, enum: KIND, default: "milestone", set: normalizeKind, index: true },

    // Used for Gantt ordering and left-hand lane positioning
    workstreamId:   { type: Schema.Types.ObjectId, ref: "Workstream", index: true, default: null },
    workstreamName: { type: String, default: "" },
    rowOrder: { type: Number, default: 0, index: true },
    laneOrder:{ type: Number, default: 0, index: true },

    // Optional WBS/phase classification to match analogue planning docs
    wbs: { type: String, default: "" },
    phase: { type: String, default: "" },

    // Planned dates (server previously required these; keep required but be defensive)
    startPlanned: { type: Date, required: true, index: true },
    endPlanned:   { type: Date, required: true, index: true },

    // enum + safe mapper + safe default
    status: {
      type: String,
      enum: STATUS,
      default: "pending",
      set: normalizeStatus,
      index: true,
    },

    // Completion / actuals
    actualEndAt: { type: Date, index: true },
    completedAt: { type: Date, index: true },
    completedBy: { type: Schema.Types.ObjectId, ref: "User" },

    // “Roadblock” naming: keep both (roadblock + isRoadblock alias)
    roadblock: { type: Boolean, default: false },
    isRoadblock: { type: Boolean, default: false },

    // Dependencies (kept + expanded)
    requires: [{ type: Schema.Types.ObjectId, ref: "TaskMilestone" }],
    blockedBy: [{ type: Schema.Types.ObjectId, ref: "TaskMilestone" }],

    // Notes
    notes: { type: String, default: "" },

    // Soft delete (optional but helps planning edits)
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

/* ---------------------- Compatibility Virtuals ---------------------- */

// allow client to send/receive "title" and still map to name
TaskMilestoneSchema.virtual("title")
  .get(function () { return this.name; })
  .set(function (v) { this.name = v; });

// defensive alias used by some earlier UI logic
TaskMilestoneSchema.virtual("endActual")
  .set(function (v) { this.actualEndAt = v; })
  .get(function () { return this.actualEndAt; });

/* ---------------------- Pre-validate normalization ---------------------- */

TaskMilestoneSchema.pre("validate", function (next) {
  if (typeof this.name === "string") this.name = this.name.trim();
  if (typeof this.workstreamName === "string") this.workstreamName = this.workstreamName.trim();
  if (typeof this.wbs === "string") this.wbs = this.wbs.trim();
  if (typeof this.phase === "string") this.phase = this.phase.trim();
  if (typeof this.notes === "string") this.notes = this.notes.trim();

  // normalize status + kind
  if (this.status != null) this.status = normalizeStatus(this.status);
  this.kind = normalizeKind(this.kind);

  // keep roadblock mirrors consistent
  if (this.isRoadblock && !this.roadblock) this.roadblock = true;
  if (this.roadblock && !this.isRoadblock) this.isRoadblock = true;

  // Defensive: if only one planned date arrives, mirror it
  const s = pickDate(this.startPlanned);
  const e = pickDate(this.endPlanned);
  if (s && !e) this.endPlanned = s;
  if (!s && e) this.startPlanned = e;

  // Ensure planned start <= planned end
  if (this.startPlanned && this.endPlanned && this.startPlanned > this.endPlanned) {
    const tmp = this.startPlanned;
    this.startPlanned = this.endPlanned;
    this.endPlanned = tmp;
  }

  // If status is finished and completedAt missing, fill it
  if (String(this.status) === "finished") {
    if (!this.completedAt && this.actualEndAt) this.completedAt = this.actualEndAt;
    if (!this.completedAt) this.completedAt = new Date();
    if (!this.actualEndAt) this.actualEndAt = this.completedAt;
  }

  next();
});

module.exports = mongoose.models.TaskMilestone || mongoose.model("TaskMilestone", TaskMilestoneSchema);
