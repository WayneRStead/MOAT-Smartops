// core-backend/routes/vehicleTrips.js
//
// ✅ DROP-IN replacement
// - Stores ALL trip photos in MongoDB GridFS bucket: vehicleTrips.files / vehicleTrips.chunks
// - Returns URLs like: /files/vehicle-trips/<FILENAME>
//   (this matches the index.js handler we added that streams by *filename*)
// - Does NOT write to /uploads on disk (Render filesystem is ephemeral)

const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

const Vehicle = require("../models/Vehicle");
const VehicleTrip = require("../models/VehicleTrip");

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
function toNum(n) {
  if (n === "" || n == null) return undefined;
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}
function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function toObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
}
function computeDistance(odoStart, odoEnd) {
  const a = Number(odoStart),
    b = Number(odoEnd);
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

function getOrgId(req) {
  // resolveOrgContext usually sets one of these; keep it defensive.
  return (
    req.org?._id ||
    req.orgId ||
    req.organization?._id ||
    req.tenant?._id ||
    req.user?.orgId ||
    undefined
  );
}

/* ------------------------------ GridFS ------------------------------ */
/**
 * Bucket name MUST match your MongoDB collections:
 * - vehicleTrips.files
 * - vehicleTrips.chunks
 */
function getBucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error("MongoDB not ready (mongoose.connection.db missing).");
  return new GridFSBucket(db, { bucketName: "vehicleTrips" });
}

function makeSafeFilename(originalname = "photo") {
  const safe = String(originalname).replace(/[^\w.-]+/g, "_");
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

/**
 * IMPORTANT:
 * We return URLs that look like "/files/vehicle-trips/<filename>"
 * because your index.js now streams *by filename* from GridFS as a fallback.
 */
function urlForFilename(filename) {
  return `/files/vehicle-trips/${filename}`;
}

async function saveFileToGridFS(file, extraMeta = {}) {
  if (!file) throw new Error("No file");
  const bucket = getBucket();

  const filename = makeSafeFilename(file.originalname);

  const uploadStream = bucket.openUploadStream(filename, {
    contentType: file.mimetype,
    metadata: {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      ...extraMeta,
    },
  });

  uploadStream.end(file.buffer);

  await new Promise((resolve, reject) => {
    uploadStream.on("finish", resolve);
    uploadStream.on("error", reject);
  });

  return {
    filename,
    url: urlForFilename(filename),
    mime: file.mimetype,
    size: file.size,
  };
}

/* ------------------------------ uploads ------------------------------ */
/**
 * ✅ Memory storage (NOT disk)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\//i.test(file.mimetype)) return cb(new Error("Only image uploads are allowed."));
    cb(null, true);
  },
});

/* ------------------------------- reads -------------------------------- */
// GET /vehicles/:vehicleId/trips  (list)
router.get("/vehicles/:vehicleId/trips", async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: "Invalid vehicle id" });

    const { limit = 200, skip = 0, driverId, projectId, taskId, includeDeleted } = req.query;

    const q = { vehicleId: vId };

    // Tenancy (if your data is org-scoped, this prevents cross-org leakage)
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    if (!includeDeleted) q.isDeleted = { $ne: true };

    if (driverId) q.driverUserId = driverId;
    if (projectId) q.projectId = projectId;
    if (taskId) q.taskId = taskId;

    const list = await VehicleTrip.find(q)
      .sort({ startedAt: -1, createdAt: -1 })
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 200, 1000))
      .lean();

    res.json(list);
  } catch (err) {
    next(err);
  }
});

// GET /vehicles/:vehicleId/trips/open  (open trip or 404)
router.get("/vehicles/:vehicleId/trips/open", async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: "Invalid vehicle id" });

    const q = { vehicleId: vId, status: "open", isDeleted: { $ne: true } };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const open = await VehicleTrip.findOne(q).lean();
    if (!open) return res.status(404).json({ error: "No open trip" });

    res.json(open);
  } catch (err) {
    next(err);
  }
});

// GET /vehicle-trips/:id  (canonical)
router.get("/vehicle-trips/:id", async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: "Invalid id" });

    const q = { _id: tId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q).lean();
    if (!trip) return res.status(404).json({ error: "Not found" });

    res.json(trip);
  } catch (err) {
    next(err);
  }
});

