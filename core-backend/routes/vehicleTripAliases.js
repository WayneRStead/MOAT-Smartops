// core-backend/routes/vehicleTripAliases.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const VehicleTrip = require('../models/VehicleTrip'); // canonical model
const Vehicle = require('../models/Vehicle');         // for odometer floor checks

/* ------------------------------ helpers ------------------------------ */
function toNum(n) {
  if (n === '' || n == null) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}
function sanitizeGeo(g) {
  if (!g || typeof g !== 'object') return undefined;
  const lat = toNum(g.lat);
  const lng = toNum(g.lng);
  const acc = toNum(g.acc);
  if (lat == null || lng == null) return undefined;
  return { lat, lng, acc: acc == null ? undefined : acc };
}
function computeDistance(odoStart, odoEnd) {
  const a = Number(odoStart), b = Number(odoEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.max(0, b - a);
}

// Build a partial patch from request body (lenient to older clients)
function toPatch(body = {}) {
  const patch = {};

  if ('startedAt' in body)  patch.startedAt = body.startedAt ? new Date(body.startedAt) : null;
  if ('endedAt'   in body)  patch.endedAt   = body.endedAt ? new Date(body.endedAt) : null;

  if ('odoStart'  in body)  patch.odoStart  = body.odoStart === '' ? null : toNum(body.odoStart);
  if ('odoEnd'    in body)  patch.odoEnd    = body.odoEnd   === '' ? null : toNum(body.odoEnd);

  if ('driverUserId' in body) patch.driverUserId = body.driverUserId || null;
  if ('projectId'    in body) patch.projectId    = body.projectId || null;
  if ('taskId'       in body) patch.taskId       = body.taskId || null;

  if ('notes' in body) patch.notes = body.notes ?? '';

  if (Array.isArray(body.tags)) patch.tags = body.tags;

  // Optional business/private purpose (only set if valid)
  if (body.purpose === 'Business' || body.purpose === 'Private') {
    patch.purpose = body.purpose;
  }

  // Optional geo blocks (start/end)
  const sg = sanitizeGeo(body.startGeo);
  const eg = sanitizeGeo(body.endGeo);
  if (sg) patch.startGeo = sg;
  if (eg) patch.endGeo = eg;

  return patch;
}

/**
 * Update a trip by id with odometer validation and distance recompute.
 * Optionally constrain by vehicleId (for nested alias).
 */
async function updateTripById(id, body, vehicleIdConstraint) {
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error('Invalid trip id'); err.status = 400; throw err;
  }

  const query = { _id: id };
  if (vehicleIdConstraint) query.vehicleId = vehicleIdConstraint;

  const trip = await VehicleTrip.findOne(query);
  if (!trip) {
    const err = new Error('Trip not found'); err.status = 404; throw err;
  }

  const patch = toPatch(body);

  // ----- ODOMETER GUARDS -----
  // If odoStart is being updated, enforce it is >= last closed end & >= vehicle.odometer
  if (Object.prototype.hasOwnProperty.call(patch, 'odoStart') && patch.odoStart != null) {
    const vId = trip.vehicleId;
    if (vId) {
      const [lastClosed, vehicle] = await Promise.all([
        VehicleTrip.findOne({ vehicleId: vId, _id: { $ne: trip._id }, endedAt: { $ne: null } })
                   .sort({ endedAt: -1 })
                   .lean(),
        Vehicle.findById(vId).lean(),
      ]);
      const lastEndOdo = Number.isFinite(lastClosed?.odoEnd) ? Number(lastClosed.odoEnd) : -Infinity;
      const vehicleOdo = Number.isFinite(vehicle?.odometer) ? Number(vehicle.odometer) : -Infinity;
      const floor = Math.max(lastEndOdo, vehicleOdo);
      if (Number.isFinite(floor) && patch.odoStart < floor) {
        const err = new Error(`Odometer start (${patch.odoStart}) cannot be less than last recorded end (${floor}).`);
        err.status = 422; throw err;
      }
    }
  }

  // If odoEnd is being updated (or will be computed later), enforce end >= start
  const nextOdoStart = (Object.prototype.hasOwnProperty.call(patch, 'odoStart') && patch.odoStart != null)
    ? patch.odoStart
    : trip.odoStart;

  if (Object.prototype.hasOwnProperty.call(patch, 'odoEnd') && patch.odoEnd != null) {
    if (nextOdoStart != null && patch.odoEnd < nextOdoStart) {
      const err = new Error(`Odometer end (${patch.odoEnd}) cannot be less than trip start (${nextOdoStart}).`);
      err.status = 422; throw err;
    }
  }

  // ----- APPLY PATCH -----
  // mirror driverId for older clients
  if (patch.driverUserId && !patch.driverId) patch.driverId = patch.driverUserId;

  Object.assign(trip, patch);

  // ----- DERIVED FIELDS -----
  if (trip.odoStart != null && trip.odoEnd != null) {
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);
  }

  await trip.save();
  return trip;
}

/* ------------------------------- READ ------------------------------- */

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

/* --------------------------- UPDATE (PUT/PATCH) --------------------------- */

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
