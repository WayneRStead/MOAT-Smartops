// core-backend/routes/tasks.js — visibility-enabled (org-scoped & backward-compatible)
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { requireAuth } = require("../middleware/auth");
const Task = require("../models/Task");
const Project = require("../models/Project"); // inherit project fences

const router = express.Router();

/* ------------------------- Helpers ------------------------- */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const OID = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

function allowRoles(...roles) {
  return (req, res, next) => {
    const role = req.user?.role || req.user?.claims?.role;
    if (!roles.length) return next();
    if (!role) return res.sendStatus(401);
    if (!roles.includes(role)) return res.sendStatus(403);
    next();
  };
}

const getRole = (req) => (req.user?.role || req.user?.claims?.role || "user");
const isAdminRole = (role) => ["admin", "superadmin"].includes(String(role).toLowerCase());
const isAdmin = (req) => isAdminRole(getRole(req));

// enum-ish
const normalizeStatus = (s) => (s ? String(s).toLowerCase() : undefined);

/* ----------------------- Org helpers ----------------------- */

const wantsObjectId = (model, p) => model?.schema?.path(p)?.instance === "ObjectId";
function hasPath(model, p) {
  return !!(model && model.schema && model.schema.path && model.schema.path(p));
}

/**
 * IMPORTANT:
 * - If token orgId is NOT a valid ObjectId (e.g. "root"), do NOT scope by org at all.
 */
function orgScope(model, req) {
  if (!hasPath(model, "orgId")) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  if (wantsObjectId(model, "orgId")) return { orgId: new mongoose.Types.ObjectId(s) };
  return { orgId: s };
}

