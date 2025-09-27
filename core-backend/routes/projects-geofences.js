// core-backend/routes/projects-geofences.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Project = require('../models/Project');

const router = express.Router();

/* ------------------------ ACL with robust fallbacks ------------------------ */
let acl = null;
try { acl = require('../middleware/acl'); } catch (_) { /* optional */ }
const _isAdmin = (u) => {
  const r = String(u?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
};
const isAdmin       = acl?.isAdmin || _isAdmin;
const canReadProject = (typeof acl?.canReadProject === 'function')
  ? acl.canReadProject
  : (_user, _proj) => true; // UI already gates access to page
const canEditProject = (typeof acl?.canEditProject === 'function')
  ? acl.canEditProject
  : (user, _proj) => isAdmin(user);

/* --------------------------- Upload destination --------------------------- */
const uploadsRoot = path.join(__dirname, '..', 'uploads');
const baseDir = path.join(uploadsRoot, 'fences', 'projects');
fs.mkdirSync(baseDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = req.params.id || '_project';
    const dir = path.join(baseDir, projectId, String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, path.basename(file.originalname || 'fences')),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(kml|kmz|geojson|json)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Unsupported file type. Use .kml, .kmz or .geojson'), ok);
  },
});

/* --------------------------------- Utils ---------------------------------- */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  return { orgId: new mongoose.Types.ObjectId(s) };
}

const PREC = 6;
const r6 = (n) => Number.parseFloat(Number(n).toFixed(PREC));
function closeRing(coords) {
  if (!coords?.length) return coords || [];
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...coords, first];
  return coords;
}

/* -------- normalize <-> project fields -------- */
function applyFencesToProject(project, fences = []) {
  project.locationGeoFence = undefined;
  project.geoPolygon = undefined;
  project.geoJSON = undefined;
  project.kmlRef = undefined;

  const circles = [];
  const polygons = [];

  (Array.isArray(fences) ? fences : []).forEach((f) => {
    if (!f || typeof f !== 'object') return;
    if (f.type === 'circle' && f.center && Number.isFinite(+f.radius)) {
      const lat = Number(f.center.lat);
      const lng = Number(f.center.lng);
      const radius = Number(f.radius);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radius)) {
        circles.push({ lat: r6(lat), lng: r6(lng), radius });
      }
    } else if (f.type === 'polygon' && Array.isArray(f.polygon) && f.polygon.length >= 3) {
      const ring = f.polygon
        .map(([lng, lat]) => [r6(Number(lng)), r6(Number(lat))])
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (ring.length >= 3) polygons.push(closeRing(ring));
    } else if (f.type === 'point' && f.point) {
      const lat = Number(f.point.lat);
      const lng = Number(f.point.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        circles.push({ lat: r6(lat), lng: r6(lng), radius: 10 });
      }
    }
  });

  if (polygons.length) {
    project.geoMode = 'polygon';
    project.geoJSON = {
      type: 'MultiPolygon',
      coordinates: polygons.map((outer) => [outer]),
    };
  }

  if (circles.length) {
    const c = circles[0];
    project.locationGeoFence = { lat: c.lat, lng: c.lng, radius: c.radius };
    if (!polygons.length) project.geoMode = 'circle';
  }

  if (!polygons.length && !circles.length) {
    project.geoMode = 'off';
  }

  return project;
}

