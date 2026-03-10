// core-backend/routes/logbook.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");

const router = express.Router();

// Prefer already-compiled model; only require if missing
const VehicleLog =
  mongoose.models.VehicleLog || require("../models/VehicleLog");

/* ----------------------------- helpers ------------------------------ */
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) =>
  isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : null;

function computeDistance(start, end) {
  if (start == null || end == null) return undefined;
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return undefined;
  return Math.max(0, e - s);
}

// Prefer org from middleware (req.org), fallback to resolved auth context
function getOrgId(req) {
  return req.org?._id || req.orgId || req.user?.orgId || undefined;
}

// Build an org filter only if schema supports orgId
function buildOrgFilter(req) {
  const orgId = getOrgId(req);
  const path = VehicleLog.schema.path("orgId");
  if (!path) return {};
  if (!orgId) return {};

  const s = String(orgId);

  if (path.instance === "ObjectID") {
    return isValidId(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  if (path.instance === "String") {
    return s ? { orgId: s } : {};
  }
  return {};
}

function cleanTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean).map(String);
  if (typeof tags === "string" && tags.trim()) return [tags.trim()];
  return [];
}

/* ----------------------------- core ops ----------------------------- */
async function listLogs(req, res) {
  const { vehicleId, q, tag, from, to, minKm, maxKm, limit } = req.query;

  const find = { ...buildOrgFilter(req) };

  // allow vehicleId via query OR via nested routes param
  const vParam = req.params.vehicleId;
  const vId = vehicleId || vParam;
  if (vId) {
    const oid = asObjectId(vId);
    if (!oid) return res.status(400).json({ error: "invalid vehicleId" });
    find.vehicleId = oid;
  }

  if (q) {
    const rx = new RegExp(String(q), "i");
    find.$or = [{ title: rx }, { notes: rx }, { tags: q }];
  }

  if (tag) find.tags = tag;

  if (from || to) {
    find.ts = {
      ...(from ? { $gte: new Date(from) } : {}),
      ...(to ? { $lte: new Date(to) } : {}),
    };
  }

  if (minKm || maxKm) {
    find.distance = {};
    if (minKm != null && minKm !== "") find.distance.$gte = Number(minKm);
    if (maxKm != null && maxKm !== "") find.distance.$lte = Number(maxKm);
  }

  const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);

  const rows = await VehicleLog.find(find)
    .sort({ ts: -1, createdAt: -1 })
    .limit(lim)
    .lean();

  res.json(rows);
}

async function createLog(req, res) {
  const body = req.body || {};
  const vParam = req.params.vehicleId;

  const vehicleId = body.vehicleId || vParam;
  const vid = asObjectId(vehicleId);
  if (!vid)
    return res.status(400).json({ error: "vehicleId required/invalid" });

  const title = body.title;
  if (!title) return res.status(400).json({ error: "title required" });

  const odometer =
    body.odometer != null && body.odometer !== ""
      ? Number(body.odometer)
      : undefined;

  const odometerStart =
    body.odometerStart != null && body.odometerStart !== ""
      ? Number(body.odometerStart)
      : odometer;

  const odometerEnd =
    body.odometerEnd != null && body.odometerEnd !== ""
      ? Number(body.odometerEnd)
      : odometer;

  const cost =
    body.cost != null && body.cost !== "" ? Number(body.cost) : undefined;

  const doc = {
    vehicleId: vid,
    title: String(title).trim(),
    type: String(body.type || "other")
      .trim()
      .toLowerCase(),
    vendor: String(body.vendor || "").trim(),
    cost: Number.isFinite(cost) ? cost : undefined,
    notes: String(body.notes || ""),
    tags: cleanTags(body.tags),
    ts: body.ts ? new Date(body.ts) : new Date(),
    odometer: Number.isFinite(odometer) ? odometer : undefined,
    odometerStart: Number.isFinite(odometerStart) ? odometerStart : undefined,
    odometerEnd: Number.isFinite(odometerEnd) ? odometerEnd : undefined,
    distance: computeDistance(odometerStart, odometerEnd),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    sourceOfflineEventId: body.sourceOfflineEventId || undefined,
    createdBy: req.user?.sub || req.user?._id || "unknown",
  };

  const orgFilter = buildOrgFilter(req);
  if (orgFilter.orgId != null) doc.orgId = orgFilter.orgId;

  const row = await VehicleLog.create(doc);
  res.status(201).json(row);
}

