// core-backend/routes/tasks.js — visibility-enabled
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
const toObjectId = (maybeId) => {
  const s = String(maybeId || "");
  return isId(s) ? new mongoose.Types.ObjectId(s) : undefined;
};

function allowRoles(...roles) {
  return (req, res, next) => {
    const user = req.user || {};
    const role = user.role || user.claims?.role;
    if (!roles.length) return next();
    if (!role) return res.sendStatus(401);
    if (!roles.includes(role)) return res.sendStatus(403);
    next();
  };
}

const getRole = (req) => (req.user?.role || req.user?.claims?.role || "user");
const isAdminRole = (role) => ["admin", "superadmin"].includes(String(role));
const isAdmin = (req) => isAdminRole(getRole(req));

// Accept our canonical labels; store lowercase
const normalizeStatus = (s) => (s ? String(s).toLowerCase() : undefined);

// recompute minutes based on log
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

// Ensure every log row has an _id (migration helper for older docs)
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

// Reflect status from the last chronological action (photo does not affect)
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

// Shape response
function normalizeOut(t) {
  const obj = t.toObject ? t.toObject() : { ...t };
  return {
    ...obj,
    dueAt: obj.dueDate || null,
    assignee: Array.isArray(obj.assignedTo) ? obj.assignedTo[0] : undefined,
    actualDurationMinutes: computeActualMinutes(obj.actualDurationLog || []),
    isBlocked: (obj.dependentTaskIds?.length || 0) > 0,
    // expose visibility for frontend
    visibilityMode: obj.visibilityMode || "org",
    assignedUserIds: Array.isArray(obj.assignedUserIds) ? obj.assignedUserIds : [],
    assignedGroupIds: Array.isArray(obj.assignedGroupIds) ? obj.assignedGroupIds : [],
  };
}

/* ---------------- Visibility helpers ---------------- */
// Expect req.myGroupIds from middleware/access ([] if missing).
function buildVisibilityFilter(req) {
  if (isAdmin(req)) return {}; // admins can see everything including admins-only

  const myId = toObjectId(
    req.user?._id || req.user?.id || req.user?.sub || req.user?.userId
  );
  const myGroups = (req.myGroupIds || []).map((g) => toObjectId(g)).filter(Boolean);

  // Default to org-visible when unset
  return {
    $or: [
      { visibilityMode: { $exists: false } },
      { visibilityMode: "org" },
      {
        visibilityMode: "restricted",
        $or: [
          { assignedUserIds: myId },
          { assignedGroupIds: { $in: myGroups } },
        ],
      },
      // users should NOT see admins-only
    ],
  };
}

async function assertCanSeeTaskOrAdmin(req, taskId) {
  if (isAdmin(req)) return true;
  const filter = { _id: toObjectId(taskId), ...buildVisibilityFilter(req) };
  const exists = await Task.exists(filter);
  return !!exists;
}

function andFilters(...parts) {
  const filters = parts.filter(Boolean);
  if (!filters.length) return {};
  if (filters.length === 1) return filters[0];
  return { $and: filters };
}

function coerceObjectIdArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
}

