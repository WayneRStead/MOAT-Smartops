// core-backend/routes/logbook.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");

const router = express.Router();

// Prefer already-compiled model; only require if missing
const VehicleLog = mongoose.models.VehicleLog || require("../models/VehicleLog");

/* ----------------------------- helpers ------------------------------ */
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) => (isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

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
  if (!vid) return res.status(400).json({ error: "vehicleId required/invalid" });

  const title = body.title;
  if (!title) return res.status(400).json({ error: "title required" });

  const odometerStart =
    body.odometerStart != null && body.odometerStart !== "" ? Number(body.odometerStart) : undefined;
  const odometerEnd =
    body.odometerEnd != null && body.odometerEnd !== "" ? Number(body.odometerEnd) : undefined;

  const doc = {
    vehicleId: vid,
    title: String(title).trim(),
    notes: String(body.notes || ""),
    tags: cleanTags(body.tags),
    ts: body.ts ? new Date(body.ts) : new Date(),
    odometerStart,
    odometerEnd,
    distance: computeDistance(odometerStart, odometerEnd),
    createdBy: req.user?.sub || req.user?._id || "unknown",
  };

  const orgFilter = buildOrgFilter(req);
  if (orgFilter.orgId != null) doc.orgId = orgFilter.orgId;

  const row = await VehicleLog.create(doc);
  res.status(201).json(row);
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
router.get("/vehicles/:vehicleId/entries", (req, res, next) => listLogs(req, res).catch(next));

// Additional useful aliases
router.get("/vehicles/:vehicleId/logbook", (req, res, next) => listLogs(req, res).catch(next));
router.get("/vehicles/:vehicleId/logbook-entries", (req, res, next) => listLogs(req, res).catch(next));

// CREATE aliases (the ones you showed in your network log)
router.post("/logbook", (req, res, next) => createLog(req, res).catch(next));
router.post("/logbooks", (req, res, next) => createLog(req, res).catch(next));
router.post("/vehicles/:vehicleId/logbook", (req, res, next) => createLog(req, res).catch(next));
router.post("/vehicles/:vehicleId/logbook-entries", (req, res, next) => createLog(req, res).catch(next));

module.exports = router;
