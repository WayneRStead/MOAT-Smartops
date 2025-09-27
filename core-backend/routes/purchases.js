// core-backend/routes/purchases.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

const Purchase = mongoose.models.Purchase || require('../models/Purchase');
const Vehicle  = mongoose.models.Vehicle  || require('../models/Vehicle');

const router = express.Router();

function isAdmin(req) {
  const r = String(req.user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}
function buildOrgFilter(model, orgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return {};
  // Stored as String here
  const s = String(orgId || '');
  return s ? { orgId: s } : {};
}
function isValidId(v) { return !!v && mongoose.Types.ObjectId.isValid(String(v)); }
const asId = (v) => new mongoose.Types.ObjectId(String(v));

// LIST
// GET /purchases?vehicleId=&projectId=&taskId=&vendorId=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&limit=500
router.get('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, projectId, taskId, vendorId, dateFrom, dateTo, limit } = req.query;
    const find = { ...buildOrgFilter(Purchase, req.user?.orgId) };

    if (isValidId(vehicleId)) find.vehicleId = asId(vehicleId);
    if (isValidId(projectId)) find.projectId = asId(projectId);
    if (isValidId(taskId))    find.taskId    = asId(taskId);
    if (isValidId(vendorId))  find.vendorId  = asId(vendorId);

    if (dateFrom || dateTo) {
      find.date = {};
      if (dateFrom) find.date.$gte = new Date(dateFrom);
      if (dateTo)   find.date.$lte = new Date(dateTo);
    }

    // Non-admins: reuse vehicle visibility (driver scope)
    if (!isAdmin(req) && isValidId(vehicleId)) {
      const veh = await Vehicle.findById(vehicleId).lean();
      if (!veh) return res.json([]); // no access/no vehicle
    }

    const lim = Math.min(parseInt(limit || '500', 10) || 500, 1000);
    const rows = await Purchase.find(find)
      .sort({ date: -1, createdAt: -1 })
      .limit(lim)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    res.json(rows.map(r => ({
      ...r,
      vendor: r.vendorId ? { _id: String(r.vendorId._id), name: r.vendorId.name } : undefined,
      vendorId: r.vendorId ? String(r.vendorId._id) : undefined,
      projectId: r.projectId ? String(r.projectId._id) : r.projectId,
      taskId: r.taskId ? String(r.taskId._id) : r.taskId,
    })));
  } catch (e) {
    console.error('GET /purchases error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE
router.post('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, vendorId, projectId, taskId, date, cost, type, notes, docUrls } = req.body || {};
    if (!isValidId(vehicleId)) return res.status(400).json({ error: 'vehicleId required' });
    if (!date) return res.status(400).json({ error: 'date required' });

    const doc = new Purchase({
      vehicleId: asId(vehicleId),
      vendorId: isValidId(vendorId) ? asId(vendorId) : undefined,
      projectId: isValidId(projectId) ? asId(projectId) : undefined,
      taskId: isValidId(taskId) ? asId(taskId) : undefined,
      date: new Date(date),
      cost: cost != null ? Number(cost) : 0,
      type: (type || 'other').toLowerCase(),
      notes: notes || '',
      docUrls: Array.isArray(docUrls) ? docUrls : [],
      orgId: String(req.user?.orgId || 'root'),
    });

    await doc.save();
    const ret = await Purchase.findById(doc._id)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    res.status(201).json({
      ...ret,
      vendor: ret.vendorId ? { _id: String(ret.vendorId._id), name: ret.vendorId.name } : undefined,
      vendorId: ret.vendorId ? String(ret.vendorId._id) : undefined,
      projectId: ret.projectId ? String(ret.projectId._id) : ret.projectId,
      taskId: ret.taskId ? String(ret.taskId._id) : ret.taskId,
    });
  } catch (e) {
    console.error('POST /purchases error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const p = await Purchase.findOne({ _id: req.params.id, ...buildOrgFilter(Purchase, req.user?.orgId) });
    if (!p) return res.status(404).json({ error: 'Not found' });

    const { vendorId, projectId, taskId, date, cost, type, notes, docUrls } = req.body || {};
    if (vendorId !== undefined) p.vendorId = isValidId(vendorId) ? new mongoose.Types.ObjectId(vendorId) : undefined;
    if (projectId !== undefined) p.projectId = isValidId(projectId) ? new mongoose.Types.ObjectId(projectId) : undefined;
    if (taskId !== undefined) p.taskId = isValidId(taskId) ? new mongoose.Types.ObjectId(taskId) : undefined;
    if (date !== undefined) p.date = date ? new Date(date) : p.date;
    if (cost !== undefined) p.cost = Number(cost);
    if (type !== undefined) p.type = String(type || 'other').toLowerCase();
    if (notes !== undefined) p.notes = notes || '';
    if (docUrls !== undefined) p.docUrls = Array.isArray(docUrls) ? docUrls : [];

    await p.save();
    const ret = await Purchase.findById(p._id)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    res.json({
      ...ret,
      vendor: ret.vendorId ? { _id: String(ret.vendorId._id), name: ret.vendorId.name } : undefined,
      vendorId: ret.vendorId ? String(ret.vendorId._id) : undefined,
      projectId: ret.projectId ? String(ret.projectId._id) : ret.projectId,
      taskId: ret.taskId ? String(ret.taskId._id) : ret.taskId,
    });
  } catch (e) {
    console.error('PUT /purchases/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await Purchase.findOneAndDelete({ _id: req.params.id, ...buildOrgFilter(Purchase, req.user?.orgId) });
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /purchases/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