function ensureOrgOnDoc(model, doc, req) {
  if (!hasPath(model, "orgId")) return true;
  const present = doc.orgId != null && String(doc.orgId) !== "";
  if (present) return true;

  const raw = req.user?.orgId;
  if (!raw) return false;
  const s = String(raw);

  if (wantsObjectId(model, "orgId")) {
    if (!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId = new mongoose.Types.ObjectId(s);
  } else {
    if (!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId = s;
  }
  return true;
}

/* ----------------------- Time helpers ---------------------- */

function computeActualMinutes(log = []) {
  const entries = [...(log || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  let totalMs = 0;
  let startedAt = null;
  for (const e of entries) {
    const t = new Date(e.at).getTime();
    if ((e.action === "start" || e.action === "resume") && startedAt == null) {
      startedAt = t;
    } else if ((e.action === "pause" || e.action === "complete") && startedAt != null) {
      totalMs += Math.max(0, t - startedAt);
      startedAt = null;
    }
  }
  return Math.round(totalMs / 60000);
}

function ensureLogIds(taskDoc) {
  let patched = false;
  for (const e of taskDoc.actualDurationLog || []) {
    if (!e._id) {
      e._id = new mongoose.Types.ObjectId();
      patched = true;
    }
  }
  return patched;
}

function setStatusFromLog(taskDoc) {
  const log = [...(taskDoc.actualDurationLog || [])]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .filter((e) => e.action !== "photo");
  if (!log.length) return;
  const last = log[log.length - 1];
  if (last.action === "start" || last.action === "resume") taskDoc.status = "in-progress";
  if (last.action === "pause") taskDoc.status = "paused";
  if (last.action === "complete") taskDoc.status = "completed";
}

/* ---------------- normalize output ---------------- */
function normalizeOut(t) {
  const obj = t.toObject ? t.toObject() : { ...t };
  return {
    ...obj,
    // prefer dueAt if present, else legacy dueDate
    dueAt: obj.dueAt ?? obj.dueDate ?? null,
    // expose startDate, and alias startAt for older clients
    startDate: obj.startDate ?? null,
    startAt: obj.startDate ?? null,
    // legacy mirrors (kept)
    assignee: Array.isArray(obj.assignedTo) ? obj.assignedTo[0] : obj.assignee,
    actualDurationMinutes: computeActualMinutes(obj.actualDurationLog || []),
    isBlocked: (obj.dependentTaskIds?.length || 0) > 0,
    visibilityMode: obj.visibilityMode || "org",
    assignedUserIds: Array.isArray(obj.assignedUserIds) ? obj.assignedUserIds : [],
    assignedGroupIds: Array.isArray(obj.assignedGroupIds) ? obj.assignedGroupIds : [],
  };
}

/* ---------------- Visibility helpers ---------------- */

function normalizeMode(mode) {
  const v = String(mode || "org").toLowerCase();
  if (v === "restricted") return "assignees+groups";
  return v;
}
function buildVisibilityFilter(req) {
  if (isAdmin(req)) return {};

  const me =
    OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);
  const myGroups = (req.myGroupIds || []).map((g) => OID(g)).filter(Boolean);

  return {
    $or: [
      { visibilityMode: { $exists: false } },
      { visibilityMode: "org" },

      { visibilityMode: "assignees",        assignedUserIds: me },
      { visibilityMode: "assignees+groups", assignedUserIds: me },

      { visibilityMode: "assignees",        assignedTo: me }, // legacy
      { visibilityMode: "assignees+groups", assignedTo: me },

      ...(myGroups.length
        ? [
            { visibilityMode: "groups",           assignedGroupIds: { $in: myGroups } },
            { visibilityMode: "assignees+groups", assignedGroupIds: { $in: myGroups } },
            { visibilityMode: "groups",           groupId: { $in: myGroups } }, // legacy single group
            { visibilityMode: "assignees+groups", groupId: { $in: myGroups } },
          ]
        : []),
    ],
  };
}

async function assertCanSeeTaskOrAdmin(req, taskId) {
  if (isAdmin(req)) return true;
  const filter = { _id: OID(taskId), ...orgScope(Task, req), ...buildVisibilityFilter(req) };
  const exists = await Task.exists(filter);
  return !!exists;
}

function andFilters(...parts) {
  const xs = parts.filter(Boolean);
  if (!xs.length) return {};
  if (xs.length === 1) return xs[0];
  return { $and: xs };
}

function coerceObjectIdArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
}

function sanitizeVisibilityInput(reqBody, roleIsAdmin) {
  const out = {};
  if (reqBody.visibilityMode != null) {
    let v = normalizeMode(reqBody.visibilityMode);
    if (["org", "assignees", "groups", "assignees+groups", "admins"].includes(v)) {
      if (v === "admins" && !roleIsAdmin) {
        throw Object.assign(new Error("Only admins can set admins visibility"), { status: 403 });
      }
      out.visibilityMode = v;
    }
  }
  if (reqBody.assignedUserIds !== undefined) {
    out.assignedUserIds = coerceObjectIdArray(reqBody.assignedUserIds);
  }
  if (reqBody.assignedGroupIds !== undefined) {
    out.assignedGroupIds = coerceObjectIdArray(reqBody.assignedGroupIds);
  }

  if (out.assignedUserIds === undefined && Array.isArray(reqBody.assignedTo)) {
    out.assignedUserIds = coerceObjectIdArray(reqBody.assignedTo);
  }
  if (out.assignedGroupIds === undefined && reqBody.groupId) {
    const gid = OID(reqBody.groupId);
    out.assignedGroupIds = gid ? [gid] : [];
  }

  return out;
}

/* ---------------- Geofence helpers ---------------- */

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      ((yi > point.lat) !== (yj > point.lat)) &&
      (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function collectTaskFences(taskOrProject) {
  const src = taskOrProject || {};
  const fences = [];

  if (src.locationGeoFence?.lat != null && src.locationGeoFence?.lng != null) {
    fences.push({
      type: "circle",
      center: { lat: Number(src.locationGeoFence.lat), lng: Number(src.locationGeoFence.lng) },
      radius: Number(src.locationGeoFence.radius || 50),
    });
  }
  if (Array.isArray(src.geoFences)) {
    for (const f of src.geoFences) {
      if (f?.type === "circle" && f.center && f.radius != null) {
        fences.push({
          type: "circle",
          center: { lat: Number(f.center.lat), lng: Number(f.center.lng) },
          radius: Number(f.radius),
        });
      } else if (f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3) {
        fences.push({ type: "polygon", ring: f.polygon });
      }
    }
  }
  return fences;
}
function isInsideAnyFence(point, fences) {
  for (const f of fences) {
    if (f.type === "circle") {
      const d = haversineMeters(f.center, point);
      if (d <= (f.radius || 0)) return true;
    } else if (f.type === "polygon") {
      if (pointInPolygon(point, f.ring)) return true;
    }
  }
  return false;
}
function extractKMLFromKMZ(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    thePreferred = entries.find(e => /(^|\/)doc\.kml$/i.test(e.entryName));
    const kmlEntry = thePreferred || entries.find(e => /\.kml$/i.test(e.entryName));
    if (!kmlEntry) return null;
    return kmlEntry.getData().toString("utf8");
  } catch {
    return null;
  }
}

/* --------- parse uploads (geojson/kml/kmz) ---------- */
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});
function parseGeoJSONToFences(buf, defaultRadius = 50) {
  const fences = [];
  let gj;
  try { gj = JSON.parse(buf.toString("utf8")); } catch { return fences; }
  function addGeom(geom) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    if (t === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const outer = geom.coordinates[0];
      if (Array.isArray(outer) && outer.length >= 3) {
        fences.push({ type: "polygon", polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]) });
      }
    } else if (t === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        const outer = Array.isArray(poly) && poly.length ? poly[0] : null;
        if (outer && outer.length >= 3) {
          fences.push({ type: "polygon", polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]) });
        }
      }
    } else if (t === "Point" && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      const [lng, lat] = geom.coordinates;
      fences.push({ type: "circle", center: { lat: Number(lat), lng: Number(lng) }, radius: Number(defaultRadius) });
    }
  }
  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) {
    gj.features.forEach(f => addGeom(f?.geometry));
  } else if (gj.type === "Feature") {
    addGeom(gj.geometry);
  } else {
    addGeom(gj);
  }
  return fences;
}
function parseKMLToFences(text, defaultRadius = 50) {
  const fences = [];
  const lower = text.toLowerCase();
  const polyRegex = /<polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/polygon>/gi;
  let m;
  while ((m = polyRegex.exec(lower)) !== null) {
    const pairs = m[1]
      .trim()
      .split(/\s+/)
      .map((p) => p.split(",").slice(0, 2).map(Number))
      .filter((a) => a.length === 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]));
    if (pairs.length >= 3) fences.push({ type: "polygon", polygon: pairs.map(([lng, lat]) => [lng, lat]) });
  }
  const ptRegex = /<point[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/point>/gi;
  while ((m = ptRegex.exec(lower)) !== null) {
    const nums = m[1].trim().split(/,\s*/).slice(0, 2).map(Number);
    if (nums.length === 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      const [lng, lat] = nums;
      fences.push({ type: "circle", center: { lat, lng }, radius: Number(defaultRadius) });
    }
  }
  return fences;
}

