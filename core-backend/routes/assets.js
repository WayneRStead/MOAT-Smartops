// core-backend/routes/assets.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const Asset = require('../models/Asset');
const { requireAuth, resolveOrgContext, requireOrg } = require('../middleware/auth');

// Prefer User model for labels
const User = mongoose.models.User || (() => { try { return require('../models/User'); } catch { return null; } })();

const router = express.Router();

/* ------------------------------ GridFS (Assets) ------------------------------ */
/**
 * We store NEW asset attachments in GridFS bucket "assets".
 * Collections: assets.files + assets.chunks
 *
 * Files are served via:
 *   GET /assets/files/:fileId
 *   GET /api/assets/files/:fileId
 *
 * NOTE: This file route is PUBLIC (no auth), to allow <img src="..."> rendering.
 * The fileId is effectively unguessable (ObjectId) and is sufficient for now.
 */
function getBucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error('MongoDB connection not ready (mongoose.connection.db missing).');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: 'assets' });
}

function toObjectIdOrNull(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

function safeName(original) {
  return String(original || 'upload')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
}

function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function getOrgId(req) {
  return req.org?._id || req.orgObjectId || req.orgId || req.user?.orgId || undefined;
}

function buildOrgMeta(req) {
  const oid = getOrgId(req);
  return oid ? String(oid) : undefined;
}

function fileUrlFromFileId(fileId) {
  // IMPORTANT: relative URL; works with either /assets or /api/assets mounts
  return `/files/assets/${fileId}`;
}

/* ------------------------------ PUBLIC FILE SERVE ------------------------------ */
/**
 * GET /assets/files/:fileId
 * Streams from GridFS bucket "assets".
 *
 * This is intentionally BEFORE auth middleware so <img src> can load without a token.
 */
router.get('/files/:fileId', async (req, res, next) => {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: 'Invalid file id' });

    const bucket = getBucket();
    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files || !files.length) return res.status(404).json({ error: 'File not found' });

    const f = files[0];
    res.setHeader('Content-Type', f.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const dl = bucket.openDownloadStream(fileId);
    dl.on('error', (e) => next(e));
    dl.pipe(res);
  } catch (e) {
    next(e);
  }
});

// ✅ Enforce tenant context on ALL *API* routes (everything except /files/:fileId)
router.use(requireAuth, resolveOrgContext, requireOrg);

/* ------------------------------ legacy disk paths ------------------------------ */
/**
 * We keep legacy disk logic ONLY for cleaning up OLD attachments
 * that were saved to /uploads/assets before this fix.
 */
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(__dirname, '..', 'uploads');
const ASSETS_DIR = path.join(UPLOADS_DIR, 'assets');
try { fs.mkdirSync(ASSETS_DIR, { recursive: true }); } catch {}

/* ------------------------------ Multer (memory) ------------------------------ */
/**
 * NEW uploads go to memory and are written into GridFS.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (matches your previous disk limit intent)
});

/* ------------------------------ helpers ------------------------------ */
function err(res, code, msg) { return res.status(code).json({ error: msg || 'Bad request' }); }
function isId(v) { return mongoose.Types.ObjectId.isValid(String(v || '')); }
function castOptId(v) { const s = String(v || ''); return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : undefined; }
function hasPath(model, p) { return !!(model && model.schema && model.schema.path && model.schema.path(p)); }

/**
 * Build an org filter favoring the per-request org context:
 *   1) req.orgObjectId (parsed ObjectId when header is an ObjectId)
 *   2) req.orgId       (header / query / body)
 *   3) req.user.orgId  (token fallback)
 * and respecting the Asset schema type (ObjectId vs String).
 */
function buildOrgFilterFromReq(req) {
  if (!hasPath(Asset, 'orgId')) return {};
  const orgPath = Asset.schema.path('orgId');
  const wantsObjectId = orgPath?.instance === 'ObjectId' || orgPath?.instance === 'ObjectID';

  const src = req.orgObjectId || req.orgId || req.user?.orgId || null;
  if (!src) return {}; // requireOrg already enforces presence; keep safe default

  if (req.orgObjectId && wantsObjectId) return { orgId: req.orgObjectId };

  const s = String(src);
  if (wantsObjectId) {
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  return { orgId: s };
}

function canonAssetStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return undefined;
  if (['lost', 'missing', 'cannot find', 'misplaced'].includes(s)) return 'lost';
  if (['stolen', 'theft', 'theft reported', 'reported stolen'].includes(s)) return 'stolen';
  return s;
}