async function updateLog(req, res) {
  const entryId = req.params.id || req.params.entryId;
  if (!asObjectId(entryId)) {
    return res.status(404).json({ error: "Not found" });
  }

  const row = await VehicleLog.findOne({
    _id: asObjectId(entryId),
    ...buildOrgFilter(req),
  });

  if (!row) return res.status(404).json({ error: "Not found" });

  const body = req.body || {};

  if (body.title != null) row.title = String(body.title).trim();
  if (body.type != null)
    row.type = String(body.type || "other")
      .trim()
      .toLowerCase();
  if (body.vendor != null) row.vendor = String(body.vendor || "").trim();
  if (body.notes != null) row.notes = String(body.notes || "");
  if (body.tags != null) row.tags = cleanTags(body.tags);

  if (body.cost !== undefined) {
    row.cost =
      body.cost != null &&
      body.cost !== "" &&
      Number.isFinite(Number(body.cost))
        ? Number(body.cost)
        : undefined;
  }

  if (body.ts != null) {
    row.ts = body.ts ? new Date(body.ts) : row.ts;
  }

  if (body.odometer !== undefined) {
    row.odometer =
      body.odometer != null &&
      body.odometer !== "" &&
      Number.isFinite(Number(body.odometer))
        ? Number(body.odometer)
        : undefined;
  }

  if (body.odometerStart !== undefined) {
    row.odometerStart =
      body.odometerStart != null &&
      body.odometerStart !== "" &&
      Number.isFinite(Number(body.odometerStart))
        ? Number(body.odometerStart)
        : undefined;
  }

  if (body.odometerEnd !== undefined) {
    row.odometerEnd =
      body.odometerEnd != null &&
      body.odometerEnd !== "" &&
      Number.isFinite(Number(body.odometerEnd))
        ? Number(body.odometerEnd)
        : undefined;
  }

  if (body.odometer !== undefined) {
    if (row.odometer != null) {
      row.odometerStart = row.odometer;
      row.odometerEnd = row.odometer;
    }
  }

  row.distance = computeDistance(row.odometerStart, row.odometerEnd);

  if (Array.isArray(body.attachments)) {
    row.attachments = body.attachments;
  }

  await row.save();
  res.json(row);
}

async function deleteLog(req, res) {
  const entryId = req.params.id || req.params.entryId;
  if (!asObjectId(entryId)) {
    return res.status(404).json({ error: "Not found" });
  }

  const deleted = await VehicleLog.findOneAndDelete({
    _id: asObjectId(entryId),
    ...buildOrgFilter(req),
  });

  if (!deleted) return res.status(404).json({ error: "Not found" });

  return res.sendStatus(204);
}

/* ----------------------------- ROUTES ------------------------------ */
/**
 * IMPORTANT:
 * This file defines FULL paths ("/logbook", "/vehicles/:id/logbook", etc).
 * Therefore it should be mounted at "/" and "/api" in index.js (see below).
 */

// LIST aliases
router.get("/logbook", (req, res, next) => listLogs(req, res).catch(next));
router.get("/logbooks", (req, res, next) => listLogs(req, res).catch(next));

// Your frontend is calling this:
router.get("/vehicles/:vehicleId/entries", (req, res, next) =>
  listLogs(req, res).catch(next),
);

// Additional useful aliases
router.get("/vehicles/:vehicleId/logbook", (req, res, next) =>
  listLogs(req, res).catch(next),
);
router.get("/vehicles/:vehicleId/logbook-entries", (req, res, next) =>
  listLogs(req, res).catch(next),
);

// CREATE aliases (the ones you showed in your network log)
router.post("/logbook", (req, res, next) => createLog(req, res).catch(next));
router.post("/logbooks", (req, res, next) => createLog(req, res).catch(next));
router.post("/vehicles/:vehicleId/logbook", (req, res, next) =>
  createLog(req, res).catch(next),
);
router.post("/vehicles/:vehicleId/logbook-entries", (req, res, next) =>
  createLog(req, res).catch(next),
);

// UPDATE aliases
router.put("/logbook/:id", (req, res, next) => updateLog(req, res).catch(next));
router.put("/logbooks/:id", (req, res, next) =>
  updateLog(req, res).catch(next),
);
router.put("/vehicles/:vehicleId/logbook/:entryId", (req, res, next) =>
  updateLog(req, res).catch(next),
);
router.put("/vehicles/:vehicleId/logbook-entries/:entryId", (req, res, next) =>
  updateLog(req, res).catch(next),
);

// DELETE aliases
router.delete("/logbook/:id", (req, res, next) =>
  deleteLog(req, res).catch(next),
);
router.delete("/logbooks/:id", (req, res, next) =>
  deleteLog(req, res).catch(next),
);
router.delete("/vehicles/:vehicleId/logbook/:entryId", (req, res, next) =>
  deleteLog(req, res).catch(next),
);
router.delete(
  "/vehicles/:vehicleId/logbook-entries/:entryId",
  (req, res, next) => deleteLog(req, res).catch(next),
);

module.exports = router;
