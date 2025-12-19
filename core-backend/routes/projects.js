const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { requireAuth } = require("../middleware/auth");
const Project = require("../models/Project");
const Task = require("../models/Task");

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
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      ((yi > point.lat) !== (yj > point.lat)) &&
      (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function collectProjectFences(p) {
  const out = [];
  const list = Array.isArray(p?.geoFences) ? p.geoFences : (p?.geoFence ? [p.geoFence] : []);
  for (const f of (list || [])) {
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
          radius: Number(f.radius)
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

// GeoJSON → polygons (ignore Points for projects)
function parseGeoJSONToProjectFences(buf) {
  const out = [];
  let gj;
  try { gj = JSON.parse(buf.toString("utf8")); } catch { return out; }

  function addGeom(geom) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    if (t === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const outer = geom.coordinates[0]; // [[lng,lat],...]
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
    // Points/LineStrings are ignored at project level
  }

  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) {
    gj.features.forEach(f => addGeom(f?.geometry));
  } else if (gj.type === "Feature") {
    addGeom(gj.geometry);
  } else {
    addGeom(gj);
  }

  return out;
}

// Very lightweight KML parser for <Polygon><coordinates>
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
    if (pairs.length >= 3) {
      fences.push({ type: "polygon", polygon: pairs.map(([lng, lat]) => [lng, lat]) });
    }
  }
  return fences;
}

