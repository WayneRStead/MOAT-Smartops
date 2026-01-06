// core-backend/routes/invoices.js
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');

// Prefer already-compiled models to avoid OverwriteModelError
const Invoice = mongoose.models.Invoice || require('../models/Invoice');

// Optional Vendor model
let Vendor = null;
try { Vendor = mongoose.models.Vendor || require('../models/Vendor'); } catch { Vendor = null; }

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  return mongoose.Types.ObjectId.isValid(s)
    ? { orgId: new mongoose.Types.ObjectId(s) }
    : { orgId: s };
}

function safeOrgId(req) {
  const raw = req.user?.orgId;
  return raw ? String(raw) : 'global';
}

function addDays(dateLike, days) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (isNaN(+d)) return null;
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function normalizeDueAt(body) {
  // Prefer explicit dueAt; otherwise compute from submittedAt/issuedAt + termsDays/terms
  const dueExplicit = body.dueAt ? new Date(body.dueAt) : null;
  if (dueExplicit && !isNaN(+dueExplicit)) return dueExplicit;

  const submitted = body.submittedAt || body.issuedAt;
  const terms = Number(body.termsDays ?? body.terms ?? body.netDays ?? 0);
  const d = addDays(submitted, terms);
  return d || null;
}

function computeStatusLikeFrontend({ paidAt, dueAt }) {
  if (paidAt) return 'paid';
  if (dueAt && new Date(dueAt).getTime() < Date.now()) return 'outstanding';
  return 'submitted';
}

// upsert vendor by name if requested and model exists
async function maybeUpsertVendor({ reqUser, name, email, phone, upsertFlag }) {
  if (!Vendor || !upsertFlag || !name) return null;
  const scope = orgScope(reqUser?.orgId);
  let v = await Vendor.findOne({ name, ...scope }).lean();
  if (v) return v._id;
  v = await Vendor.create({ name, email, phone, ...scope });
  return v._id;
}

/* --------------------------- role guarding --------------------------- */
/**
 * Invoice rule:
 * - create/edit/upload: manager, admin, superadmin
 * - delete: admin, superadmin
 *
 * Supports:
 * - req.user.role as string
 * - req.user.roles as array
 * - case-insensitive
 * - treats "org_admin" / "super-admin" etc. as admin (contains "admin")
 */
function userHasAnyRole(user, allowed = []) {
  const want = new Set((allowed || []).map(r => String(r).toLowerCase()));

  const r1 = String(user?.role || '').toLowerCase().trim();
  if (r1) {
    if (want.has(r1)) return true;
    // allow admin variants if "admin" is allowed
    if (want.has('admin') && r1.includes('admin')) return true;
    if (want.has('superadmin') && r1.includes('super')) return true;
  }

  const rs = Array.isArray(user?.roles) ? user.roles : [];
  for (const r of rs) {
    const rr = String(r || '').toLowerCase().trim();
    if (!rr) continue;
    if (want.has(rr)) return true;
    if (want.has('admin') && rr.includes('admin')) return true;
    if (want.has('superadmin') && rr.includes('super')) return true;
  }

  return false;
}

function requireAnyRole(...allowed) {
  return function (req, res, next) {
    if (userHasAnyRole(req.user, allowed)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

/* ----------------------------- file upload ---------------------------- */
// Multer storage with per-org subfolder and deterministic filename
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const org = safeOrgId(req);
    const dir = path.join(__dirname, '..', 'uploads', 'invoices', org);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const id = req.params.id || 'unknown';
    const ts = Date.now();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'upload', ext).replace(/[^\w.\-]+/g, '_');
    cb(null, `${id}-${ts}-${base}${ext}`);
  },
});
const upload = multer({ storage });

/* -------------------------------- LIST ------------------------------- */
/**
 * GET /invoices
 * Query:
 *   - q: text search (number, vendorName, notes)
 *   - status: submitted|outstanding|paid|void
 *   - from, to: date range (issuedAt/submittedAt/createdAt)
 *   - limit: default 200 (max 1000)
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { q, status, from, to, limit } = req.query;
    const filter = { ...orgScope(req.user?.orgId) };

    if (status) filter.status = status;

    if (q) {
      const rx = new RegExp(String(q), 'i');
      filter.$or = [
        { number: rx },
        { vendorName: rx },
        { notes: rx },
      ];
    }

    const range = {};
    if (from) range.$gte = new Date(from);
    if (to)   range.$lte = new Date(to);
    if (Object.keys(range).length) {
      filter.$or = (filter.$or || []).concat([
        { submittedAt: range }, { issuedAt: range }, { createdAt: range }
      ]);
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 1000);

    const rows = await Invoice.find(filter)
      .sort({ submittedAt: -1, issuedAt: -1, createdAt: -1 })
      .limit(lim)
      .lean();

    res.json(rows);
  } catch (e) { next(e); }
});

/* -------------------------------- READ ------------------------------- */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await Invoice.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) { next(e); }
});

/* ------------------------------- CREATE ------------------------------ */
/**
 * Body can include:
 * number, projectId, vendorId?, vendorName?,
 * amount, currency, submittedAt/issuedAt, paidAt/paymentDate,
 * termsDays/terms/netDays, dueAt?, notes, status?
 *
 * Use ?upsertVendor=1 to auto-create vendor if only vendorName provided.
 */
