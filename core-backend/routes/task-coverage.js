// core-backend/routes/task-coverage.js
// ✅ DROP-IN replacement
// Fixes:
// 1) Export KMZ/CSV now supports geometry.type: Polygon, MultiPolygon, LineString, MultiLineString
// 2) Adds Cache-Control: no-store headers (prevents 304 caching issues in browser)
// 3) Keeps orgId mixed matching logic (string OR ObjectId)

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mongoose = require("mongoose");
const AdmZip = require("adm-zip");

const { requireAuth } = require("../middleware/auth");
const Task = require("../models/Task");
const TaskCoverage = require("../models/TaskCoverage");

const router = express.Router();

/* ------------------------ Common helpers ------------------------ */
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const OID = (v) =>
  isId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined;

const getRole = (req) =>
  (req.user && (req.user.role || (req.user.claims && req.user.claims.role))) ||
  "user";
const isAdminRole = (role) =>
  ["admin", "superadmin"].includes(String(role).toLowerCase());
const isAdmin = (req) => isAdminRole(getRole(req));

function hasPath(model, p) {
  return !!(model && model.schema && model.schema.path && model.schema.path(p));
}

function orgFieldType(model) {
  if (!model || !model.schema || !model.schema.path) return null;
  const p = model.schema.path("orgId");
  if (!p) return null;
  return p.instance;
}

/**
 * ✅ Org scope that tolerates mixed storage (string OR ObjectId)
 * - For admin: allow ?orgId= override
 * - For non-admin: always use token org
 * - Always matches BOTH forms via $or when possible (handles legacy rows)
 */
function orgScope(model, req) {
  if (!hasPath(model, "orgId")) return {};

  let raw = "";
  if (isAdmin(req) && req.query && req.query.orgId) {
    raw = String(req.query.orgId || "").trim();
  }
  if (!raw) raw = String((req.user && req.user.orgId) || "").trim();
  if (!raw) return {};

  const t = orgFieldType(model);

  const asString = raw;
  const asObjectId = isId(raw) ? OID(raw) : null;

  const ors = [];
  if (asObjectId) ors.push({ orgId: asObjectId });
  if (asString) ors.push({ orgId: asString });

  if (!ors.length) return {};

  // even if schema is ObjectId, we still want to match legacy string rows
  if (t === "ObjectId" || t === "String" || t === "Mixed" || !t) {
    return ors.length === 1 ? ors[0] : { $or: ors };
  }

  return ors.length === 1 ? ors[0] : { $or: ors };
}

/** Visibility filter consistent with /routes/tasks.js */
function buildVisibilityFilter(req) {
  if (isAdmin(req)) return {};

  const me =
    OID(req.user && req.user._id) ||
    OID(req.user && req.user.id) ||
    OID(req.user && req.user.sub) ||
    OID(req.user && req.user.userId);

  const myGroups = (req.myGroupIds || []).map((g) => OID(g)).filter(Boolean);

  return {
    $or: [
      { visibilityMode: { $exists: false } },
      { visibilityMode: "org" },
      { visibilityMode: "assignees", assignedUserIds: me },
      { visibilityMode: "assignees+groups", assignedUserIds: me },
      { visibilityMode: "assignees", assignedTo: me },
      { visibilityMode: "assignees+groups", assignedTo: me },
      ...(myGroups.length
        ? [
            { visibilityMode: "groups", assignedGroupIds: { $in: myGroups } },
            {
              visibilityMode: "assignees+groups",
              assignedGroupIds: { $in: myGroups },
            },
            { visibilityMode: "groups", groupId: { $in: myGroups } },
            { visibilityMode: "assignees+groups", groupId: { $in: myGroups } },
          ]
        : []),
    ],
  };
}

/** Ensure the requester can see this task (or is admin) */
async function assertCanSeeTaskOrAdmin(req, taskId) {
  if (isAdmin(req)) return true;
  const filter = Object.assign(
    { _id: OID(taskId) },
    orgScope(Task, req),
    buildVisibilityFilter(req),
  );
  const exists = await Task.exists(filter);
  return !!exists;
}

function setNoStore(res) {
  // Prevent browser/proxy caching (fixes 304 issues in devtools exports/listing)
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

/* -------------------------- Upload plumbing -------------------------- */
const uploadsRoot = path.join(__dirname, "..", "uploads");
const coverageDir = path.join(uploadsRoot, "coverage", "tasks");
fs.mkdirSync(coverageDir, { recursive: true });

function cleanFilename(name) {
  return String(name || "")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);
}

const disk = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(
      coverageDir,
      String(req.params.id || "_task"),
      String(Date.now()),
    );
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) =>
    cb(null, cleanFilename(file.originalname || "coverage")),
});

