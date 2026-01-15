// core-backend/routes/task-milestones.js
// ✅ DROP-IN replacement: supports milestone kinds + planning fields + project-level list
// ✅ PLUS: merges legacy embedded milestones stored in Task.milestones[] (older data)

const express = require("express");
const mongoose = require("mongoose");
const Task = require("../models/Task");
const TaskMilestone = require("../models/TaskMilestone");

const router = express.Router({ mergeParams: true });

/* -------------------- helpers -------------------- */

const STATUS = ["pending", "started", "paused", "paused - problem", "finished"];
const KIND = ["milestone", "deliverable", "reporting"];

function normalizeStatus(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "planned" || s === "plan") return "pending";
  if (s === "complete" || s === "completed" || s === "done") return "finished";
  return STATUS.includes(s) ? s : undefined;
}

function normalizeKind(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["deliverable", "deliverables", "output"].includes(s)) return "deliverable";
  if (["report", "reporting", "reporting-point", "reporting point"].includes(s)) return "reporting";
  return "milestone";
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getOrgId(req) {
  return req.user?.orgId || req.headers["x-org-id"] || req.body?.orgId || undefined;
}

function asObjectIdArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(String)
    .filter(Boolean)
    .map((id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null))
    .filter(Boolean);
}

/**
 * Accept aliases from client and return canonical fields.
 */
function pickFields(src = {}) {
  const out = {};

  out.name =
    (src.name != null ? String(src.name).trim() : undefined) ??
    (src.title != null ? String(src.title).trim() : undefined);

  out.kind = normalizeKind(src.kind ?? src.type ?? src.milestoneType);

  out.startPlanned =
    parseDate(src.startPlanned) ||
    parseDate(src.startAt) ||
    parseDate(src.startDate) ||
    parseDate(src.plannedStartAt);

  out.endPlanned =
    parseDate(src.endPlanned) ||
    parseDate(src.endAt) ||
    parseDate(src.dueAt) ||
    parseDate(src.dueDate) ||
    parseDate(src.targetDate) ||
    parseDate(src.plannedEndAt) ||
    parseDate(src.endDate);

  out.actualEndAt =
    parseDate(src.actualEndAt) ||
    parseDate(src.endActual) ||
    parseDate(src.completedAt) ||
    parseDate(src.finishedAt);

  const norm = normalizeStatus(src.status);
  if (norm) out.status = norm;

  const rb = src.isRoadblock ?? src.roadblock ?? src.blocker ?? src.isRoadBlock;
  if (rb != null) out.isRoadblock = !!rb;

  const depends = src.dependsOn ?? src.requires ?? src.dependencies;
  if (depends != null) out.dependsOn = asObjectIdArray(depends);

  // planning extras
  if ("projectId" in src)
    out.projectId = mongoose.isValidObjectId(String(src.projectId))
      ? new mongoose.Types.ObjectId(String(src.projectId))
      : undefined;

  if ("workstreamId" in src)
    out.workstreamId = mongoose.isValidObjectId(String(src.workstreamId))
      ? new mongoose.Types.ObjectId(String(src.workstreamId))
      : null;

  if ("workstreamName" in src) out.workstreamName = String(src.workstreamName || "");
  if ("rowOrder" in src) out.rowOrder = Number.isFinite(Number(src.rowOrder)) ? Number(src.rowOrder) : undefined;
  if ("laneOrder" in src) out.laneOrder = Number.isFinite(Number(src.laneOrder)) ? Number(src.laneOrder) : undefined;
  if ("wbs" in src) out.wbs = String(src.wbs || "");
  if ("phase" in src) out.phase = String(src.phase || "");
  if ("notes" in src) out.notes = String(src.notes || "");

  // soft delete (optional)
  if ("isDeleted" in src) out.isDeleted = !!src.isDeleted;

  return out;
}

async function loadTaskForOrg(taskId, orgId) {
  if (!mongoose.isValidObjectId(taskId)) return null;
  const t = await Task.findById(taskId).lean();
  if (!t) return null;
  if (orgId) {
    const taskOrg = t.orgId || t.org || t.organizationId;
    if (String(taskOrg) !== String(orgId)) return "forbidden";
  }
  return t;
}

async function validate(task, fields, selfId = null) {
  if (!fields.name || !fields.startPlanned || !fields.endPlanned) {
    return "name, startPlanned and endPlanned are required";
  }
  if (fields.startPlanned > fields.endPlanned) {
    return "startPlanned cannot be after endPlanned";
  }

  // OPTIONAL constraint: keep milestones within task planned/due if due exists
  const due = task?.dueAt ? new Date(task.dueAt) : task?.dueDate ? new Date(task.dueDate) : null;
  if (due && fields.endPlanned > due) {
    // if you want to allow deliverables AFTER due, remove this guard
    return "endPlanned cannot be after the task due date";
  }

  if (fields.dependsOn?.length) {
    const count = await TaskMilestone.countDocuments({
      _id: { $in: fields.dependsOn },
      taskId: task._id,
      isDeleted: { $ne: true },
    });
    if (count !== fields.dependsOn.length) {
      return "All dependsOn milestones must exist and belong to this task";
    }
    if (selfId && fields.dependsOn.map(String).includes(String(selfId))) {
      return "A milestone cannot depend on itself";
    }
  }

  if (fields.kind && !KIND.includes(fields.kind)) {
    return "Invalid kind (milestone | deliverable | reporting)";
  }

  return null;
}

