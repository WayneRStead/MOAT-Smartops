// core-backend/routes/vehicleTrips.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');

const Vehicle = require('../models/Vehicle');
const VehicleTrip = require('../models/VehicleTrip');

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
function readGeo(body = {}) {
  const lat = toNum(body.lat);
  const lng = toNum(body.lng);
  const acc = toNum(body.acc);
  if (lat == null || lng == null) return undefined;
  return { lat, lng, acc: acc == null ? undefined : acc };
}
function toPoint(geo) {
  const lat = Number(geo?.lat);
  const lng = Number(geo?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
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
    const startGeo =
  (body.startLat != null && body.startLng != null)
    ? { lat: Number(body.startLat), lng: Number(body.startLng), acc: toNum(body.startAccuracy) }
    : readGeo(body);

const startLocation =
  (body?.startLocation?.type === 'Point' &&
   Array.isArray(body.startLocation.coordinates) &&
   body.startLocation.coordinates.length >= 2)
    ? { type: 'Point', coordinates: [
        Number(body.startLocation.coordinates[0]),
        Number(body.startLocation.coordinates[1]),
      ] }
    : (body.startLat != null && body.startLng != null)
      ? { type: 'Point', coordinates: [Number(body.startLng), Number(body.startLat)] }
      : undefined;

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

      // GEO
      startGeo,
      startLocation,

      // Purpose
      purpose: (body.purpose === 'Private' || body.purpose === 'Business') ? body.purpose : 'Business',
    }));

    // Fallback odoStart to vehicle.odometer if present
    if (trip.odoStart == null && Number.isFinite(vehicle?.odometer)) {
      trip.odoStart = Number(vehicle.odometer);
    }

    // --- ODOMETER GUARD: start must be >= last closed end & >= vehicle.odometer ---
    const lastClosed = await VehicleTrip
      .findOne({ vehicleId: vId, endedAt: { $ne: null } })
      .sort({ endedAt: -1 });

    const lastEndOdo = Number.isFinite(lastClosed?.odoEnd) ? Number(lastClosed.odoEnd) : undefined;
    const vehicleOdo = Number.isFinite(vehicle?.odometer) ? Number(vehicle.odometer) : undefined;
    const floorOdo = Math.max(
      Number.isFinite(lastEndOdo) ? lastEndOdo : -Infinity,
      Number.isFinite(vehicleOdo) ? vehicleOdo : -Infinity
    );

    if (Number.isFinite(floorOdo) && Number.isFinite(trip.odoStart) && trip.odoStart < floorOdo) {
      return res.status(422).json({
        error: `Odometer start (${trip.odoStart}) cannot be less than last recorded end (${floorOdo}).`
      });
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

    // Purpose (optional update)
    if (body.purpose === 'Business' || body.purpose === 'Private') {
      trip.purpose = body.purpose;
    }

    // Odometer end (must be >= start)
    const incomingEnd = toNum(body.odoEnd);
    if (incomingEnd != null) {
      if (trip.odoStart != null && incomingEnd < Number(trip.odoStart)) {
        return res.status(422).json({
          error: `Odometer end (${incomingEnd}) cannot be less than trip start (${trip.odoStart}).`
        });
      }
      trip.odoEnd = incomingEnd;
    }

    // GEO
    const endGeo =
  (body.endLat != null && body.endLng != null)
    ? { lat: Number(body.endLat), lng: Number(body.endLng), acc: toNum(body.endAccuracy) }
    : readGeo(body);

const endLocation =
  (body?.endLocation?.type === 'Point' &&
   Array.isArray(body.endLocation.coordinates) &&
   body.endLocation.coordinates.length >= 2)
    ? {
        type: 'Point',
        coordinates: [
          Number(body.endLocation.coordinates[0]),
          Number(body.endLocation.coordinates[1]),
        ],
      }
    : (body.endLat != null && body.endLng != null)
      ? { type: 'Point', coordinates: [Number(body.endLng), Number(body.endLat)] }
      : (endGeo ? { type: 'Point', coordinates: [endGeo.lng, endGeo.lat] } : undefined);

trip.endGeo = endGeo || undefined;
trip.endLocation = endLocation;

    // close + distance
    trip.endedAt = new Date();
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);

    await trip.save();
    res.json(trip.toObject());
  } catch (err) { next(err); }
});

/* ------------------------------ updates ------------------------------- */
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
    purpose: (patch.purpose === 'Business' || patch.purpose === 'Private') ? patch.purpose : undefined,
  });

  Object.assign(trip, clean);

  // Optional geo fixes via patch
  if (patch.startGeo) {
    const g = stripUndef({
      lat: toNum(patch.startGeo.lat),
      lng: toNum(patch.startGeo.lng),
      acc: toNum(patch.startGeo.acc),
    });
    trip.startGeo = (g.lat != null && g.lng != null) ? g : undefined;
    trip.startLocation = (g.lat != null && g.lng != null)
      ? { type: 'Point', coordinates: [g.lng, g.lat] }
      : undefined;
  }

  if (patch.endGeo) {
    const g = stripUndef({
      lat: toNum(patch.endGeo.lat),
      lng: toNum(patch.endGeo.lng),
      acc: toNum(patch.endGeo.acc),
    });
    trip.endGeo = (g.lat != null && g.lng != null) ? g : undefined;
    trip.endLocation = (g.lat != null && g.lng != null)
      ? { type: 'Point', coordinates: [g.lng, g.lat] }
      : undefined;
  }

  // distance (if both odos present)
  if (trip.odoStart != null && trip.odoEnd != null) {
    trip.distance = Math.max(0, Number(trip.odoEnd) - Number(trip.odoStart));
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

/* -------------------------------- audit ------------------------------- */
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
router.post('/vehicle-trips/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const meta = fileMeta(req.file.filename, req.file);
    res.json(meta);
  } catch (err) { next(err); }
});

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