// Alias: GET /vehicleTrips/:id  → rewrite to /vehicle-trips/:id
router.get("/vehicleTrips/:id", (req, _res, next) => {
  req.url = req.url.replace(/^\/vehicleTrips\//, "/vehicle-trips/");
  next();
}, router);

/* ----------------------- create / close trip --------------------------- */
// POST /vehicles/:vehicleId/trips/start
router.post("/vehicles/:vehicleId/trips/start", async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    if (!vId) return res.status(400).json({ error: "Invalid vehicle id" });

    const orgId = getOrgId(req);

    const vehicle = await Vehicle.findById(vId);
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

    // Only one open trip per vehicle (per org if orgId exists)
    const openQ = { vehicleId: vId, status: "open", isDeleted: { $ne: true } };
    if (orgId) openQ.orgId = orgId;

    const existing = await VehicleTrip.findOne(openQ);
    if (existing) return res.status(400).json({ error: "There is already an open trip for this vehicle." });

    const body = req.body || {};

    // GEO
    const startGeo =
      body.startLat != null && body.startLng != null
        ? { lat: Number(body.startLat), lng: Number(body.startLng), acc: toNum(body.startAccuracy) }
        : readGeo(body);

    const startLocation =
      body?.startLocation?.type === "Point" &&
      Array.isArray(body.startLocation.coordinates) &&
      body.startLocation.coordinates.length >= 2
        ? {
            type: "Point",
            coordinates: [Number(body.startLocation.coordinates[0]), Number(body.startLocation.coordinates[1])],
          }
        : body.startLat != null && body.startLng != null
        ? { type: "Point", coordinates: [Number(body.startLng), Number(body.startLat)] }
        : undefined;

    // Driver (required by your schema)
    const driverUserId = body.driverUserId || body.driverId || vehicle.driverId || req.user?._id;
    if (!driverUserId) return res.status(422).json({ error: "driverUserId is required (missing driver)." });

    // OdoStart (required by your schema)
    let odoStart = toNum(body.odoStart);
    if (odoStart == null && Number.isFinite(vehicle?.odometer)) odoStart = Number(vehicle.odometer);
    if (odoStart == null) return res.status(422).json({ error: "odoStart is required." });

    // Odometer guard: start must be >= last closed end & >= vehicle.odometer
    const lastClosedQ = { vehicleId: vId, status: "closed", isDeleted: { $ne: true } };
    if (orgId) lastClosedQ.orgId = orgId;

    const lastClosed = await VehicleTrip.findOne(lastClosedQ).sort({ endedAt: -1, createdAt: -1 });

    const lastEndOdo = Number.isFinite(lastClosed?.odoEnd) ? Number(lastClosed.odoEnd) : undefined;
    const vehicleOdo = Number.isFinite(vehicle?.odometer) ? Number(vehicle.odometer) : undefined;
    const floorOdo = Math.max(
      Number.isFinite(lastEndOdo) ? lastEndOdo : -Infinity,
      Number.isFinite(vehicleOdo) ? vehicleOdo : -Infinity
    );

    if (Number.isFinite(floorOdo) && Number.isFinite(odoStart) && odoStart < floorOdo) {
      return res.status(422).json({
        error: `Odometer start (${odoStart}) cannot be less than last recorded end (${floorOdo}).`,
      });
    }

    const trip = new VehicleTrip(
      stripUndef({
        orgId,
        vehicleId: vId,
        driverUserId,
        status: "open",
        startedAt: new Date(),
        odoStart,
        projectId: body.projectId || vehicle.projectId || undefined,
        taskId: body.taskId || vehicle.taskId || undefined,
        notes: body.notes || undefined,
        tags: Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : undefined,
        purpose: body.purpose === "Private" || body.purpose === "Business" ? body.purpose : "Business",
        startGeo,
        startLocation,

        // Keep compatibility: if frontend sends a URL already, store it.
        startPhoto: body.startPhotoUrl ? { url: body.startPhotoUrl } : undefined,

        createdBy: req.user?.email || req.user?.username || undefined,
        updatedBy: req.user?.email || req.user?.username || undefined,
      })
    );

    await trip.save();
    res.json(trip.toObject());
  } catch (err) {
    next(err);
  }
});