/* -------------------- NEW: legacy embedded milestones support -------------------- */
/**
 * Older data may exist under Task.milestones[] (embedded array).
 * We map those to the newer TaskMilestone response shape so the UI can display them.
 *
 * We do NOT write to legacy anymore — this is read-only compatibility.
 */
function normalizeLegacyEmbeddedMilestones(task) {
  const legacy = Array.isArray(task?.milestones) ? task.milestones : [];
  if (!legacy.length) return [];

  const taskStart = parseDate(task?.startDate || task?.startAt) || null;

  return legacy.map((m, idx) => {
    // legacy fields we’ve seen commonly:
    // { _id, title, dueAt, status: "open"|"done", completedAt, notes, order, assignee }
    const legacyId = m?._id ? String(m._id) : `legacy_${String(task._id)}_${idx}`;

    const legacyStatusRaw = String(m?.status || "").toLowerCase();
    const status = legacyStatusRaw === "done" ? "finished" : "pending";

    const endPlanned = parseDate(m?.dueAt || m?.dueDate) || null;

    return {
      _id: legacyId,
      // keep fields your UI expects
      name: String(m?.title || m?.name || "Legacy deliverable").trim(),
      kind: "deliverable", // safest assumption for “deliverables block”
      taskId: task._id,
      projectId: task?.projectId,

      startPlanned: taskStart, // best available anchor
      endPlanned,

      actualEndAt: parseDate(m?.completedAt || m?.actualEndAt) || undefined,
      status,

      roadblock: false,
      isRoadblock: false,
      requires: [],

      // planning extras
      workstreamId: null,
      workstreamName: "",
      rowOrder: Number.isFinite(Number(m?.order)) ? Number(m.order) : 0,
      laneOrder: 0,
      wbs: "",
      phase: "",
      notes: String(m?.notes || ""),

      // make clear it’s legacy
      _legacy: true,
      _legacySource: "Task.milestones[]",
    };
  });
}

/* ===================== NEW: PROJECT-LEVEL LIST (for Gantt) ===================== */
/**
 * GET /task-milestones?projectId=...
 * Useful when the Gantt wants to show all deliverables/reporting points without fetching per-task.
 */
