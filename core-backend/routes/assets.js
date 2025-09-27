// core-backend/routes/assets.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const Asset = require('../models/Asset');
const { requireAuth } = require('../middleware/auth');

// Prefer already-compiled User model; require if needed (for label fallback)
const User = mongoose.models.User || (() => { try { return require('../models/User'); } catch { return null; } })();

const router = express.Router();

// Require auth for everything in this router
router.use(requireAuth);

/* ------------------------------ uploads ------------------------------ */

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(__dirname, '..', 'uploads');
const ASSETS_DIR  = path.join(UPLOADS_DIR, 'assets');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

function safeName(original) {
  return String(original || 'upload')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASSETS_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeName(file.originalname)}`)
});
const upload = multer({ storage });

/* ------------------------------ helpers ------------------------------ */

function err(res, code, msg) {
  return res.status(code).json({ error: msg || 'Bad request' });
}
function isId(v) {
  return mongoose.Types.ObjectId.isValid(String(v || ''));
}
function castOptId(v) {
  const s = String(v || '');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : undefined;
}
function hasPath(model, p) {
  return !!(model && model.schema && model.schema.path && model.schema.path(p));
}
// org scoping that tolerates orgId as ObjectId OR String (and skips if token has "root")
function buildOrgFilterFromReq(req) {
  if (!hasPath(Asset, 'orgId')) return {}; // schema may not have orgId; skip scoping
  const raw = req.user?.orgId;
  if (!raw) return {};

  const orgPath = Asset.schema.path('orgId');
  const wantsObjectId = orgPath?.instance === 'ObjectId';
  const s = String(raw);

  if (wantsObjectId) {
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  // String orgId field
  return { orgId: s };
}

// resolve friendly uploader label (name/email) from req / DB
async function resolveUploaderLabel(req) {
  const label =
    (req.user && (req.user.name || req.user.email)) ||
    '';

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
    } catch { /* ignore */ }
  }
  return ''; // fallback (UI will see id)
}

// add uploadedByDisplay for responses (prefers label; falls back to lookup, then id)
async function addUploaderDisplay(docs) {
  const rows = Array.isArray(docs) ? docs : [docs];
  const needLookup = new Set();

  for (const r of rows) {
    const atts = r?.attachments || [];
    for (const a of atts) {
      if (a.uploadedByLabel) {
        a.uploadedByDisplay = a.uploadedByLabel;
      } else if (a.uploadedBy && mongoose.Types.ObjectId.isValid(String(a.uploadedBy))) {
        needLookup.add(String(a.uploadedBy));
      }
    }
  }

  let map = new Map();
  if (User && needLookup.size) {
    const idList = [...needLookup].map(id => new mongoose.Types.ObjectId(id));
    try {
      const users = await User.find({ _id: { $in: idList } }).select('name email').lean();
      map = new Map(users.map(u => [String(u._id), (u.name || u.email || u._id)]));
    } catch { /* ignore */ }
  }

  for (const r of rows) {
    const atts = r?.attachments || [];
    for (const a of atts) {
      if (!a.uploadedByDisplay) {
        const s = String(a.uploadedBy || '');
        a.uploadedByDisplay = a.uploadedByLabel || map.get(s) || a.uploadedBy || '';
      }
    }
  }
  return docs;
}

/* -------------------------------- LIST -------------------------------- */
/**
 * GET /assets
 * Query: q, projectId, status, limit
 * Org-scoped if Asset has orgId in schema
 */
router.get('/', async (req, res) => {
  try {
    const { q, projectId, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);

    const where = { ...buildOrgFilterFromReq(req) };

    if (q) {
      const rx = new RegExp(String(q).trim(), 'i');
      where.$or = [{ name: rx }, { code: rx }, { type: rx }, { notes: rx }];
    }
    if (projectId) {
      const pid = castOptId(projectId);
      if (pid) where.projectId = pid;
      else where.projectId = projectId; // fall back if schema uses string
    }
    if (status) where.status = status;

    let rows = await Asset.find(where)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean({ virtuals: true });

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
    if (!body.name || !String(body.name).trim()) {
      return err(res, 400, 'Name is required');
    }

    const lat = body.lat != null ? Number(body.lat) : undefined;
    const lng = body.lng != null ? Number(body.lng) : undefined;

    const doc = new Asset({
      name: String(body.name).trim(),
      code: body.code || undefined,
      type: body.type || undefined,
      status: body.status || 'active',
      projectId: castOptId(body.projectId) || body.projectId || undefined,
      notes: body.notes || '',
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
    });

    // Attach orgId if schema has it
    if (hasPath(Asset, 'orgId')) {
      const orgPath = Asset.schema.path('orgId');
      const wantsObjectId = orgPath?.instance === 'ObjectId';
      const raw = req.user?.orgId;
      if (raw) {
        const s = String(raw);
        doc.orgId = wantsObjectId && mongoose.Types.ObjectId.isValid(s)
          ? new mongoose.Types.ObjectId(s)
          : s;
      }
    }

    // Record creator if your schema has such field(s)
    if ('createdBy' in doc) {
      doc.createdBy = req.user?.sub || req.user?.email || String(req.user?._id || '');
    }
    if ('createdByUserId' in doc && req.user?._id) {
      doc.createdByUserId = castOptId(req.user._id) || req.user._id;
    }

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
      status:    body.status,
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

    // Best-effort: remove files referenced by attachments
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
    const { date, note } = req.body || {};

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    doc.maintenance = doc.maintenance || [];
    doc.maintenance.push({ date: date ? new Date(date) : undefined, note: note || '' });
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

// upload photo (WRITE-TIME IMPROVEMENT: store uploadedByLabel)
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    if (!req.file) return err(res, 400, 'No file provided');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const relPath = path.join('assets', req.file.filename).replace(/\\/g, '/'); // windows-safe
    const url = `/files/${relPath}`;

    // Determine id + label
    const uploadedById =
      (req.user?._id && String(req.user._id)) ||
      (req.user?.sub && String(req.user.sub)) ||
      (req.user?.id && String(req.user.id)) ||
      (req.user?.email && String(req.user.email)) ||
      '';

    let uploadedByLabel =
      (req.user && (req.user.name || req.user.email)) ||
      '';

    if (!uploadedByLabel) {
      uploadedByLabel = await resolveUploaderLabel(req);
    }

    doc.attachments = doc.attachments || [];
    doc.attachments.push({
      url,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: uploadedById,       // keep id/identifier
      uploadedByLabel,                // <-- friendly name/email for display
      note: req.body?.note || ''
    });

    await doc.save();

    // Add display on the way out
    const out = doc.toObject ? doc.toObject() : doc;
    await addUploaderDisplay(out);
    res.json(out);
  } catch (e) {
    console.error('POST /assets/:id/attachments error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// delete photo
router.delete('/:id/attachments/:attId', async (req, res) => {
  try {
    const { id, attId } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const where = { _id: id, ...buildOrgFilterFromReq(req) };
    const doc = await Asset.findOne(where);
    if (!doc) return err(res, 404, 'Not found');

    const att = (doc.attachments || []).find(a => String(a._id) === String(attId));
    if (!att) return err(res, 404, 'Attachment not found');

    // remove file
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

module.exports = router;
