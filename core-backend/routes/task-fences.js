// core-backend/routes/task-fences.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Task = require('../models/Task');

const router = express.Router();

/* ------------------------ ACL (robust fallback) ------------------------ */
const _isAdmin = (u) => {
  const r = String(u?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
};

let canReadTask = (_user, _task) => true;              // default: allow read (UI already gates)
let canEditTask = (user, _task) => _isAdmin(user);     // default: admin can edit
let isAdmin     = _isAdmin;

try {
  const acl = require('../middleware/acl');
  if (acl) {
    if (typeof acl.isAdmin === 'function')     isAdmin = acl.isAdmin;
    if (typeof acl.canReadTask === 'function') canReadTask = acl.canReadTask;
    if (typeof acl.canEditTask === 'function') canEditTask = acl.canEditTask;
  }
} catch (_) {
  // keep fallbacks above
}

/* ------------------------- Optional KMZ support ------------------------- */
let JSZip = null;
try { JSZip = require('jszip'); } catch (_) { /* If missing, KMZ uploads will 501 */ }

/* --------------------------------- Upload storage --------------------------------- */
const uploadsRoot = path.join(__dirname, '..', 'uploads');
const baseDir = path.join(uploadsRoot, 'fences', 'tasks');
fs.mkdirSync(baseDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const taskId = req.params.id || '_task';
    const dir = path.join(baseDir, taskId, String(Date.now()));
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

/* ----------------------------------- Helpers ----------------------------------- */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * org scope that matches string or ObjectId orgIds in the DB.
 * If you have legacy tasks with no orgId, set ALLOW_ORGLESS=1 during migration.
 */
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  const inList = [s];
  if (mongoose.Types.ObjectId.isValid(s)) inList.push(new mongoose.Types.ObjectId(s));

  const or = [{ orgId: { $in: inList } }];
  if (process.env.ALLOW_ORGLESS === '1') {
    or.push({ orgId: { $exists: false } }, { orgId: null });
  }
  return { $or: or };
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

/** Normalize incoming "fences" (UI format) into Task fields. */
function applyFencesToTask(task, fences = []) {
  // Reset shape fields
  task.locationGeoFence = undefined;
  task.geoPolygon = undefined;
  task.geoJSON = undefined;
  task.geoMode = 'off';

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
    task.geoMode = 'polygon';
    task.geoJSON = {
      type: 'MultiPolygon',
      coordinates: polygons.map((outer) => [outer]),
    };
  }
  if (circles.length) {
    const c = circles[0];
    task.locationGeoFence = { lat: c.lat, lng: c.lng, radius: c.radius };
    if (!polygons.length) task.geoMode = 'circle';
  }
  if (!polygons.length && !circles.length) task.geoMode = 'off';
  return task;
}

/** Build UI-format fences array from Task. */
function fencesFromTask(task) {
  const out = [];
  // Circle
  if (task.locationGeoFence && Number.isFinite(task.locationGeoFence.lat) && Number.isFinite(task.locationGeoFence.lng)) {
    out.push({
      type: 'circle',
      center: { lat: Number(task.locationGeoFence.lat), lng: Number(task.locationGeoFence.lng) },
      radius: Number(task.locationGeoFence.radius || 50),
    });
  }
  // GeoJSON Polygon/MultiPolygon
  const gj = task.geoJSON;
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
  // Legacy geoPolygon
  if (!gj && Array.isArray(task.geoPolygon) && task.geoPolygon.length >= 3) {
    const ring = task.geoPolygon
      .map((p) => [Number(p.lng), Number(p.lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (ring.length >= 3) out.push({ type: 'polygon', polygon: closeRing(ring) });
  }
  return out;
}

/* ---------------------- Minimal parsers for upload ---------------------- */
function parseGeoJSONToRings(obj) {
  const rings = [];
  const pushPoly = (coords) => {
    if (!Array.isArray(coords)) return;
    const outer = coords[0];
    if (!Array.isArray(outer) || outer.length < 3) return;
    const cleaned = outer
      .map(([lng, lat]) => [r6(Number(lng)), r6(Number(lat))])
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
}

function parseKMLStringToRings(kmlText) {
  const rings = [];
  const coordsBlocks = Array.from(kmlText.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi));
  coordsBlocks.forEach((m) => {
    const raw = (m[1] || '').trim();
    if (!raw) return;
    const pts = raw
      .split(/\s+/)
      .map((pair) => {
        const [lng, lat] = pair.split(',').slice(0, 2).map(Number);
        return [r6(lng), r6(lat)];
      })
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (pts.length >= 3) rings.push(closeRing(pts));
  });
  return rings;
}

/* ------------------------------------ GET ------------------------------------ */
router.get('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findOne({ _id: id, ...orgScope(req.user?.orgId) }).lean();
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (!canReadTask(req.user, task)) return res.status(403).json({ error: 'Forbidden' });

    const fences = fencesFromTask(task);
    res.json({ fences, geoFences: fences });
  } catch (e) {
    console.error('GET /tasks/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* -------------------------------- PUT/IMPORT -------------------------------- */
router.put('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req.user, task)) return res.status(403).json({ error: 'Forbidden' });

    const fences = Array.isArray(req.body?.fences) ? req.body.fences : [];
    applyFencesToTask(task, fences);

    await task.save();
    res.json({ ok: true, fences: fencesFromTask(task) });
  } catch (e) {
    console.error('PUT /tasks/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.post('/:id/geofences/import', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req.user, task)) return res.status(403).json({ error: 'Forbidden' });

    const fences = Array.isArray(req.body?.fences) ? req.body.fences : [];
    applyFencesToTask(task, fences);

    await task.save();
    res.json({ ok: true, fences: fencesFromTask(task) });
  } catch (e) {
    console.error('POST /tasks/:id/geofences/import failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* ---------------------------------- CLEAR ---------------------------------- */
router.delete('/:id/geofences', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req.user, task)) return res.status(403).json({ error: 'Forbidden' });

    task.locationGeoFence = undefined;
    task.geoPolygon = undefined;
    task.geoJSON = undefined;
    task.kmlRef = undefined;
    task.geoMode = 'off';

    await task.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /tasks/:id/geofences failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.post('/:id/geofences/clear', requireAuth, async (req, res) => {
  try {
    req.method = 'DELETE';
    return router.handle(req, res);
  } catch (e) {
    console.error('POST /tasks/:id/geofences/clear failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

/* ---------------------------------- UPLOAD ---------------------------------- */
router.post('/:id/geofences/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req.user, task)) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const rel = '/files/' + path.relative(uploadsRoot, req.file.path).replace(/\\/g, '/');
    const lower = (req.file.originalname || '').toLowerCase();
    const ext = path.extname(lower);

    // keep a reference to the uploaded file (for traceability / download)
    task.kmlRef = { url: rel, name: req.file.originalname || 'fences' };

    if (ext === '.kmz') {
      if (!JSZip) {
        return res.status(501).json({
          error: "KMZ support requires the 'jszip' package on the server. Run `npm i jszip` in core-backend.",
        });
      }
      const buf = fs.readFileSync(req.file.path);
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
      if (!entry) return res.status(400).json({ error: 'KMZ contains no .kml file' });
      const kmlText = await entry.async('text');
      const rings = parseKMLStringToRings(kmlText);
      if (!rings.length) return res.status(400).json({ error: 'No polygons found in KMZ' });
      const fences = rings.map((r) => ({ type: 'polygon', polygon: r }));
      applyFencesToTask(task, fences);
      await task.save();
      return res.status(201).json({ ok: true, fences: fencesFromTask(task), kmlRef: task.kmlRef });
    }

    if (ext === '.kml') {
      const text = fs.readFileSync(req.file.path, 'utf8');
      const rings = parseKMLStringToRings(text);
      if (!rings.length) return res.status(400).json({ error: 'No polygons found in KML' });
      const fences = rings.map((r) => ({ type: 'polygon', polygon: r }));
      applyFencesToTask(task, fences);
      await task.save();
      return res.status(201).json({ ok: true, fences: fencesFromTask(task), kmlRef: task.kmlRef });
    }

    if (ext === '.geojson' || ext === '.json') {
      const text = fs.readFileSync(req.file.path, 'utf8');
      let obj;
      try { obj = JSON.parse(text); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
      const rings = parseGeoJSONToRings(obj);
      if (!rings.length) return res.status(400).json({ error: 'No polygons found in GeoJSON' });
      const fences = rings.map((r) => ({ type: 'polygon', polygon: r }));
      applyFencesToTask(task, fences);
      await task.save();
      return res.status(201).json({ ok: true, fences: fencesFromTask(task), kmlRef: task.kmlRef });
    }

    return res.status(400).json({ error: 'Unsupported file type' });
  } catch (e) {
    console.error('POST /tasks/:id/geofences/upload failed:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
