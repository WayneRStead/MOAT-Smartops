// core-backend/routes/task-coverage.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mongoose = require("mongoose");
const AdmZip = require("adm-zip");

const { requireAuth } = require("../middleware/auth");
const Task = require("../models/Task");
const Project = require("../models/Project");
const TaskCoverage = require("../models/TaskCoverage");

const router = express.Router();

/* ------------------------ Common helpers ------------------------ */
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const OID = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);
const getRole = (req) => (req.user?.role || req.user?.claims?.role || "user");
const isAdminRole = (role) => ["admin", "superadmin"].includes(String(role).toLowerCase());
const isAdmin = (req) => isAdminRole(getRole(req));

function hasPath(model, p) {
  return !!(model && model.schema && model.schema.path && model.schema.path(p));
}
const wantsObjectId = (model, p) => model?.schema?.path(p)?.instance === "ObjectId";

/** org scope consistent with /routes/tasks.js */
function orgScope(model, req) {
  if (!hasPath(model, "orgId")) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  return wantsObjectId(model, "orgId")
    ? { orgId: new mongoose.Types.ObjectId(s) }
    : { orgId: s };
}

/** Visibility filter consistent with /routes/tasks.js */
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

/** Ensure the requester can see this task (or is admin) */
async function assertCanSeeTaskOrAdmin(req, taskId) {
  if (isAdmin(req)) return true;
  const filter = { _id: OID(taskId), ...orgScope(Task, req), ...buildVisibilityFilter(req) };
  const exists = await Task.exists(filter);
  return !!exists;
}

/* -------------------------- Upload plumbing -------------------------- */
const uploadsRoot = path.join(__dirname, "..", "uploads");
const coverageDir = path.join(uploadsRoot, "coverage", "tasks");
fs.mkdirSync(coverageDir, { recursive: true });

function cleanFilename(name) {
  return String(name || "").replace(/[^\w.\-]+/g, "_").slice(0, 120);
}
const disk = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(coverageDir, String(req.params.id || "_task"), String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, cleanFilename(file.originalname || "coverage")),
});
const uploadDisk = multer({
  storage: disk,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(kml|kmz|geojson|json)$/i.test(file.originalname || "");
    cb(ok ? null : new Error("Unsupported file type. Use .kml, .kmz or .geojson"), ok);
  },
});

