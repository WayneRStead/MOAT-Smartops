// core-backend/routes/vehicleTripAliases.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const VehicleTrip = require('../models/VehicleTrip'); // canonical model

// --- Helpers ---
function toPatch(doc, body = {}) {
  const patch = {};
  if ('startedAt' in body)  patch.startedAt  = body.startedAt ? new Date(body.startedAt) : null;
  if ('endedAt' in body)    patch.endedAt    = body.endedAt ? new Date(body.endedAt) : null;
  if ('odoStart' in body)   patch.odoStart   = body.odoStart === '' ? null : Number(body.odoStart);
  if ('odoEnd' in body)     patch.odoEnd     = body.odoEnd === '' ? null : Number(body.odoEnd);
  if ('driverUserId' in body) patch.driverUserId = body.driverUserId || null;
  if ('projectId' in body)    patch.projectId    = body.projectId || null;
  if ('taskId' in body)       patch.taskId       = body.taskId || null;
  if ('notes' in body)        patch.notes        = body.notes ?? '';
  return patch;
}

async function updateTripById(id, body, vehicleIdConstraint) {
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error('Invalid trip id'); err.status = 400; throw err;
  }
  const patch = toPatch({}, body);
  const q = { _id: id };
  if (vehicleIdConstraint) q.vehicleId = vehicleIdConstraint;
  const updated = await VehicleTrip.findOneAndUpdate(q, { $set: patch }, { new: true });
  if (!updated) {
    const err = new Error('Trip not found'); err.status = 404; throw err;
  }
  return updated;
}

// --------------- READ ---------------

// GET /vehicleTrips/:id   (legacy singular-camel)
router.get('/vehicleTrips/:id', async (req, res, next) => {
  try {
    const t = await VehicleTrip.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not Found' });
    res.json(t);
  } catch (e) { next(e); }
});

// GET /trips/:id   (very old path)
router.get('/trips/:id', async (req, res, next) => {
  try {
    const t = await VehicleTrip.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not Found' });
    res.json(t);
  } catch (e) { next(e); }
});

// GET /vehicles/:vehicleId/trips/open  (alias for "open trip")
router.get('/vehicles/:vehicleId/trips/open', async (req, res, next) => {
  try {
    const t = await VehicleTrip.findOne({
      vehicleId: req.params.vehicleId,
      endedAt: { $in: [null, undefined] },
    }).sort({ startedAt: -1 });
    if (!t) return res.status(404).json({ error: 'No open trip' });
    res.json(t);
  } catch (e) { next(e); }
});

// --------------- UPDATE (PUT/PATCH) ---------------

// PUT/PATCH /vehicleTrips/:id
router.put('/vehicleTrips/:id',  async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body)); }
  catch (e) { next(e); }
});
router.patch('/vehicleTrips/:id', async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body)); }
  catch (e) { next(e); }
});

// PUT/PATCH /trips/:id
router.put('/trips/:id',  async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body)); }
  catch (e) { next(e); }
});
router.patch('/trips/:id', async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body)); }
  catch (e) { next(e); }
});

// PUT/PATCH /vehicles/:vehicleId/trips/:id  (scoped alias)
router.put('/vehicles/:vehicleId/trips/:id',  async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body, req.params.vehicleId)); }
  catch (e) { next(e); }
});
router.patch('/vehicles/:vehicleId/trips/:id', async (req, res, next) => {
  try { res.json(await updateTripById(req.params.id, req.body, req.params.vehicleId)); }
  catch (e) { next(e); }
});

module.exports = router;
