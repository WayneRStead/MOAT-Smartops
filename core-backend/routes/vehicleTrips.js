// core-backend/routes/vehicleTrips.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');

const Vehicle = require('../models/Vehicle');       // assumes it exists
const VehicleTrip = require('../models/VehicleTrip'); // canonical trip model

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function toNum(n) {
  if (n === '' || n == null) return undefined;
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}
function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}
function computeDistance(odoStart, odoEnd) {
  const a = Number(odoStart), b = Number(odoEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.max(0, b - a);
}

/* ------------------------------ uploads ------------------------------ */
// Store under /uploads/vehicle-trips, served by /files/vehicle-trips/*
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'vehicle-trips');
ensureDir(UPLOAD_ROOT);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = String(file.originalname || 'photo').replace(/[^\w.-]+/g, '_');
    cb(null, `${ts}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    // allow any image/*; relax if your phones produce odd mimetypes
    if (!/^image\//i.test(file.mimetype)) return cb(new Error('Only image uploads are allowed.'));
    cb(null, true);
  },
});

function fileMeta(localName, file) {
  return {
    url: `/files/vehicle-trips/${localName}`,
    filename: localName,
    size: file.size,
    mime: file.mimetype,
  };
}

/* ------------------------------- reads -------------------------------- */
// GET /vehicles/:vehicleId/trips  (list)
router.get('/vehicles/:vehicleId/trips', async (req, res, next) => {
  try {
    const { vehicleId } = req.params;
    const vId = toObjectId(vehicleId);
    if (!vId) return res.status(400).json({ error: 'Invalid vehicle id' });

    const { limit = 200, skip = 0, driverId, projectId, taskId } = req.query;
    const q = { vehicleId: vId };
    if (driverId) q.$or = [{ driverUserId: driverId }, { driverId: driverId }];
    if (projectId) q.projectId = projectId;
    if (taskId) q.taskId = taskId;

    const list = await VehicleTrip.find(q)
      .sort({ startedAt: -1, createdAt: -1 })
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 200, 1000))
      .lean();

    res.json(list);
  } catch (err) { next(err); }
});

// GET /vehicles/:vehicleId/trips/open  (open trip or 404)
router.get('/vehicles/:vehicleId/trips/open', async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: 'Invalid vehicle id' });

    const open = await VehicleTrip.findOne({ vehicleId: vId, endedAt: { $exists: false } }).lean();
    if (!open) return res.status(404).json({ error: 'No open trip' });
    res.json(open);
  } catch (err) { next(err); }
});

// GET /vehicle-trips/:id  (canonical)
router.get('/vehicle-trips/:id', async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: 'Invalid id' });
    const trip = await VehicleTrip.findById(tId).lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    res.json(trip);
  } catch (err) { next(err); }
});

// Alias: GET /vehicleTrips/:id
router.get('/vehicleTrips/:id', async (req, res, next) => {
  req.url = req.url.replace(/^\/vehicleTrips\//, '/vehicle-trips/'); // rewrite
  next();
}, router);

/* ----------------------- create / close trip --------------------------- */
// POST /vehicles/:vehicleId/trips/start
router.post('/vehicles/:vehicleId/trips/start', async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: 'Invalid vehicle id' });

    const vehicle = await Vehicle.findById(vId);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const existing = await VehicleTrip.findOne({ vehicleId: vId, endedAt: { $exists: false } });
    if (existing) return res.status(400).json({ error: 'There is already an open trip for this vehicle.' });

    const body = req.body || {};
    const trip = new VehicleTrip(stripUndef({
      vehicleId: vId,
      startedAt: new Date(),
      odoStart: toNum(body.odoStart),
      driverUserId: body.driverUserId || body.driverId || vehicle.driverId || req.user?._id,
      driverId: body.driverUserId || body.driverId || vehicle.driverId || req.user?._id, // mirror
      projectId: body.projectId || vehicle.projectId || undefined,
      taskId: body.taskId || vehicle.taskId || undefined,
      notes: body.notes || undefined,
      tags: Array.isArray(body.tags) ? body.tags : (body.tags ? [body.tags] : undefined),
      startPhoto: body.startPhotoUrl ? { url: body.startPhotoUrl } : undefined,
    }));

    if (trip.odoStart == null && Number.isFinite(vehicle?.odometer)) {
      trip.odoStart = Number(vehicle.odometer);
    }

    await trip.save();
    res.json(trip.toObject());
  } catch (err) { next(err); }
});

// POST /vehicles/:vehicleId/trips/:tripId/end
router.post('/vehicles/:vehicleId/trips/:tripId/end', async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    const tId = toObjectId(req.params.tripId);
    if (!vId || !tId) return res.status(400).json({ error: 'Invalid id' });

    const trip = await VehicleTrip.findOne({ _id: tId, vehicleId: vId });
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.endedAt) return res.status(400).json({ error: 'Trip already ended' });

    const body = req.body || {};
    if (body.notes) trip.notes = String(body.notes);
    if (body.endPhotoUrl) trip.endPhoto = { url: body.endPhotoUrl };

    const odoEnd = toNum(body.odoEnd);
    if (odoEnd != null) trip.odoEnd = odoEnd;

    trip.endedAt = new Date();
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);

    await trip.save();
    res.json(trip.toObject());
  } catch (err) { next(err); }
});

/* ------------------------------ updates ------------------------------- */
/**
 * PATCH /vehicle-trips/:id (canonical)
 * PUT   /vehicle-trips/:id (accepted)
 * Also exposes aliases:
 *   - /vehicleTrips/:id
 *   - /vehicles/:vehicleId/trips/:tripId  (PUT & PATCH)
 *   - /trips/:id  (PUT & PATCH)
 */
async function applyTripPatch(trip, patch) {
  // normalize
  const clean = stripUndef({
    startedAt: patch.startedAt ? new Date(patch.startedAt) : undefined,
    endedAt:   patch.endedAt   ? new Date(patch.endedAt)   : undefined,
    odoStart:  toNum(patch.odoStart),
    odoEnd:    toNum(patch.odoEnd),
    driverUserId: patch.driverUserId || patch.driverId,
    driverId:     patch.driverUserId || patch.driverId,
    projectId: patch.projectId,
    taskId: patch.taskId,
    notes: patch.notes,
    tags: Array.isArray(patch.tags) ? patch.tags : undefined,
  });

  Object.assign(trip, clean);
  // distance (if both odos present)
  if (trip.odoStart != null && trip.odoEnd != null) {
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);
  }
  await trip.save();
  return trip;
}

async function updateById(req, res, next) {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: 'Invalid id' });
    const trip = await VehicleTrip.findById(tId);
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const updated = await applyTripPatch(trip, req.body || {});
    res.json(updated.toObject());
  } catch (err) { next(err); }
}
router.patch('/vehicle-trips/:id', updateById);
router.put('/vehicle-trips/:id', updateById);

// alias: /vehicleTrips/:id
router.patch('/vehicleTrips/:id', updateById);
router.put('/vehicleTrips/:id', updateById);

// nested aliases: /vehicles/:vehicleId/trips/:tripId
async function updateNested(req, res, next) {
  try {
    const vId = toObjectId(req.params.vehicleId);
    const tId = toObjectId(req.params.tripId);
    if (!vId || !tId) return res.status(400).json({ error: 'Invalid id' });

    const trip = await VehicleTrip.findOne({ _id: tId, vehicleId: vId });
    if (!trip) return res.status(404).json({ error: 'Not found' });

    const updated = await applyTripPatch(trip, req.body || {});
    res.json(updated.toObject());
  } catch (err) { next(err); }
}
router.patch('/vehicles/:vehicleId/trips/:tripId', updateNested);
router.put('/vehicles/:vehicleId/trips/:tripId', updateNested);

// generic collection alias: /trips/:id
router.patch('/trips/:id', updateById);
router.put('/trips/:id', updateById);

/* -------------------------------- audit ------------------------------- */
// If you later add real audit logs, return them here.
// For now, return the current doc plus a stub history array.
router.get('/vehicle-trips/:id/audit', async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: 'Invalid id' });
    const trip = await VehicleTrip.findById(tId).lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    res.json({ trip, history: [] });
  } catch (err) { next(err); }
});

/* ------------------------------ uploads ------------------------------- */
// Pre-upload: POST /vehicle-trips/upload
router.post('/vehicle-trips/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const meta = fileMeta(req.file.filename, req.file);
    res.json(meta);
  } catch (err) { next(err); }
});

// Attach to an existing trip (start photo)
router.post('/vehicle-trips/:id/upload-start', upload.single('file'), async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: 'Invalid id' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const trip = await VehicleTrip.findById(tId);
    if (!trip) return res.status(404).json({ error: 'Not found' });
    trip.startPhoto = fileMeta(req.file.filename, req.file);
    await trip.save();
    res.json(trip.toObject());
  } catch (err) { next(err); }
});

// Attach to an existing trip (end photo)
router.post('/vehicle-trips/:id/upload-end', upload.single('file'), async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: 'Invalid id' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const trip = await VehicleTrip.findById(tId);
    if (!trip) return res.status(404).json({ error: 'Not found' });
    trip.endPhoto = fileMeta(req.file.filename, req.file);
    await trip.save();
    res.json(trip.toObject());
  } catch (err) { next(err); }
});

module.exports = router;
