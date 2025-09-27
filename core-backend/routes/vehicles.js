// core-backend/routes/vehicles.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ---------------------------- model loading ---------------------------- */
// Prefer already-compiled model; require() only if missing
const Vehicle = mongoose.models.Vehicle || require('../models/Vehicle');

/* ------------------------------- helpers ------------------------------- */

const isValidId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) => (isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

// Build an org filter that matches your Vehicle schema (String or ObjectId).
// If the schema has no orgId, we skip org scoping.
// If orgId is a string like "root" but schema expects ObjectId, we skip filtering to avoid cast errors.
function buildOrgFilter(model, orgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return {}; // schema has no orgId -> no org filter
  const s = String(orgId || '');
  if (p.instance === 'String') {
    return s ? { orgId: s } : {};
  }
  // ObjectId orgId
  return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
}

function isAdmin(req) {
  const r = String(req.user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

// Escape for regex
function escapeRx(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keep IDs usable by the UI after populate
function normalizeOut(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };

  // driver
  if (out.driverId && typeof out.driverId === 'object' && out.driverId._id) {
    const drv = out.driverId;
    out.driver = { _id: String(drv._id), name: drv.name, email: drv.email };
    out.driverName = drv.name || drv.email || String(drv._id);
    out.driverId = String(drv._id);
  } else if (isValidId(out.driverId)) {
    out.driverId = String(out.driverId);
  } else {
    out.driverId = undefined;
  }

  // task
  if (out.taskId && typeof out.taskId === 'object' && out.taskId._id) {
    const t = out.taskId;
    out.task = { _id: String(t._id), title: t.title };
    out.taskTitle = t.title || String(t._id);
    out.taskId = String(t._id);
  } else if (isValidId(out.taskId)) {
    out.taskId = String(out.taskId);
  } else {
    out.taskId = undefined;
  }

  if (isValidId(out.projectId)) out.projectId = String(out.projectId);
  else out.projectId = undefined;

  return out;
}

// Visibility guard for a single vehicle (non-admins)
function visibleToReq(req, doc) {
  if (isAdmin(req)) return true;
  const ids = (req.accessibleUserIds || []).map(String);
  const driver = doc?.driverId ? String(doc.driverId._id || doc.driverId) : undefined;
  // allow if unassigned OR driver is visible
  return !driver || ids.includes(driver);
}

/* ---------------------- reminders: nextDue helper ---------------------- */
function computeNextDue(reminders = []) {
  let dateDue = null, odoDue = null;
  (reminders || []).forEach(r => {
    if (!r || r.active === false) return;
    if (r.kind === 'date' && r.dueDate) {
      if (!dateDue || new Date(r.dueDate) < new Date(dateDue.dueDate)) {
        dateDue = { reminderId: r._id, dueDate: r.dueDate };
      }
    }
    if (r.kind === 'odometer' && r.dueOdometer != null) {
      const km = Number(r.dueOdometer);
      if (!Number.isFinite(km)) return;
      if (!odoDue || km < Number(odoDue.dueOdometer)) {
        odoDue = { reminderId: r._id, dueOdometer: km };
      }
    }
  });
  return { dateDue, odoDue };
}

/* -------------------------------- LIST --------------------------------- */
// GET /vehicles
router.get('/', requireAuth, async (req, res) => {
  try {
    const { q, projectId, status, limit, driverId, taskId } = req.query;

    const find = {
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    };

    if (q) {
      const rx = new RegExp(escapeRx(q), 'i');
      find.$or = [{ reg: rx }, { make: rx }, { model: rx }];
    }
    if (isValidId(projectId)) find.projectId = asObjectId(projectId);
    if (isValidId(driverId))  find.driverId  = asObjectId(driverId);
    if (isValidId(taskId))    find.taskId    = asObjectId(taskId);
    if (status) find.status = status;

    // Non-admin visibility: show vehicles they can see
    if (!isAdmin(req)) {
      const ids = (req.accessibleUserIds || []).map((x) =>
        isValidId(x) ? new mongoose.Types.ObjectId(String(x)) : x
      );
      // Vehicles with visible driver OR unassigned
      find.$or = [
        ...(find.$or || []),
        { driverId: { $in: ids } },
        { driverId: { $exists: false } },
        { driverId: null },
      ];
    }

    const lim = Math.min(parseInt(limit || '500', 10) || 500, 1000);

    const rows = await Vehicle.find(find)
      .sort({ updatedAt: -1 })
      .limit(lim)
      .populate({ path: 'driverId', select: 'name email' })
      .populate({ path: 'taskId',   select: 'title' })
      .lean();

    res.json(rows.map(normalizeOut));
  } catch (e) {
    console.error('GET /vehicles error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------------- READ --------------------------------- */
// GET /vehicles/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Not found' });

    const row = await Vehicle.findOne({
      _id: id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    })
      .populate({ path: 'driverId', select: 'name email' })
      .populate({ path: 'taskId',   select: 'title' })
      .lean();

    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!visibleToReq(req, row)) return res.status(403).json({ error: 'Forbidden' });

    res.json(normalizeOut(row));
  } catch (e) {
    console.error('GET /vehicles/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- CREATE -------------------------------- */
// POST /vehicles
router.post('/', requireAuth, async (req, res) => {
  try {
    const { reg, make, model, year, status, projectId, driverId, taskId } = req.body || {};
    if (!reg || !String(reg).trim()) {
      return res.status(400).json({ error: 'reg required' });
    }

    // Prepare doc
    const doc = new Vehicle({
      reg: String(reg).trim(),
      make: make || '',
      model: model || '',
      year: year ? Number(year) : undefined,
      status: status || 'active',
      projectId: isValidId(projectId) ? asObjectId(projectId) : undefined,
      driverId:  isValidId(driverId)  ? asObjectId(driverId)  : undefined,
      taskId:    isValidId(taskId)    ? asObjectId(taskId)    : undefined,
    });

    // Set orgId if schema has it
    const orgPath = Vehicle?.schema?.path('orgId');
    if (orgPath) {
      if (orgPath.instance === 'String') {
        doc.orgId = String(req.user?.orgId || 'root');
      } else if (mongoose.Types.ObjectId.isValid(String(req.user?.orgId))) {
        doc.orgId = new mongoose.Types.ObjectId(String(req.user.orgId));
      }
    }

    await doc.save();

    const ret = await Vehicle.findById(doc._id)
      .populate({ path: 'driverId', select: 'name email' })
      .populate({ path: 'taskId',   select: 'title' })
      .lean();

    res.status(201).json(normalizeOut(ret));
  } catch (e) {
    console.error('POST /vehicles error:', e);
    if (e && e.code === 11000) {
      return res.status(409).json({ error: 'Vehicle with this registration already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- UPDATE -------------------------------- */
// PUT /vehicles/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const v = await Vehicle.findOne({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    });
    if (!v) return res.status(404).json({ error: 'Not found' });

    if (!visibleToReq(req, v)) return res.status(403).json({ error: 'Forbidden' });

    const { reg, make, model, year, status, projectId, driverId, taskId } = req.body || {};

    if (reg != null)   v.reg = String(reg).trim();
    if (make != null)  v.make = make;
    if (model != null) v.model = model;
    if (year != null)  v.year = year ? Number(year) : undefined;
    if (status != null && ['active', 'workshop', 'retired'].includes(status)) v.status = status;

    if (projectId !== undefined) v.projectId = isValidId(projectId) ? asObjectId(projectId) : undefined;
    if (driverId  !== undefined) v.driverId  = isValidId(driverId)  ? asObjectId(driverId)  : undefined;
    if (taskId    !== undefined) v.taskId    = isValidId(taskId)    ? asObjectId(taskId)    : undefined;

    await v.save();

    const ret = await Vehicle.findById(v._id)
      .populate({ path: 'driverId', select: 'name email' })
      .populate({ path: 'taskId',   select: 'title' })
      .lean();

    res.json(normalizeOut(ret));
  } catch (e) {
    console.error('PUT /vehicles/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- DELETE -------------------------------- */
// DELETE /vehicles/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await Vehicle.findOneAndDelete({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    });
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /vehicles/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ----------------------------- REMINDERS ------------------------------- */
// GET /vehicles/:id/reminders
router.get('/:id/reminders', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const v = await Vehicle.findOne({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    }).lean();
    if (!v) return res.status(404).json({ error: 'Not found' });
    if (!visibleToReq(req, v)) return res.status(403).json({ error: 'Forbidden' });

    const nextDue = computeNextDue(v.reminders || []);
    res.json({ reminders: v.reminders || [], nextDue });
  } catch (e) {
    console.error('GET /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /vehicles/:id/reminders
router.post('/:id/reminders', requireAuth, async (req, res) => {
  try {
    const { kind, dueDate, dueOdometer, notes } = req.body || {};
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    if (!['date','odometer'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });

    const v = await Vehicle.findOne({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    });
    if (!v) return res.status(404).json({ error: 'Not found' });
    if (!visibleToReq(req, v)) return res.status(403).json({ error: 'Forbidden' });

    v.reminders = v.reminders || [];
    v.reminders.push({
      kind,
      dueDate: kind === 'date' ? (dueDate ? new Date(dueDate) : undefined) : undefined,
      dueOdometer: kind === 'odometer' ? (dueOdometer != null ? Number(dueOdometer) : undefined) : undefined,
      notes: notes || '',
      active: true,
      createdAt: new Date(),
    });
    await v.save();

    const vv = v.toObject();
    res.json({ reminders: vv.reminders || [], nextDue: computeNextDue(vv.reminders || []) });
  } catch (e) {
    console.error('POST /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /vehicles/:id/reminders/:rid
router.put('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.rid)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const v = await Vehicle.findOne({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    });
    if (!v) return res.status(404).json({ error: 'Not found' });
    if (!visibleToReq(req, v)) return res.status(403).json({ error: 'Forbidden' });

    const r = (v.reminders || []).id(req.params.rid);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });

    const { active, notes, dueDate, dueOdometer } = req.body || {};
    if (typeof active === 'boolean') r.active = active;
    if (typeof notes === 'string') r.notes = notes;
    if (r.kind === 'date' && dueDate !== undefined) r.dueDate = dueDate ? new Date(dueDate) : undefined;
    if (r.kind === 'odometer' && dueOdometer !== undefined) r.dueOdometer = dueOdometer != null ? Number(dueOdometer) : undefined;

    await v.save();

    const vv = v.toObject();
    res.json({ reminders: vv.reminders || [], nextDue: computeNextDue(vv.reminders || []) });
  } catch (e) {
    console.error('PUT /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /vehicles/:id/reminders/:rid
router.delete('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.rid)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Try subdocument deletion first
    const v = await Vehicle.findOne({
      _id: req.params.id,
      ...buildOrgFilter(Vehicle, req.user?.orgId),
    });
    if (!v) return res.status(404).json({ error: 'Not found' });
    if (!visibleToReq(req, v)) return res.status(403).json({ error: 'Forbidden' });

    const sub = (v.reminders || []).id(req.params.rid);
    if (sub && typeof sub.deleteOne === 'function') {
      sub.deleteOne(); // Mongoose 6/7 compatible
      await v.save();
      const vv = v.toObject();
      return res.json({ reminders: vv.reminders || [], nextDue: computeNextDue(vv.reminders || []) });
    }

    // Fallback (if reminders array contains plain objects and not subdocs)
    await Vehicle.updateOne(
      { _id: req.params.id, ...buildOrgFilter(Vehicle, req.user?.orgId) },
      { $pull: { reminders: { _id: new mongoose.Types.ObjectId(String(req.params.rid)) } } }
    );

    const fresh = await Vehicle.findById(req.params.id, { reminders: 1 }).lean();
    return res.json({ reminders: fresh?.reminders || [], nextDue: computeNextDue(fresh?.reminders || []) });
  } catch (e) {
    console.error('DELETE /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
