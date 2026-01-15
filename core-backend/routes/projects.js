// core-backend/routes/projects.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { requireAuth } = require("../middleware/auth");
const Project = require("../models/Project");
const Task = require("../models/Task");
const TaskMilestone = require("../models/TaskMilestone");

const router = express.Router();

/* ------------------------- Helpers ------------------------- */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const toObjectId = (maybeId) => {
  const s = String(maybeId || "");
  return isId(s) ? new mongoose.Types.ObjectId(s) : undefined;
};

function allowRoles(...roles) {
  const allow = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const user = req.user || {};
    const role = String(user.role || user.claims?.role || "").toLowerCase();
    if (!allow.length) return next();
    if (!role) return res.sendStatus(401);
    if (!allow.includes(role)) return res.sendStatus(403);
    next();
  };
}

const normalizeStatus = (s) => (s ? String(s).toLowerCase().trim() : undefined);

// If orgId is a valid ObjectId, scope by it; otherwise (e.g. "root") skip scoping
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  return { orgId: new mongoose.Types.ObjectId(s) };
}

// Normalize nullable id fields from request body (accept "", null to clear)
function readNullableId(val) {
  if (val === null || val === "" || typeof val === "undefined") return null;
  if (!isId(val)) return "INVALID";
  return toObjectId(val);
}

/* ---- geofence shape helpers (same shapes used by tasks) ---- */

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

function collectProjectFences(p) {
  const out = [];
  const list = Array.isArray(p?.geoFences) ? p.geoFences : p?.geoFence ? [p.geoFence] : [];
  for (const f of list || []) {
    if (f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3) {
      out.push({ type: "polygon", ring: f.polygon });
    }
  }
  return out;
}

function collectTaskFences(t) {
  const fences = [];
  if (t.locationGeoFence?.lat != null && t.locationGeoFence?.lng != null) {
    fences.push({
      type: "circle",
      center: { lat: Number(t.locationGeoFence.lat), lng: Number(t.locationGeoFence.lng) },
      radius: Number(t.locationGeoFence.radius || 50),
    });
  }
  if (Array.isArray(t.geoFences)) {
    for (const f of t.geoFences) {
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

/* ------------------------- KML/GeoJSON parse ------------------------- */

// In-memory upload for parsing KML/KMZ/GeoJSON
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function extractKMLFromKMZ(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const preferred = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.entryName));
    const kmlEntry = preferred || entries.find((e) => /\.kml$/i.test(e.entryName));
    if (!kmlEntry) return null;
    return kmlEntry.getData().toString("utf8");
  } catch {
    return null;
  }
}

function parseGeoJSONToProjectFences(buf) {
  const out = [];
  let gj;
  try {
    gj = JSON.parse(buf.toString("utf8"));
  } catch {
    return out;
  }

  function addGeom(geom) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    if (t === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const outer = geom.coordinates[0];
      if (Array.isArray(outer) && outer.length >= 3) {
        out.push({ type: "polygon", polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]) });
      }
    } else if (t === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        const outer = Array.isArray(poly) && poly.length ? poly[0] : null;
        if (outer && outer.length >= 3) {
          out.push({ type: "polygon", polygon: outer.map(([lng, lat]) => [Number(lng), Number(lat)]) });
        }
      }
    }
  }

  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) {
    gj.features.forEach((f) => addGeom(f?.geometry));
  } else if (gj.type === "Feature") {
    addGeom(gj.geometry);
  } else {
    addGeom(gj);
  }

  return out;
}

function parseKMLToProjectFences(text) {
  const fences = [];
  const lower = text.toLowerCase();
  const polyRegex = /<polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/polygon>/gi;
  let m;
  while ((m = polyRegex.exec(lower)) !== null) {
    const coordsRaw = m[1];
    const pairs = coordsRaw
      .trim()
      .split(/\s+/)
      .map((p) => p.split(",").slice(0, 2).map(Number))
      .filter((a) => a.length === 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]));
    if (pairs.length >= 3) fences.push({ type: "polygon", polygon: pairs.map(([lng, lat]) => [lng, lat]) });
  }
  return fences;
}

/* ------------------------------------------------------------------ */
/* ---------------------- NEW: Planning Helpers ---------------------- */
/* ------------------------------------------------------------------ */

function asDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = String(t || "").trim();
    if (!s) continue;
    out.push(s);
  }
  // de-dup case-insensitively
  const seen = new Set();
  const dedup = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(s);
  }
  return dedup;
}

