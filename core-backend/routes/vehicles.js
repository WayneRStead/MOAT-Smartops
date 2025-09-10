// core-backend/routes/vehicles.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

let Vehicle;
try {
  Vehicle = mongoose.model('Vehicle');
} catch {
  Vehicle = require('../models/Vehicle');
}

const router = express.Router();

const isValidId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) => (isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);
const cleanId = (v) => (v === '' || v === undefined || v === null ? undefined : v);

// Escape for regex
function escapeRx(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// After .lean().populate(), keep IDs as ids for selects,
// but also expose small display helpers.
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

  // Keep projectId as a plain id (no populate) so existing UI keeps working
  if (isValidId(out.projectId)) out.projectId = String(out.projectId);
  else out.projectId = undefined;

  return out;
}

// ---------- LIST: GET /api/vehicles ----------
router.get('/', requireAuth, async (req, res) => {
  try {
    const { q, projectId, status, limit, driverId, taskId } = req.query;

    const find = {};
    if (q) {
      const rx = new RegExp(escapeRx(q), 'i');
      find.$or = [{ reg: rx }, { make: rx }, { model: rx }];
    }
    if (isValidId(projectId)) find.projectId = asObjectId(projectId);
    if (isValidId(driverId))  find.driverId  = asObjectId(driverId);
    if (isValidId(taskId))    find.taskId    = asObjectId(taskId);
    if (status) find.status = status;

    const lim = Math.min(parseInt(limit || '500', 10) || 500, 1000);

    // Populate only driverId & taskId (NOT projectId to avoid breaking UI)
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

// ---------- READ ONE: GET /api/vehicles/:id ----------
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Not found' });

    const row = await Vehicle.findById(id)
      .populate({ path: 'driverId', select: 'name email' })
      .populate({ path: 'taskId',   select: 'title' })
      .lean();
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json(normalizeOut(row));
  } catch (e) {
    console.error('GET /vehicles/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- CREATE: POST /api/vehicles ----------
router.post('/', requireAuth, async (req, res) => {
  try {
    const { reg, make, model, year, status, projectId, driverId, taskId } = req.body || {};
    if (!reg || !String(reg).trim()) {
      return res.status(400).json({ error: 'reg required' });
    }

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

    await doc.save();

    // Re-read with populate, then normalize output (keep ids + provide display helpers)
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

// ---------- UPDATE: PUT /api/vehicles/:id ----------
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });

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

// ---------- DELETE: DELETE /api/vehicles/:id ----------
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await Vehicle.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /vehicles/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- Reminders (optional; used by VehicleDetail.jsx) ----------
   If you already have these elsewhere, remove this whole section to avoid duplicate routes.
---------------------------------------------------------------------*/
router.get('/:id/reminders', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const v = await Vehicle.findById(req.params.id).lean();
    if (!v) return res.status(404).json({ error: 'Not found' });

    let dateDue = null, odoDue = null;
    (v.reminders || []).forEach(r => {
      if (!r.active) return;
      if (r.kind === 'date' && r.dueDate) {
        if (!dateDue || new Date(r.dueDate) < new Date(dateDue.dueDate)) {
          dateDue = { reminderId: r._id, dueDate: r.dueDate };
        }
      }
      if (r.kind === 'odometer' && r.dueOdometer != null) {
        if (!odoDue || r.dueOdometer < odoDue.dueOdometer) {
          odoDue = { reminderId: r._id, dueOdometer: r.dueOdometer };
        }
      }
    });

    res.json({ reminders: v.reminders || [], nextDue: { dateDue, odoDue } });
  } catch (e) {
    console.error('GET /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/reminders', requireAuth, async (req, res) => {
  try {
    const { kind, dueDate, dueOdometer, notes } = req.body || {};
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    if (!['date','odometer'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });

    const update = {
      $push: {
        reminders: {
          kind,
          dueDate: kind === 'date' ? (dueDate ? new Date(dueDate) : undefined) : undefined,
          dueOdometer: kind === 'odometer' ? (dueOdometer != null ? Number(dueOdometer) : undefined) : undefined,
          notes: notes || '',
          active: true,
          createdAt: new Date(),
        }
      }
    };

    const doc = await Vehicle.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // reuse logic from GET
    let dateDue = null, odoDue = null;
    (doc.reminders || []).forEach(r => {
      if (!r.active) return;
      if (r.kind === 'date' && r.dueDate) {
        if (!dateDue || new Date(r.dueDate) < new Date(dateDue.dueDate)) {
          dateDue = { reminderId: r._id, dueDate: r.dueDate };
        }
      }
      if (r.kind === 'odometer' && r.dueOdometer != null) {
        if (!odoDue || r.dueOdometer < odoDue.dueOdometer) {
          odoDue = { reminderId: r._id, dueOdometer: r.dueOdometer };
        }
      }
    });

    res.json({ reminders: doc.reminders || [], nextDue: { dateDue, odoDue } });
  } catch (e) {
    console.error('POST /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const r = (v.reminders || []).id(req.params.rid);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });

    const { active, notes, dueDate, dueOdometer } = req.body || {};
    if (typeof active === 'boolean') r.active = active;
    if (typeof notes === 'string') r.notes = notes;
    if (r.kind === 'date' && dueDate !== undefined) r.dueDate = dueDate ? new Date(dueDate) : undefined;
    if (r.kind === 'odometer' && dueOdometer !== undefined) r.dueOdometer = dueOdometer != null ? Number(dueOdometer) : undefined;

    await v.save();

    const vv = v.toObject();
    let dateDue = null, odoDue = null;
    (vv.reminders || []).forEach(x => {
      if (!x.active) return;
      if (x.kind === 'date' && x.dueDate) {
        if (!dateDue || new Date(x.dueDate) < new Date(dateDue.dueDate)) {
          dateDue = { reminderId: x._id, dueDate: x.dueDate };
        }
      }
      if (x.kind === 'odometer' && x.dueOdometer != null) {
        if (!odoDue || x.dueOdometer < odoDue.dueOdometer) {
          odoDue = { reminderId: x._id, dueOdometer: x.dueOdometer };
        }
      }
    });

    res.json({ reminders: vv.reminders || [], nextDue: { dateDue, odoDue } });
  } catch (e) {
    console.error('PUT /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const r = (v.reminders || []).id(req.params.rid);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });
    r.remove();
    await v.save();

    const vv = v.toObject();
    let dateDue = null, odoDue = null;
    (vv.reminders || []).forEach(x => {
      if (!x.active) return;
      if (x.kind === 'date' && x.dueDate) {
        if (!dateDue || new Date(x.dueDate) < new Date(dateDue.dueDate)) {
          dateDue = { reminderId: x._id, dueDate: x.dueDate };
        }
      }
      if (x.kind === 'odometer' && x.dueOdometer != null) {
        if (!odoDue || x.dueOdometer < odoDue.dueOdometer) {
          odoDue = { reminderId: x._id, dueOdometer: x.dueOdometer };
        }
      }
    });

    res.json({ reminders: vv.reminders || [], nextDue: { dateDue, odoDue } });
  } catch (e) {
    console.error('DELETE /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