async function resolveUploaderLabel(req) {
  const label = (req.user && (req.user.name || req.user.email)) || '';
  if (label) return label;
  const idStr =
    (req.user?._id && String(req.user._id)) ||
    (req.user?.sub && String(req.user.sub)) ||
    (req.user?.id && String(req.user.id)) ||
    '';
  if (User && mongoose.Types.ObjectId.isValid(idStr)) {
    try {
      const u = await User.findById(idStr).select('name email').lean();
      if (u) return u.name || u.email || '';
    } catch {}
  }
  return '';
}

async function addUploaderDisplay(docs) {
  const rows = Array.isArray(docs) ? docs : [docs];
  const needLookup = new Set();
  for (const r of rows) {
    for (const a of (r?.attachments || [])) {
      if (a.uploadedByLabel) a.uploadedByDisplay = a.uploadedByLabel;
      else if (a.uploadedBy && mongoose.Types.ObjectId.isValid(String(a.uploadedBy))) needLookup.add(String(a.uploadedBy));
    }
  }
  let map = new Map();
  if (User && needLookup.size) {
    const idList = [...needLookup].map((id) => new mongoose.Types.ObjectId(id));
    try {
      const users = await User.find({ _id: { $in: idList } }).select('name email').lean();
      map = new Map(users.map((u) => [String(u._id), (u.name || u.email || u._id)]));
    } catch {}
  }
  for (const r of rows) {
    for (const a of (r?.attachments || [])) {
      if (!a.uploadedByDisplay) {
        const s = String(a.uploadedBy || '');
        a.uploadedByDisplay = a.uploadedByLabel || map.get(s) || a.uploadedBy || '';
      }
    }
  }
  return docs;
}

