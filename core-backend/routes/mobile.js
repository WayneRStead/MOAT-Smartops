// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();

const mongoose = require("mongoose");

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

/* ------------------------------------------------------------------ */
/*  Offline Events collection (raw ingestion)                          */
/* ------------------------------------------------------------------ */

const OfflineEventSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventType: { type: String, index: true },
    entityRef: { type: String },
    payload: { type: Object },
    fileUris: { type: [String], default: [] },
    createdAtClient: { type: String },
    receivedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

const OfflineEvent =
  mongoose.models.OfflineEvent ||
  mongoose.model("OfflineEvent", OfflineEventSchema);

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function modelIfExists(name) {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
}

function asObjectIdOrNull(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (mongoose.isValidObjectId(v))
    return new mongoose.Types.ObjectId(String(v));
  return null;
}

/**
 * Task assignment query builder:
 * We don’t know your schema field names, so we try common ones.
 * Any of these matching the current user counts as “allocated to user”.
 */
function buildTaskAssignedToUserOr(reqUserId) {
  const uid = asObjectIdOrNull(reqUserId);
  if (!uid) return { _id: { $exists: false } }; // will match nothing safely

  return {
    $or: [
      // common patterns
      { assignedTo: uid },
      { assignedUserId: uid },
      { assignee: uid },
      { ownerId: uid },
      { userId: uid },

      // arrays of user ids
      { assignedToIds: uid },
      { assignedUsers: uid },
      { assignees: uid },
      { allocatedUsers: uid },

      // embedded objects
      { "assignedTo._id": uid },
      { "assignee._id": uid },
      { "owner._id": uid },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Auth for all routes                                                */
/* ------------------------------------------------------------------ */

router.use(requireAuth, resolveOrgContext, requireOrg);

/* ------------------------------------------------------------------ */
/*  POST /api/mobile/offline-events                                    */
/* ------------------------------------------------------------------ */

router.post("/offline-events", async (req, res, next) => {
  try {
    const body = req.body || {};

    const orgId = req.orgObjectId || req.user?.orgId;
    const userId = req.user?._id || null;

    const doc = await OfflineEvent.create({
      orgId,
      userId,
      eventType: body.eventType || "unknown",
      entityRef: body.entityRef || null,
      payload: body.payload || {},
      fileUris: Array.isArray(body.fileUris) ? body.fileUris : [],
      createdAtClient: body.createdAt || null,
    });

    res.json({ ok: true, id: doc._id });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/mobile/lists                                              */
/*  Used by mobile app to cache dropdown lists for offline use         */
/* ------------------------------------------------------------------ */

router.get("/lists", async (req, res, next) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;
    const userId = req.user?._id;

    if (!orgId) {
      return res.status(400).json({ error: "Missing org context" });
    }

    // Models (must exist in your backend)
    const Task = modelIfExists("Task") || require("../models/Task");
    const Project = modelIfExists("Project") || require("../models/Project");
    const User = modelIfExists("User") || require("../models/User");

    // Optional model(s)
    const TaskMilestone =
      modelIfExists("TaskMilestone") || modelIfExists("Milestone") || null;

    // 1) TASKS allocated to user (robust multi-field matching)
    const taskWhere = {
      orgId,
      isDeleted: { $ne: true },
      ...buildTaskAssignedToUserOr(userId),
    };

    const tasks = await Task.find(taskWhere)
      .select(
        "_id title name status state projectId project taskId code number milestone milestones",
      )
      .sort({ updatedAt: -1 })
      .lean();

    // 2) PROJECTS: prefer only projects referenced by these tasks (best UX)
    const projectIds = new Set();
    for (const t of tasks || []) {
      const pid =
        asObjectIdOrNull(t.projectId) ||
        asObjectIdOrNull(t.project?._id) ||
        asObjectIdOrNull(t.project);
      if (pid) projectIds.add(String(pid));
    }

    let projects = [];
    if (projectIds.size > 0) {
      projects = await Project.find({
        orgId,
        isDeleted: { $ne: true },
        _id: {
          $in: Array.from(projectIds).map(
            (x) => new mongoose.Types.ObjectId(x),
          ),
        },
      })
        .select("_id name title code number status")
        .sort({ updatedAt: -1 })
        .lean();
    } else {
      // fallback: if no tasks found, still allow “project selected” dropdown
      projects = await Project.find({
        orgId,
        isDeleted: { $ne: true },
      })
        .select("_id name title code number status")
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean();
    }

    // 3) MILESTONES: if you have a milestone collection, return it.
    // Otherwise, mobile can derive milestones from tasks (if tasks include milestone fields).
    let milestones = [];
    if (TaskMilestone) {
      milestones = await TaskMilestone.find({
        orgId,
        isDeleted: { $ne: true },
      })
        .select("_id name title taskId projectId status order")
        .sort({ order: 1, updatedAt: -1 })
        .lean();
    }

    // 4) USERS: minimal list for “attach document to user” etc.
    // If you later want access-scoped users only, we can tighten this.
    const users = await User.find({
      orgId,
      isDeleted: { $ne: true },
      active: { $ne: false },
    })
      .select("_id name email role roles")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    res.json({
      ok: true,
      projects: projects || [],
      tasks: tasks || [],
      milestones: milestones || [],
      users: users || [],
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