function fencesFromProject(project) {
  const out = [];
  if (project.locationGeoFence && Number.isFinite(project.locationGeoFence.lat) && Number.isFinite(project.locationGeoFence.lng)) {
    out.push({
      type: 'circle',
      center: {
        lat: Number(project.locationGeoFence.lat),
        lng: Number(project.locationGeoFence.lng),
      },
      radius: Number(project.locationGeoFence.radius || 50),
    });
  }
  const gj = project.geoJSON;
  if (gj && (gj.type === 'Polygon' || gj.type === 'MultiPolygon')) {
    const polys = gj.type === 'Polygon' ? [gj.coordinates] : gj.coordinates;
    polys.forEach((poly) => {
      const outer = Array.isArray(poly?.[0]) ? poly[0] : null;
      if (!outer || outer.length < 3) return;
      const ring = outer
        .map(([lng, lat]) => [Number(lng), Number(lat)])
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (ring.length >= 3) out.push({ type: 'polygon', polygon: closeRing(ring) });
    });
  }
  if (!gj && Array.isArray(project.geoPolygon) && project.geoPolygon.length >= 3) {
    const ring = project.geoPolygon
      .map((p) => [Number(p.lng), Number(p.lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (ring.length >= 3) out.push({ type: 'polygon', polygon: closeRing(ring) });
  }
  return out;
}

/* ------------------------ lightweight server-side parsers ------------------------ */
function parseGeoJSONTextToRings(text) {
  try {
    const obj = JSON.parse(text);
    const rings = [];
    const pushPoly = (coords) => {
      if (!Array.isArray(coords)) return;
      const outer = coords[0];
      if (!Array.isArray(outer) || outer.length < 3) return;
      const cleaned = outer.map(([lng, lat]) => [r6(Number(lng)), r6(Number(lat))])
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (cleaned.length >= 3) rings.push(closeRing(cleaned));
    };
    const handle = (g) => {
      if (!g) return;
      if (g.type === 'Polygon') pushPoly(g.coordinates);
      if (g.type === 'MultiPolygon') (g.coordinates || []).forEach(pushPoly);
    };
    if (obj.type === 'FeatureCollection') {
      (obj.features || []).forEach((f) => handle(f?.geometry));
    } else if (obj.type === 'Feature') {
      handle(obj.geometry);
    } else {
      handle(obj);
    }
    return rings;
  } catch { return []; }
}

function parseKMLTextToRings(kmlText) {
  const rings = [];
  const re = /<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi;
  let m;
  while ((m = re.exec(kmlText))) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    const pts = raw.split(/\s+/).map((pair) => {
      const [lng, lat] = pair.split(',').slice(0, 2).map(Number);
      return [r6(lng), r6(lat)];
    }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (pts.length >= 3) rings.push(closeRing(pts));
  }
  return rings;
}

async function parseKMZBufferToRings(buffer) {
  let JSZip;
  try { JSZip = require('jszip'); } catch { return { rings: [], note: "Install 'jszip' to parse KMZ (npm i jszip)" }; }
  const zip = await JSZip.loadAsync(buffer);
  const entry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
  if (!entry) return { rings: [] };
  const kmlText = await entry.async('text');
  return { rings: parseKMLTextToRings(kmlText) };
}

/* ------------------------------------ GET ------------------------------------ */
router.get('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, ...orgScope(req.user?.orgId) }).lean();
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!canReadProject(req.user, project)) return res.status(403).json({ error: 'Forbidden' });

    const fences = fencesFromProject(project);
    res.json({ fences, geoFences: fences });
  } catch (e) {
    console.error('GET /projects/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* -------------------------------- PUT/IMPORT -------------------------------- */
router.put('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!canEditProject(req.user, project)) return res.status(403).json({ error: 'Forbidden' });

    const fences = Array.isArray(req.body?.fences) ? req.body.fences : [];
    applyFencesToProject(project, fences);

    await project.save();
    res.json({ ok: true, fences: fencesFromProject(project) });
  } catch (e) {
    console.error('PUT /projects/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.post('/:id/geofences/import', requireAuth, async (req, res) => {
  try {
    req.url = req.url.replace('/import', '');
    return router.handle({ ...req, method: 'PUT' }, res);
  } catch (e) {
    console.error('POST /projects/:id/geofences/import failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* ---------------------------------- CLEAR ---------------------------------- */
router.delete('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!canEditProject(req.user, project)) return res.status(403).json({ error: 'Forbidden' });

    project.locationGeoFence = undefined;
    project.geoPolygon = undefined;
    project.geoJSON = undefined;
    project.kmlRef = undefined;
    project.geoMode = 'off';

    await project.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /projects/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.post('/:id/geofences/clear', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    req.method = 'DELETE';
    req.url = `/projects/${id}/geofences`;
    return router.handle(req, res);
  } catch (e) {
    console.error('POST /projects/:id/geofences/clear failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* ---------------------------------- UPLOAD ---------------------------------- */
router.post('/:id/geofences/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!canEditProject(req.user, project)) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    // Accept & ignore any of: ?radius, ?buffer, ?radiusMeters
    /* const { radius, buffer, radiusMeters } = req.query; */

    const rel = '/files/' + path.relative(uploadsRoot, req.file.path).replace(/\\/g, '/');

    // Always keep a file reference
    project.kmlRef = { url: rel, name: req.file.originalname || 'fences' };

    // Try to derive polygons so the map renders immediately
    const name = (req.file.originalname || '').toLowerCase();
    let rings = [];
    let parseNote = null;

    if (name.endsWith('.geojson') || name.endsWith('.json')) {
      const text = await fs.promises.readFile(req.file.path, 'utf8');
      rings = parseGeoJSONTextToRings(text);
    } else if (name.endsWith('.kml')) {
      const text = await fs.promises.readFile(req.file.path, 'utf8');
      rings = parseKMLTextToRings(text);
    } else if (name.endsWith('.kmz')) {
      const buf = await fs.promises.readFile(req.file.path);
      const out = await parseKMZBufferToRings(buf);
      rings = out.rings || [];
      parseNote = out.note || null;
    }

    if (rings.length) {
      project.geoMode = 'polygon';
      project.geoJSON = {
        type: 'MultiPolygon',
        coordinates: rings.map((outer) => [outer]),
      };
    }

    await project.save();
    res.status(201).json({
      ok: true,
      kmlRef: project.kmlRef,
      derivedPolygons: (rings || []).length,
      note: parseNote || undefined,
      fences: fencesFromProject(project),
    });
  } catch (e) {
    console.error('POST /projects/:id/geofences/upload failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
