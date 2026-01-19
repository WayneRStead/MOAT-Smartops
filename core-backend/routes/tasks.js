// core-backend/routes/tasks.js
// ✅ DROP-IN replacement: adds planning/gantt fields + project planning bulk endpoints
// Keeps all existing behavior (visibility, logs, attachments to GridFS, geofences, etc.)

const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const AdmZip = require("adm-zip");

const { requireAuth } = require("../middleware/auth");
const Task = require("../models/Task");
const Project = require("../models/Project");
const TaskMilestone = require("../models/TaskMilestone");

const { getBucket } = require("../lib/gridfs");

const router = express.Router();

router.get("/_ping", (_req, res) => res.json({ ok: true }));
router.post("/_ping", (_req, res) => res.json({ ok: true }));

/* ------------------------- Helpers ------------------------- */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const OID = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

function parseDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function numOrUndef(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Accepts: id string, object with {_id|id|value|userId}, array (first item)
function extractId(maybe) {
  if (!maybe) return undefined;
  if (typeof maybe === "string" && isId(maybe)) return new mongoose.Types.ObjectId(maybe);
  if (Array.isArray(maybe) && maybe.length) return extractId(maybe[0]);
  if (typeof maybe === "object") {
    const cand = maybe._id || maybe.id || maybe.value || maybe.userId;
    if (typeof cand === "string" && isId(cand)) return new mongoose.Types.ObjectId(cand);
  }
  return undefined;
}

function allowRoles(...roles) {
  const allowed = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const roleRaw = req.user?.role || req.user?.claims?.role;
    const role = String(roleRaw || "").toLowerCase();
    if (!allowed.length) return next();
    if (!role) return res.sendStatus(401);
    if (!allowed.includes(role)) return res.sendStatus(403);
    next();
  };
}

const getRole = (req) => (req.user?.role || req.user?.claims?.role || "user");
const isAdminRole = (role) => ["admin", "superadmin"].includes(String(role).toLowerCase());
const isAdmin = (req) => isAdminRole(getRole(req));

