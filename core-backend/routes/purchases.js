// core-backend/routes/purchases.js
const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');

const Purchase = mongoose.models.Purchase || require('../models/Purchase');
const Vehicle  = mongoose.models.Vehicle  || require('../models/Vehicle');

const router = express.Router();

/* ------------------------------- helpers ------------------------------- */
function isAdmin(req) {
  const r = String(req.user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}
function buildOrgFilter(model, orgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return {};
  const s = String(orgId || '');
  return s ? { orgId: s } : {};
}
function isValidId(v) { return !!v && mongoose.Types.ObjectId.isValid(String(v)); }
const asId = (v) => new mongoose.Types.ObjectId(String(v));

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

/* ------------------------------- uploads ------------------------------- */
// Base: /uploads/purchases/<vehicleId>/...
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'purchases');
ensureDir(UPLOAD_ROOT);

// Multer storage that nests by vehicleId
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const vehicleId = String(req.params?.vehicleId || '').trim();
    const dest = vehicleId && isValidId(vehicleId)
      ? path.join(UPLOAD_ROOT, vehicleId)
      : UPLOAD_ROOT;
    ensureDir(dest);
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = String(file.originalname || 'receipt').replace(/[^\w.-]+/g, '_');
    cb(null, `${ts}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\//i.test(file.mimetype)) return cb(new Error('Only image uploads are allowed.'));
    cb(null, true);
  },
});

// Build a public file URL under /files (assuming app.use('/files', express.static(...)))
function buildFileUrl(vehicleId, filename) {
  const base = `/files/purchases/${vehicleId}`;
  return `${base}/${filename}`;
}

/* ------------------------------- list ---------------------------------- */
// GET /purchases?vehicleId=&projectId=&taskId=&vendorId=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&limit=500
router.get('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, projectId, taskId, vendorId, dateFrom, dateTo, limit } = req.query;
    const find = { ...buildOrgFilter(Purchase, req.user?.orgId) };

    if (isValidId(vehicleId)) find.vehicleId = asId(vehicleId);
    if (isValidId(projectId)) find.projectId = asId(projectId);
    if (isValidId(taskId))    find.taskId    = asId(taskId);
    if (isValidId(vendorId))  find.vendorId  = asId(vendorId);

    if (dateFrom || dateTo) {
      find.date = {};
      if (dateFrom) find.date.$gte = new Date(dateFrom);
      if (dateTo)   find.date.$lte = new Date(dateTo);
    }

    // Non-admins: reuse vehicle visibility (driver scope)
    if (!isAdmin(req) && isValidId(vehicleId)) {
      const veh = await Vehicle.findById(vehicleId).lean();
      if (!veh) return res.json([]); // no access/no vehicle
    }

    const lim = Math.min(parseInt(limit || '500', 10) || 500, 1000);
    const rows = await Purchase.find(find)
      .sort({ date: -1, createdAt: -1 })
      .limit(lim)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    res.json(rows.map(r => {
      const vendor = r.vendorId ? { _id: String(r.vendorId._id), name: r.vendorId.name } : undefined;
      const vendorIdStr = r.vendorId ? String(r.vendorId._id) : undefined;
      const projIdStr = r.projectId ? String(r.projectId._id) : r.projectId;
      const taskIdStr = r.taskId ? String(r.taskId._id) : r.taskId;

      // prefer structured receiptPhoto, fall back to docUrls[0]
      const receiptUrl = r?.receiptPhoto?.url || (Array.isArray(r.docUrls) && r.docUrls[0]) || undefined;
      return {
        ...r,
        vendor,
        vendorId: vendorIdStr,
        projectId: projIdStr,
        taskId: taskIdStr,
        receiptPhoto: r.receiptPhoto ? { url: r.receiptPhoto.url } : (receiptUrl ? { url: receiptUrl } : undefined),
        // convenience for UI table & legacy:
        receiptUrl,
      };
    }));
  } catch (e) {
    console.error('GET /purchases error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- create -------------------------------- */
// POST /purchases
router.post('/', requireAuth, async (req, res) => {
  try {
    // Support both `receiptPhotoUrl` and legacy `receiptUrl`
    const {
      vehicleId, vendorId, projectId, taskId,
      date, cost, type, notes, docUrls,
      receiptPhotoUrl, receiptUrl
    } = req.body || {};

    if (!isValidId(vehicleId)) return res.status(400).json({ error: 'vehicleId required' });
    if (!date) return res.status(400).json({ error: 'date required' });

    const chosenReceiptUrl = (receiptPhotoUrl || receiptUrl || '').trim() || undefined;

    // Start with provided docUrls; mirror receipt into docUrls[0] for backward compatibility
    let docUrlArr = Array.isArray(docUrls) ? [...docUrls] : [];
    if (chosenReceiptUrl) {
      if (!docUrlArr.includes(chosenReceiptUrl)) {
        docUrlArr = [chosenReceiptUrl, ...docUrlArr];
      }
    }

    const doc = new Purchase({
      vehicleId: asId(vehicleId),
      vendorId: isValidId(vendorId) ? asId(vendorId) : undefined,
      projectId: isValidId(projectId) ? asId(projectId) : undefined,
      taskId: isValidId(taskId) ? asId(taskId) : undefined,
      date: new Date(date),
      cost: cost != null ? Number(cost) : 0,
      type: (type || 'other').toLowerCase(),
      notes: notes || '',
      docUrls: docUrlArr,
      // new structured field used by UI
      receiptPhoto: chosenReceiptUrl ? { url: chosenReceiptUrl } : undefined,
      orgId: String(req.user?.orgId || 'root'),
    });

    await doc.save();
    const ret = await Purchase.findById(doc._id)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    const vendor = ret.vendorId ? { _id: String(ret.vendorId._id), name: ret.vendorId.name } : undefined;
    const vendorIdStr = ret.vendorId ? String(ret.vendorId._id) : undefined;
    const projIdStr = ret.projectId ? String(ret.projectId._id) : ret.projectId;
    const taskIdStr = ret.taskId ? String(ret.taskId._id) : ret.taskId;
    const finalReceiptUrl = ret?.receiptPhoto?.url || (Array.isArray(ret.docUrls) && ret.docUrls[0]) || undefined;

    res.status(201).json({
      ...ret,
      vendor,
      vendorId: vendorIdStr,
      projectId: projIdStr,
      taskId: taskIdStr,
      receiptPhoto: ret.receiptPhoto ? { url: ret.receiptPhoto.url } : (finalReceiptUrl ? { url: finalReceiptUrl } : undefined),
      receiptUrl: finalReceiptUrl,
    });
  } catch (e) {
    console.error('POST /purchases error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- update -------------------------------- */
// PUT /purchases/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const p = await Purchase.findOne({ _id: req.params.id, ...buildOrgFilter(Purchase, req.user?.orgId) });
    if (!p) return res.status(404).json({ error: 'Not found' });

    // Accept both names
    const {
      vendorId, projectId, taskId, date, cost, type, notes, docUrls,
      receiptPhotoUrl, receiptUrl
    } = req.body || {};
    const chosenReceiptUrl = (receiptPhotoUrl || receiptUrl || '').trim();

    if (vendorId !== undefined) p.vendorId = isValidId(vendorId) ? new mongoose.Types.ObjectId(vendorId) : undefined;
    if (projectId !== undefined) p.projectId = isValidId(projectId) ? new mongoose.Types.ObjectId(projectId) : undefined;
    if (taskId !== undefined) p.taskId = isValidId(taskId) ? new mongoose.Types.ObjectId(taskId) : undefined;
    if (date !== undefined) p.date = date ? new Date(date) : p.date;
    if (cost !== undefined) p.cost = Number(cost);
    if (type !== undefined) p.type = String(type || 'other').toLowerCase();
    if (notes !== undefined) p.notes = notes || '';
    if (docUrls !== undefined) p.docUrls = Array.isArray(docUrls) ? docUrls : p.docUrls;

    // Update structured receipt field (supports clearing by sending empty string/null)
    if (receiptPhotoUrl !== undefined || receiptUrl !== undefined) {
      p.receiptPhoto = chosenReceiptUrl ? { url: chosenReceiptUrl } : undefined;
      // Also mirror into docUrls[0] for compatibility
      if (chosenReceiptUrl) {
        const arr = Array.isArray(p.docUrls) ? [...p.docUrls] : [];
        if (!arr.includes(chosenReceiptUrl)) p.docUrls = [chosenReceiptUrl, ...arr];
      }
    }

    await p.save();
    const ret = await Purchase.findById(p._id)
      .populate({ path: 'vendorId', select: 'name' })
      .populate({ path: 'projectId', select: 'name' })
      .populate({ path: 'taskId',    select: 'title' })
      .lean();

    const vendor = ret.vendorId ? { _id: String(ret.vendorId._id), name: ret.vendorId.name } : undefined;
    const vendorIdStr = ret.vendorId ? String(ret.vendorId._id) : undefined;
    const projIdStr = ret.projectId ? String(ret.projectId._id) : ret.projectId;
    const taskIdStr = ret.taskId ? String(ret.taskId._id) : ret.taskId;
    const finalReceiptUrl = ret?.receiptPhoto?.url || (Array.isArray(ret.docUrls) && ret.docUrls[0]) || undefined;

    res.json({
      ...ret,
      vendor,
      vendorId: vendorIdStr,
      projectId: projIdStr,
      taskId: taskIdStr,
      receiptPhoto: ret.receiptPhoto ? { url: ret.receiptPhoto.url } : (finalReceiptUrl ? { url: finalReceiptUrl } : undefined),
      receiptUrl: finalReceiptUrl,
    });
  } catch (e) {
    console.error('PUT /purchases/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- delete -------------------------------- */
// DELETE /purchases/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await Purchase.findOneAndDelete({ _id: req.params.id, ...buildOrgFilter(Purchase, req.user?.orgId) });
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /purchases/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* --------------------------- receipt upload ---------------------------- */
/**
 * POST /vehicles/:vehicleId/purchases/upload
 * Body: multipart/form-data with single field `file` (image/*)
 * Returns: { url, filename, size, mime, vehicleId }
 *
 * Note: This does NOT attach the URL to a Purchase; the client should
 * include the returned URL later in /purchases POST/PUT via `receiptPhotoUrl`
 * (or legacy `receiptUrl`). The route stores under /uploads/purchases/:vehicleId,
 * which should be exposed via /files/purchases/:vehicleId by your static server.
 */
router.post('/vehicles/:vehicleId/purchases/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const vehicleId = String(req.params.vehicleId || '').trim();
    if (!isValidId(vehicleId)) return res.status(400).json({ error: 'Invalid vehicle id' });

    // Optional: verify vehicle exists (and acts as a visibility guard)
    const vehicle = await Vehicle.findById(vehicleId).lean();
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    if (!req.file) return res.status(400).json({ error: 'No file' });

    const url = buildFileUrl(vehicleId, req.file.filename);
    return res.json({
      url,
      filename: req.file.filename,
      size: req.file.size,
      mime: req.file.mimetype,
      vehicleId,
    });
  } catch (e) {
    console.error('POST /vehicles/:vehicleId/purchases/upload error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
