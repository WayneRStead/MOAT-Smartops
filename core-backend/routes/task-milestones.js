// core-backend/routes/task-milestones.js
const express = require('express');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const TaskMilestone = require('../models/TaskMilestone');

const router = express.Router({ mergeParams: true });

/* -------------------- helpers -------------------- */

const STATUS = ['pending', 'started', 'paused', 'paused - problem', 'finished'];

function normalizeStatus(v) {
  if (v == null) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'planned' || s === 'plan') return 'pending';
  if (s === 'complete' || s === 'completed') return 'finished';
  return STATUS.includes(s) ? s : undefined;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getOrgId(req) {
  // prefer authenticated user, but allow header/body as fallback during migration
  return req.user?.orgId || req.headers['x-org-id'] || req.body?.orgId || undefined;
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
 * Accept every alias the frontend might send and return
 * the canonical fields our model/routes use.
 */
function pickFields(src = {}) {
  const out = {};

  // name/title
  out.name =
    (src.name != null ? String(src.name).trim() : undefined) ??
    (src.title != null ? String(src.title).trim() : undefined);

  // planned start (accept lots of aliases)
  out.startPlanned =
    parseDate(src.startPlanned) ||
    parseDate(src.startAt) ||
    parseDate(src.startDate) ||
    parseDate(src.plannedStartAt);

  // planned end (accept lots of aliases)
  out.endPlanned =
    parseDate(src.endPlanned) ||
    parseDate(src.endAt) ||
    parseDate(src.dueAt) ||
    parseDate(src.dueDate) ||
    parseDate(src.targetDate) ||
    parseDate(src.plannedEndAt) ||
    parseDate(src.endDate);

  // actual end (aliases → canonical: actualEndAt)
  out.actualEndAt =
    parseDate(src.actualEndAt) ||
    parseDate(src.endActual) ||
    parseDate(src.completedAt) ||
    parseDate(src.finishedAt);

  // status (normalize & validate)
  const norm = normalizeStatus(src.status);
  if (norm) out.status = norm;

  // roadblock flag (accept multiple field names)
  const rb =
    src.isRoadblock ??
    src.roadblock ??
    src.blocker ??
    src.isRoadBlock;
  if (rb != null) out.isRoadblock = !!rb;

  // dependencies (accept multiple field names)
  const depends =
    src.dependsOn ??
    src.requires ??
    src.dependencies;
  if (depends != null) out.dependsOn = asObjectIdArray(depends);

  return out;
}

async function loadTaskForOrg(taskId, orgId) {
  if (!mongoose.isValidObjectId(taskId)) return null;
  const t = await Task.findById(taskId).lean();
  if (!t) return null;
  if (orgId) {
    const taskOrg = t.orgId || t.org || t.organizationId;
    if (String(taskOrg) !== String(orgId)) return 'forbidden';
  }
  return t;
}

async function validate(task, fields, selfId = null) {
  if (!fields.name || !fields.startPlanned || !fields.endPlanned) {
    return 'name, startPlanned and endPlanned are required';
  }
  if (fields.startPlanned > fields.endPlanned) {
    return 'startPlanned cannot be after endPlanned';
  }
  const due = task?.dueAt ? new Date(task.dueAt) : null;
  if (due && fields.endPlanned > due) {
    return 'endPlanned cannot be after the task due date';
  }
  if (fields.dependsOn?.length) {
    // all dependencies must belong to the same task
    const count = await TaskMilestone.countDocuments({
      _id: { $in: fields.dependsOn },
      taskId: task._id,
    });
    if (count !== fields.dependsOn.length) {
      return 'All dependsOn milestones must exist and belong to this task';
    }
    if (selfId && fields.dependsOn.map(String).includes(String(selfId))) {
      return 'A milestone cannot depend on itself';
    }
  }
  return null;
}

/* -------------------- routes -------------------- */

/**
 * GET /tasks/:taskId/milestones
 */
router.get('/:taskId/milestones', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: 'Task not found' });
    if (task === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    const where = { taskId: task._id };
    if (orgId) where.orgId = orgId;

    const items = await TaskMilestone.find(where)
      .sort({ startPlanned: 1, createdAt: 1 })
      .lean();

    return res.json(items);
  } catch (err) {
    console.error('[milestones:list]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /tasks/:taskId/milestones
 * Accepts aliases from the client and mirrors fields so the model is happy
 * regardless of field naming.
 */
router.post('/:taskId/milestones', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: 'Task not found' });
    if (task === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    const fields = pickFields(req.body || {});
    const errMsg = await validate(task, fields);
    if (errMsg) return res.status(400).json({ error: errMsg });

    // auto-stamp actual when finishing (if not provided)
    if (fields.status === 'finished' && !fields.actualEndAt) {
      fields.actualEndAt = new Date();
    }
    // if actual provided but no status, mark finished
    if (fields.actualEndAt && !fields.status) {
      fields.status = 'finished';
    }

    const created = await TaskMilestone.create({
      name: fields.name,
      taskId: task._id,
      orgId,

      startPlanned: fields.startPlanned,
      endPlanned: fields.endPlanned,
      actualEndAt: fields.actualEndAt ?? undefined,

      status: fields.status ?? 'pending',

      // schema field is `roadblock`
      roadblock: !!fields.isRoadblock,

      // schema field is `requires`
      requires: fields.dependsOn || [],
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error('[milestones:create]', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message, details: err.errors });
    }
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /tasks/:taskId/milestones/:milestoneId
 * Keeps status and actualEndAt in sync in BOTH directions:
 * - status -> finished (without explicit actual) => stamp actualEndAt now
 * - status -> not finished (without explicit actual) => clear actualEndAt
 * - explicit actualEndAt provided => keep it; if non-null and no status provided, force status=finished
 */
router.patch('/:taskId/milestones/:milestoneId', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: 'Task not found' });
    if (task === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    const { milestoneId } = req.params;
    if (!mongoose.isValidObjectId(milestoneId)) {
      return res.status(400).json({ error: 'Invalid milestone id' });
    }

    const doc = await TaskMilestone.findOne({
      _id: milestoneId,
      taskId: task._id,
      ...(orgId ? { orgId } : {}),
    });
    if (!doc) return res.status(404).json({ error: 'Milestone not found' });

    // Merge existing doc with incoming body, then normalize into canonical fields
    const merged = pickFields({ ...doc.toObject(), ...(req.body || {}) });
    const errMsg = await validate(task, merged, doc._id);
    if (errMsg) return res.status(400).json({ error: errMsg });

    const incomingStatus = normalizeStatus(req.body?.status); // undefined | 'pending' | ... | 'finished'
    const clientProvidedActual =
      'actualEndAt' in (req.body || {}) ||
      'endActual'   in (req.body || {}) ||
      'completedAt' in (req.body || {}) ||
      'finishedAt'  in (req.body || {});

    // --- Auto-sync rules between status and actualEndAt ---
    if (clientProvidedActual) {
      // If client explicitly gives an actual end, keep it and ensure status is finished when it’s non-null (and status not explicitly sent)
      if (merged.actualEndAt && !incomingStatus) {
        merged.status = 'finished';
      }
    } else if (incomingStatus) {
      if (incomingStatus === 'finished') {
        // No explicit actual provided -> stamp now if we don't already have one
        if (!merged.actualEndAt) merged.actualEndAt = new Date();
      } else {
        // Moving away from finished with no explicit actual -> clear the actual
        merged.actualEndAt = null;
      }
      merged.status = incomingStatus; // apply normalized status
    }
    // ------------------------------------------------------

    // Persist canonical fields
    if (merged.name != null) doc.name = merged.name;

    if (merged.startPlanned != null) doc.startPlanned = merged.startPlanned;
    if (merged.endPlanned != null)   doc.endPlanned   = merged.endPlanned;

    if ('actualEndAt' in merged)     doc.actualEndAt  = merged.actualEndAt; // allow null to clear

    if (merged.status) doc.status = merged.status;

    if (merged.isRoadblock != null) {
      doc.roadblock = !!merged.isRoadblock;
    }

    if (merged.dependsOn != null) {
      doc.requires = merged.dependsOn; // canonical field in schema
    }

    await doc.save();
    return res.json(doc);
  } catch (err) {
    console.error('[milestones:update]', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message, details: err.errors });
    }
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /tasks/:taskId/milestones/:milestoneId
 */
router.delete('/:taskId/milestones/:milestoneId', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const task = await loadTaskForOrg(req.params.taskId, orgId);
    if (task === null) return res.status(404).json({ error: 'Task not found' });
    if (task === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    const { milestoneId } = req.params;
    if (!mongoose.isValidObjectId(milestoneId)) {
      return res.status(400).json({ error: 'Invalid milestone id' });
    }

    const removed = await TaskMilestone.findOneAndDelete({
      _id: milestoneId,
      taskId: task._id,
      ...(orgId ? { orgId } : {}),
    });
    if (!removed) return res.status(404).json({ error: 'Milestone not found' });

    // Clean up dependencies (schema uses `requires`)
    await TaskMilestone.updateMany(
      { taskId: task._id, ...(orgId ? { orgId } : {}) },
      { $pull: { requires: removed._id } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[milestones:delete]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