function safePlanningItem(raw = {}) {
  // Accept mild aliasing from UI
  const type = String(raw.type || "").toLowerCase();
  const title = raw.title != null ? String(raw.title).trim() : raw.name != null ? String(raw.name).trim() : "";

  const startPlanned = asDate(raw.startPlanned ?? raw.startAt ?? raw.startDate);
  const endPlanned = asDate(raw.endPlanned ?? raw.endAt ?? raw.dueAt ?? raw.dueDate);

  const parentPlanningId = raw.parentPlanningId ? toObjectId(raw.parentPlanningId) : null;

  const dependsOnPlanningIds = Array.isArray(raw.dependsOnPlanningIds || raw.dependsOn || raw.requires)
    ? (raw.dependsOnPlanningIds || raw.dependsOn || raw.requires).filter(isId).map(toObjectId)
    : [];

  const assigneeUserId =
    raw.assigneeUserId || raw.assignee || raw.assigneeId ? readNullableId(raw.assigneeUserId ?? raw.assignee ?? raw.assigneeId) : null;

  const groupId = raw.groupId ? readNullableId(raw.groupId) : null;

  const priority = String(raw.priority || "medium").toLowerCase();
  const okPriority = ["low", "medium", "high", "urgent"].includes(priority) ? priority : "medium";

  const status = String(raw.status || "planned").toLowerCase();
  const okStatus = ["planned", "active", "done"].includes(status) ? status : "planned";

  return {
    _id: raw._id && isId(raw._id) ? new mongoose.Types.ObjectId(String(raw._id)) : new mongoose.Types.ObjectId(),
    type: type === "deliverable" ? "deliverable" : "task",
    title,
    description: raw.description != null ? String(raw.description) : raw.notes != null ? String(raw.notes) : "",
    startPlanned,
    endPlanned,
    parentPlanningId: parentPlanningId || null,
    dependsOnPlanningIds,
    assigneeUserId: assigneeUserId === "INVALID" ? "INVALID" : assigneeUserId || null,
    groupId: groupId === "INVALID" ? "INVALID" : groupId || null,
    tags: normalizeTags(raw.tags),
    priority: okPriority,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    status: okStatus,
    wbsCode: raw.wbsCode != null ? String(raw.wbsCode) : "",
    costEstimate: raw.costEstimate != null ? Number(raw.costEstimate) : undefined,
  };
}

function validatePlanningItems(items = []) {
  const errs = [];

  // must have required fields and valid dates
  for (const it of items) {
    if (!it.title) errs.push(`Planning item ${String(it._id)} is missing title`);
    if (!it.startPlanned) errs.push(`Planning item "${it.title || it._id}" is missing startPlanned`);
    if (!it.endPlanned) errs.push(`Planning item "${it.title || it._id}" is missing endPlanned`);
    if (it.startPlanned && it.endPlanned && it.startPlanned > it.endPlanned) {
      errs.push(`Planning item "${it.title || it._id}" has startPlanned after endPlanned`);
    }
    if (it.assigneeUserId === "INVALID") errs.push(`Planning item "${it.title || it._id}" has invalid assigneeUserId`);
    if (it.groupId === "INVALID") errs.push(`Planning item "${it.title || it._id}" has invalid groupId`);
  }

  // deliverables must have a parent task
  const byId = new Map(items.map((x) => [String(x._id), x]));
  for (const it of items) {
    if (it.type === "deliverable") {
      if (!it.parentPlanningId) {
        errs.push(`Deliverable "${it.title || it._id}" must have parentPlanningId`);
      } else {
        const parent = byId.get(String(it.parentPlanningId));
        if (!parent) errs.push(`Deliverable "${it.title}" parentPlanningId not found in this plan`);
        else if (parent.type !== "task") errs.push(`Deliverable "${it.title}" parentPlanningId must refer to a task item`);
      }
    }
  }

  // dependencies must exist in plan
  for (const it of items) {
    for (const dep of it.dependsOnPlanningIds || []) {
      if (!byId.has(String(dep))) {
        errs.push(`Planning item "${it.title || it._id}" dependsOn missing item ${String(dep)}`);
      }
      if (String(dep) === String(it._id)) {
        errs.push(`Planning item "${it.title || it._id}" cannot depend on itself`);
      }
    }
  }

  return errs;
}

