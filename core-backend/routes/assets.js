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
// ✅ Enforce tenant context on ALL routes
router.use(requireAuth, resolveOrgContext, requireOrg);

/* ------------------------------ uploads ------------------------------ */
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(__dirname, '..', 'uploads');
const ASSETS_DIR  = path.join(UPLOADS_DIR, 'assets');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

function safeName(original) {
  return String(original || 'upload').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 180);
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASSETS_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeName(file.originalname)}`)
});
const upload = multer({ storage });

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
  const wantsObjectId = orgPath?.instance === 'ObjectId';

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
  const idStr = (req.user?._id && String(req.user._id)) || (req.user?.sub && String(req.user.sub)) || (req.user?.id && String(req.user.id)) || '';
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
    const idList = [...needLookup].map(id => new mongoose.Types.ObjectId(id));
    try {
      const users = await User.find({ _id: { $in: idList } }).select('name email').lean();
      map = new Map(users.map(u => [String(u._id), (u.name || u.email || u._id)]));
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
      const wantsObjectId = orgPath?.instance === 'ObjectId';
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
    asset = (await addUploaderDisplay(asset));
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
      name:      body.name,
      code:      body.code,
      type:      body.type,
      status:    body.status !== undefined ? canonAssetStatus(body.status) : undefined,
      projectId: castOptId(body.projectId) ?? body.projectId,
      notes:     body.notes,
      lat:       body.lat != null ? Number(body.lat) : undefined,
      lng:       body.lng != null ? Number(body.lng) : undefined,
      location:  body.location,
      geometry:  body.geometry,
    };
    Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    let doc = await Asset.findOneAndUpdate(where, { $set: update }, { new: true, runValidators: true }).lean();
    if (!doc) return err(res, 404, 'Not found');
    doc = (await addUploaderDisplay(doc));
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

    for (const att of (doc.attachments || [])) {
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
      date: date ? new Date(date) : new Date(),           // auto-gather if not provided
      note: note || '',
      by:   who,
      lat:  Number.isFinite(Number(lat)) ? Number(lat) : undefined,
      lng:  Number.isFinite(Number(lng)) ? Number(lng) : undefined,
      acc:  Number.isFinite(Number(acc)) ? Number(acc) : undefined,
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

    doc.maintenance = (doc.maintenance || []).filter(m => String(m._id) !== String(mid));
    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error('DELETE /assets/:id/maintenance/:mid error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ---------------------------- Attachments ----------------------------- */
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    if (!req.file) return err(res, 400, 'No file provided');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const relPath = path.join('assets', req.file.filename).replace(/\\/g, '/');
    const url = `/files/${relPath}`;

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
    const scanned = ['1','true','yes','on'].includes(String(req.body?.scanned || '').toLowerCase());

    doc.attachments = doc.attachments || [];
    doc.attachments.push({
      url,
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

    const att = (doc.attachments || []).find(a => String(a._id) === String(attId));
    if (!att) return err(res, 404, 'Attachment not found');

    const rel = String(att.url || '').replace(/^\/files\//, '');
    if (rel) {
      const p = path.join(UPLOADS_DIR, rel);
      try { fs.unlinkSync(p); } catch {}
    }

    doc.attachments = (doc.attachments || []).filter(a => String(a._id) !== String(attId));
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
    const esc = (s='') => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
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
          m.acc != null ? `<b>Accuracy:</b> ${m.acc} m` : ''
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
          a.url ? `<b>URL:</b> ${esc(a.url)}` : ''
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
    const outName = `${(assetName || 'asset').toString().replace(/[^\w.-]+/g,'_')}_geo.kmz`;
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);

    const archive = archiver('zip', { zlib: { level: 0 } }); // store-only is fine for KMZ
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