const uploadDisk = multer({
  storage: disk,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(kml|kmz|geojson|json)$/i.test(file.originalname || "");
    cb(
      ok
        ? null
        : new Error("Unsupported file type. Use .kml, .kmz or .geojson"),
      ok,
    );
  },
});

/* -------------------------- Light parsers -------------------------- */
function parseGeoJSON(obj) {
  const out = { polygons: [], lines: [] };

  const pushPoly = (coords) => {
    if (!Array.isArray(coords)) return;
    const outer = coords[0];
    if (!Array.isArray(outer) || outer.length < 3) return;
    const ring = outer
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ring.length >= 3) out.polygons.push(ring);
  };

  const pushLine = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const line = coords
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
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
      default:
        break;
    }
  };

  if (obj.type === "FeatureCollection")
    (obj.features || []).forEach((f) => handle(f && f.geometry));
  else if (obj.type === "Feature") handle(obj.geometry);
  else handle(obj);

  return out;
}

function parseKMLCoordsBlocks(kmlText) {
  const out = [];
  const blocks = Array.from(
    kmlText.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi),
  );
  blocks.forEach((m) => {
    const raw = String(m[1] || "").trim();
    if (!raw) return;
    const pts = raw
      .split(/\s+/)
      .map((pair) => {
        const parts = pair.split(",");
        const lng = Number(parts[0]);
        const lat = Number(parts[1]);
        return [lng, lat];
      })
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length >= 2) out.push(pts);
  });
  return out;
}

function parseKMLToLinesPolys(kmlText) {
  const blocks = parseKMLCoordsBlocks(kmlText);
  const polys = [];
  const lines = [];

  blocks.forEach((pts) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed =
      pts.length >= 3 &&
      first &&
      last &&
      Number(first[0]) === Number(last[0]) &&
      Number(first[1]) === Number(last[1]);

    if (closed) polys.push(pts);
    else lines.push(pts);
  });

  return { polygons: polys, lines: lines };
}

function parseKMZToLinesPolys(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const preferred = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.entryName));
  const kmlEntry =
    preferred || entries.find((e) => /\.kml$/i.test(e.entryName));
  if (!kmlEntry) return { polygons: [], lines: [] };
  const kmlText = kmlEntry.getData().toString("utf8");
  return parseKMLToLinesPolys(kmlText);
}

/* -------------------------- KMZ/CSV export helpers -------------------------- */
function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function covName(c, idx) {
  const base = (c.note || c.label || "").trim();
  if (base) return base;
  const d = c.date ? " — " + new Date(c.date).toLocaleDateString() : "";
  return "Coverage " + (idx + 1) + d;
}

/**
 * ✅ Normalize ALL supported types into:
 *   polys: array of rings (each ring: [[lng,lat], ...])
 *   lines: array of lines (each line: [[lng,lat], ...])
 */
function normalizeGeomToPolysLines(geometry) {
  const out = { polys: [], lines: [] };
  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates))
    return out;

  const t = geometry.type;

  if (t === "Polygon") {
    const outer = geometry.coordinates[0];
    if (Array.isArray(outer) && outer.length >= 3) out.polys.push(outer);
  } else if (t === "MultiPolygon") {
    (geometry.coordinates || []).forEach((poly) => {
      const outer = Array.isArray(poly && poly[0]) ? poly[0] : null;
      if (Array.isArray(outer) && outer.length >= 3) out.polys.push(outer);
    });
  } else if (t === "LineString") {
    const line = geometry.coordinates;
    if (Array.isArray(line) && line.length >= 2) out.lines.push(line);
  } else if (t === "MultiLineString") {
    (geometry.coordinates || []).forEach((line) => {
      if (Array.isArray(line) && line.length >= 2) out.lines.push(line);
    });
  }

  return out;
}

