// core-backend/routes/assets.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const Asset = require('../models/Asset');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(__dirname, '..', 'uploads');
const ASSETS_DIR  = path.join(UPLOADS_DIR, 'assets');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASSETS_DIR),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || 'upload')
      .replace(/[^\w.-]+/g, '_')
      .replace(/_+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// ---- helpers ----
function err(res, code, msg) {
  return res.status(code).json({ error: msg || 'Bad request' });
}
function isId(v) {
  return mongoose.Types.ObjectId.isValid(String(v || ''));
}

// ---- list assets ----
router.get('/', async (req, res) => {
  try {
    const { q, projectId, status, limit = 500 } = req.query;
    const where = {};
    if (q) {
      const rx = new RegExp(String(q).trim(), 'i');
      where.$or = [{ name: rx }, { code: rx }, { type: rx }];
    }
    if (projectId) where.projectId = projectId;
    if (status) where.status = status;

    const rows = await Asset.find(where)
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(limit) || 500, 2000))
      .lean({ virtuals: true });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- create asset ----
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return err(res, 400, 'Name is required');
    }

    // accept lat/lng directly (like Clockings)
    const lat = body.lat != null ? Number(body.lat) : undefined;
    const lng = body.lng != null ? Number(body.lng) : undefined;

    const asset = new Asset({
      name: String(body.name).trim(),
      code: body.code || undefined,
      type: body.type || undefined,
      status: body.status || 'active',
      projectId: body.projectId || undefined,
      notes: body.notes || '',
      lat, lng
    });

    await asset.save();
    res.json(asset);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- read asset ----
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const asset = await Asset.findById(id);
    if (!asset) return err(res, 404, 'Not found');
    res.json(asset);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- update asset (accepts lat/lng) ----
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');

    const body = req.body || {};
    // normalize projectId empty string -> null
    if (body.projectId === '') body.projectId = null;

    const update = {
      name:      body.name,
      code:      body.code,
      type:      body.type,
      status:    body.status,
      projectId: body.projectId,
      notes:     body.notes,
      lat:       body.lat,
      lng:       body.lng,
      location:  body.location,
      geometry:  body.geometry,
    };

    // strip undefineds so we don't overwrite unintentionally
    Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

    const doc = await Asset.findOneAndUpdate(
      { _id: id },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!doc) return err(res, 404, 'Not found');
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- delete asset ----
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const doc = await Asset.findById(id);
    if (!doc) return err(res, 404, 'Not found');

    // best-effort: remove files
    for (const att of (doc.attachments || [])) {
      const rel = String(att.url || '').replace(/^\/files\//, '');
      if (!rel) continue;
      const p = path.join(UPLOADS_DIR, rel);
      try { fs.unlinkSync(p); } catch {}
    }
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- maintenance add ----
router.post('/:id/maintenance', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const { date, note } = req.body || {};
    const doc = await Asset.findById(id);
    if (!doc) return err(res, 404, 'Not found');

    doc.maintenance.push({
      date: date ? new Date(date) : undefined,
      note: note || ''
    });
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- maintenance delete ----
router.delete('/:id/maintenance/:mid', async (req, res) => {
  try {
    const { id, mid } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const doc = await Asset.findById(id);
    if (!doc) return err(res, 404, 'Not found');
    doc.maintenance = (doc.maintenance || []).filter(m => String(m._id) !== String(mid));
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* -------------------- Attachments (like Tasks) -------------------- */

// upload photo
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    if (!req.file) return err(res, 400, 'No file provided');

    const doc = await Asset.findById(id);
    if (!doc) return err(res, 404, 'Not found');

    const relPath = path.join('assets', req.file.filename).replace(/\\/g, '/'); // windows-safe
    const url = `/files/${relPath}`;

    doc.attachments = doc.attachments || [];
    doc.attachments.push({
      url,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user?.sub || req.user?.email || undefined,
      note: req.body?.note || ''
    });

    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// delete photo
router.delete('/:id/attachments/:attId', async (req, res) => {
  try {
    const { id, attId } = req.params;
    if (!isId(id)) return err(res, 400, 'Invalid id');
    const doc = await Asset.findById(id);
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
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;