function normalizeStatus(s) {
  if (s == null) return undefined;

  const raw = String(s).trim();
  const v = raw.toLowerCase().replace(/\s+/g, "");

  if (["pending", "todo", "tbd", "planned", "plan", "open"].includes(v)) return "Pending";
  if (["started", "inprogress", "in-progress", "active", "running"].includes(v)) return "Started";
  if (["paused", "pause", "onhold", "hold"].includes(v)) return "Paused";
  if (["paused-problem", "pausedproblem", "problem", "blocked", "blocker", "issue"].includes(v)) return "Paused-Problem";
  if (["finished", "finish", "done", "complete", "completed", "closed"].includes(v)) return "Finished";

  // If user passes one of the exact values already, keep it
  if (["Pending", "Started", "Paused", "Paused-Problem", "Finished"].includes(raw)) return raw;

  // Fallback: leave original
  return raw;
}

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

  // NOTE: if schema is Mixed we prefer ObjectId when possible
  if (wantsObjectId(model, "orgId")) {
    if (!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId = new mongoose.Types.ObjectId(s);
  } else {
    // Mixed/string path: still require ObjectId-looking token (matches your existing behavior)
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
    .filter((e) => e.action !== "photo" && e.action !== "fence");

  if (!log.length) return;

  const last = log[log.length - 1];
  if (last.action === "start" || last.action === "resume") taskDoc.status = "Started";
  if (last.action === "pause") taskDoc.status = "Paused";
  if (last.action === "complete") taskDoc.status = "Finished";
}

/* ---------------- normalize output ---------------- */
function normalizeOut(t) {
  const obj = t.toObject ? t.toObject() : { ...t };

  // Prefer planning fields when present (Gantt-first)
  const plannedStartAt = obj.plannedStartAt || obj.startDate || null;
  const plannedEndAt = obj.plannedEndAt || obj.dueAt || obj.dueDate || null;

  return {
    ...obj,
    // legacy mirrors (still used by existing UI)
    dueAt: obj.dueAt ?? obj.dueDate ?? plannedEndAt ?? null,
    dueDate: obj.dueDate ?? obj.dueAt ?? plannedEndAt ?? null,
    startDate: obj.startDate ?? plannedStartAt ?? null,
    startAt: obj.startDate ?? plannedStartAt ?? null,

    // planning fields (new UI can use these)
    plannedStartAt,
    plannedEndAt,

    // assignee mirrors
    assignee: Array.isArray(obj.assignedTo) ? obj.assignedTo[0] : obj.assignee,

    // derived
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

  const me = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);
  const myGroups = (req.myGroupIds || []).map((g) => OID(g)).filter(Boolean);

  return {
    $or: [
      { visibilityMode: { $exists: false } },
      { visibilityMode: "org" },

      { visibilityMode: "assignees", assignedUserIds: me },
      { visibilityMode: "assignees+groups", assignedUserIds: me },

      { visibilityMode: "assignees", assignedTo: me }, // legacy
      { visibilityMode: "assignees+groups", assignedTo: me },

      ...(myGroups.length
        ? [
            { visibilityMode: "groups", assignedGroupIds: { $in: myGroups } },
            { visibilityMode: "assignees+groups", assignedGroupIds: { $in: myGroups } },
            { visibilityMode: "groups", groupId: { $in: myGroups } }, // legacy single group
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

function applyAssignees(taskDoc, objIdArray) {
  const arr = Array.isArray(objIdArray) ? objIdArray.filter(Boolean) : [];
  taskDoc.assignedTo = [...arr]; // legacy
  taskDoc.assignedUserIds = [...arr]; // new
  taskDoc.assignee = arr[0] || null; // singular mirror
}

/* ---------------- Planning field handling (NEW) ---------------- */

function applyPlanningFields(taskDoc, body = {}) {
  // plannedStartAt / plannedEndAt
  if ("plannedStartAt" in body || "planStartAt" in body) {
    taskDoc.plannedStartAt = parseDate(body.plannedStartAt ?? body.planStartAt) || undefined;
  }
  if ("plannedEndAt" in body || "planEndAt" in body) {
    taskDoc.plannedEndAt = parseDate(body.plannedEndAt ?? body.planEndAt) || undefined;
  }

  // Workstream/lane
  if ("workstreamId" in body) taskDoc.workstreamId = OID(body.workstreamId) || null;
  if ("workstreamName" in body) taskDoc.workstreamName = String(body.workstreamName || "");

  // Ordering / WBS / phase / discipline
  if ("rowOrder" in body) taskDoc.rowOrder = numOrUndef(body.rowOrder) ?? taskDoc.rowOrder;
  if ("laneOrder" in body) taskDoc.laneOrder = numOrUndef(body.laneOrder) ?? taskDoc.laneOrder;
  if ("wbs" in body) taskDoc.wbs = String(body.wbs || "");
  if ("phase" in body) taskDoc.phase = String(body.phase || "");
  if ("discipline" in body) taskDoc.discipline = String(body.discipline || "");

  // createdFromPlan flag
  if ("createdFromPlan" in body) taskDoc.createdFromPlan = !!body.createdFromPlan;
}

/* ---------------- Geofence helpers (unchanged) ---------------- */

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat),
    lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
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
    const thePreferred = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.entryName));
    const kmlEntry = thePreferred || entries.find((e) => /\.kml$/i.test(e.entryName));
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
  try {
    gj = JSON.parse(buf.toString("utf8"));
  } catch {
    return fences;
  }
  function addGeom(geom) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    if (t === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const outer = geom.coordinates[0];
      if (Array.isArray(outer) && outer.length >= 3) {
        fences.push({
          type: "polygon",
          polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]),
        });
      }
    } else if (t === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        const outer = Array.isArray(poly) && poly.length ? poly[0] : null;
        if (outer && outer.length >= 3) {
          fences.push({
            type: "polygon",
            polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]),
          });
        }
      }
    } else if (t === "Point" && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      const [lng, lat] = geom.coordinates;
      fences.push({
        type: "circle",
        center: { lat: Number(lat), lng: Number(lng) },
        radius: Number(defaultRadius),
      });
    }
  }
  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) {
    gj.features.forEach((f) => addGeom(f?.geometry));
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

/* ============================ NEW: PLANNING APIs ============================ */

/**
 * GET /tasks/planning?projectId=...
 * Returns all tasks for a project, sorted for Gantt use.
 * (Includes planning fields; still applies visibility.)
 */
router.get("/planning", requireAuth, async (req, res) => {
  try {
    const pid = OID(req.query.projectId);
    if (!pid) return res.status(400).json({ error: "projectId required" });

    const base = { ...orgScope(Task, req), projectId: pid };
    const filter = andFilters(base, buildVisibilityFilter(req));

    const rows = await Task.find(filter)
      .sort({ rowOrder: 1, laneOrder: 1, plannedStartAt: 1, startDate: 1, plannedEndAt: 1, dueAt: 1 })
      .lean();

    res.json(rows.map(normalizeOut));
  } catch (e) {
    console.error("GET /tasks/planning error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /tasks/planning?projectId=...
 * Bulk-save planning edits coming from Gantt.
 */
router.put("/planning", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const pid = OID(req.query.projectId);
    if (!pid) return res.status(400).json({ error: "projectId required" });

    const items = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!items.length) return res.status(400).json({ error: "tasks[] required" });

    const proj = await Project.findOne({ _id: pid, ...orgScope(Project, req) }).session(session);
    if (!proj) return res.status(404).json({ error: "Project not found" });

    const updatedIds = [];

    for (const it of items) {
      const tid = OID(it._id || it.id);
      if (!tid) continue;

      const canSee = await assertCanSeeTaskOrAdmin(req, tid);
      if (!canSee) continue;

      const t = await Task.findOne({ _id: tid, projectId: pid, ...orgScope(Task, req) }).session(session);
      if (!t) continue;

      if ("title" in it && it.title != null) t.title = String(it.title).trim();
      if ("description" in it && it.description != null) t.description = String(it.description);

      applyPlanningFields(t, it);

      if ("startDate" in it || "startAt" in it) {
        t.startDate = parseDate(it.startDate ?? it.startAt) || t.startDate;
      }
      if ("dueAt" in it || "dueDate" in it || "endDate" in it) {
        const d = parseDate(it.dueAt ?? it.dueDate ?? it.endDate);
        if (d) {
          t.dueAt = d;
          t.dueDate = d;
        }
      }

      if ((t.plannedStartAt || t.plannedEndAt) && t.createdFromPlan !== true) {
        if ("createdFromPlan" in it) t.createdFromPlan = !!it.createdFromPlan;
      }

      if (!ensureOrgOnDoc(Task, t, req)) continue;

      await t.save({ session });
      updatedIds.push(t._id);
    }

    await session.commitTransaction();
    session.endSession();

    const fresh = await Task.find({ _id: { $in: updatedIds } })
      .sort({ rowOrder: 1, laneOrder: 1, plannedStartAt: 1, startDate: 1 })
      .lean();

    res.json({ ok: true, updated: updatedIds.length, tasks: fresh.map(normalizeOut) });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    console.error("PUT /tasks/planning error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------- LIST ---------------------------- */
/**
 * ✅ IMPORTANT FIX:
 * This endpoint must allow listing tasks WITHOUT projectId
 * because the Tasks module calls:
 *   GET /tasks?limit=500&orgId=...
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const {
      q,
      status,
      userId,
      groupId,
      projectId,
      tag,
      priority,
      dueFrom,
      dueTo,
      startFrom,
      startTo,
      sort,
      limit,
      // NEW: planning time filters
      planFrom,
      planTo,
      // NEW: includeDeleted
      includeDeleted,
    } = req.query;

    // ✅ FIXED: orgScope signature must be orgScope(Task, req)
    const base = { ...orgScope(Task, req) };

    // Validate projectId/groupId if provided (no longer required)
    if (projectId && !isId(projectId)) {
      return res.status(400).json({ error: "bad projectId" });
    }
    if (groupId && !isId(groupId)) {
      return res.status(400).json({ error: "bad groupId" });
    }
    if (userId && !isId(userId)) {
      return res.status(400).json({ error: "bad userId" });
    }

    // Soft delete filter (default: hide)
    if (!isAdmin(req)) {
      base.isDeleted = { $ne: true };
    } else {
      if (String(includeDeleted || "").toLowerCase() !== "true") {
        base.isDeleted = { $ne: true };
      }
    }

    if (q) {
      base.$or = [{ title: new RegExp(q, "i") }, { description: new RegExp(q, "i") }, { tags: String(q) }];
    }
    if (status) base.status = normalizeStatus(status);
    if (priority) base.priority = String(priority).toLowerCase();

    if (userId) {
      const uid = new mongoose.Types.ObjectId(userId);
      base.$and = (base.$and || []).concat([{ $or: [{ assignedUserIds: uid }, { assignedTo: uid }] }]);
    }

    if (groupId) {
      const gid = new mongoose.Types.ObjectId(groupId);
      base.$and = (base.$and || []).concat([{ $or: [{ assignedGroupIds: gid }, { groupId: gid }] }]);
    }

    if (projectId) base.projectId = new mongoose.Types.ObjectId(projectId);
    if (tag) base.tags = tag;

    // due range (legacy)
    if (dueFrom || dueTo) {
      base.dueDate = {
        ...(dueFrom ? { $gte: new Date(dueFrom) } : {}),
        ...(dueTo ? { $lte: new Date(dueTo) } : {}),
      };
    }

    // start range (legacy)
    if (startFrom || startTo) {
      base.startDate = {
        ...(startFrom ? { $gte: new Date(startFrom) } : {}),
        ...(startTo ? { $lte: new Date(startTo) } : {}),
      };
    }

    // NEW: planning range (preferred for gantt)
    if (planFrom || planTo) {
      base.plannedStartAt = {
        ...(planFrom ? { $gte: new Date(planFrom) } : {}),
        ...(planTo ? { $lte: new Date(planTo) } : {}),
      };
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);
    const filter = andFilters(base, buildVisibilityFilter(req));

    const useTimelineSort = sort === "timeline" || !!startFrom || !!startTo || !!planFrom || !!planTo;
    const sortSpec = useTimelineSort
      ? { rowOrder: 1, laneOrder: 1, plannedStartAt: 1, startDate: 1, plannedEndAt: 1, dueAt: 1, updatedAt: -1 }
      : { dueDate: 1, updatedAt: -1 };

    const rows = await Task.find(filter).sort(sortSpec).limit(lim).lean();
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
    if (Array.isArray(body.assignedTo)) {
      assignedTo = body.assignedTo.filter(isId).map((id) => new mongoose.Types.ObjectId(id));
    } else {
      const one = extractId(
        body.assignee ||
          body.assigneeId ||
          (Array.isArray(body.assignedTo) ? body.assignedTo[0] : undefined)
      );
      if (one) assignedTo = [one];
    }

    const startDate = body.startDate ? new Date(body.startDate) : body.startAt ? new Date(body.startAt) : undefined;

    const rawDue = body.dueAt ?? body.dueDate ?? body.deadline ?? body.deadlineAt ?? undefined;
    const dueDate = rawDue ? new Date(rawDue) : undefined;

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
      assignee: assignedTo[0] || null,
      assignedUserIds: [...assignedTo],

      projectId: OID(body.projectId),
      groupId: OID(body.groupId),

      startDate,
      dueDate,
      dueAt: dueDate,

      dependentTaskIds: Array.isArray(body.dependentTaskIds)
        ? body.dependentTaskIds.filter(isId).map((id) => new mongoose.Types.ObjectId(id))
        : [],

      enforceQRScan: !!body.enforceQRScan,
      enforceLocationCheck: !!body.enforceLocationCheck,
      locationGeoFence: body.locationGeoFence || undefined,

      ...(Array.isArray(body.geoFences) ? { geoFences: body.geoFences } : {}),

      estimatedDuration: body.estimatedDuration != null ? Number(body.estimatedDuration) : undefined,

      ...visibility,
    });

    applyPlanningFields(doc, body);

    const createIncoming =
      Object.prototype.hasOwnProperty.call(body, "assignedUserIds")
        ? coerceObjectIdArray(body.assignedUserIds)
        : Object.prototype.hasOwnProperty.call(body, "assignedTo")
        ? coerceObjectIdArray(body.assignedTo)
        : Object.prototype.hasOwnProperty.call(body, "assignee") || Object.prototype.hasOwnProperty.call(body, "assigneeId")
        ? extractId(body.assignee || body.assigneeId)
          ? [extractId(body.assignee || body.assigneeId)]
          : []
        : null;

    if (createIncoming != null) {
      applyAssignees(doc, createIncoming);
    } else {
      if (Array.isArray(doc.assignedUserIds) && doc.assignedUserIds.length) {
        applyAssignees(doc, doc.assignedUserIds);
      }
    }

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

/* --------------------------- UPDATE (PUT full) --------------------------- */
/**
 * ✅ FIX: Frontend is calling PUT /tasks/:id
 * Your router only had PATCH /tasks/:id, so PUT was 404.
 * This PUT handler mirrors the PATCH logic.
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const role = String(getRole(req) || "user").toLowerCase();
    const elevated = role === "manager" || isAdminRole(role);

    const b = req.body || {};

    // Non-elevated users: allow ONLY status update
    if (!elevated) {
      if (!("status" in b)) {
        return res.status(403).json({ error: "Only managers/admins can edit task fields" });
      }
      t.status = normalizeStatus(b.status) || t.status;
      await t.save();
      return res.json(normalizeOut(t));
    }

    // Elevated users: full update behavior
    if (b.title != null) t.title = String(b.title).trim();
    if (b.description != null) t.description = String(b.description);
    if (b.priority != null) t.priority = String(b.priority).toLowerCase();
    if (b.tags != null) t.tags = Array.isArray(b.tags) ? b.tags : [];
    if (b.status != null) t.status = normalizeStatus(b.status);

    if (b.startDate != null || b.startAt != null) {
      t.startDate = b.startDate ? new Date(b.startDate) : b.startAt ? new Date(b.startAt) : undefined;
    }

    if (b.dueAt != null || b.dueDate != null || b.deadline != null || b.deadlineAt != null) {
      const rawDue = b.dueAt ?? b.dueDate ?? b.deadline ?? b.deadlineAt ?? null;
      const d = rawDue ? new Date(rawDue) : undefined;
      t.dueDate = d;
      t.dueAt = d;
    }

    applyPlanningFields(t, b);

    if (b.projectId !== undefined) t.projectId = OID(b.projectId);
    if (b.groupId !== undefined) t.groupId = OID(b.groupId);

    let incomingAssignees = null;

    if (Object.prototype.hasOwnProperty.call(b, "assignedUserIds")) {
      incomingAssignees = coerceObjectIdArray(b.assignedUserIds);
    } else if (Object.prototype.hasOwnProperty.call(b, "assignedTo")) {
      incomingAssignees = Array.isArray(b.assignedTo) ? coerceObjectIdArray(b.assignedTo) : null;
    } else if (
      Object.prototype.hasOwnProperty.call(b, "assignee") ||
      Object.prototype.hasOwnProperty.call(b, "assigneeId")
    ) {
      const one = extractId(b.assignee || b.assigneeId);
      if (one) incomingAssignees = [one];
      else if (b.assignee === null || b.assigneeId === null) incomingAssignees = [];
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

    try {
      const vis = sanitizeVisibilityInput(b, isAdmin(req));
      if (vis.visibilityMode != null) t.visibilityMode = vis.visibilityMode;

      if (vis.assignedUserIds != null && incomingAssignees == null) {
        incomingAssignees = vis.assignedUserIds;
      }

      if (vis.assignedGroupIds != null) {
        t.assignedGroupIds = vis.assignedGroupIds;
        t.groupId =
          Array.isArray(vis.assignedGroupIds) && vis.assignedGroupIds[0] ? vis.assignedGroupIds[0] : undefined;
      }
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || "visibility error" });
    }

    if (incomingAssignees != null) applyAssignees(t, incomingAssignees);

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

/* --------------------- ACTION: start/pause/... (unchanged) --------------------- */
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

    if (action === "start" || action === "resume") {
      const done = await Task.countDocuments({ _id: { $in: t.dependentTaskIds }, status: "Finished" });
      if (done !== (t.dependentTaskIds?.length || 0) && !adminOverride) {
        return res.status(400).json({ error: "dependencies not completed" });
      }
    }

    if ((action === "start" || action === "resume") && !adminOverride) {
      if (t.enforceQRScan) {
        if (!qrToken) return res.status(400).json({ error: "QR required" });
      }

      if (t.enforceLocationCheck) {
        const nLat = Number(lat),
          nLng = Number(lng);
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

    const actorId = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    const nLat = Number(lat),
      nLng = Number(lng);
    t.actualDurationLog.push({
      action,
      at: new Date(),
      userId: actorId,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
      ...(Number.isFinite(nLat) && Number.isFinite(nLng) ? { lat: nLat, lng: nLng } : {}),
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

/* ---------------------- MANUAL LOG CRUD (unchanged) ---------------------- */
const ALLOWED_LOG_ACTIONS = new Set(["start", "pause", "resume", "complete", "photo", "fence"]);

router.post("/:id/logs", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const canSee = await assertCanSeeTaskOrAdmin(req, req.params.id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { action, at, note, lat, lng, milestoneId } = req.body || {};
    if (!ALLOWED_LOG_ACTIONS.has(String(action))) {
      return res.status(400).json({ error: "bad action" });
    }

    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    let msId = undefined;
    if (milestoneId !== undefined && milestoneId !== null) {
      const oid = OID(milestoneId);
      if (!oid) return res.status(400).json({ error: "bad milestoneId" });
      const exists = await TaskMilestone.exists({ _id: oid, taskId: t._id });
      if (!exists) return res.status(400).json({ error: "milestone not found for this task" });
      msId = oid;
    }

    const editorId = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    const nLat = Number(lat),
      nLng = Number(lng);

    t.actualDurationLog.push({
      action,
      at: at ? new Date(at) : new Date(),
      userId: editorId,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
      note: note || "",
      ...(msId ? { milestoneId: msId } : {}),
      ...(Number.isFinite(nLat) && Number.isFinite(nLng) ? { lat: nLat, lng: nLng } : {}),
    });

    ensureLogIds(t);
    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id).populate("actualDurationLog.userId", "name email").lean();
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

    const { action, at, note, lat, lng, milestoneId } = req.body || {};

    const t = await Task.findOne({ _id: id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    ensureLogIds(t);

    const row = (t.actualDurationLog || []).find((e) => String(e._id) === String(logId));
    if (!row) return res.status(404).json({ error: "log row not found" });

    if (action != null) {
      if (!ALLOWED_LOG_ACTIONS.has(String(action))) {
        return res.status(400).json({ error: "bad action" });
      }
      row.action = String(action);
    }
    if (at != null) row.at = at ? new Date(at) : row.at;
    if (note != null) row.note = String(note);

    if (lat != null && lng != null) {
      const nLat = Number(lat),
        nLng = Number(lng);
      if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
        row.lat = nLat;
        row.lng = nLng;
      }
    }

    if ("milestoneId" in (req.body || {})) {
      if (milestoneId === null) {
        row.milestoneId = undefined;
      } else {
        const oid = OID(milestoneId);
        if (!oid) return res.status(400).json({ error: "bad milestoneId" });
        const exists = await TaskMilestone.exists({ _id: oid, taskId: t._id });
        if (!exists) return res.status(400).json({ error: "milestone not found for this task" });
        row.milestoneId = oid;
      }
    }

    row.editedAt = new Date();
    row.editedBy = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id).populate("actualDurationLog.userId", "name email").lean();
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
    t.actualDurationLog = (t.actualDurationLog || []).filter((e) => String(e._id) !== String(logId));

    if (t.actualDurationLog.length === before) {
      return res.status(404).json({ error: "log row not found" });
    }

    setStatusFromLog(t);
    await t.save();

    const fresh = await Task.findById(t._id).populate("actualDurationLog.userId", "name email").lean();
    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("DELETE /tasks/:id/logs/:logId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------- ATTACHMENTS (unchanged, GridFS) ---------------------- */

const uploadsRoot = path.join(__dirname, "..", "uploads");
const taskDir = path.join(uploadsRoot, "tasks");
try {
  fs.mkdirSync(taskDir, { recursive: true });
} catch {}

function cleanFilename(name) {
  return String(name || "").replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function isSupportedAttachment(file) {
  const mime = (file?.mimetype || "").toLowerCase();
  const ext = ((file?.originalname || "").split(".").pop() || "").toLowerCase();

  const isImage = mime.startsWith("image/");
  const isKMZ = ext === "kmz" || mime.includes("kmz") || mime === "application/zip";
  const isKML =
    ext === "kml" ||
    mime.includes("kml") ||
    mime === "application/xml" ||
    mime === "text/xml" ||
    mime === "application/vnd.google-earth.kml+xml";
  const isGJ = ext === "geojson" || mime.includes("geo+json") || mime === "application/json";

  return { ok: !!(isImage || isKMZ || isKML || isGJ), isImage, isFence: !!(isKMZ || isKML || isGJ) };
}

async function putToGridFS({ buffer, filename, mimetype, metadata }) {
  const bucket = getBucket();
  const safeName = `${Date.now()}_${cleanFilename(filename)}`;

  const up = bucket.openUploadStream(safeName, {
    contentType: mimetype || "application/octet-stream",
    metadata: metadata || {},
  });

  up.end(buffer);

  const fileId = await new Promise((resolve, reject) => {
    up.on("finish", () => resolve(up.id));
    up.on("error", reject);
  });

  return fileId;
}

router.post("/:id/attachments", requireAuth, uploadMem.single("file"), async (req, res) => {
  try {
    const t = await Task.findOne({ _id: req.params.id, ...orgScope(Task, req) });
    if (!t) return res.status(404).json({ error: "Not found" });

    const canSee = await assertCanSeeTaskOrAdmin(req, t._id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "file required" });

    const { ok, isImage } = isSupportedAttachment(file);
    if (!ok) {
      return res.status(400).json({ error: "unsupported file type (images, .kmz, .kml, .geojson)" });
    }

    const note = String(req.body?.note || "");
    const lat = req.body?.lat,
      lng = req.body?.lng;
    const nLat = Number(lat),
      nLng = Number(lng);

    const userId = OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub) || OID(req.user?.userId);

    const fileId = await putToGridFS({
      buffer: file.buffer,
      filename: file.originalname,
      mimetype: file.mimetype,
      metadata: {
        kind: "task-attachment",
        taskId: String(t._id),
        orgId: req.user?.orgId ? String(req.user.orgId) : "",
        uploadedBy: req.user?.name || req.user?.email || "",
        note,
      },
    });

    const relUrl = `/files/tasks/${fileId}`;

    t.attachments = t.attachments || [];
    t.attachments.push({
      filename: file.originalname,
      url: relUrl,
      mime: file.mimetype || "",
      size: file.size,
      uploadedBy: req.user?.name || req.user?.email || String(req.user?._id || ""),
      uploadedAt: new Date(),
      note,
      storage: "gridfs",
      fileId,
    });

    t.actualDurationLog.push({
      action: isImage ? "photo" : "fence",
      at: new Date(),
      userId,
      note,
      actorName: req.user?.name,
      actorEmail: req.user?.email,
      actorSub: req.user?.sub || req.user?.id,
      ...(Number.isFinite(nLat) && Number.isFinite(nLng) ? { lat: nLat, lng: nLng } : {}),
    });

    ensureLogIds(t);
    await t.save();

    const fresh = await Task.findById(t._id).populate("actualDurationLog.userId", "name email").lean();
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

    const removed = (t.attachments || []).find((a) => String(a._id) === String(req.params.attId));

    const before = (t.attachments || []).length;
    t.attachments = (t.attachments || []).filter((a) => String(a._id) !== String(req.params.attId));
    if (t.attachments.length === before) {
      return res.status(404).json({ error: "attachment not found" });
    }

    await t.save();

    try {
      const fid = removed?.fileId;
      if (fid && mongoose.Types.ObjectId.isValid(String(fid))) {
        getBucket().delete(new mongoose.Types.ObjectId(String(fid)), () => {});
      }
    } catch {}

    const fresh = await Task.findById(t._id).lean();
    res.json(normalizeOut(fresh));
  } catch (e) {
    console.error("DELETE /tasks/:id/attachments/:attId error:", e);
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

module.exports = router;