function covsToKML(docName, covs) {
  let placemarks = "";

  covs.forEach((c, idx) => {
    const nm = covName(c, idx);
    const { polys, lines } = normalizeGeomToPolysLines(c.geometry);

    polys.forEach((outer, j) => {
      const coords = (outer || []).map((p) => `${p[0]},${p[1]},0`).join(" ");
      placemarks += `
<Placemark>
  <name>${escapeXml(nm)} (poly ${j + 1})</name>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`;
    });

    lines.forEach((line, j) => {
      const coords = (line || []).map((p) => `${p[0]},${p[1]},0`).join(" ");
      placemarks += `
<Placemark>
  <name>${escapeXml(nm)} (path ${j + 1})</name>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>${escapeXml(docName || "Coverage")}</name>${placemarks}
  </Document>
</kml>`;
}

function covsToCSV(covs) {
  const rows = [
    [
      "coverageId",
      "date",
      "type",
      "featureIndex",
      "vertexIndex",
      "lng",
      "lat",
      "note",
    ].join(","),
  ];

  covs.forEach((c, idx) => {
    const dateStr = c.date ? new Date(c.date).toISOString() : "";
    const note = String(c.note || c.label || covName(c, idx)).replace(
      /"/g,
      '""',
    );

    const { polys, lines } = normalizeGeomToPolysLines(c.geometry);

    polys.forEach((outer, fi) => {
      (outer || []).forEach((p, vi) => {
        rows.push(
          [c._id, dateStr, "polygon", fi, vi, p[0], p[1], `"${note}"`].join(
            ",",
          ),
        );
      });
    });

    lines.forEach((line, fi) => {
      (line || []).forEach((p, vi) => {
        rows.push(
          [c._id, dateStr, "line", fi, vi, p[0], p[1], `"${note}"`].join(","),
        );
      });
    });
  });

  return rows.join("\n");
}

/* -------------------------- GET list -------------------------- */
router.get("/:id/coverage", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const from = req.query.from;
    const to = req.query.to;
    const limit = req.query.limit;

    const q = Object.assign({ taskId: OID(id) }, orgScope(TaskCoverage, req));
    if (from || to) {
      q.date = Object.assign(
        {},
        from ? { $gte: new Date(from) } : {},
        to ? { $lte: new Date(to) } : {},
      );
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 1000);

    const rows = await TaskCoverage.find(q)
      .sort({ date: -1, createdAt: -1 })
      .limit(lim)
      .lean();

    return res.json(rows);
  } catch (e) {
    console.error("GET /tasks/:id/coverage error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- GET single -------------------------- */
router.get("/:id/coverage/:covId", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    const covId = req.params.covId;
    if (!isId(id) || !isId(covId))
      return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const row = await TaskCoverage.findOne(
      Object.assign(
        { _id: OID(covId), taskId: OID(id) },
        orgScope(TaskCoverage, req),
      ),
    ).lean();

    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/:covId error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- POST (JSON body) -------------------------- */
router.post("/:id/coverage", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });
    if (!isAdmin(req))
      return res.status(403).json({ error: "Admin only for now" });

    const body = req.body || {};
    if (
      !body.geometry ||
      !body.geometry.type ||
      !Array.isArray(body.geometry.coordinates)
    ) {
      return res
        .status(400)
        .json({ error: "geometry required (GeoJSON-like)" });
    }

    const t = await Task.findOne(
      Object.assign({ _id: id }, orgScope(Task, req)),
    ).lean();
    if (!t) return res.status(404).json({ error: "task missing" });

    let rawOrg = "";
    if (isAdmin(req) && req.query && req.query.orgId)
      rawOrg = String(req.query.orgId || "").trim();
    if (!rawOrg) rawOrg = String((req.user && req.user.orgId) || "").trim();
    const writeOrgId = isId(rawOrg) ? OID(rawOrg) : rawOrg;

    const actorUserId =
      OID(
        req.user &&
          (req.user._id || req.user.id || req.user.sub || req.user.userId),
      ) || undefined;

    const doc = await TaskCoverage.create({
      orgId: writeOrgId,
      taskId: OID(id),
      projectId: t.projectId || undefined,
      geometry: {
        type: String(body.geometry.type),
        coordinates: body.geometry.coordinates,
      },
      date: body.date ? new Date(body.date) : undefined,
      source: "api",
      note: String(body.note || body.label || "").trim(),
      fileRef: body.fileRef || body.sourceFile || undefined,
      uploadedBy: {
        userId: actorUserId,
        name: req.user && req.user.name,
        email: req.user && req.user.email,
      },
    });

    return res.status(201).json(doc.toObject());
  } catch (e) {
    console.error("POST /tasks/:id/coverage error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- UPLOAD (file) -------------------------- */
router.post(
  "/:id/coverage/upload",
  requireAuth,
  uploadDisk.single("file"),
  async (req, res) => {
    try {
      setNoStore(res);

      const id = req.params.id;
      if (!isId(id)) return res.status(400).json({ error: "bad id" });

      const canSee = await assertCanSeeTaskOrAdmin(req, id);
      if (!canSee) return res.status(403).json({ error: "Forbidden" });
      if (!req.file) return res.status(400).json({ error: "file required" });

      const label = String((req.body && req.body.label) || "").trim();
      const date =
        req.body && req.body.date ? new Date(req.body.date) : undefined;

      const t = await Task.findOne(
        Object.assign({ _id: id }, orgScope(Task, req)),
      ).lean();
      if (!t) return res.status(404).json({ error: "task missing" });

      const relUrl =
        "/files/" +
        path.relative(uploadsRoot, req.file.path).replace(/\\/g, "/");

      const fileRef = {
        url: relUrl,
        name: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
      };

      const lower = String(req.file.originalname || "").toLowerCase();
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

      let rawOrg = "";
      if (isAdmin(req) && req.query && req.query.orgId)
        rawOrg = String(req.query.orgId || "").trim();
      if (!rawOrg) rawOrg = String((req.user && req.user.orgId) || "").trim();
      const writeOrgId = isId(rawOrg) ? OID(rawOrg) : rawOrg;

      const actorUserId =
        OID(
          req.user &&
            (req.user._id || req.user.id || req.user.sub || req.user.userId),
        ) || undefined;

      const docs = [];

      if (polys.length) {
        docs.push({
          orgId: writeOrgId,
          taskId: OID(id),
          projectId: t.projectId || undefined,
          geometry: {
            type: "MultiPolygon",
            coordinates: polys.map((ring) => [ring]),
          },
          date,
          source: "file-upload",
          note: label || "coverage area",
          fileRef,
          uploadedBy: {
            userId: actorUserId,
            name: req.user && req.user.name,
            email: req.user && req.user.email,
          },
        });
      }

      if (lines.length) {
        docs.push({
          orgId: writeOrgId,
          taskId: OID(id),
          projectId: t.projectId || undefined,
          geometry: { type: "MultiLineString", coordinates: lines },
          date,
          source: "file-upload",
          note: label || "coverage path",
          fileRef,
          uploadedBy: {
            userId: actorUserId,
            name: req.user && req.user.name,
            email: req.user && req.user.email,
          },
        });
      }

      const created = await TaskCoverage.insertMany(docs);
      return res.status(201).json(created.map((d) => d.toObject()));
    } catch (e) {
      console.error("POST /tasks/:id/coverage/upload error:", e);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

/* -------------------------- DELETE -------------------------- */
router.delete("/:id/coverage/:covId", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    const covId = req.params.covId;
    if (!isId(id) || !isId(covId))
      return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });
    if (!isAdmin(req))
      return res.status(403).json({ error: "Admin only for now" });

    const del = await TaskCoverage.findOneAndDelete(
      Object.assign(
        { _id: OID(covId), taskId: OID(id) },
        orgScope(TaskCoverage, req),
      ),
    );

    if (!del) return res.status(404).json({ error: "Not found" });
    return res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /tasks/:id/coverage/:covId error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- EXPORT: KMZ -------------------------- */
router.get("/:id/coverage/export.kmz", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const from = req.query.from;
    const to = req.query.to;

    const q = Object.assign({ taskId: OID(id) }, orgScope(TaskCoverage, req));
    if (from || to) {
      q.date = Object.assign(
        {},
        from ? { $gte: new Date(from) } : {},
        to ? { $lte: new Date(to) } : {},
      );
    }

    const covs = await TaskCoverage.find(q)
      .sort({ date: 1, createdAt: 1 })
      .lean();

    const task = await Task.findById(id).lean();

    const kml = covsToKML((task && task.title) || "task_" + id, covs);
    const zip = new AdmZip();
    zip.addFile("doc.kml", Buffer.from(kml, "utf8"));

    const safeTitle = String((task && task.title) || id).replace(
      /[^\w\-]+/g,
      "_",
    );
    const name = "task_" + safeTitle + "_coverage.kmz";

    const buf = zip.toBuffer();
    res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.end(buf);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/export.kmz error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- EXPORT: CSV -------------------------- */
router.get("/:id/coverage/export.csv", requireAuth, async (req, res) => {
  try {
    setNoStore(res);

    const id = req.params.id;
    if (!isId(id)) return res.status(400).json({ error: "bad id" });

    const canSee = await assertCanSeeTaskOrAdmin(req, id);
    if (!canSee) return res.status(403).json({ error: "Forbidden" });

    const from = req.query.from;
    const to = req.query.to;

    const q = Object.assign({ taskId: OID(id) }, orgScope(TaskCoverage, req));
    if (from || to) {
      q.date = Object.assign(
        {},
        from ? { $gte: new Date(from) } : {},
        to ? { $lte: new Date(to) } : {},
      );
    }

    const covs = await TaskCoverage.find(q)
      .sort({ date: 1, createdAt: 1 })
      .lean();

    const csv = covsToCSV(covs);

    const name = "task_" + id + "_coverage.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.end(csv);
  } catch (e) {
    console.error("GET /tasks/:id/coverage/export.csv error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