/* -------------------------- Light parsers -------------------------- */
function parseGeoJSON(obj) {
  // Returns { polygons: [ [ [lng,lat], ...] ], lines: [ [ [lng,lat], ...] ] }
  const out = { polygons: [], lines: [] };
  const pushPoly = (coords) => {
    if (!Array.isArray(coords)) return;
    const outer = coords[0];
    if (!Array.isArray(outer) || outer.length < 3) return;
    const ring = outer
      .map(([lng, lat]) => [Number(lng), Number(lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (ring.length >= 3) out.polygons.push(ring);
  };
  const pushLine = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const line = coords
      .map(([lng, lat]) => [Number(lng), Number(lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (line.length >= 2) out.lines.push(line);
  };

  const handle = (g) => {
    if (!g || !g.type) return;
    switch (g.type) {
      case "Polygon":
        pushPoly(g.coordinates);
        break;
      case "MultiPolygon":
        (g.coordinates || []).forEach(pushPoly);
        break;
      case "LineString":
        pushLine(g.coordinates);
        break;
      case "MultiLineString":
        (g.coordinates || []).forEach(pushLine);
        break;
      case "GeometryCollection":
        (g.geometries || []).forEach(handle);
        break;
    }
  };

  if (obj.type === "FeatureCollection") (obj.features || []).forEach((f) => handle(f?.geometry));
  else if (obj.type === "Feature") handle(obj.geometry);
  else handle(obj);

  return out;
}

function parseKMLCoordsBlocks(kmlText) {
  // returns array of arrays of [lng,lat] — we won't distinguish Poly vs Line here
  const out = [];
  const blocks = Array.from(kmlText.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi));
  blocks.forEach((m) => {
    const raw = (m[1] || "").trim();
    if (!raw) return;
    const pts = raw
      .split(/\s+/)
      .map((pair) => {
        const [lng, lat] = pair.split(",").slice(0, 2).map(Number);
        return [lng, lat];
      })
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (pts.length >= 2) out.push(pts);
  });
  return out;
}

function parseKMZToLinesPolys(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const preferred = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.entryName));
  const kmlEntry = preferred || entries.find((e) => /\.kml$/i.test(e.entryName));
  if (!kmlEntry) return { polygons: [], lines: [] };
  const kmlText = kmlEntry.getData().toString("utf8");
  return parseKMLToLinesPolys(kmlText);
}

function parseKMLToLinesPolys(kmlText) {
  // Heuristic: if first == last (closed) and len>=3 => polygon ring, else line
  const blocks = parseKMLCoordsBlocks(kmlText);
  const polys = [];
  const lines = [];
  blocks.forEach((pts) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (
      pts.length >= 3 &&
      first &&
      last &&
      Number(first[0]) === Number(last[0]) &&
      Number(first[1]) === Number(last[1])
    ) {
      polys.push(pts);
    } else {
      lines.push(pts);
    }
  });
  return { polygons: polys, lines };
}

/* -------------------------- KMZ/CSV export helpers -------------------------- */
function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function covsToKML(docName, covs) {
  let placemarks = "";
  covs.forEach((c, idx) => {
    const nm =
      c.label ||
      `Coverage ${idx + 1}${c.date ? " — " + new Date(c.date).toLocaleDateString() : ""}`;
    if (c.geometry?.type === "MultiPolygon") {
      (c.geometry.coordinates || []).forEach((poly, j) => {
        const outer = Array.isArray(poly?.[0]) ? poly[0] : poly;
        const coords = (outer || []).map(([lng, lat]) => `${lng},${lat},0`).join(" ");
        placemarks += `
<Placemark>
  <name>${escapeXml(nm)} (poly ${j + 1})</name>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`;
      });
    } else if (c.geometry?.type === "MultiLineString") {
      (c.geometry.coordinates || []).forEach((line, j) => {
        const coords = (line || []).map(([lng, lat]) => `${lng},${lat},0`).join(" ");
        placemarks += `
<Placemark>
  <name>${escapeXml(nm)} (path ${j + 1})</name>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
      });
    }
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>${escapeXml(docName || "Coverage")}</name>${placemarks}
  </Document>
</kml>`;
}

function covsToCSV(covs) {
  // Flatten vertices for simple analysis in Excel/QGIS
  const rows = [
    ["coverageId", "date", "type", "featureIndex", "vertexIndex", "lng", "lat", "label"].join(","),
  ];
  covs.forEach((c) => {
    const dateStr = c.date ? new Date(c.date).toISOString() : "";
    const label = (c.label || "").replace(/"/g, '""');
    if (c.geometry?.type === "MultiPolygon") {
      (c.geometry.coordinates || []).forEach((poly, fi) => {
        const outer = Array.isArray(poly?.[0]) ? poly[0] : poly;
        (outer || []).forEach(([lng, lat], vi) => {
          rows.push(
            [c._id, dateStr, "polygon", fi, vi, lng, lat, `"${label}"`].join(",")
          );
        });
      });
    } else if (c.geometry?.type === "MultiLineString") {
      (c.geometry.coordinates || []).forEach((line, fi) => {
        (line || []).forEach(([lng, lat], vi) => {
          rows.push([c._id, dateStr, "line", fi, vi, lng, lat, `"${label}"`].join(","));
        });
      });
    }
  });
  return rows.join("\n");
}

/* -------------------------- GET list -------------------------- */
router.get("/:id/coverage", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { from, to, limit } = req.query;
    const q = {
      taskId: OID(id),
      ...orgScope(TaskCoverage, req),
    };
    if (from || to) {
      q.date = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 1000);
    const rows = await TaskCoverage.find(q).sort({ date: -1, uploadedAt: -1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error("GET /tasks/:id/coverage error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- GET single -------------------------- */
router.get("/:id/coverage/:covId", requireAuth, async (req, res) => {
  try {
    const { id, covId } = req.params;
    if (!isId(id) || !isId(covId)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const row = await TaskCoverage.findOne({
      _id: OID(covId),
      taskId: OID(id),
      ...orgScope(TaskCoverage, req),
    }).lean();

    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/:covId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- POST (JSON body) -------------------------- */
router.post("/:id/coverage", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only for now" });

    const body = req.body || {};
    if (!body.geometry || !body.geometry.type || !Array.isArray(body.geometry.coordinates)) {
      return res.status(400).json({ error: "geometry required (GeoJSON-like)" });
    }

    const t = await Task.findOne({ _id: id, ...orgScope(Task, req) }).lean();
    if (!t) return res.status(404).json({ error: "task missing" });

    const doc = await TaskCoverage.create({
      orgId: req.user?.orgId,
      taskId: OID(id),
      projectId: t.projectId || undefined,
      geometry: {
        type:
          body.geometry.type === "Polygon"
            ? "MultiPolygon"
            : body.geometry.type === "LineString"
            ? "MultiLineString"
            : body.geometry.type,
        coordinates:
          body.geometry.type === "Polygon"
            ? [body.geometry.coordinates]
            : body.geometry.coordinates,
      },
      date: body.date ? new Date(body.date) : undefined,
      label: body.label || "",
      color: body.color || "",
      sourceFile: body.sourceFile || undefined,
      uploadedBy: {
        _id: OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub),
        name: req.user?.name,
        email: req.user?.email,
        sub: req.user?.sub || req.user?.id,
      },
    });

    res.status(201).json(doc.toObject());
  } catch (e) {
    console.error("POST /tasks/:id/coverage error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- UPLOAD (file) -------------------------- */
router.post(
  "/:id/coverage/upload",
  requireAuth,
  uploadDisk.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "bad id" });

      const canSee = await assertCanSeeTaskOrAdmin(req, id);
      if (!canSee) return res.status(403).json({ error: "Forbidden" });
      if (!req.file) return res.status(400).json({ error: "file required" });

      // Optional hints
      const label = String(req.body?.label || "").trim();
      const color = String(req.body?.color || "").trim();
      const date = req.body?.date ? new Date(req.body.date) : undefined;

      const t = await Task.findOne({ _id: id, ...orgScope(Task, req) }).lean();
      if (!t) return res.status(404).json({ error: "task missing" });

      const relUrl = "/files/" + path.relative(uploadsRoot, req.file.path).replace(/\\/g, "/");
      const sourceFile = {
        url: relUrl,
        name: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
      };

      const lower = (req.file.originalname || "").toLowerCase();
      const ext = path.extname(lower);

      let polys = [];
      let lines = [];

      if (ext === ".kmz") {
        const buf = fs.readFileSync(req.file.path);
        const parsed = parseKMZToLinesPolys(buf);
        polys = parsed.polygons;
        lines = parsed.lines;
      } else if (ext === ".kml") {
        const text = fs.readFileSync(req.file.path, "utf8");
        const parsed = parseKMLToLinesPolys(text);
        polys = parsed.polygons;
        lines = parsed.lines;
      } else if (ext === ".geojson" || ext === ".json") {
        const text = fs.readFileSync(req.file.path, "utf8");
        let obj;
        try {
          obj = JSON.parse(text);
        } catch {
          return res.status(400).json({ error: "Invalid JSON" });
        }
        const parsed = parseGeoJSON(obj);
        polys = parsed.polygons;
        lines = parsed.lines;
      } else {
        return res.status(400).json({ error: "Unsupported file type" });
      }

      if (!polys.length && !lines.length) {
        return res.status(400).json({ error: "No usable shapes found" });
      }

      // Prefer the shape type that exists; if both exist we emit two docs
      const docs = [];
      if (polys.length) {
        docs.push({
          orgId: req.user?.orgId,
          taskId: OID(id),
          projectId: t.projectId || undefined,
          geometry: { type: "MultiPolygon", coordinates: polys.map((ring) => [ring]) },
          date,
          label: label || "coverage area",
          color,
          sourceFile,
          uploadedBy: {
            _id: OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub),
            name: req.user?.name,
            email: req.user?.email,
            sub: req.user?.sub || req.user?.id,
          },
        });
      }
      if (lines.length) {
        docs.push({
          orgId: req.user?.orgId,
          taskId: OID(id),
          projectId: t.projectId || undefined,
          geometry: { type: "MultiLineString", coordinates: lines },
          date,
          label: label || "coverage path",
          color,
          sourceFile,
          uploadedBy: {
            _id: OID(req.user?._id) || OID(req.user?.id) || OID(req.user?.sub),
            name: req.user?.name,
            email: req.user?.email,
            sub: req.user?.sub || req.user?.id,
          },
        });
      }

      const created = await TaskCoverage.insertMany(docs);
      res.status(201).json(created.map((d) => d.toObject()));
    } catch (e) {
      console.error("POST /tasks/:id/coverage/upload error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* -------------------------- DELETE -------------------------- */
router.delete("/:id/coverage/:covId", requireAuth, async (req, res) => {
  try {
    const { id, covId } = req.params;
    if (!isId(id) || !isId(covId)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only for now" });

    const del = await TaskCoverage.findOneAndDelete({
      _id: OID(covId),
      taskId: OID(id),
      ...orgScope(TaskCoverage, req),
    });
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /tasks/:id/coverage/:covId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- EXPORT: KMZ -------------------------- */
router.get("/:id/coverage/export.kmz", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { from, to } = req.query;
    const q = { taskId: OID(id), ...orgScope(TaskCoverage, req) };
    if (from || to) {
      q.date = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    const covs = await TaskCoverage.find(q).sort({ date: 1, uploadedAt: 1 }).lean();
    const task = await Task.findById(id).lean();

    const kml = covsToKML(task?.title || `task_${id}`, covs);
    const zip = new AdmZip();
    zip.addFile("doc.kml", Buffer.from(kml, "utf8"));

    const name = `task_${(task?.title || id).replace(/[^\w\-]+/g, "_")}_coverage.kmz`;
    const buf = zip.toBuffer();
    res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.end(buf);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/export.kmz error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- EXPORT: CSV -------------------------- */
router.get("/:id/coverage/export.csv", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const { from, to } = req.query;
    const q = { taskId: OID(id), ...orgScope(TaskCoverage, req) };
    if (from || to) {
      q.date = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    const covs = await TaskCoverage.find(q).sort({ date: 1, uploadedAt: 1 }).lean();
    const csv = covsToCSV(covs);
    const name = `task_${id}_coverage.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.end(csv);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/export.csv error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