/* ------------------------------- exports ------------------------------- */
// Helpers to pull lat/lng safely
function pickLatLng(trip, which /* 'start' | 'end' */) {
  const loc = trip?.[which + 'Location'];
  if (loc && Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
    const lng = Number(loc.coordinates[0]);
    const lat = Number(loc.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const geo = trip?.[which + 'Geo'];
  if (geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng))) {
    return { lat: Number(geo.lat), lng: Number(geo.lng) };
  }
  return null;
}

function tripToCsvRow(t) {
  const s = pickLatLng(t, 'start') || {};
  const e = pickLatLng(t, 'end') || {};
  return [
    String(t._id || ''),
    String(t.vehicleId || ''),
    String(t.driverUserId || ''),
    t.startedAt ? new Date(t.startedAt).toISOString() : '',
    t.endedAt ? new Date(t.endedAt).toISOString() : '',
    Number.isFinite(t.odoStart) ? t.odoStart : '',
    Number.isFinite(t.odoEnd) ? t.odoEnd : '',
    Number.isFinite(t.distance) ? t.distance : '',
    (t.purpose || ''),
    (t.projectId || ''),
    (t.taskId || ''),
    s.lat ?? '', s.lng ?? '',
    e.lat ?? '', e.lng ?? '',
    (t.notes || '').replace(/\r?\n/g, ' '),
    Array.isArray(t.tags) ? t.tags.join('|') : ''
  ];
}

router.get('/vehicles/:vehicleId/trips.csv', async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: 'Invalid vehicle id' });

    const { limit = 1000, skip = 0 } = req.query;
    const trips = await VehicleTrip.find({ vehicleId: vId })
      .sort({ startedAt: 1, createdAt: 1 })
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 1000, 5000))
      .lean();

    const header = [
      'tripId','vehicleId','driverUserId','startedAt','endedAt',
      'odoStart','odoEnd','distance','purpose','projectId','taskId',
      'startLat','startLng','endLat','endLng','notes','tags'
    ];

    const rows = trips.map(tripToCsvRow);
    const csv = [header, ...rows].map(cols =>
      cols.map(v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vehicle-${String(vId)}-trips.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

function kmlPlacemark(name, lat, lng, whenIso) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `
    <Placemark>
      <name>${name}</name>
      ${whenIso ? `<TimeStamp><when>${whenIso}</when></TimeStamp>` : ''}
      <Point><coordinates>${lng},${lat},0</coordinates></Point>
    </Placemark>
  `;
}

router.get('/vehicles/:vehicleId/trips.kml', async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: 'Invalid vehicle id' });

    const { limit = 1000, skip = 0 } = req.query;
    const trips = await VehicleTrip.find({ vehicleId: vId })
      .sort({ startedAt: 1, createdAt: 1 })
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 1000, 5000))
      .lean();

    // Build Placemarks for starts & ends; optionally a LineString per trip if both ends exist
    const placemarks = [];
    const lines = [];

    for (const t of trips) {
      const s = pickLatLng(t, 'start');
      const e = pickLatLng(t, 'end');

      if (s) placemarks.push(kmlPlacemark(`Trip ${t._id} start`, s.lat, s.lng, t.startedAt ? new Date(t.startedAt).toISOString() : ''));
      if (e) placemarks.push(kmlPlacemark(`Trip ${t._id} end`, e.lat, e.lng, t.endedAt ? new Date(t.endedAt).toISOString() : ''));

      if (s && e) {
        lines.push(`
          <Placemark>
            <name>Trip ${t._id}</name>
            <Style>
              <LineStyle><width>3</width></LineStyle>
            </Style>
            <LineString>
              <tessellate>1</tessellate>
              <coordinates>
                ${s.lng},${s.lat},0
                ${e.lng},${e.lat},0
              </coordinates>
            </LineString>
          </Placemark>
        `);
      }
    }

    const doc = `<?xml version="1.0" encoding="UTF-8"?>
      <kml xmlns="http://www.opengis.net/kml/2.2">
        <Document>
          <name>Vehicle ${String(vId)} Trips</name>
          ${placemarks.join('\n')}
          ${lines.join('\n')}
        </Document>
      </kml>`;

    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vehicle-${String(vId)}-trips.kml"`);
    res.send(doc);
  } catch (err) { next(err); }
});

module.exports = router;