/* ------------------------------ GridFS save/delete ------------------------------ */
async function saveAssetFileToGridFS(req, file, { assetId } = {}) {
  if (!file) throw new Error('No file provided');

  const bucket = getBucket();
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName(file.originalname)}`;

  const uploadStream = bucket.openUploadStream(filename, {
    contentType: file.mimetype,
    metadata: stripUndef({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      orgId: buildOrgMeta(req),
      assetId: assetId ? String(assetId) : undefined,
      uploadedBy: req.user?._id ? String(req.user._id) : (req.user?.sub ? String(req.user.sub) : undefined),
    }),
  });

  uploadStream.end(file.buffer);

  const done = await new Promise((resolve, reject) => {
    uploadStream.on('finish', resolve);
    uploadStream.on('error', reject);
  });

  const fileId = String(done?._id || uploadStream.id);

  return {
    fileId,
    filename,
    size: file.size,
    mime: file.mimetype,
    url: fileUrlFromFileId(fileId),
  };
}

async function deleteGridFSFileById(fileId) {
  const oid = toObjectIdOrNull(fileId);
  if (!oid) return;
  const bucket = getBucket();
  try {
    await bucket.delete(oid);
  } catch {
    // ignore missing
  }
}

/* -------------------------------- LIST -------------------------------- */
router.get('/', async (req, res) => {
  try {
    const { q, projectId } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
    const where = { ...buildOrgFilterFromReq(req) };
    if (q) {
      const rx = new RegExp(String(q).trim(), 'i');
      where.$or = [{ name: rx }, { code: rx }, { type: rx }, { notes: rx }];
    }
    if (projectId) {
      const pid = castOptId(projectId);
      where.projectId = pid || projectId;
    }
    if (req.query.status) {
      const s = canonAssetStatus(req.query.status);
      if (s) where.status = s;
    }

    let rows = await Asset.find(where).sort({ updatedAt: -1 }).limit(limit).lean({ virtuals: true });
    rows = await addUploaderDisplay(rows);
    res.json(rows);
  } catch (e) {
    console.error('GET /assets error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ------------------------------- CREATE ------------------------------- */
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return err(res, 400, 'Name is required');

    const lat = body.lat != null ? Number(body.lat) : undefined;
    const lng = body.lng != null ? Number(body.lng) : undefined;

    const doc = new Asset({
      name: String(body.name).trim(),
      code: body.code || undefined,
      type: body.type || undefined,
      status: canonAssetStatus(body.status) || 'active',
      projectId: castOptId(body.projectId) || body.projectId || undefined,
      notes: body.notes || '',
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
    });

    // 🔑 ensure orgId is set from the *request* org first (header), then token
    if (hasPath(Asset, 'orgId')) {
      const orgPath = Asset.schema.path('orgId');
      const wantsObjectId = orgPath?.instance === 'ObjectId' || orgPath?.instance === 'ObjectID';
      const src = req.orgObjectId || req.orgId || req.user?.orgId || null;
      if (src) {
        if (req.orgObjectId && wantsObjectId) {
          doc.orgId = req.orgObjectId;
        } else {
          const s = String(src);
          doc.orgId = wantsObjectId && mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : s;
        }
      }
    }

    if ('createdBy' in doc) doc.createdBy = req.user?.sub || req.user?.email || String(req.user?._id || '');
    if ('createdByUserId' in doc && req.user?._id) doc.createdByUserId = castOptId(req.user._id) || req.user._id;

    await doc.save();
    res.status(201).json(doc);
  } catch (e) {
    console.error('POST /assets error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* -------------------------------- READ -------------------------------- */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    let asset = await Asset.findOne(where).lean();
    if (!asset) return err(res, 404, 'Not found');
    asset = await addUploaderDisplay(asset);
    res.json(asset);
  } catch (e) {
    console.error('GET /assets/:id error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ------------------------------- UPDATE ------------------------------- */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const body = req.body || {};
    if (body.projectId === '') body.projectId = null;

    const update = {
      name: body.name,
      code: body.code,
      type: body.type,
      status: body.status !== undefined ? canonAssetStatus(body.status) : undefined,
      projectId: castOptId(body.projectId) ?? body.projectId,
      notes: body.notes,
      lat: body.lat != null ? Number(body.lat) : undefined,
      lng: body.lng != null ? Number(body.lng) : undefined,
      location: body.location,
      geometry: body.geometry,
    };
    Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    let doc = await Asset.findOneAndUpdate(where, { $set: update }, { new: true, runValidators: true }).lean();
    if (!doc) return err(res, 404, 'Not found');
    doc = await addUploaderDisplay(doc);
    res.json(doc);
  } catch (e) {
    console.error('PUT /assets/:id error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ------------------------------- DELETE ------------------------------- */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    // Delete attachments:
    // - NEW: GridFS (by fileId)
    // - OLD: disk /files/assets/<filename>
    for (const att of (doc.attachments || [])) {
      if (att?.fileId) {
        await deleteGridFSFileById(att.fileId);
        continue;
      }
      const rel = String(att.url || '').replace(/^\/files\//, '');
      if (!rel) continue;
      const p = path.join(UPLOADS_DIR, rel);
      try { fs.unlinkSync(p); } catch {}
    }

    await doc.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /assets/:id error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ------------------------ Maintenance entries ------------------------- */
router.post('/:id/maintenance', async (req, res) => {
  try {
    if (!hasPath(Asset, 'maintenance')) return err(res, 400, 'Maintenance not supported on Asset model');
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const { date, note, lat, lng, acc, scanned } = req.body || {};

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const who = (req.user?.name || req.user?.email || req.user?.sub || req.user?._id || '').toString();

    doc.maintenance = doc.maintenance || [];
    doc.maintenance.push({
      date: date ? new Date(date) : new Date(),
      note: note || '',
      by: who,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : undefined,
      lng: Number.isFinite(Number(lng)) ? Number(lng) : undefined,
      acc: Number.isFinite(Number(acc)) ? Number(acc) : undefined,
      scanned: !!scanned,
    });
    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error('POST /assets/:id/maintenance error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.delete('/:id/maintenance/:mid', async (req, res) => {
  try {
    if (!hasPath(Asset, 'maintenance')) return err(res, 400, 'Maintenance not supported on Asset model');
    const { id, mid } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    doc.maintenance = (doc.maintenance || []).filter((m) => String(m._id) !== String(mid));
    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error('DELETE /assets/:id/maintenance/:mid error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ---------------------------- Attachments ----------------------------- */
/**
 * POST /assets/:id/attachments
 * NEW behavior: saves file to GridFS bucket "assets" and stores {fileId,url,...} on the Asset doc.
 */
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    if (!req.file) return err(res, 400, 'No file provided');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const meta = await saveAssetFileToGridFS(req, req.file, { assetId: id });

    const uploadedById =
      (req.user?._id && String(req.user._id)) ||
      (req.user?.sub && String(req.user.sub)) ||
      (req.user?.id && String(req.user.id)) ||
      (req.user?.email && String(req.user.email)) ||
      '';

    let uploadedByLabel = (req.user && (req.user.name || req.user.email)) || '';
    if (!uploadedByLabel) uploadedByLabel = await resolveUploaderLabel(req);

    // Optional geotags & scanned flag
    const lat = Number.isFinite(Number(req.body?.lat)) ? Number(req.body.lat) : undefined;
    const lng = Number.isFinite(Number(req.body?.lng)) ? Number(req.body.lng) : undefined;
    const acc = Number.isFinite(Number(req.body?.acc)) ? Number(req.body.acc) : undefined;
    const scanned = ['1', 'true', 'yes', 'on'].includes(String(req.body?.scanned || '').toLowerCase());

    doc.attachments = doc.attachments || [];
    doc.attachments.push({
      fileId: meta.fileId,          // ✅ NEW
      url: meta.url,                // ✅ NEW (e.g. /assets/files/<fileId>)
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: uploadedById,
      uploadedByLabel,
      note: req.body?.note || '',
      lat, lng, acc, scanned,
    });

    await doc.save();

    const out = doc.toObject ? doc.toObject() : doc;
    await addUploaderDisplay(out);
    res.json(out);
  } catch (e) {
    console.error('POST /assets/:id/attachments error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.delete('/:id/attachments/:attId', async (req, res) => {
  try {
    const { id, attId } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const att = (doc.attachments || []).find((a) => String(a._id) === String(attId));
    if (!att) return err(res, 404, 'Attachment not found');

    // NEW: GridFS deletion
    if (att.fileId) {
      await deleteGridFSFileById(att.fileId);
    } else {
      // OLD: disk deletion
      const rel = String(att.url || '').replace(/^\/files\//, '');
      if (rel) {
        const p = path.join(UPLOADS_DIR, rel);
        try { fs.unlinkSync(p); } catch {}
      }
    }

    doc.attachments = (doc.attachments || []).filter((a) => String(a._id) !== String(attId));
    await doc.save();

    const out = doc.toObject ? doc.toObject() : doc;
    await addUploaderDisplay(out);
    res.json(out);
  } catch (e) {
    console.error('DELETE /assets/:id/attachments/:attId error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ----------------------------- KMZ Export ----------------------------- */
// GET /assets/:id/export-kmz  -> downloads a KMZ with doc.kml
router.get('/:id/export-kmz', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where).lean();
    if (!doc) return err(res, 404, 'Not found');

    // build KML
    const esc = (s = '') => String(s).replace(/[<&>]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));
    const rows = [];
    const assetName = doc.name || doc.code || `Asset ${doc._id}`;

    // Maintenance
    for (const m of (doc.maintenance || [])) {
      if (m && m.lat != null && m.lng != null) {
        const title = `${assetName} — Log`;
        const who = m.by || '';
        const when = m.date ? new Date(m.date).toISOString() : (m.createdAt ? new Date(m.createdAt).toISOString() : '');
        const desc = [
          `<b>Asset:</b> ${esc(assetName)}`,
          `<b>Type:</b> Log`,
          m.note ? `<b>Note:</b> ${esc(m.note)}` : '',
          who ? `<b>By:</b> ${esc(who)}` : '',
          when ? `<b>When:</b> ${esc(when)}` : '',
          m.scanned ? `<b>Scanned:</b> yes` : '',
          m.acc != null ? `<b>Accuracy:</b> ${m.acc} m` : '',
        ].filter(Boolean).join('<br/>');

        rows.push(`
          <Placemark>
            <name>${esc(title)}</name>
            <description><![CDATA[${desc}]]></description>
            <Point><coordinates>${m.lng},${m.lat},0</coordinates></Point>
          </Placemark>`);
      }
    }

    // Attachments
    for (const a of (doc.attachments || [])) {
      if (a && a.lat != null && a.lng != null) {
        const title = `${assetName} — Attachment`;
        const who = a.uploadedByLabel || a.uploadedByDisplay || a.uploadedBy || '';
        const when = a.uploadedAt ? new Date(a.uploadedAt).toISOString() : '';
        const desc = [
          `<b>Asset:</b> ${esc(assetName)}`,
          `<b>Type:</b> Attachment`,
          a.filename ? `<b>File:</b> ${esc(a.filename)}` : '',
          a.note ? `<b>Note:</b> ${esc(a.note)}` : '',
          who ? `<b>By:</b> ${esc(who)}` : '',
          when ? `<b>When:</b> ${esc(when)}` : '',
          a.scanned ? `<b>Scanned:</b> yes` : '',
          a.acc != null ? `<b>Accuracy:</b> ${a.acc} m` : '',
          a.url ? `<b>URL:</b> ${esc(a.url)}` : '',
        ].filter(Boolean).join('<br/>');

        rows.push(`
          <Placemark>
            <name>${esc(title)}</name>
            <description><![CDATA[${desc}]]></description>
            <Point><coordinates>${a.lng},${a.lat},0</coordinates></Point>
          </Placemark>`);
      }
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(assetName)} — Geo Activity</name>
    ${rows.join('\n')}
  </Document>
</kml>`;

    // zip as KMZ (doc.kml)
    let archiver;
    try { archiver = require('archiver'); } catch {
      return err(res, 500, 'KMZ export requires "archiver". Install with: npm i archiver');
    }
    res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
    const outName = `${(assetName || 'asset').toString().replace(/[^\w.-]+/g, '_')}_geo.kmz`;
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', (_e) => { try { res.end(); } catch {} });
    archive.pipe(res);
    archive.append(kml, { name: 'doc.kml' });
    await archive.finalize();
  } catch (e) {
    console.error('GET /assets/:id/export-kmz error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;
