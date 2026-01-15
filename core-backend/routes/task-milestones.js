// core-backend/routes/task-milestones.js
// ✅ DROP-IN replacement
// Purpose:
// - Keeps new TaskMilestone collection working
// - ALSO returns legacy embedded milestones stored in Task.milestones[]
// - Fixes "No deliverables yet" when old milestones exist

const express = require("express");
const mongoose = require("mongoose");

const { requireAuth } = require("../middleware/auth");
const Task = require("../models/Task");
const TaskMilestone = require("../models/TaskMilestone");

const router = express.Router();

/* ------------------------- Helpers ------------------------- */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const OID = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

function allowRoles(...roles) {
  const allow = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const role = String(req.user?.role || req.user?.claims?.role || "").toLowerCase();
    if (!allow.length) return next();
    if (!role) return res.sendStatus(401);
    if (!allow.includes(role)) return res.sendStatus(403);
    next();
  };
}

const wantsObjectId = (model, p) => model?.schema?.path(p)?.instance === "ObjectId";
function hasPath(model, p) {
  return !!(model && model.schema && model.schema.path && model.schema.path(p));
}

/**
 * IMPORTANT:
 * - If token orgId is NOT a valid ObjectId (e.g. "root"), do NOT scope by org at all.
 */
function orgScope(model, req) {
  if (!hasPath(model, "orgId")) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  if (wantsObjectId(model, "orgId")) return { orgId: new mongoose.Types.ObjectId(s) };
  return { orgId: s };
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------- Normalizers ------------------------- */

// Shape the frontend expects (simple, consistent)
function normalizeNewMilestone(m) {
  const obj = m?.toObject ? m.toObject() : m;
  return {
    _id: String(obj._id),
    id: String(obj._id),
    taskId: obj.taskId ? String(obj.taskId) : null,

    // canonical names
    name: obj.name || "",
    title: obj.name || "",

    startPlanned: obj.startPlanned || null,
    endPlanned: obj.endPlanned || null,

    status: obj.status || "pending",
    actualEndAt: obj.actualEndAt || null,
    roadblock: !!obj.roadblock,
    requires: Array.isArray(obj.requires) ? obj.requires.map(String) : [],

    // audit
    createdAt: obj.createdAt || null,
    updatedAt: obj.updatedAt || null,

    // flags
    source: "taskMilestone",
  };
}

// Convert legacy Task.milestones[] rows to the same response shape
function normalizeLegacyMilestone(row, taskId) {
  const id = row?._id ? String(row._id) : `legacy_${Math.random().toString(16).slice(2)}`;

  // legacy had: title, dueAt, status(open/done), completedAt, assignee, notes, order
  const legacyStatus = String(row?.status || "open").toLowerCase() === "done" ? "finished" : "pending";

  return {
    _id: id,
    id,
    taskId: String(taskId),

    // canonical names
    name: row?.title || "",
    title: row?.title || "",

    // legacy has only a due date. We'll treat that as endPlanned.
    startPlanned: null,
    endPlanned: row?.dueAt ? new Date(row.dueAt) : null,

    // map to new-style status
    status: legacyStatus,
    actualEndAt: row?.completedAt ? new Date(row.completedAt) : null,
    roadblock: false,
    requires: [],

    // extras (kept as best-effort)
    notes: row?.notes || "",
    order: typeof row?.order === "number" ? row.order : 0,
    assignee: row?.assignee ? String(row.assignee) : null,

    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,

    source: "task.milestones",
  };
}

function sortMilestones(a, b) {
  // Prefer endPlanned, then startPlanned, then createdAt, then name
  const ae = a.endPlanned ? new Date(a.endPlanned).getTime() : Infinity;
  const be = b.endPlanned ? new Date(b.endPlanned).getTime() : Infinity;
  if (ae !== be) return ae - be;

  const as = a.startPlanned ? new Date(a.startPlanned).getTime() : Infinity;
  const bs = b.startPlanned ? new Date(b.startPlanned).getTime() : Infinity;
  if (as !== bs) return as - bs;

  const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (ac !== bc) return ac - bc;

  return String(a.name || "").localeCompare(String(b.name || ""));
}

/* ------------------------- Routes ------------------------- */

/**
 * GET /tasks/:taskId/milestones?limit=500
 * Returns BOTH:
 * - TaskMilestone collection records
 * - legacy Task.milestones[] embedded rows
 */
router.get("/:taskId/milestones", requireAuth, async (req, res) => {
  try {
    const taskId = OID(req.params.taskId);
    if (!taskId) return res.status(400).json({ error: "bad taskId" });

    const lim = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);

    // Load task so we can pull legacy embedded milestones (and also verify it exists in org)
    const task = await Task.findOne({ _id: taskId, ...orgScope(Task, req) }).lean();
    if (!task) return res.status(404).json({ error: "Task not found" });

    // New milestones from collection
    const newer = await TaskMilestone.find({ taskId, ...orgScope(TaskMilestone, req) })
      .sort({ endPlanned: 1, startPlanned: 1, createdAt: 1 })
      .limit(lim)
      .lean();

    const newList = newer.map(normalizeNewMilestone);

    // Legacy embedded milestones from Task
    const legacyRows = Array.isArray(task.milestones) ? task.milestones : [];
    const legacyList = legacyRows.map((row) => normalizeLegacyMilestone(row, taskId));

    // Merge and sort
    const merged = [...legacyList, ...newList].sort(sortMilestones).slice(0, lim);

    res.json(merged);
  } catch (e) {
    console.error("GET /tasks/:taskId/milestones error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /tasks/:taskId/milestones
 * Creates a NEW TaskMilestone (collection-based).
 * (We do NOT write into legacy Task.milestones anymore.)
 */
router.post("/:taskId/milestones", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const taskId = OID(req.params.taskId);
    if (!taskId) return res.status(400).json({ error: "bad taskId" });

    const task = await Task.findOne({ _id: taskId, ...orgScope(Task, req) });
    if (!task) return res.status(404).json({ error: "Task not found" });

    const b = req.body || {};
    const name = String(b.name || b.title || "").trim();
    if (!name) return res.status(400).json({ error: "name/title required" });

    const startPlanned = parseDate(b.startPlanned || b.startAt || b.startDate);
    const endPlanned = parseDate(b.endPlanned || b.endAt || b.dueAt || b.dueDate);

    // Your schema requires both planned dates
    if (!startPlanned || !endPlanned) {
      return res.status(400).json({ error: "startPlanned and endPlanned required" });
    }
    if (endPlanned < startPlanned) {
      return res.status(400).json({ error: "endPlanned cannot be before startPlanned" });
    }

    const doc = new TaskMilestone({
      name,
      taskId,
      startPlanned,
      endPlanned,
      status: b.status || "pending",
      roadblock: !!b.roadblock,
      requires: Array.isArray(b.requires) ? b.requires.filter(isId).map((x) => new mongoose.Types.ObjectId(x)) : [],
      ...(hasPath(TaskMilestone, "orgId") ? { orgId: orgScope(TaskMilestone, req).orgId } : {}),
    });

    await doc.save();

    res.status(201).json(normalizeNewMilestone(doc));
  } catch (e) {
    console.error("POST /tasks/:taskId/milestones error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PATCH /tasks/:taskId/milestones/:id
 * Updates collection-based milestone only (new system).
 */
router.patch("/:taskId/milestones/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const taskId = OID(req.params.taskId);
    const id = OID(req.params.id);
    if (!taskId || !id) return res.status(400).json({ error: "bad id" });

    const doc = await TaskMilestone.findOne({ _id: id, taskId, ...orgScope(TaskMilestone, req) });
    if (!doc) return res.status(404).json({ error: "Milestone not found" });

    const b = req.body || {};
    if (b.name != null || b.title != null) doc.name = String(b.name ?? b.title).trim();
    if (b.status != null) doc.status = b.status;

    if ("startPlanned" in b || "startAt" in b || "startDate" in b) {
      const d = parseDate(b.startPlanned || b.startAt || b.startDate);
      if (d) doc.startPlanned = d;
    }
    if ("endPlanned" in b || "endAt" in b || "dueAt" in b || "dueDate" in b) {
      const d = parseDate(b.endPlanned || b.endAt || b.dueAt || b.dueDate);
      if (d) doc.endPlanned = d;
    }
    if (doc.endPlanned < doc.startPlanned) {
      return res.status(400).json({ error: "endPlanned cannot be before startPlanned" });
    }

    if ("roadblock" in b) doc.roadblock = !!b.roadblock;
    if ("requires" in b) {
      doc.requires = Array.isArray(b.requires) ? b.requires.filter(isId).map((x) => new mongoose.Types.ObjectId(x)) : [];
    }
    if ("actualEndAt" in b || "endActual" in b) {
      const d = parseDate(b.actualEndAt || b.endActual);
      doc.actualEndAt = d || undefined;
    }

    await doc.save();
    res.json(normalizeNewMilestone(doc));
  } catch (e) {
    console.error("PATCH /tasks/:taskId/milestones/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /tasks/:taskId/milestones/:id
 * Deletes collection-based milestone only.
 */
router.delete("/:taskId/milestones/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const taskId = OID(req.params.taskId);
    const id = OID(req.params.id);
    if (!taskId || !id) return res.status(400).json({ error: "bad id" });

    const del = await TaskMilestone.findOneAndDelete({ _id: id, taskId, ...orgScope(TaskMilestone, req) });
    if (!del) return res.status(404).json({ error: "Milestone not found" });

    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /tasks/:taskId/milestones/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