// POST /vehicles/:vehicleId/trips/:tripId/end
router.post("/vehicles/:vehicleId/trips/:tripId/end", async (req, res, next) => {
  try {
    const vId = toObjectId(req.params.vehicleId);
    const tId = toObjectId(req.params.tripId);
    if (!vId || !tId) return res.status(400).json({ error: "Invalid id" });

    const orgId = getOrgId(req);

    const q = { _id: tId, vehicleId: vId, isDeleted: { $ne: true } };
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    if (trip.status === "closed" || trip.endedAt) return res.status(400).json({ error: "Trip already ended" });

    const body = req.body || {};
    if (body.notes) trip.notes = String(body.notes);

    // Purpose (optional update)
    if (body.purpose === "Business" || body.purpose === "Private") trip.purpose = body.purpose;

    // Odometer end (must be >= start)
    const incomingEnd = toNum(body.odoEnd);
    if (incomingEnd != null) {
      if (trip.odoStart != null && incomingEnd < Number(trip.odoStart)) {
        return res.status(422).json({
          error: `Odometer end (${incomingEnd}) cannot be less than trip start (${trip.odoStart}).`,
        });
      }
      trip.odoEnd = incomingEnd;
    }

    // GEO
    const endGeo =
      body.endLat != null && body.endLng != null
        ? { lat: Number(body.endLat), lng: Number(body.endLng), acc: toNum(body.endAccuracy) }
        : readGeo(body);

    const endLocation =
      body?.endLocation?.type === "Point" &&
      Array.isArray(body.endLocation.coordinates) &&
      body.endLocation.coordinates.length >= 2
        ? {
            type: "Point",
            coordinates: [Number(body.endLocation.coordinates[0]), Number(body.endLocation.coordinates[1])],
          }
        : body.endLat != null && body.endLng != null
        ? { type: "Point", coordinates: [Number(body.endLng), Number(body.endLat)] }
        : endGeo
        ? { type: "Point", coordinates: [endGeo.lng, endGeo.lat] }
        : undefined;

    trip.endGeo = endGeo || undefined;
    trip.endLocation = endLocation || undefined;

    // keep compatibility: if frontend sends URL directly
    if (body.endPhotoUrl) trip.endPhoto = { url: body.endPhotoUrl };

    // close + distance
    trip.endedAt = new Date();
    trip.status = "closed";
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);

    trip.updatedBy = req.user?.email || req.user?.username || trip.updatedBy;
    trip.lastEditedAt = new Date();
    trip.lastEditedBy = req.user?._id || trip.lastEditedBy;

    await trip.save();
    res.json(trip.toObject());
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ updates ------------------------------- */
async function applyTripPatch(trip, patch) {
  const clean = stripUndef({
    startedAt: patch.startedAt ? new Date(patch.startedAt) : undefined,
    endedAt: patch.endedAt ? new Date(patch.endedAt) : undefined,
    odoStart: toNum(patch.odoStart),
    odoEnd: toNum(patch.odoEnd),
    driverUserId: patch.driverUserId || patch.driverId,
    projectId: patch.projectId,
    taskId: patch.taskId,
    notes: patch.notes,
    tags: Array.isArray(patch.tags) ? patch.tags : undefined,
    purpose: patch.purpose === "Business" || patch.purpose === "Private" ? patch.purpose : undefined,
    status: patch.status, // allow if caller uses open/closed/cancelled
  });

  Object.assign(trip, clean);

  if (patch.startGeo) {
    const g = stripUndef({
      lat: toNum(patch.startGeo.lat),
      lng: toNum(patch.startGeo.lng),
      acc: toNum(patch.startGeo.acc),
    });
    trip.startGeo = g.lat != null && g.lng != null ? g : undefined;
    trip.startLocation = g.lat != null && g.lng != null ? { type: "Point", coordinates: [g.lng, g.lat] } : undefined;
  }

  if (patch.endGeo) {
    const g = stripUndef({
      lat: toNum(patch.endGeo.lat),
      lng: toNum(patch.endGeo.lng),
      acc: toNum(patch.endGeo.acc),
    });
    trip.endGeo = g.lat != null && g.lng != null ? g : undefined;
    trip.endLocation = g.lat != null && g.lng != null ? { type: "Point", coordinates: [g.lng, g.lat] } : undefined;
  }

  if (trip.odoStart != null && trip.odoEnd != null) {
    trip.distance = Math.max(0, Number(trip.odoEnd) - Number(trip.odoStart));
  }

  // keep status consistent with endedAt if someone patches endedAt
  if (trip.endedAt && trip.status === "open") trip.status = "closed";
  if (!trip.endedAt && trip.status === "closed") trip.status = "open";

  await trip.save();
  return trip;
}

async function updateById(req, res, next) {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: "Invalid id" });

    const q = { _id: tId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q);
    if (!trip) return res.status(404).json({ error: "Not found" });

    const updated = await applyTripPatch(trip, req.body || {});
    res.json(updated.toObject());
  } catch (err) {
    next(err);
  }
}
router.patch("/vehicle-trips/:id", updateById);
router.put("/vehicle-trips/:id", updateById);