router.get("/", async (req, res) => {
  try {
    const projectId = req.query.projectId;
    if (!projectId || !mongoose.isValidObjectId(String(projectId))) {
      return res.status(400).json({ error: "projectId required" });
    }

    const orgId = getOrgId(req);

    const where = {
      projectId: new mongoose.Types.ObjectId(String(projectId)),
      isDeleted: { $ne: true },
      ...(orgId ? { orgId } : {}),
    };

    const items = await TaskMilestone.find(where)
      .sort({ rowOrder: 1, laneOrder: 1, startPlanned: 1, createdAt: 1 })
      .lean();

    return res.json(items);
  } catch (err) {
    console.error("[milestones:project-list]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- Existing per-task routes (kept) -------------------- */

/**
 * GET /tasks/:taskId/milestones
 * ✅ NOW merges legacy embedded Task.milestones[] with TaskMilestone collection rows.
 */
router.get("/:taskId/milestones", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: "Task not found" });
    if (task === "forbidden") return res.status(403).json({ error: "Forbidden" });

    const where = { taskId: task._id, isDeleted: { $ne: true } };
    if (orgId) where.orgId = orgId;

    const items = await TaskMilestone.find(where)
      .sort({ rowOrder: 1, laneOrder: 1, startPlanned: 1, createdAt: 1 })
      .lean();

    // ✅ legacy merge
    const legacy = normalizeLegacyEmbeddedMilestones(task);

    // Merge, then sort similarly so UI stays stable
    const merged = [...legacy, ...(items || [])].sort((a, b) => {
      const ra = Number(a?.rowOrder || 0);
      const rb = Number(b?.rowOrder || 0);
      if (ra !== rb) return ra - rb;

      const la = Number(a?.laneOrder || 0);
      const lb = Number(b?.laneOrder || 0);
      if (la !== lb) return la - lb;

      const sa = a?.startPlanned ? new Date(a.startPlanned).getTime() : 0;
      const sb = b?.startPlanned ? new Date(b.startPlanned).getTime() : 0;
      if (sa !== sb) return sa - sb;

      const ca = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const cb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ca - cb;
    });

    return res.json(merged);
  } catch (err) {
    console.error("[milestones:list]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /tasks/:taskId/milestones
 */
router.post("/:taskId/milestones", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: "Task not found" });
    if (task === "forbidden") return res.status(403).json({ error: "Forbidden" });

    const fields = pickFields(req.body || {});
    fields.projectId = fields.projectId || task.projectId || undefined;

    const errMsg = await validate(task, fields);
    if (errMsg) return res.status(400).json({ error: errMsg });

    // auto stamp actual when finishing
    if (fields.status === "finished" && !fields.actualEndAt) fields.actualEndAt = new Date();
    if (fields.actualEndAt && !fields.status) fields.status = "finished";

    const created = await TaskMilestone.create({
      name: fields.name,
      kind: fields.kind || "milestone",

      taskId: task._id,
      projectId: fields.projectId,
      orgId,

      startPlanned: fields.startPlanned,
      endPlanned: fields.endPlanned,
      actualEndAt: fields.actualEndAt ?? undefined,

      status: fields.status ?? "pending",

      roadblock: !!fields.isRoadblock,
      isRoadblock: !!fields.isRoadblock,

      requires: fields.dependsOn || [],

      // planning extras
      workstreamId: fields.workstreamId ?? null,
      workstreamName: fields.workstreamName || "",
      rowOrder: fields.rowOrder ?? 0,
      laneOrder: fields.laneOrder ?? 0,
      wbs: fields.wbs || "",
      phase: fields.phase || "",
      notes: fields.notes || "",
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error("[milestones:create]", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message, details: err.errors });
    }
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * PATCH /tasks/:taskId/milestones/:milestoneId
 */
router.patch("/:taskId/milestones/:milestoneId", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: "Task not found" });
    if (task === "forbidden") return res.status(403).json({ error: "Forbidden" });

    const { milestoneId } = req.params;
    if (!mongoose.isValidObjectId(milestoneId)) {
      return res.status(400).json({ error: "Invalid milestone id" });
    }

    const doc = await TaskMilestone.findOne({
      _id: milestoneId,
      taskId: task._id,
      ...(orgId ? { orgId } : {}),
    });
    if (!doc) return res.status(404).json({ error: "Milestone not found" });

    // Merge for validation
    const merged = pickFields({ ...doc.toObject(), ...(req.body || {}) });
    merged.projectId = merged.projectId || doc.projectId || task.projectId || undefined;

    const errMsg = await validate(task, merged, doc._id);
    if (errMsg) return res.status(400).json({ error: errMsg });

    const incomingStatus = normalizeStatus(req.body?.status);
    const clientProvidedActual =
      "actualEndAt" in (req.body || {}) ||
      "endActual" in (req.body || {}) ||
      "completedAt" in (req.body || {}) ||
      "finishedAt" in (req.body || {});

    if (clientProvidedActual) {
      if (merged.actualEndAt && !incomingStatus) merged.status = "finished";
    } else if (incomingStatus) {
      if (incomingStatus === "finished") {
        if (!merged.actualEndAt) merged.actualEndAt = new Date();
      } else {
        merged.actualEndAt = null;
      }
      merged.status = incomingStatus;
    }

    if (merged.name != null) doc.name = merged.name;
    if (merged.kind) doc.kind = merged.kind;

    if (merged.projectId) doc.projectId = merged.projectId;

    if (merged.startPlanned != null) doc.startPlanned = merged.startPlanned;
    if (merged.endPlanned != null) doc.endPlanned = merged.endPlanned;

    if ("actualEndAt" in merged) doc.actualEndAt = merged.actualEndAt;

    if (merged.status) doc.status = merged.status;

    if (merged.isRoadblock != null) {
      doc.roadblock = !!merged.isRoadblock;
      doc.isRoadblock = !!merged.isRoadblock;
    }

    if (merged.dependsOn != null) {
      doc.requires = merged.dependsOn;
    }

    // planning extras
    if (merged.workstreamId !== undefined) doc.workstreamId = merged.workstreamId;
    if (merged.workstreamName !== undefined) doc.workstreamName = merged.workstreamName;
    if (merged.rowOrder !== undefined) doc.rowOrder = merged.rowOrder;
    if (merged.laneOrder !== undefined) doc.laneOrder = merged.laneOrder;
    if (merged.wbs !== undefined) doc.wbs = merged.wbs;
    if (merged.phase !== undefined) doc.phase = merged.phase;
    if (merged.notes !== undefined) doc.notes = merged.notes;

    if (merged.isDeleted !== undefined) doc.isDeleted = !!merged.isDeleted;

    await doc.save();
    return res.json(doc);
  } catch (err) {
    console.error("[milestones:update]", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message, details: err.errors });
    }
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /tasks/:taskId/milestones/:milestoneId
 * Soft delete to preserve planning history.
 */
router.delete("/:taskId/milestones/:milestoneId", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: "Task not found" });
    if (task === "forbidden") return res.status(403).json({ error: "Forbidden" });

    const { milestoneId } = req.params;
    if (!mongoose.isValidObjectId(milestoneId)) {
      return res.status(400).json({ error: "Invalid milestone id" });
    }

    const doc = await TaskMilestone.findOne({
      _id: milestoneId,
      taskId: task._id,
      ...(orgId ? { orgId } : {}),
    });
    if (!doc) return res.status(404).json({ error: "Milestone not found" });

    doc.isDeleted = true;
    await doc.save();

    // Remove dependency references (requires)
    await TaskMilestone.updateMany(
      { taskId: task._id, ...(orgId ? { orgId } : {}), isDeleted: { $ne: true } },
      { $pull: { requires: doc._id } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[milestones:delete]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
