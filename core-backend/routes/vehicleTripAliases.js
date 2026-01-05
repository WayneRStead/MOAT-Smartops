// core-backend/routes/vehicleTripAliases.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const VehicleTrip = require("../models/VehicleTrip");
const Vehicle = require("../models/Vehicle");

/* ------------------------------ helpers ------------------------------ */
function toNum(n) {
  if (n === "" || n == null) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}
function sanitizeGeo(g) {
  if (!g || typeof g !== "object") return undefined;
  const lat = toNum(g.lat);
  const lng = toNum(g.lng);
  const acc = toNum(g.acc);
  if (lat == null || lng == null) return undefined;
  return { lat, lng, acc: acc == null ? undefined : acc };
}
function computeDistance(odoStart, odoEnd) {
  const a = Number(odoStart),
    b = Number(odoEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.max(0, b - a);
}

// best-effort orgId extraction (matches what your middleware usually sets)
function getOrgId(req) {
  return (
    req.org?._id ||
    req.orgId ||
    req.organization?._id ||
    req.tenant?._id ||
    req.user?.orgId ||
    undefined
  );
}

// Build a partial patch from request body (lenient to older clients)
function toPatch(body = {}) {
  const patch = {};

  if ("startedAt" in body) patch.startedAt = body.startedAt ? new Date(body.startedAt) : null;
  if ("endedAt" in body) patch.endedAt = body.endedAt ? new Date(body.endedAt) : null;

  if ("odoStart" in body) patch.odoStart = body.odoStart === "" ? null : toNum(body.odoStart);
  if ("odoEnd" in body) patch.odoEnd = body.odoEnd === "" ? null : toNum(body.odoEnd);

  if ("driverUserId" in body) patch.driverUserId = body.driverUserId || null;
  if ("projectId" in body) patch.projectId = body.projectId || null;
  if ("taskId" in body) patch.taskId = body.taskId || null;

  if ("notes" in body) patch.notes = body.notes ?? "";

  if (Array.isArray(body.tags)) patch.tags = body.tags;

  if (body.purpose === "Business" || body.purpose === "Private") patch.purpose = body.purpose;

  // Allow legacy status strings if provided, but only if valid
  if (body.status === "open" || body.status === "closed" || body.status === "cancelled") {
    patch.status = body.status;
  }

  const sg = sanitizeGeo(body.startGeo);
  const eg = sanitizeGeo(body.endGeo);
  if (sg) patch.startGeo = sg;
  if (eg) patch.endGeo = eg;

  return patch;
}

/**
 * Update a trip by id with odometer validation and distance recompute.
 * Optionally constrain by vehicleId (for nested alias).
 * Also constrains by orgId if available on request.
 */
async function updateTripById(req, id, body, vehicleIdConstraint) {
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error("Invalid trip id");
    err.status = 400;
    throw err;
  }

  const orgId = getOrgId(req);

  const query = { _id: id };
  if (vehicleIdConstraint) query.vehicleId = vehicleIdConstraint;
  if (orgId) query.orgId = orgId;

  const trip = await VehicleTrip.findOne(query);
  if (!trip) {
    const err = new Error("Trip not found");
    err.status = 404;
    throw err;
  }

  const patch = toPatch(body);

  // ----- ODOMETER GUARDS -----
  if (Object.prototype.hasOwnProperty.call(patch, "odoStart") && patch.odoStart != null) {
    const vId = trip.vehicleId;
    if (vId) {
      const [lastClosed, vehicle] = await Promise.all([
        VehicleTrip.findOne({
          vehicleId: vId,
          _id: { $ne: trip._id },
          isDeleted: { $ne: true },
          // prefer status, but tolerate older docs that only used endedAt
          $or: [{ status: "closed" }, { endedAt: { $ne: null } }],
          ...(orgId ? { orgId } : {}),
        })
          .sort({ endedAt: -1, createdAt: -1 })
          .lean(),
        Vehicle.findById(vId).lean(),
      ]);

      const lastEndOdo = Number.isFinite(lastClosed?.odoEnd) ? Number(lastClosed.odoEnd) : -Infinity;
      const vehicleOdo = Number.isFinite(vehicle?.odometer) ? Number(vehicle.odometer) : -Infinity;
      const floor = Math.max(lastEndOdo, vehicleOdo);

      if (Number.isFinite(floor) && patch.odoStart < floor) {
        const err = new Error(
          `Odometer start (${patch.odoStart}) cannot be less than last recorded end (${floor}).`
        );
        err.status = 422;
        throw err;
      }
    }
  }

  const nextOdoStart =
    Object.prototype.hasOwnProperty.call(patch, "odoStart") && patch.odoStart != null
      ? patch.odoStart
      : trip.odoStart;

  if (Object.prototype.hasOwnProperty.call(patch, "odoEnd") && patch.odoEnd != null) {
    if (nextOdoStart != null && patch.odoEnd < nextOdoStart) {
      const err = new Error(
        `Odometer end (${patch.odoEnd}) cannot be less than trip start (${nextOdoStart}).`
      );
      err.status = 422;
      throw err;
    }
  }

  // mirror driverId for older clients (safe even if schema doesn't have it)
  if (patch.driverUserId && !patch.driverId) patch.driverId = patch.driverUserId;

  Object.assign(trip, patch);

  // Keep status consistent with endedAt if patched
  if (trip.endedAt && trip.status === "open") trip.status = "closed";
  if (!trip.endedAt && trip.status === "closed") trip.status = "open";

  if (trip.odoStart != null && trip.odoEnd != null) {
    trip.distance = computeDistance(trip.odoStart, trip.odoEnd);
  }

  await trip.save();
  return trip;
}

