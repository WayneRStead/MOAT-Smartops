// core-backend/routes/projects-geofences.js
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { requireAuth } = require("../middleware/auth");
const Project = require("../models/Project");

const router = express.Router();

/* --------- auth roles helper (copied) --------- */
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

/* --------- upload (in-memory) --------- */
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

/* --------- parsers (same as tasks) --------- */
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

/* ------------- Routes ------------- */

// Upload & parse GeoJSON/KML/KMZ → append to project.geoFences
router.post(
  "/:id/geofences/upload",
  requireAuth,
  allowRoles("manager", "admin", "superadmin"),
  memUpload.single("file"),
  async (req, res) => {
    try {
      const p = await Project.findById(req.params.id);
      if (!p) return res.status(404).json({ error: "Not found" });
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

      p.geoFences = Array.isArray(p.geoFences) ? p.geoFences : [];
      for (const f of fences) {
        if (f.type === "polygon") p.geoFences.push({ type: "polygon", polygon: f.polygon });
        else if (f.type === "circle") p.geoFences.push({ type: "circle", center: f.center, radius: f.radius });
      }
      await p.save();

      res.json({ geoFences: p.geoFences });
    } catch (e) {
      console.error("POST /projects/:id/geofences/upload error:", e);
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
      const p = await Project.findById(req.params.id);
      if (!p) return res.status(404).json({ error: "Not found" });
      p.geoFences = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
      await p.save();
      res.json({ geoFences: p.geoFences });
    } catch (e) {
      console.error("PUT /projects/:id/geofences error:", e);
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
      const p = await Project.findById(req.params.id);
      if (!p) return res.status(404).json({ error: "Not found" });
      const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
      p.geoFences = Array.isArray(p.geoFences) ? p.geoFences.concat(arr) : arr;
      await p.save();
      res.json({ geoFences: p.geoFences });
    } catch (e) {
      console.error("PATCH /projects/:id/geofences error:", e);
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
      const p = await Project.findById(req.params.id);
      if (!p) return res.status(404).json({ error: "Not found" });
      p.geoFences = [];
      await p.save();
      res.json({ geoFences: p.geoFences });
    } catch (e) {
      console.error("DELETE /projects/:id/geofences error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// Read fences
router.get("/:id/geofences", requireAuth, async (req, res) => {
  try {
    const p = await Project.findById(req.params.id).lean();
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json({ geoFences: Array.isArray(p.geoFences) ? p.geoFences : [] });
  } catch (e) {
    console.error("GET /projects/:id/geofences error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