/* ------------------------------ LIST ------------------------------ */
// GET /api/projects?q=&status=&tag=&limit=
router.get("/", requireAuth, async (req, res) => {
  try {
    const { q, status, tag, limit } = req.query;
    const find = {
      ...orgScope(req.user?.orgId),
    };

    if (q) {
      find.$or = [
        { name: new RegExp(q, "i") },
        { description: new RegExp(q, "i") },
        { tags: String(q) },
      ];
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
router.post("/", requireAuth, allowRoles("manager","admin","superadmin"), async (req, res) => {
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

    // manager + members (new)
    const managerId = readNullableId(b.manager ?? b.managerId);
    if (managerId === "INVALID") return res.status(400).json({ error: "invalid manager id" });

    const members = Array.isArray(b.members)
      ? b.members.filter(isId).map(toObjectId)
      : [];

    const doc = new Project({
      orgId,
      name: String(b.name).trim(),
      description: b.description || "",
      status: normalizeStatus(b.status) || "active",
      tags: Array.isArray(b.tags) ? b.tags : [],
      ...(Array.isArray(b.geoFences) ? { geoFences: b.geoFences } : {}),
      startDate: b.startDate ? new Date(b.startDate) : undefined,
      endDate:   b.endDate   ? new Date(b.endDate)   : undefined,
      clientId:  toObjectId(b.clientId),
      groupId:   toObjectId(b.groupId),
      manager:   managerId || undefined,
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
  if (b.name         != null) p.name = String(b.name).trim();
  if (b.description  != null) p.description = String(b.description);
  if (b.status       != null) p.status = normalizeStatus(b.status);
  if (b.tags         != null) p.tags = Array.isArray(b.tags) ? b.tags : [];

  if (Object.prototype.hasOwnProperty.call(b, "startDate"))
    p.startDate = b.startDate ? new Date(b.startDate) : undefined;
  if (Object.prototype.hasOwnProperty.call(b, "endDate"))
    p.endDate = b.endDate ? new Date(b.endDate) : undefined;

  if (p.startDate && p.endDate && p.endDate < p.startDate) {
    return res.status(400).json({ error: "endDate cannot be before startDate" });
  }

  if (b.clientId !== undefined) p.clientId = toObjectId(b.clientId);
  if (b.groupId  !== undefined) p.groupId  = toObjectId(b.groupId);

  if (b.geoFences !== undefined) p.geoFences = Array.isArray(b.geoFences) ? b.geoFences : [];

  // NEW: manager + members
  if (Object.prototype.hasOwnProperty.call(b, "manager") || Object.prototype.hasOwnProperty.call(b, "managerId")) {
    const mid = readNullableId(b.manager ?? b.managerId);
    if (mid === "INVALID") return res.status(400).json({ error: "invalid manager id" });
    p.manager = mid || undefined; // allow clear with null/""
  }

  if (Object.prototype.hasOwnProperty.call(b, "members")) {
    if (!Array.isArray(b.members)) return res.status(400).json({ error: "members must be an array of ids" });
    p.members = b.members.filter(isId).map(toObjectId);
  }

  await p.save();
  return null;
}

/* ----------------------------- UPDATE (PUT) ----------------------------- */
// PUT /api/projects/:id
router.put("/:id", requireAuth, allowRoles("manager","admin","superadmin"), async (req, res) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!p) return res.status(404).json({ error: "Not found" });

    const err = await applyProjectUpdates(p, req.body || {}, res);
    if (err) return; // response already sent
    res.json(p.toObject());
  } catch (e) {
    console.error("PUT /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- UPDATE (PATCH) ----------------------------- */
// PATCH /api/projects/:id  (partial update)
router.patch("/:id", requireAuth, allowRoles("manager","admin","superadmin"), async (req, res) => {
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
// PATCH /api/projects/:id/manager  { manager: "<userId|null|''>" }
router.patch("/:id/manager", requireAuth, allowRoles("manager","admin","superadmin"), async (req, res) => {
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
// DELETE /api/projects/:id
router.delete("/:id", requireAuth, allowRoles("manager","admin","superadmin"), async (req, res) => {
  try {
    const del = await Project.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /projects/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------- PROJECT GEOFENCES CRUD -----------------------
   NOTE: You also mounted a dedicated projects-geofences router earlier.
   If you want to avoid duplicate handlers, feel free to remove these
   endpoints from this file and keep the dedicated router only. */

router.post(
  "/:id/geofences/upload",
  requireAuth,
  allowRoles("manager","admin","superadmin"),
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

      if (!fences.length) {
        return res.status(400).json({ error: "no usable polygons found" });
      }

      p.geoFences = Array.isArray(p.geoFences) ? p.geoFences : [];
      for (const f of fences) {
        if (f.type === "polygon") {
          p.geoFences.push({ type: "polygon", polygon: f.polygon });
        }
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

router.put(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager","admin","superadmin"),
  async (req, res) => {
    try {
      const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
      if (!p) return res.status(404).json({ error: "Not found" });
      const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
      p.geoFences = arr.filter(f => f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3);
      await p.save();
      res.json(await Project.findById(p._id).lean());
    } catch (e) {
      console.error("PUT /projects/:id/geofences error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.patch(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager","admin","superadmin"),
  async (req, res) => {
    try {
      const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
      if (!p) return res.status(404).json({ error: "Not found" });
      const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
      const add = arr.filter(f => f?.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3);
      p.geoFences = Array.isArray(p.geoFences) ? p.geoFences.concat(add) : add;
      await p.save();
      res.json(await Project.findById(p._id).lean());
    } catch (e) {
      console.error("PATCH /projects/:id/geofences error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.delete(
  "/:id/geofences",
  requireAuth,
  allowRoles("manager","admin","superadmin"),
  async (req, res) => {
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
  }
);

router.get(
  "/:id/geofences",
  requireAuth,
  async (req, res) => {
    try {
      const p = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
      if (!p) return res.status(404).json({ error: "Not found" });
      res.json({ geoFences: Array.isArray(p.geoFences) ? p.geoFences : [] });
    } catch (e) {
      console.error("GET /projects/:id/geofences error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* -------------------------- LIST PROJECT TASKS -------------------------- */
// GET /api/projects/:id/tasks?status=&limit=
router.get("/:id/tasks", requireAuth, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const pid = req.params.id;
    if (!isId(pid)) return res.status(400).json({ error: "bad id" });

    const find = {
      projectId: new mongoose.Types.ObjectId(pid),
      ...orgScope(req.user?.orgId), // 🔒 scope to org
    };
    if (status) find.status = normalizeStatus(status);

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 1000);
    const rows = await Task.find(find)
      // sort by whichever your schema actually uses:
      .sort({ dueAt: 1, dueDate: 1, updatedAt: -1 })
      .limit(lim)
      .lean();

    res.json(rows);
  } catch (e) {
    console.error("GET /projects/:id/tasks error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- COVERAGE ----------------------------- */
// GET /api/projects/:id/coverage
router.get("/:id/coverage", requireAuth, async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!project) return res.status(404).json({ error: "Not found" });

    const projectFences = collectProjectFences(project); // [{type:'polygon', ring:[[lng,lat],...]}]

    // Completed/done tasks in this project (with any fences), scoped to org
    const doneStates = ["completed", "done", "finished"];
    const tasks = await Task.find({
      projectId: new mongoose.Types.ObjectId(project._id),
      ...orgScope(req.user?.orgId),
      status: { $in: doneStates },
    }).lean();

    const completedTaskFences = [];
    for (const t of tasks) {
      completedTaskFences.push(...collectTaskFences(t));
    }

    res.json({
      projectId: String(project._id),
      projectFences,
      completedTaskFences,
      stats: {
        totalCompletedTasks: tasks.length,
        completedTasksWithFences: tasks.filter(
          t => (Array.isArray(t.geoFences) && t.geoFences.length) || !!t.locationGeoFence
        ).length,
        fenceFragmentsReturned: completedTaskFences.length,
      }
    });
  } catch (e) {
    console.error("GET /projects/:id/coverage error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