function sanitizeVisibilityInput(reqBody, roleIsAdmin) {
  const out = {};
  if (reqBody.visibilityMode != null) {
    const v = String(reqBody.visibilityMode).toLowerCase();
    if (["org", "restricted", "admins"].includes(v)) {
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

  // Legacy fallbacks if new fields are omitted
  if (out.assignedUserIds === undefined && Array.isArray(reqBody.assignedTo)) {
    out.assignedUserIds = coerceObjectIdArray(reqBody.assignedTo);
  }
  if (out.assignedGroupIds === undefined && reqBody.groupId) {
    const gid = toObjectId(reqBody.groupId);
    out.assignedGroupIds = gid ? [gid] : [];
  }

  return out;
}

/* ---------------- Geofence helpers ---------------- */

// Great-circle distance (meters)
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

// ray-casting point in polygon; ring = [[lng,lat], ...] closed ring
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

// Normalize legacy circle + new geoFences into a single list
function collectTaskFences(taskOrProject) {
  const src = taskOrProject || {};
  const fences = [];

  // Legacy single circle on tasks { lat, lng, radius }
  if (src.locationGeoFence?.lat != null && src.locationGeoFence?.lng != null) {
    fences.push({
      type: "circle",
      center: { lat: Number(src.locationGeoFence.lat), lng: Number(src.locationGeoFence.lng) },
      radius: Number(src.locationGeoFence.radius || 50),
    });
  }

  // Multi-fence support (circles and/or polygons)
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

// Extract first .kml text from a KMZ (zip) buffer
function extractKMLFromKMZ(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const preferred = entries.find(e => /(^|\/)doc\.kml$/i.test(e.entryName));
    const kmlEntry = preferred || entries.find(e => /\.kml$/i.test(e.entryName));
    if (!kmlEntry) return null;
    return kmlEntry.getData().toString("utf8");
  } catch {
    return null;
  }
}

/* ---------------- Project overlap (warning-only) helpers ---------------- */

async function getProjectPolygonsForTask(taskLike) {
  try {
    if (!taskLike?.projectId) return [];
    const proj = await Project.findById(taskLike.projectId).lean();
    if (!proj) return [];
    const arr = Array.isArray(proj.geoFences) ? proj.geoFences : (proj.geoFence ? [proj.geoFence] : []);
    return arr
      .filter(f => f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3)
      .map(f => ({ type: "polygon", ring: f.polygon }));
  } catch { return []; }
}

function fenceOverlapsAnyProjectPolygon(fence, projectPolys = []) {
  if (!projectPolys.length) return true; // no project fence → OK
  if (fence.type === "circle") {
    const pt = { lat: Number(fence.center.lat), lng: Number(fence.center.lng) };
    return projectPolys.some(poly => pointInPolygon(pt, poly.ring));
  }
  const verts = fence.ring || fence.polygon || [];
  if (Array.isArray(verts) && verts.length >= 3) {
    // Heuristic: if any vertex is inside any project polygon, consider overlapping
    return verts.some(([lng, lat]) =>
      projectPolys.some(poly => pointInPolygon({ lat, lng }, poly.ring))
    );
  }
  return true;
}

function gatherIncomingFencesFromBody(body) {
  const fences = [];
  if (body.locationGeoFence?.lat != null && body.locationGeoFence?.lng != null) {
    fences.push({ type: "circle", center: { lat: Number(body.locationGeoFence.lat), lng: Number(body.locationGeoFence.lng) }, radius: Number(body.locationGeoFence.radius || 50) });
  }
  if (Array.isArray(body.geoFences)) {
    for (const f of body.geoFences) {
      if (f?.type === "circle" && f.center && f.radius != null) {
        fences.push({ type: "circle", center: { lat: Number(f.center.lat), lng: Number(f.center.lng) }, radius: Number(f.radius) });
      } else if (f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3) {
        fences.push({ type: "polygon", polygon: f.polygon });
      }
    }
  }
  return fences;
}

/* ---------------------------- LIST ---------------------------- */
router.get("/", requireAuth, async (req, res) => {
  try {
    const {
      q, status, userId, groupId, projectId, tag, priority,
      dueFrom, dueTo, limit
    } = req.query;

    const base = {};

    if (q) {
      base.$or = [
        { title: new RegExp(q, "i") },
        { description: new RegExp(q, "i") },
        { tags: String(q) },
      ];
    }
    if (status) base.status = normalizeStatus(status);
    if (priority) base.priority = String(priority).toLowerCase();

    if (userId && isId(userId)) base.assignedTo = new mongoose.Types.ObjectId(userId);
    if (groupId && isId(groupId)) base.groupId = new mongoose.Types.ObjectId(groupId);
    if (projectId && isId(projectId)) base.projectId = new mongoose.Types.ObjectId(projectId);

    if (tag) base.tags = tag;

    if (dueFrom || dueTo) {
      base.dueDate = {
        ...(dueFrom ? { $gte: new Date(dueFrom) } : {}),
        ...(dueTo   ? { $lte: new Date(dueTo) }   : {}),
      };
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);

    const filter = andFilters(base, buildVisibilityFilter(req));

    const rows = await Task.find(filter)
      .sort({ dueDate: 1, updatedAt: -1 })
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
    const _id = toObjectId(req.params.id);
    if (!_id) return res.status(400).json({ error: "bad id" });

    const t = await Task.findOne(andFilters({ _id }, buildVisibilityFilter(req)))
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
      const oid = toObjectId(body.assignee);
      assignedTo = oid ? [oid] : [];
    }

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

      assignedTo,
      projectId: toObjectId(body.projectId),
      groupId:   toObjectId(body.groupId),
      dueDate,

      dependentTaskIds: Array.isArray(body.dependentTaskIds)
        ? body.dependentTaskIds.filter(isId).map((id) => new mongoose.Types.ObjectId(id))
        : [],

      enforceQRScan: !!body.enforceQRScan,
      enforceLocationCheck: !!body.enforceLocationCheck,
      locationGeoFence: body.locationGeoFence || undefined, // legacy circle

      // Multi-fence support (circles/polygons)
      ...(Array.isArray(body.geoFences) ? { geoFences: body.geoFences } : {}),

      estimatedDuration: body.estimatedDuration != null ? Number(body.estimatedDuration) : undefined,

      // Visibility
      ...visibility,
    });

    await doc.save();

    // Warnings if task fences appear outside project boundary
    let warnings = [];
    try {
      const projPolys = await getProjectPolygonsForTask(doc);
      const fences = collectTaskFences(doc);
      if (projPolys.length && fences.length) {
        const allOverlap = fences.every(f => fenceOverlapsAnyProjectPolygon(f, projPolys));
        if (!allOverlap) warnings.push("One or more task geofences do not overlap the project boundary.");
      }
    } catch { /* ignore */ }

    const out = normalizeOut(doc);
    if (warnings.length) out.warnings = warnings;
    res.status(201).json(out);
  } catch (e) {
    console.error("POST /tasks error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- UPDATE --------------------------- */
router.put("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const t = await Task.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Not found" });

    const b = req.body || {};
    if (b.title != null) t.title = String(b.title).trim();
    if (b.description != null) t.description = String(b.description);
    if (b.priority != null) t.priority = String(b.priority).toLowerCase();
    if (b.tags != null) t.tags = Array.isArray(b.tags) ? b.tags : [];
    if (b.status != null) t.status = normalizeStatus(b.status);

    if (Object.prototype.hasOwnProperty.call(b, "dueDate") ||
        Object.prototype.hasOwnProperty.call(b, "dueAt")) {
      t.dueDate = b.dueDate ? new Date(b.dueDate)
               : b.dueAt   ? new Date(b.dueAt)
               : undefined;
    }

    if (b.projectId !== undefined) t.projectId = toObjectId(b.projectId);
    if (b.groupId   !== undefined) t.groupId   = toObjectId(b.groupId);

    if (Object.prototype.hasOwnProperty.call(b, "assignedTo")) {
      if (Array.isArray(b.assignedTo)) {
        t.assignedTo = b.assignedTo.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
      } else {
        t.assignedTo = [];
      }
    } else if (Object.prototype.hasOwnProperty.call(b, "assignee")) {
      const oid = toObjectId(b.assignee);
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

    // accept geoFences on update
    if (b.geoFences !== undefined) t.geoFences = Array.isArray(b.geoFences) ? b.geoFences : [];

    if (b.estimatedDuration !== undefined) {
      t.estimatedDuration = b.estimatedDuration != null ? Number(b.estimatedDuration) : undefined;
    }

    // Visibility updates
    try {
      const vis = sanitizeVisibilityInput(b, isAdmin(req));
      if (vis.visibilityMode != null) t.visibilityMode = vis.visibilityMode;
      if (vis.assignedUserIds != null) t.assignedUserIds = vis.assignedUserIds;
      if (vis.assignedGroupIds != null) t.assignedGroupIds = vis.assignedGroupIds;
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || "visibility error" });
    }

    await t.save();

    // Warnings if task fences appear outside project boundary
    let warnings = [];
    try {
      const projPolys = await getProjectPolygonsForTask(t);
      const fences = collectTaskFences(t);
      if (projPolys.length && fences.length) {
        const allOverlap = fences.every(f => fenceOverlapsAnyProjectPolygon(f, projPolys));
        if (!allOverlap) warnings.push("One or more task geofences do not overlap the project boundary.");
      }
    } catch { /* ignore */ }

    const out = normalizeOut(t);
    if (warnings.length) out.warnings = warnings;
    res.json(out);
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

    const t = await Task.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Not found" });

    // Must be visible to act (unless admin override via role)
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

        // Gather all fences (legacy circle + new arrays)
        let fences = collectTaskFences(t);

        // Inherit from project if none set on task
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
      toObjectId(req.user?._id) ||
      toObjectId(req.user?.id) ||
      toObjectId(req.user?.sub) ||
      toObjectId(req.user?.userId);

    const actorName  = req.user?.name || req.user?.fullName || undefined;
    const actorEmail = req.user?.email || undefined;
    const actorSub   = req.user?.sub || req.user?.id || undefined;

    t.actualDurationLog.push({
      action,
      at: new Date(),
      userId: actorId,
      actorName,
      actorEmail,
      actorSub,
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

    const t = await Task.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Not found" });

    const editorId =
      toObjectId(req.user?._id) || toObjectId(req.user?.id) || toObjectId(req.user?.sub) || toObjectId(req.user?.userId);

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

    const t = await Task.findById(id);
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
      toObjectId(req.user?._id) || toObjectId(req.user?.id) || toObjectId(req.user?.sub) || toObjectId(req.user?.userId);

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

    const t = await Task.findById(id);
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
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, taskDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${cleanFilename(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

/* ---------------------- GEOFENCE UPLOAD ---------------------- */
// In-memory upload for parsing KML/KMZ/GeoJSON
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // plenty for shapes
});

// GeoJSON → fences
function parseGeoJSONToFences(buf, defaultRadius = 50) {
  const fences = [];
  let gj;
  try { gj = JSON.parse(buf.toString("utf8")); } catch { return fences; }

  function addGeom(geom) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    if (t === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const outer = geom.coordinates[0]; // [[lng,lat],[...]]
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

// Very lightweight KML parser for <Polygon><coordinates> and <Point><coordinates>
function parseKMLToFences(text, defaultRadius = 50) {
  const fences = [];
  const lower = text.toLowerCase();

  // Polygons
  const polyRegex = /<polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/polygon>/gi;
  let m;
  while ((m = polyRegex.exec(lower)) !== null) {
    const coordsRaw = m[1];
    const pairs = coordsRaw
      .trim()
      .split(/\s+/)
      .map((p) => p.split(",").slice(0, 2).map(Number))
      .filter((a) => a.length === 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]));
    if (pairs.length >= 3) {
      // KML is lon,lat — keep as [lng,lat]
      fences.push({ type: "polygon", polygon: pairs.map(([lng, lat]) => [lng, lat]) });
    }
  }

  // Points (buffer them to circles)
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

// Upload & parse GeoJSON/KML/KMZ → store as geoFences
router.post(
  "/:id/geofences/upload",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  memUpload.single("file"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
      if (!t) return res.status(404).json({ error: "Not found" });

      const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
      if (!canSee) return res.status(403).json({ error: "Forbidden" });

      if (!req.file) return res.status(400).json({ error: "file required" });

      const radius = Number(req.query.radius || 50); // meters for points
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

      if (!fences.length) {
        return res.status(400).json({ error: "no usable shapes found" });
      }

      // Append to existing geoFences
      t.geoFences = Array.isArray(t.geoFences) ? t.geoFences : [];
      for (const f of fences) {
        if (f.type === "polygon") {
          t.geoFences.push({ type: "polygon", polygon: f.polygon });
        } else if (f.type === "circle") {
          t.geoFences.push({ type: "circle", center: f.center, radius: f.radius });
        }
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

// Replace all fences
router.put(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
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
  }
);

// Append fences
router.patch(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
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
  }
);

// Clear all fences
router.delete(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
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
  }
);

// Read fences only
router.get(
  "/:id/geofences",
  requireAuth,
  async (req, res) => {
    try {
      const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
      if (!canSee) return res.status(403).json({ error: "Forbidden" });

      const t = await Task.findById(req.params.id).lean();
      if (!t) return res.status(404).json({ error: "Not found" });
      res.json({ geoFences: Array.isArray(t.geoFences) ? t.geoFences : [] });
    } catch (e) {
      console.error("GET /tasks/:id/geofences error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// Effective (task-or-project) fences for preview/inheritance
router.get("/:id/geofences/effective", requireAuth, async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const t = await Task.findById(req.params.id).lean();
    if (!t) return res.status(404).json({ error: "Not found" });

    let fences = collectTaskFences(t);
    let source = "task";

    if (!fences.length && t.projectId) {
      const proj = await Project.findById(t.projectId).lean();
      if (proj) {
        const pf = collectTaskFences(proj);
        if (pf.length) {
          fences = pf;
          source = "project";
        } else {
          source = "none";
        }
      } else {
        source = "none";
      }
    }

    // convert internal 'ring' to storage shape for polygons
    const out = fences.map(f => (f.type === "polygon" && f.ring)
      ? { type: "polygon", polygon: f.ring }
      : f);

    res.json({ geoFences: out, source });
  } catch (e) {
    console.error("GET /tasks/:id/geofences/effective error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------- Upload photo → attachments + photo log ---------------- */
router.post(
  "/:id/attachments",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
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

      const userId =
        toObjectId(req.user?._id) || toObjectId(req.user?.id) || toObjectId(req.user?.sub) || toObjectId(req.user?.userId);
      const uploadedBy = req.user?.name || req.user?.email || undefined;

      t.attachments = t.attachments || [];
      t.attachments.push({
        filename: file.originalname,
        url: relUrl,
        mime,
        size: file.size,
        uploadedBy,
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
  }
);

// Delete attachment
router.delete(
  "/:id/attachments/:attId",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const t = await Task.findById(req.params.id);
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
  }
);

/* --------------------------- DELETE --------------------------- */
router.delete("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const del = await Task.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /tasks/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
