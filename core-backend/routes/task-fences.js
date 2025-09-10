// core-backend/routes/task-fences.js
// Minimal task-level geofence endpoints (file-based store).
// Supports .geojson / .json / .kml / .kmz
//
// npm i multer @tmcw/togeojson xmldom jszip

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const { DOMParser } = require('xmldom');
const tj = require('@tmcw/togeojson');
const JSZip = require('jszip');

const router = express.Router();

// Where we store task fences on disk
const fencesDir = path.join(__dirname, '..', 'uploads', 'task-fences');
fs.mkdirSync(fencesDir, { recursive: true });

function fileForTask(taskId) {
  return path.join(fencesDir, `${String(taskId)}.json`);
}

// ---------- Helpers: parse & normalize ----------

async function geojsonFromBuffer(filename, buffer) {
  const ext = String(path.extname(filename || '')).toLowerCase();

  if (ext === '.geojson' || ext === '.json') {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw Object.assign(new Error('Invalid GeoJSON'), { status: 400 });
    }
  }

  if (ext === '.kml') {
    const xml = buffer.toString('utf8');
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    return tj.kml(dom);
  }

  if (ext === '.kmz') {
    const zip = await JSZip.loadAsync(buffer);
    // find first .kml entry
    const kmlEntry = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml'));
    if (!kmlEntry) throw Object.assign(new Error('KMZ missing .kml'), { status: 400 });
    const kmlText = await kmlEntry.async('text');
    const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
    return tj.kml(dom);
  }

  throw Object.assign(new Error('Unsupported file type. Use .geojson, .kml, or .kmz'), { status: 415 });
}

// Normalize a [lng,lat] coord or {lat,lng} to [lat,lng]
function toLatLngPair(pt) {
  const num = (x) => Number.isFinite(typeof x === 'string' ? Number(x) : x);
  if (Array.isArray(pt) && pt.length >= 2) {
    const lng = Number(pt[0]); const lat = Number(pt[1]);
    if (num(lat) && num(lng)) return [lat, lng];
  } else if (pt && typeof pt === 'object') {
    const lat = Number(pt.lat); const lng = Number(pt.lng);
    if (num(lat) && num(lng)) return [lat, lng];
  }
  return null;
}

function normalizeFromGeoJSON(geojson, pointRadiusMeters) {
  const out = [];
  if (!geojson) return out;

  const pushPolygon = (ring) => {
    // ring should be array of [lat,lng]
    if (Array.isArray(ring) && ring.length >= 3) {
      out.push({ type: 'polygon', polygon: ring.map(([lat, lng]) => [lng, lat]) }); // store as [lng,lat]
    }
  };

  const ensureRingLatLng = (ring) =>
    (Array.isArray(ring) ? ring.map(([lng, lat]) => [lat, lng]).filter(x => x && Number.isFinite(x[0]) && Number.isFinite(x[1])) : null);

  const handleFeature = (feat) => {
    if (!feat || !feat.geometry) return;
    const g = feat.geometry;
    switch ((g.type || '').toLowerCase()) {
      case 'point': {
        const [lng, lat] = g.coordinates || [];
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const radius = Number(pointRadiusMeters) || 50;
          out.push({
            type: 'circle',
            center: { lat, lng },
            radius
          });
        }
        break;
      }
      case 'multipolygon': {
        // take outer rings of each polygon
        for (const poly of g.coordinates || []) {
          const outer = poly && poly[0];
          if (outer) {
            const ring = ensureRingLatLng(outer);
            if (ring && ring.length >= 3) pushPolygon(ring);
          }
        }
        break;
      }
      case 'polygon': {
        const outer = (g.coordinates || [])[0];
        const ring = ensureRingLatLng(outer);
        if (ring && ring.length >= 3) pushPolygon(ring);
        break;
      }
      case 'linestring':
      case 'multilinestring': {
        // treat as a buffered path? For now, skip (or could convert to polygon later)
        break;
      }
      default:
        break;
    }
  };

  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features || []) handleFeature(f);
  } else if (geojson.type === 'Feature') {
    handleFeature(geojson);
  } else if (geojson.type) {
    // Bare geometry
    handleFeature({ geometry: geojson });
  }
  return out;
}

// ---------- Routes ----------

// GET task-level fences (exactly what's saved for this task)
router.get('/:taskId/geofences', (req, res) => {
  const file = fileForTask(req.params.taskId);
  if (!fs.existsSync(file)) return res.json({ geoFences: [] });
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(json?.geoFences) ? json.geoFences : (Array.isArray(json) ? json : []);
    return res.json({ geoFences: arr });
  } catch (e) {
    console.error('Read task fences failed:', e);
    return res.status(500).json({ error: 'Failed to read task fences' });
  }
});

// PUT replace task-level fences (accepts { geoFences: [...] })
router.put('/:taskId/geofences', (req, res) => {
  const file = fileForTask(req.params.taskId);
  try {
    const arr = Array.isArray(req.body?.geoFences) ? req.body.geoFences : [];
    fs.writeFileSync(file, JSON.stringify({ geoFences: arr }, null, 2));
    return res.json({ ok: true, geoFences: arr });
  } catch (e) {
    console.error('Write task fences failed:', e);
    return res.status(500).json({ error: 'Failed to save task fences' });
  }
});

// DELETE clear task-level fences
router.delete('/:taskId/geofences', (req, res) => {
  const file = fileForTask(req.params.taskId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return res.json({ ok: true });
  } catch (e) {
    console.error('Delete task fences failed:', e);
    return res.status(500).json({ error: 'Failed to delete task fences' });
  }
});

// POST upload file -> parse -> normalize -> save as task fences
router.post('/:taskId/geofences/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const radius = Number(req.query.radius) || 50;

    const gj = await geojsonFromBuffer(req.file.originalname, req.file.buffer);
    const normalized = normalizeFromGeoJSON(gj, radius);

    // Save to disk
    const file = fileForTask(req.params.taskId);
    fs.writeFileSync(file, JSON.stringify({ geoFences: normalized }, null, 2));

    return res.json({ ok: true, geoFences: normalized });
  } catch (e) {
    console.error('Upload/parse task fences failed:', e);
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || 'Failed to process geofence file' });
  }
});

module.exports = router;