function userIdFromReq(req) {
  const raw = req.user?._id || req.user?.id || req.user?.userId || req.user?.sub;
  return isId(raw) ? new mongoose.Types.ObjectId(String(raw)) : null;
}

/* ------------------------------ LIST ------------------------------ */
// GET /api/projects?q=&status=&tag=&limit=
router.get("/", requireAuth, async (req, res) => {
  try {
    const { q, status, tag, limit } = req.query;
    const find = { ...orgScope(req.user?.orgId) };

    if (q) {
      find.$or = [{ name: new RegExp(q, "i") }, { description: new RegExp(q, "i") }, { tags: String(q) }];
    }
    if (status) find.status = normalizeStatus(status);
    if (tag) find.tags = tag;

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);
    const rows = await Project.find(find).sort({ updatedAt: -1, name: 1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error("GET /projects error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ NEW: PLANNING GET ------------------------------ */
// GET /api/projects/:id/planning
router.get("/:id/planning", requireAuth, async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!p) return res.status(404).json({ error: "Not found" });

    const planning = p.planning || { items: [], generatedAt: null, generatedBy: null, lastGeneratedMap: {} };
    res.json(planning);
  } catch (e) {
    console.error("GET /projects/:id/planning error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ NEW: PLANNING SAVE ------------------------------ */
/**
 * PUT /api/projects/:id/planning
 * Body:
 * {
 *   items: [ {type,title,startPlanned,endPlanned,parentPlanningId,dependsOnPlanningIds,...} ],
 *   // optional: replaceGeneratedInfo: true (rare)
 * }
 */
router.put("/:id/planning", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });

    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const items = rawItems.map(safePlanningItem);

    const errs = validatePlanningItems(items);
    if (errs.length) return res.status(400).json({ error: "Planning validation failed", details: errs });

    // Keep previous generation info unless explicitly told otherwise
    if (!p.planning) p.planning = {};
    p.planning.items = items;
    p.planning.lastEditedAt = new Date();
    p.planning.lastEditedBy = userIdFromReq(req);

    if (body.replaceGeneratedInfo === true) {
      p.planning.generatedAt = null;
      p.planning.generatedBy = null;
      p.planning.lastGeneratedMap = {};
    }

    await p.save();
    res.json(p.planning);
  } catch (e) {
    console.error("PUT /projects/:id/planning error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ NEW: PLANNING GENERATE ------------------------------ */
/**
 * POST /api/projects/:id/planning/generate
 * Body (optional):
 * { force: true }  // if you want to allow regenerate later
 */
router.post("/:id/planning/generate", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  const session = await mongoose.startSession().catch(() => null);

  async function run() {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).session(session || null);
    if (!p) return { status: 404, payload: { error: "Not found" } };

    const plan = p.planning;
    const items = Array.isArray(plan?.items) ? plan.items : [];
    if (!items.length) return { status: 400, payload: { error: "No planning items to generate" } };

    const force = !!(req.body && req.body.force);
    if (plan?.generatedAt && !force) {
      return {
        status: 409,
        payload: {
          error: "Plan has already been generated",
          message: "If you really want to generate again, call with { force: true }",
          generatedAt: plan.generatedAt,
        },
      };
    }

    // Validate again (defensive)
    const errs = validatePlanningItems(items);
    if (errs.length) return { status: 400, payload: { error: "Planning validation failed", details: errs } };

    // Build index by planningId
    const byId = new Map(items.map((x) => [String(x._id), x]));

    // Separate tasks and deliverables
    const taskItems = items.filter((x) => x.type === "task");
    const delivItems = items.filter((x) => x.type === "deliverable");

    // Sort consistently: by order then start
    taskItems.sort((a, b) => (a.order - b.order) || (+a.startPlanned - +b.startPlanned));
    delivItems.sort((a, b) => (a.order - b.order) || (+a.startPlanned - +b.startPlanned));

    // Create tasks first
    const taskMap = {}; // planningId -> taskId
    const createdTasks = [];

    for (const it of taskItems) {
      const doc = new Task({
        orgId: p.orgId, // Task.orgId is Mixed; ObjectId is OK
        projectId: p._id,

        title: it.title,
        description: it.description || "",

        startDate: it.startPlanned,
        dueAt: it.endPlanned,
        dueDate: it.endPlanned, // legacy mirror

        status: "pending",
        priority: it.priority || "medium",
        tags: Array.isArray(it.tags) ? it.tags : [],

        // group mirror (legacy single)
        groupId: it.groupId || undefined,

        // visibility defaults to org unless your UI later changes it
        visibilityMode: "org",

        // assign (keep model mirrors happy)
        assignedTo: it.assigneeUserId ? [it.assigneeUserId] : [],
        assignedUserIds: it.assigneeUserId ? [it.assigneeUserId] : [],
        assignee: it.assigneeUserId || null,

        assignedGroupIds: it.groupId ? [it.groupId] : [],
      });

      await doc.save({ session: session || undefined });
      taskMap[String(it._id)] = doc._id;
      createdTasks.push(doc._id);
    }

    // Create deliverables as TaskMilestones under the mapped task
    const milestoneMap = {}; // planningId -> milestoneId
    const createdMilestones = [];

    for (const it of delivItems) {
      const parentPlanId = it.parentPlanningId ? String(it.parentPlanningId) : "";
      const parentTaskId = taskMap[parentPlanId];

      if (!parentTaskId) {
        // should be caught by validation, but stay safe
        return {
          status: 400,
          payload: { error: `Deliverable "${it.title}" has no generated parent task (parentPlanningId=${parentPlanId})` },
        };
      }

      const ms = new TaskMilestone({
        name: it.title,
        taskId: parentTaskId,
        startPlanned: it.startPlanned,
        endPlanned: it.endPlanned,
        status: "pending",
        roadblock: false,
        requires: [],
        orgId: p.orgId, // your TaskMilestone schema uses ObjectId orgId
      });

      await ms.save({ session: session || undefined });
      milestoneMap[String(it._id)] = ms._id;
      createdMilestones.push(ms._id);
    }

    // Apply dependencies:
    // - Task dependencies -> Task.dependentTaskIds
    // - Deliverable dependencies -> TaskMilestone.requires (only if dependency is a deliverable in SAME parent task)
    for (const it of taskItems) {
      const deps = [];
      for (const depPlanId of it.dependsOnPlanningIds || []) {
        const dep = byId.get(String(depPlanId));
        if (!dep) continue;

        if (dep.type === "task") {
          const depTaskId = taskMap[String(dep._id)];
          if (depTaskId) deps.push(depTaskId);
        } else {
          // deliverable dependency: we cannot enforce milestone gating in Task model,
          // so best-effort: depend on the deliverable's parent task.
          const parent = dep.parentPlanningId ? taskMap[String(dep.parentPlanningId)] : null;
          if (parent) deps.push(parent);
        }
      }

      const taskId = taskMap[String(it._id)];
      if (taskId && deps.length) {
        await Task.updateOne(
          { _id: taskId },
          { $set: { dependentTaskIds: Array.from(new Set(deps.map(String))).map((id) => new mongoose.Types.ObjectId(id)) } },
          { session: session || undefined }
        );
      }
    }

    for (const it of delivItems) {
      const myMsId = milestoneMap[String(it._id)];
      if (!myMsId) continue;

      const parentPlanId = String(it.parentPlanningId || "");
      const reqs = [];

      for (const depPlanId of it.dependsOnPlanningIds || []) {
        const dep = byId.get(String(depPlanId));
        if (!dep) continue;

        // only allow milestone->milestone requires within the same parent task
        if (dep.type === "deliverable" && String(dep.parentPlanningId || "") === parentPlanId) {
          const depMsId = milestoneMap[String(dep._id)];
          if (depMsId) reqs.push(depMsId);
        }
      }

      if (reqs.length) {
        await TaskMilestone.updateOne(
          { _id: myMsId },
          { $set: { requires: Array.from(new Set(reqs.map(String))).map((id) => new mongoose.Types.ObjectId(id)) } },
          { session: session || undefined }
        );
      }
    }

    // Write generation audit + mapping to project
    const mapOut = {};
    for (const it of items) {
      const k = String(it._id);
      mapOut[k] = {
        taskId: taskMap[k] ? String(taskMap[k]) : null,
        milestoneId: milestoneMap[k] ? String(milestoneMap[k]) : null,
      };
    }

    p.planning.generatedAt = new Date();
    p.planning.generatedBy = userIdFromReq(req);
    p.planning.lastGeneratedMap = mapOut;

    await p.save({ session: session || undefined });

    return {
      status: 200,
      payload: {
        ok: true,
        projectId: String(p._id),
        created: {
          tasks: createdTasks.length,
          milestones: createdMilestones.length,
        },
        generatedAt: p.planning.generatedAt,
        map: mapOut,
      },
    };
  }

  try {
    if (session) {
      let result;
      await session.withTransaction(async () => {
        result = await run();
      });
      session.endSession();
      return res.status(result.status).json(result.payload);
    }

    const result = await run();
    return res.status(result.status).json(result.payload);
  } catch (e) {
    try {
      if (session) session.endSession();
    } catch {}
    console.error("POST /projects/:id/planning/generate error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ READ ------------------------------ */
// GET /api/projects/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const doc = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    console.error("GET /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- CREATE ----------------------------- */
// POST /api/projects
router.post("/", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name required" });

    if (b.startDate && b.endDate && new Date(b.endDate) < new Date(b.startDate)) {
      return res.status(400).json({ error: "endDate cannot be before startDate" });
    }

    const orgIdRaw = req.user?.orgId;
    const orgId = mongoose.Types.ObjectId.isValid(String(orgIdRaw))
      ? new mongoose.Types.ObjectId(String(orgIdRaw))
      : orgIdRaw;

    const managerId = readNullableId(b.manager ?? b.managerId);
    if (managerId === "INVALID") return res.status(400).json({ error: "invalid manager id" });

    const members = Array.isArray(b.members) ? b.members.filter(isId).map(toObjectId) : [];

    const doc = new Project({
      orgId,
      name: String(b.name).trim(),
      description: b.description || "",
      status: normalizeStatus(b.status) || "active",
      tags: Array.isArray(b.tags) ? b.tags : [],
      ...(Array.isArray(b.geoFences) ? { geoFences: b.geoFences } : {}),
      startDate: b.startDate ? new Date(b.startDate) : undefined,
      endDate: b.endDate ? new Date(b.endDate) : undefined,
      clientId: toObjectId(b.clientId),
      groupId: toObjectId(b.groupId),
      manager: managerId || undefined,
      members,
    });

    await doc.save();
    res.status(201).json(doc.toObject());
  } catch (e) {
    console.error("POST /projects error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------- UPDATE HELPERS (PUT/PATCH) ---------------------- */

async function applyProjectUpdates(p, b, res) {
  if (b.name != null) p.name = String(b.name).trim();
  if (b.description != null) p.description = String(b.description);
  if (b.status != null) p.status = normalizeStatus(b.status);
  if (b.tags != null) p.tags = Array.isArray(b.tags) ? b.tags : [];

  if (Object.prototype.hasOwnProperty.call(b, "startDate")) p.startDate = b.startDate ? new Date(b.startDate) : undefined;
  if (Object.prototype.hasOwnProperty.call(b, "endDate")) p.endDate = b.endDate ? new Date(b.endDate) : undefined;

  if (p.startDate && p.endDate && p.endDate < p.startDate) {
    return res.status(400).json({ error: "endDate cannot be before startDate" });
  }

  if (b.clientId !== undefined) p.clientId = toObjectId(b.clientId);
  if (b.groupId !== undefined) p.groupId = toObjectId(b.groupId);

  if (b.geoFences !== undefined) p.geoFences = Array.isArray(b.geoFences) ? b.geoFences : [];

  if (Object.prototype.hasOwnProperty.call(b, "manager") || Object.prototype.hasOwnProperty.call(b, "managerId")) {
    const mid = readNullableId(b.manager ?? b.managerId);
    if (mid === "INVALID") return res.status(400).json({ error: "invalid manager id" });
    p.manager = mid || undefined;
  }

  if (Object.prototype.hasOwnProperty.call(b, "members")) {
    if (!Array.isArray(b.members)) return res.status(400).json({ error: "members must be an array of ids" });
    p.members = b.members.filter(isId).map(toObjectId);
  }

  await p.save();
  return null;
}

/* ----------------------------- UPDATE (PUT) ----------------------------- */
router.put("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });

    const err = await applyProjectUpdates(p, req.body || {}, res);
    if (err) return;
    res.json(p.toObject());
  } catch (e) {
    console.error("PUT /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- UPDATE (PATCH) ----------------------------- */
router.patch("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });

    const err = await applyProjectUpdates(p, req.body || {}, res);
    if (err) return;
    res.json(p.toObject());
  } catch (e) {
    console.error("PATCH /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------- MANAGER ONLY ENDPOINT ------------------------- */
router.patch("/:id/manager", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });

    const mid = readNullableId(req.body?.manager ?? req.body?.managerId);
    if (mid === "INVALID") return res.status(400).json({ error: "invalid manager id" });

    p.manager = mid || undefined;
    await p.save();
    res.json(p.toObject());
  } catch (e) {
    console.error("PATCH /projects/:id/manager error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- DELETE ----------------------------- */
router.delete("/:id", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const del = await Project.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------- PROJECT GEOFENCES CRUD ----------------------- */

router.post(
  "/:id/geofences/upload",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  memUpload.single("file"),
  async (req, res) => {
    try {
      const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
      if (!p) return res.status(404).json({ error: "Not found" });
      if (!req.file) return res.status(400).json({ error: "file required" });

      const ext = (req.file.originalname.split(".").pop() || "").toLowerCase();
      const mime = (req.file.mimetype || "").toLowerCase();

      let fences = [];
      if (ext === "geojson" || mime.includes("geo+json") || mime === "application/json") {
        fences = parseGeoJSONToProjectFences(req.file.buffer);
      } else if (ext === "kml" || mime.includes("kml")) {
        fences = parseKMLToProjectFences(req.file.buffer.toString("utf8"));
      } else if (ext === "kmz" || mime.includes("kmz") || mime === "application/zip") {
        const kmlText = extractKMLFromKMZ(req.file.buffer);
        if (!kmlText) return res.status(400).json({ error: "no KML found in KMZ" });
        fences = parseKMLToProjectFences(kmlText);
      } else {
        return res.status(400).json({ error: "unsupported file type (use .geojson, .kml or .kmz)" });
      }

      if (!fences.length) return res.status(400).json({ error: "no usable polygons found" });

      p.geoFences = Array.isArray(p.geoFences) ? p.geoFences : [];
      for (const f of fences) {
        if (f.type === "polygon") p.geoFences.push({ type: "polygon", polygon: f.polygon });
      }

      await p.save();
      const fresh = await Project.findById(p._id).lean();
      res.json(fresh);
    } catch (e) {
      console.error("POST /projects/:id/geofences/upload error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.put("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });
    const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
    p.geoFences = arr.filter((f) => f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3);
    await p.save();
    res.json(await Project.findById(p._id).lean());
  } catch (e) {
    console.error("PUT /projects/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });
    const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
    const add = arr.filter((f) => f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3);
    p.geoFences = Array.isArray(p.geoFences) ? p.geoFences.concat(add) : add;
    await p.save();
    res.json(await Project.findById(p._id).lean());
  } catch (e) {
    console.error("PATCH /projects/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id/geofences", requireAuth, allowRoles("manager", "admin", "superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });
    p.geoFences = [];
    await p.save();
    res.json(await Project.findById(p._id).lean());
  } catch (e) {
    console.error("DELETE /projects/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id/geofences", requireAuth, async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json({ geoFences: Array.isArray(p.geoFences) ? p.geoFences : [] });
  } catch (e) {
    console.error("GET /projects/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- LIST PROJECT TASKS -------------------------- */
router.get("/:id/tasks", requireAuth, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const pid = req.params.id;
    if (!isId(pid)) return res.status(400).json({ error: "bad id" });

    const find = {
      projectId: new mongoose.Types.ObjectId(pid),
      ...orgScope(req.user?.orgId),
    };
    if (status) find.status = normalizeStatus(status);

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 1000);
    const rows = await Task.find(find).sort({ dueAt: 1, dueDate: 1, updatedAt: -1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error("GET /projects/:id/tasks error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- COVERAGE ----------------------------- */
router.get("/:id/coverage", requireAuth, async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!project) return res.status(404).json({ error: "Not found" });

    const projectFences = collectProjectFences(project);

    const doneStates = ["completed", "done", "finished"];
    const tasks = await Task.find({
      projectId: new mongoose.Types.ObjectId(project._id),
      ...orgScope(req.user?.orgId),
      status: { $in: doneStates },
    }).lean();

    const completedTaskFences = [];
    for (const t of tasks) completedTaskFences.push(...collectTaskFences(t));

    res.json({
      projectId: String(project._id),
      projectFences,
      completedTaskFences,
      stats: {
        totalCompletedTasks: tasks.length,
        completedTasksWithFences: tasks.filter((t) => (Array.isArray(t.geoFences) && t.geoFences.length) || !!t.locationGeoFence)
          .length,
        fenceFragmentsReturned: completedTaskFences.length,
      },
    });
  } catch (e) {
    console.error("GET /projects/:id/coverage error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