/* ------------------------------- READ ------------------------------- */

// GET /vehicleTrips/:id   (legacy)
router.get("/vehicleTrips/:id", async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const q = { _id: req.params.id };
    if (orgId) q.orgId = orgId;

    const t = await VehicleTrip.findOne(q);
    if (!t) return res.status(404).json({ error: "Not Found" });
    res.json(t);
  } catch (e) {
    next(e);
  }
});

// GET /trips/:id   (very old path)
router.get("/trips/:id", async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const q = { _id: req.params.id };
    if (orgId) q.orgId = orgId;

    const t = await VehicleTrip.findOne(q);
    if (!t) return res.status(404).json({ error: "Not Found" });
    res.json(t);
  } catch (e) {
    next(e);
  }
});

// GET /vehicles/:vehicleId/trips/open  (legacy alias for "open trip")
router.get("/vehicles/:vehicleId/trips/open", async (req, res, next) => {
  try {
    const orgId = getOrgId(req);

    const q = {
      vehicleId: req.params.vehicleId,
      isDeleted: { $ne: true },
      ...(orgId ? { orgId } : {}),
      // Prefer status=open, but also tolerate old docs that used endedAt missing
      $or: [{ status: "open" }, { endedAt: { $in: [null, undefined] } }],
    };

    const t = await VehicleTrip.findOne(q).sort({ startedAt: -1, createdAt: -1 });
    if (!t) return res.status(404).json({ error: "No open trip" });
    res.json(t);
  } catch (e) {
    next(e);
  }
});

/* --------------------------- UPDATE (PUT/PATCH) --------------------------- */

// PUT/PATCH /vehicleTrips/:id
router.put("/vehicleTrips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});
router.patch("/vehicleTrips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

// PUT/PATCH /trips/:id
router.put("/trips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});
router.patch("/trips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

// PUT/PATCH /vehicles/:vehicleId/trips/:id  (scoped alias)
router.put("/vehicles/:vehicleId/trips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body, req.params.vehicleId));
  } catch (e) {
    next(e);
  }
});
router.patch("/vehicles/:vehicleId/trips/:id", async (req, res, next) => {
  try {
    res.json(await updateTripById(req, req.params.id, req.body, req.params.vehicleId));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