// aliases
router.patch("/vehicleTrips/:id", updateById);
router.put("/vehicleTrips/:id", updateById);

// nested aliases: /vehicles/:vehicleId/trips/:tripId
async function updateNested(req, res, next) {
  try {
    const vId = toObjectId(req.params.vehicleId);
    const tId = toObjectId(req.params.tripId);
    if (!vId || !tId) return res.status(400).json({ error: "Invalid id" });

    const q = { _id: tId, vehicleId: vId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q);
    if (!trip) return res.status(404).json({ error: "Not found" });

    const updated = await applyTripPatch(trip, req.body || {});
    res.json(updated.toObject());
  } catch (err) {
    next(err);
  }
}
router.patch("/vehicles/:vehicleId/trips/:tripId", updateNested);
router.put("/vehicles/:vehicleId/trips/:tripId", updateNested);

/* -------------------------------- audit ------------------------------- */
router.get("/vehicle-trips/:id/audit", async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: "Invalid id" });

    const q = { _id: tId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q).lean();
    if (!trip) return res.status(404).json({ error: "Not found" });

    res.json({ trip, history: [] });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ uploads (GridFS) ------------------------------ */
/**
 * This endpoint is what your frontend logs show:
 * POST https://moat-smartops.onrender.com/vehicle-trips/upload
 *
 * It returns:
 *  { url: "/files/vehicle-trips/<filename>", filename, size, mime }
 */
router.post("/vehicle-trips/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const meta = await saveFileToGridFS(req.file, {
      uploadedBy: String(req.user?._id || ""),
      orgId: String(getOrgId(req) || ""),
    });

    res.json(meta);
  } catch (err) {
    next(err);
  }
});

router.post("/vehicle-trips/:id/upload-start", upload.single("file"), async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: "Invalid id" });
    if (!req.file) return res.status(400).json({ error: "No file" });

    const q = { _id: tId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q);
    if (!trip) return res.status(404).json({ error: "Not found" });

    const meta = await saveFileToGridFS(req.file, {
      uploadedBy: String(req.user?._id || ""),
      orgId: String(orgId || ""),
      tripId: String(trip._id),
      kind: "start",
    });

    trip.startPhoto = {
      filename: meta.filename,
      url: meta.url,
      mime: meta.mime,
      size: meta.size,
      uploadedBy: String(req.user?._id || ""),
      uploadedAt: new Date(),
    };
    trip.updatedBy = req.user?.email || req.user?.username || trip.updatedBy;

    await trip.save();
    res.json(trip.toObject());
  } catch (err) {
    next(err);
  }
});

router.post("/vehicle-trips/:id/upload-end", upload.single("file"), async (req, res, next) => {
  try {
    const tId = toObjectId(req.params.id);
    if (!tId) return res.status(400).json({ error: "Invalid id" });
    if (!req.file) return res.status(400).json({ error: "No file" });

    const q = { _id: tId };
    const orgId = getOrgId(req);
    if (orgId) q.orgId = orgId;

    const trip = await VehicleTrip.findOne(q);
    if (!trip) return res.status(404).json({ error: "Not found" });

    const meta = await saveFileToGridFS(req.file, {
      uploadedBy: String(req.user?._id || ""),
      orgId: String(orgId || ""),
      tripId: String(trip._id),
      kind: "end",
    });

    trip.endPhoto = {
      filename: meta.filename,
      url: meta.url,
      mime: meta.mime,
      size: meta.size,
      uploadedBy: String(req.user?._id || ""),
      uploadedAt: new Date(),
    };
    trip.updatedBy = req.user?.email || req.user?.username || trip.updatedBy;

    await trip.save();
    res.json(trip.toObject());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