/* ---------------------------- LIST ---------------------------- */
router.get("/", requireAuth, async (req, res) => {
  try {
    const {
      q, status, userId, groupId, projectId, tag, priority,
      dueFrom, dueTo, startFrom, startTo, sort, limit
    } = req.query;

    const base = { ...orgScope(Task, req) };

    if (q) {
      base.$or = [
        { title: new RegExp(q, "i") },
        { description: new RegExp(q, "i") },
        { tags: String(q) },
      ];
    }
    if (status) base.status = normalizeStatus(status);
    if (priority) base.priority = String(priority).toLowerCase();

    if (userId && isId(userId)) {
      const uid = new mongoose.Types.ObjectId(userId);
      base.$and = (base.$and || []).concat([{ $or: [{ assignedUserIds: uid }, { assignedTo: uid }] }]);
    }

    if (groupId && isId(groupId)) {
      const gid = new mongoose.Types.ObjectId(groupId);
      base.$and = (base.$and || []).concat([{ $or: [{ assignedGroupIds: gid }, { groupId: gid }] }]);
    }

    if (projectId && isId(projectId)) base.projectId = new mongoose.Types.ObjectId(projectId);
    if (tag) base.tags = tag;

    // due range (legacy)
    if (dueFrom || dueTo) {
      base.dueDate = {
        ...(dueFrom ? { $gte: new Date(dueFrom) } : {}),
        ...(dueTo   ? { $lte: new Date(dueTo) }   : {}),
      };
    }

    // start range (NEW)
    if (startFrom || startTo) {
      base.startDate = {
        ...(startFrom ? { $gte: new Date(startFrom) } : {}),
        ...(startTo   ? { $lte: new Date(startTo) }   : {}),
      };
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);

    const filter = andFilters(base, buildVisibilityFilter(req));

    // Sorting: default by due; timeline mode sorts by start then due
    const useTimelineSort = sort === "timeline" || !!startFrom || !!startTo;
    const sortSpec = useTimelineSort
      ? { startDate: 1, dueAt: 1, dueDate: 1, updatedAt: -1 }
      : { dueDate: 1, updatedAt: -1 };

    const rows = await Task.find(filter)
      .sort(sortSpec)
      .limit(lim)
      .lean();

    res.json(rows.map(normalizeOut));
  } catch (e) {
    console.error("GET /tasks error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------- READ ---------------------------- */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const _id = OID(req.params.id);
    if (!_id) return res.status(400).json({ error: "bad id" });

    const t = await Task.findOne(andFilters({ _id, ...orgScope(Task, req) }, buildVisibilityFilter(req)))
      .populate("assignedTo", "name email")
      .populate("actualDurationLog.userId", "name email");

    if (!t) return res.status(404).json({ error: "Not found" });

    if (ensureLogIds(t)) {
      await t.save();
      await t.populate("actualDurationLog.userId", "name email");
    }

    res.json(normalizeOut(t));
  } catch (e) {
    console.error("GET /tasks/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- CREATE --------------------------- */
router.post("/", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: "title required" });

    let assignedTo = [];
    if (Object.prototype.hasOwnProperty.call(body, "assignedTo")) {
      if (Array.isArray(body.assignedTo)) {
        assignedTo = body.assignedTo.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
      }
    } else if (Object.prototype.hasOwnProperty.call(body, "assignee")) {
      const oid = OID(body.assignee);
      assignedTo = oid ? [oid] : [];
    }

    // NEW: start date support (accept startDate or startAt)
    const startDate =
      body.startDate ? new Date(body.startDate)
      : body.startAt   ? new Date(body.startAt)
      : undefined;

    const dueDate =
      body.dueDate ? new Date(body.dueDate)
      : body.dueAt   ? new Date(body.dueAt)
      : undefined;

    // Visibility fields
    let visibility = {};
    try {
      visibility = sanitizeVisibilityInput(body, isAdmin(req));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || "visibility error" });
    }

    const doc = new Task({
      title: String(body.title).trim(),
      description: body.description || "",
      priority: String(body.priority || "medium").toLowerCase(),
      status: normalizeStatus(body.status) || "pending",
      tags: Array.isArray(body.tags) ? body.tags : [],

      assignedTo, // legacy
      projectId: OID(body.projectId),
      groupId:   OID(body.groupId),   // legacy single group

      // timeline fields
      startDate,
      dueDate,

      dependentTaskIds: Array.isArray(body.dependentTaskIds)
        ? body.dependentTaskIds.filter(isId).map((id) => new mongoose.Types.ObjectId(id))
        : [],

      enforceQRScan: !!body.enforceQRScan,
      enforceLocationCheck: !!body.enforceLocationCheck,
      locationGeoFence: body.locationGeoFence || undefined, // legacy circle

      ...(Array.isArray(body.geoFences) ? { geoFences: body.geoFences } : {}),

      estimatedDuration: body.estimatedDuration != null ? Number(body.estimatedDuration) : undefined,

      // New visibility fields
      ...visibility,
    });

    // Attach org — refuse to write non-ObjectId tokens like "root"
    if (!ensureOrgOnDoc(Task, doc, req)) {
      return res.status(400).json({ error: "orgId missing/invalid on token" });
    }

    await doc.save();
    res.status(201).json(normalizeOut(doc));
  } catch (e) {
    console.error("POST /tasks error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- UPDATE --------------------------- */
router.put("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const b = req.body || {};
    if (b.title != null) t.title = String(b.title).trim();
    if (b.description != null) t.description = String(b.description);
    if (b.priority != null) t.priority = String(b.priority).toLowerCase();
    if (b.tags != null) t.tags = Array.isArray(b.tags) ? b.tags : [];
    if (b.status != null) t.status = normalizeStatus(b.status);

    // NEW: startDate / startAt
    if (Object.prototype.hasOwnProperty.call(b, "startDate") ||
        Object.prototype.hasOwnProperty.call(b, "startAt")) {
      t.startDate = b.startDate ? new Date(b.startDate)
                 : b.startAt   ? new Date(b.startAt)
                 : undefined;
    }

    // dueAt / dueDate (kept)
    if (Object.prototype.hasOwnProperty.call(b, "dueDate") ||
        Object.prototype.hasOwnProperty.call(b, "dueAt")) {
      t.dueDate = b.dueDate ? new Date(b.dueDate)
               : b.dueAt   ? new Date(b.dueAt)
               : undefined;
    }

    if (b.projectId !== undefined) t.projectId = OID(b.projectId);
    if (b.groupId   !== undefined) t.groupId   = OID(b.groupId); // legacy

    if (Object.prototype.hasOwnProperty.call(b, "assignedTo")) {
      if (Array.isArray(b.assignedTo)) {
        t.assignedTo = b.assignedTo.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
      } else {
        t.assignedTo = [];
      }
    } else if (Object.prototype.hasOwnProperty.call(b, "assignee")) {
      const oid = OID(b.assignee);
      t.assignedTo = oid ? [oid] : [];
    }

    if (b.dependentTaskIds !== undefined) {
      t.dependentTaskIds = Array.isArray(b.dependentTaskIds)
        ? b.dependentTaskIds.filter(isId).map((id) => new mongoose.Types.ObjectId(id))
        : [];
    }

    if (b.enforceQRScan !== undefined) t.enforceQRScan = !!b.enforceQRScan;
    if (b.enforceLocationCheck !== undefined) t.enforceLocationCheck = !!b.enforceLocationCheck;
    if (b.locationGeoFence !== undefined) t.locationGeoFence = b.locationGeoFence || undefined;

    if (b.geoFences !== undefined) t.geoFences = Array.isArray(b.geoFences) ? b.geoFences : [];

    if (b.estimatedDuration !== undefined) {
      t.estimatedDuration = b.estimatedDuration != null ? Number(b.estimatedDuration) : undefined;
    }

    // Visibility updates (new fields)
    try {
      const vis = sanitizeVisibilityInput(b, isAdmin(req));
      if (vis.visibilityMode != null) t.visibilityMode = vis.visibilityMode;
      if (vis.assignedUserIds != null) t.assignedUserIds = vis.assignedUserIds;
      if (vis.assignedGroupIds != null) t.assignedGroupIds = vis.assignedGroupIds;
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || "visibility error" });
    }

    // Ensure org for legacy tasks
    if (!ensureOrgOnDoc(Task, t, req)) {
      return res.status(400).json({ error: "orgId missing/invalid on token" });
    }

    await t.save();
    res.json(normalizeOut(t));
  } catch (e) {
    console.error("PUT /tasks/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------- ACTION: start/pause/... --------------------- */
router.post("/:id/action", requireAuth, async (req, res) => {
  try {
    const { action, lat, lng, qrToken, adminOverride } = req.body || {};
    if (!["start", "pause", "resume", "complete"].includes(action)) {
      return res.status(400).json({ error: "bad action" });
    }

    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee && !adminOverride) return res.status(403).json({ error: "Forbidden" });

    // Dependencies
    if (action === "start" || action === "resume") {
      const done = await Task.countDocuments({ _id: { $in: t.dependentTaskIds }, status: "completed" });
      if (done !== (t.dependentTaskIds?.length || 0) && !adminOverride) {
        return res.status(400).json({ error: "dependencies not completed" });
      }
    }

    // Enforcement (QR + geo)
    if ((action === "start" || action === "resume") && !adminOverride) {
      if (t.enforceQRScan) {
        if (!qrToken) return res.status(400).json({ error: "QR required" });
        // TODO: validate qrToken
      }

      if (t.enforceLocationCheck) {
        const nLat = Number(lat), nLng = Number(lng);
        if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) {
          return res.status(400).json({ error: "location required" });
        }

        let fences = collectTaskFences(t);
        if (!fences.length && t.projectId) {
          const proj = await Project.findById(t.projectId).lean();
          if (proj?.geoFences?.length || (proj?.locationGeoFence && proj.locationGeoFence.lat != null)) {
            fences = collectTaskFences(proj);
          }
        }
        if (fences.length) {
          const point = { lat: nLat, lng: nLng };
          const ok = isInsideAnyFence(point, fences);
          if (!ok) return res.status(400).json({ error: "outside geofence" });
        }
      }
    }

    const actorId =
      OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    t.actualDurationLog.push({
      action,
      at: new Date(),
      userId: actorId,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
    });

    ensureLogIds(t);
    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id)
      .populate("assignedTo", "name email")
      .populate("actualDurationLog.userId", "name email")
      .lean();

    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("POST /tasks/:id/action error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------- MANUAL LOG CRUD ---------------------- */
const ALLOWED_LOG_ACTIONS = new Set(["start","pause","resume","complete","photo"]);

router.post("/:id/logs", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { action, at, note } = req.body || {};
    if (!ALLOWED_LOG_ACTIONS.has(String(action))) {
      return res.status(400).json({ error: "bad action" });
    }

    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const editorId =
      OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    t.actualDurationLog.push({
      action,
      at: at ? new Date(at) : new Date(),
      userId: editorId,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
      note: note || "",
    });

    ensureLogIds(t);
    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id)
      .populate("actualDurationLog.userId", "name email")
      .lean();

    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("POST /tasks/:id/logs error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:id/logs/:logId", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const { id, logId } = req.params;

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { action, at, note } = req.body || {};

    const t = await Task.findOne({ _id: id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    ensureLogIds(t);

    const row = (t.actualDurationLog || []).find(e => String(e._id) === String(logId));
    if (!row) return res.status(404).json({ error: "log row not found" });

    if (action != null) {
      if (!ALLOWED_LOG_ACTIONS.has(String(action))) {
        return res.status(400).json({ error: "bad action" });
      }
      row.action = String(action);
    }
    if (at != null) row.at = at ? new Date(at) : row.at;
    if (note != null) row.note = String(note);

    row.editedAt = new Date();
    row.editedBy =
      OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id)
      .populate("actualDurationLog.userId", "name email")
      .lean();

    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("PATCH /tasks/:id/logs/:logId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id/logs/:logId", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const { id, logId } = req.params;

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const t = await Task.findOne({ _id: id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    ensureLogIds(t);

    const before = t.actualDurationLog.length;
    t.actualDurationLog = (t.actualDurationLog || []).filter(e => String(e._id) !== String(logId));

    if (t.actualDurationLog.length === before) {
      return res.status(404).json({ error: "log row not found" });
    }

    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id)
      .populate("actualDurationLog.userId", "name email")
      .lean();

    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("DELETE /tasks/:id/logs/:logId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------- ATTACHMENTS ---------------------- */
// Ensure uploads dir exists: core-backend/uploads/tasks
const uploadsRoot = path.join(__dirname, "..", "uploads");
const taskDir = path.join(uploadsRoot, "tasks");
fs.mkdirSync(taskDir, { recursive: true });

function cleanFilename(name) {
  return String(name || "").replace(/[^\w.\-]+/g, "_").slice(0, 120);
}
const disk = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, taskDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${cleanFilename(file.originalname)}`),
});
const uploadDisk = multer({ storage: disk, limits: { fileSize: 20 * 1024 * 1024 } });

router.post("/:id/attachments", requireAuth, uploadDisk.single("file"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "file required" });
    const mime = file.mimetype || "";
    if (!mime.startsWith("image/")) {
      return res.status(400).json({ error: "only image uploads are allowed" });
    }

    const relUrl = `/files/tasks/${path.basename(file.path)}`;
    const note = String(req.body?.note || "");

    const userId = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    t.attachments = t.attachments || [];
    t.attachments.push({
      filename: file.originalname,
      url: relUrl,
      mime,
      size: file.size,
      uploadedBy: req.user?.name || req.user?.email || String(req.user?._id || ""),
      uploadedAt: new Date(),
      note,
    });

    t.actualDurationLog.push({
      action: "photo",
      at: new Date(),
      userId,
      note,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
    });

    ensureLogIds(t);
    await t.save();

    const fresh = await Task.findById(t._id)
      .populate("actualDurationLog.userId", "name email")
      .lean();

    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("POST /tasks/:id/attachments error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id/attachments/:attId", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const before = (t.attachments || []).length;
    t.attachments = (t.attachments || []).filter((a) => String(a._id) !== String(req.params.attId));
    if (t.attachments.length === before) {
      return res.status(404).json({ error: "attachment not found" });
    }
    await t.save();

    const fresh = await Task.findById(t._id).lean();
    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("DELETE /tasks/:id/attachments/:attId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- GEOFENCES --------------------------- */
router.post(
  "/:id/geofences/upload",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  memUpload.single("file"),
  async (req, res) => {
    try {
      const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
      if (!t) return res.status(404).json({ error: "Not found" });

      const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
      if (!canSee) return res.status(403).json({ error: "Forbidden" });

      if (!req.file) return res.status(400).json({ error: "file required" });

      const radius = Number(req.query.radius || 50);
      const ext = (req.file.originalname.split(".").pop() || "").toLowerCase();
      const mime = (req.file.mimetype || "").toLowerCase();

      let fences = [];
      if (ext === "geojson" || mime.includes("geo+json") || mime === "application/json") {
        fences = parseGeoJSONToFences(req.file.buffer, radius);
      } else if (ext === "kml" || mime.includes("kml")) {
        fences = parseKMLToFences(req.file.buffer.toString("utf8"), radius);
      } else if (ext === "kmz" || mime.includes("kmz") || mime === "application/zip") {
        const kmlText = extractKMLFromKMZ(req.file.buffer);
        if (!kmlText) return res.status(400).json({ error: "no KML found in KMZ" });
        fences = parseKMLToFences(kmlText, radius);
      } else {
        return res.status(400).json({ error: "unsupported file type (use .geojson, .kml or .kmz)" });
      }

      if (!fences.length) return res.status(400).json({ error: "no usable shapes found" });

      t.geoFences = Array.isArray(t.geoFences) ? t.geoFences : [];
      for (const f of fences) {
        if (f.type === "polygon") t.geoFences.push({ type: "polygon", polygon: f.polygon });
        else if (f.type === "circle") t.geoFences.push({ type: "circle", center: f.center, radius: f.radius });
      }

      await t.save();
      const fresh = await Task.findById(t._id).lean();
      res.json(normalizeOut(fresh));
    } catch (e) {
      console.error("POST /tasks/:id/geofences/upload error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.put("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });
    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
    t.geoFences = arr;
    await t.save();
    res.json(normalizeOut(await Task.findById(t._id).lean()));
  } catch (e) {
       console.error("PUT /tasks/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });
    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
    t.geoFences = Array.isArray(t.geoFences) ? t.geoFences.concat(arr) : arr;
    await t.save();
    res.json(normalizeOut(await Task.findById(t._id).lean()));
  } catch (e) {
    console.error("PATCH /tasks/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });
    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    t.geoFences = [];
    await t.save();
    res.json(normalizeOut(await Task.findById(t._id).lean()));
  } catch (e) {
    console.error("DELETE /tasks/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id/geofences", requireAuth, async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) }).lean();
    if (!t) return res.status(404).json({ error: "Not found" });
    res.json({ geoFences: Array.isArray(t.geoFences) ? t.geoFences : [] });
  } catch (e) {
    console.error("GET /tasks/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id/geofences/effective", requireAuth, async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) }).lean();
    if (!t) return res.status(404).json({ error: "Not found" });

    let fences = collectTaskFences(t);
    let source = "task";

    if (!fences.length && t.projectId) {
      const proj = await Project.findById(t.projectId).lean();
      if (proj) {
        const pf = collectTaskFences(proj);
        if (pf.length) { fences = pf; source = "project"; } else { source = "none"; }
      } else {
        source = "none";
      }
    }

    const out = fences.map(f => (f.type === "polygon" && f.ring)
      ? { type: "polygon", polygon: f.ring }
      : f);

    res.json({ geoFences: out, source });
  } catch (e) {
    console.error("GET /tasks/:id/geofences/effective error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- DELETE --------------------------- */
router.delete("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const del = await Task.findOneAndDelete({ _id: req.params.id, ...orgScope(Task, req) });
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /tasks/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- DEBUG --------------------------- */
router.get("/_ping", (req, res) => res.json({ ok: true }));
router.post("/_ping", (req, res) => res.json({ ok: true }));

module.exports = router;