router.post(
  '/',
  requireAuth,
  requireAnyRole('manager', 'admin', 'superadmin'),
  async (req, res, next) => {
    try {
      const scope = orgScope(req.user?.orgId);
      const upsertVendor = String(req.query.upsertVendor || '') === '1';

      let vendorId = req.body.vendorId || null;
      if (!vendorId && (req.body.vendorName || req.body.vendor)) {
        vendorId = await maybeUpsertVendor({
          reqUser: req.user,
          name: req.body.vendorName || req.body.vendor,
          email: req.body.vendorEmail,
          phone: req.body.vendorPhone,
          upsertFlag: upsertVendor,
        });
      }

      const dueAt = normalizeDueAt(req.body);
      const paidAt = req.body.paidAt || req.body.paymentDate || null;

      const docData = {
        ...req.body,
        vendorId: vendorId || req.body.vendorId || null,
        vendorName: req.body.vendorName || req.body.vendor || null,
        dueAt,
        paidAt,
        status: req.body.status || computeStatusLikeFrontend({ paidAt, dueAt }),
        ...scope,
      };

      // normalize numerics
      ['amount','netDays','termsDays','terms'].forEach(k => {
        if (docData[k] != null) docData[k] = Number(docData[k]);
      });

      // ensure required dates if frontend sends strings
      if (docData.submittedAt) docData.submittedAt = new Date(docData.submittedAt);

      const doc = await Invoice.create(docData);
      res.status(201).json(doc);
    } catch (e) { next(e); }
  }
);

/* ------------------------------- UPDATE ------------------------------ */
router.put(
  '/:id',
  requireAuth,
  requireAnyRole('manager', 'admin', 'superadmin'),
  async (req, res, next) => {
    try {
      const scope = orgScope(req.user?.orgId);
      const upsertVendor = String(req.query.upsertVendor || '') === '1';

      const set = { ...req.body };

      // optionally upsert vendor
      if (!set.vendorId && (set.vendorName || set.vendor)) {
        const vid = await maybeUpsertVendor({
          reqUser: req.user,
          name: set.vendorName || set.vendor,
          email: set.vendorEmail,
          phone: set.vendorPhone,
          upsertFlag: upsertVendor,
        });
        if (vid) set.vendorId = vid;
      }

      // recompute dueAt if inputs provided
      const maybeDue = normalizeDueAt(set);
      if (maybeDue) set.dueAt = maybeDue;

      // standardize paidAt/paymentDate
      if (set.paymentDate && !set.paidAt) set.paidAt = set.paymentDate;

      // status
      if (set.paidAt != null || set.dueAt != null || set.status == null) {
        set.status = computeStatusLikeFrontend({ paidAt: set.paidAt, dueAt: set.dueAt });
      }

      // numerics
      ['amount','netDays','termsDays','terms'].forEach(k => {
        if (set[k] != null) set[k] = Number(set[k]);
      });

      if (set.submittedAt) set.submittedAt = new Date(set.submittedAt);

      const doc = await Invoice.findOneAndUpdate(
        { _id: req.params.id, ...scope },
        set,
        { new: true, runValidators: true }
      ).lean();

      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json(doc);
    } catch (e) { next(e); }
  }
);

/* ------------------------------- DELETE ------------------------------ */
router.delete(
  '/:id',
  requireAuth,
  requireAnyRole('admin', 'superadmin'),
  async (req, res, next) => {
    try {
      const r = await Invoice.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user?.orgId) });
      if (!r) return res.status(404).json({ error: 'Not found' });

      // best-effort: remove invoice file from disk if present
      try {
        const org = safeOrgId(req);
        const fileName = r.fileName ? String(r.fileName) : null;
        if (fileName) {
          const p = path.join(__dirname, '..', 'uploads', 'invoices', org, fileName);
          try { fs.unlinkSync(p); } catch {}
        }
      } catch {}

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/* ------------------------------ UPLOAD FILE --------------------------- */
/**
 * POST /invoices/:id/file
 * form-data: file=<binary>
 *
 * Persists to fields that actually exist in models/Invoice.js:
 *   fileUrl, fileName, fileSize, fileType
 *
 * Returns { ok, url, filename, invoice }
 */
router.post(
  '/:id/file',
  requireAuth,
  requireAnyRole('manager', 'admin', 'superadmin'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file' });

      const org = safeOrgId(req);
      const filename = req.file.filename;

      // Public URL (served by /files static mount in index.js)
      const publicUrl = `/files/invoices/${org}/${filename}`;

      const scope = orgScope(req.user?.orgId);

      const update = {
        $set: {
          fileUrl: publicUrl,
          fileName: filename,
          fileSize: req.file.size || null,
          fileType: req.file.mimetype || null,
          updatedBy: req.user?.sub || req.user?._id || req.user?.email || null,
        },
      };

      const doc = await Invoice.findOneAndUpdate(
        { _id: req.params.id, ...scope },
        update,
        { new: true }
      ).lean();

      if (!doc) return res.status(404).json({ error: 'Not found' });

      res.json({ ok: true, url: publicUrl, filename, invoice: doc });
    } catch (e) { next(e); }
  }
);

module.exports = router;
