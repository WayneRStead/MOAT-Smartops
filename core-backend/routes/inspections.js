// core-backend/routes/inspections.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ------------------------ robust model loader ------------------------ */
function loadInspectionModel() {
  try {
    return mongoose.model('Inspection');
  } catch {
    const mod = require('../models/Inspection');
    if (mod && typeof mod.find === 'function' && mod.modelName) return mod;
    if (mod && mod.Inspection && typeof mod.Inspection.find === 'function') return mod.Inspection;
    try { return mongoose.model('Inspection'); } catch {}
    throw new Error('Inspection model not loaded. Check models/Inspection.js exports.');
  }
}
const Inspection = loadInspectionModel();

/* ------------------------ org scoping helpers ------------------------ */
const HAS_ORG = !!(Inspection?.schema?.path && Inspection.schema.path('orgId'));

function orgScope(orgId) {
  if (!HAS_ORG) return {};
  if (!orgId) return {};
  const s = String(orgId);
  // tolerate non-ObjectId org keys by skipping scope (e.g. "root")
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  return { orgId: new mongoose.Types.ObjectId(s) };
}

/* --------------------------- misc constants -------------------------- */
const ALLOWED_STATUS = ['open', 'in-progress', 'closed'];
const LINK_TYPES = ['project','inspection','asset','vehicle','user','task','clocking'];

function normalizeStatus(s) {
  if (!s) return undefined;
  if (s === 'planned') return 'open'; // legacy alias
  return ALLOWED_STATUS.includes(s) ? s : undefined;
}

function sendError(res, e) {
  if (e?.name === 'ValidationError') {
    return res.status(400).json({ error: 'validation', detail: e.message });
  }
  return res.status(500).json({ error: 'Server error', detail: e?.message || String(e) });
}

/* ------------------------------ role gate ---------------------------- */
function allowRoles(...roles) {
  return (req, res, next) => {
    const user = req.user || {};
    const isEnvAdmin = user?.sub && user.sub === process.env.AUTH_USER;
    if (isEnvAdmin) return next();
    if (!user?.role) return res.sendStatus(401);
    if (roles.length === 0 || roles.includes(user.role)) return next();
    return res.sendStatus(403);
  };
}

/* ==================================================================== */
/*  IMPORTANT: Guard special paths FIRST so they never hit /:id         */
/* ==================================================================== */

/**
 * These are placeholders for the new inspections feature:
 * - /inspections/forms
 * - /inspections/submissions
 * Return 404 intentionally so the frontend can fall back to its local
 * mock adapter (your axios layer already does this on 404/500).
 * Replace these stubs with real implementations when ready.
 */
router.all('/forms*', requireAuth, (_req, res) => {
  return res.status(404).json({ error: 'Forms endpoint not implemented on server' });
});

router.all('/submissions*', requireAuth, (_req, res) => {
  return res.status(404).json({ error: 'Submissions endpoint not implemented on server' });
});

/* ==================================================================== */
/*  Classic Inspections CRUD (guard :id as ObjectId)                    */
/*  NOTE: This router is mounted at /inspections                        */
/* ==================================================================== */

/* ------------------------------- LIST -------------------------------- */
// GET /inspections
router.get('/', requireAuth, async (req, res) => {
  try {
    const { projectId, status, q, limit } = req.query;
    const find = { ...orgScope(req.user?.orgId) };

    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: 'invalid projectId' });
      }
      find.projectId = new mongoose.Types.ObjectId(projectId);
    }

    const normStatus = normalizeStatus(status);
    if (status && !normStatus) {
      return res.status(400).json({ error: 'invalid status', allowed: ALLOWED_STATUS });
    }
    if (normStatus) find.status = normStatus;

    if (q) {
      find.$or = [{ title: new RegExp(q, 'i') }, { notes: new RegExp(q, 'i') }];
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 500);
    const rows = await Inspection.find(find).sort({ updatedAt: -1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error('GET /inspections error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------- READ -------------------------------- */
// GET /inspections/:id
router.get('/:id([a-fA-F0-9]{24})', requireAuth, async (req, res) => {
  try {
    const doc = await Inspection.findOne(
      { _id: req.params.id, ...orgScope(req.user?.orgId) }
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) {
    console.error('GET /inspections/:id error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------ CREATE ------------------------------- */
// POST /inspections
router.post('/', requireAuth, allowRoles('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { title, projectId, status, notes } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    const doc = new Inspection({
      title: String(title).trim(),
      notes: notes || '',
      ...(HAS_ORG ? orgScope(req.user?.orgId) : {}),
    });

    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: 'invalid projectId' });
      }
      doc.projectId = new mongoose.Types.ObjectId(projectId);
    }

    const normStatus = normalizeStatus(status);
    if (status && !normStatus) {
      return res.status(400).json({ error: 'invalid status', allowed: ALLOWED_STATUS });
    }
    if (normStatus) doc.status = normStatus; // else schema default 'open'

    await doc.save();
    res.status(201).json(doc);
  } catch (e) {
    console.error('POST /inspections error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------ UPDATE ------------------------------- */
// PUT /inspections/:id
router.put('/:id([a-fA-F0-9]{24})', requireAuth, allowRoles('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const doc = await Inspection.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const { title, status, projectId, notes } = req.body || {};
    if (title != null) doc.title = String(title).trim();

    if (status != null) {
      const norm = normalizeStatus(status);
      if (!norm) return res.status(400).json({ error: 'invalid status', allowed: ALLOWED_STATUS });
      doc.status = norm;
    }

    if (projectId != null) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: 'invalid projectId' });
      }
      doc.projectId = new mongoose.Types.ObjectId(projectId);
    }

    if (notes != null) doc.notes = notes;

    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error('PUT /inspections/:id error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------ DELETE ------------------------------- */
// DELETE /inspections/:id
router.delete('/:id([a-fA-F0-9]{24})', requireAuth, allowRoles('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const del = await Inspection.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /inspections/:id error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------- LINKS ------------------------------- */
// POST /inspections/:id/links
router.post('/:id([a-fA-F0-9]{24})/links', requireAuth, allowRoles('manager','admin','superadmin'), async (req, res) => {
  try {
    const { type, refId } = req.body || {};
    if (!type || !LINK_TYPES.includes(type)) {
      return res.status(400).json({ error: 'invalid link type', allowed: LINK_TYPES });
    }
    if (!refId || !mongoose.Types.ObjectId.isValid(refId)) {
      return res.status(400).json({ error: 'invalid refId' });
    }

    const doc = await Inspection.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if (!Array.isArray(doc.links)) doc.links = [];
    const refStr = String(refId);
    const exists = doc.links.some(l => l.type === type && String(l.refId) === refStr);
    if (!exists) {
      doc.links.push({ type, refId: new mongoose.Types.ObjectId(refStr) });
      await doc.save();
    }
    res.json(doc.links);
  } catch (e) {
    console.error('POST /inspections/:id/links error:', e);
    return sendError(res, e);
  }
});

// DELETE /inspections/:id/links
router.delete('/:id([a-fA-F0-9]{24})/links', requireAuth, allowRoles('manager','admin','superadmin'), async (req, res) => {
  try {
    const { type, refId } = req.body || {};
    if (!type || !LINK_TYPES.includes(type)) {
      return res.status(400).json({ error: 'invalid link type', allowed: LINK_TYPES });
    }
    if (!refId || !mongoose.Types.ObjectId.isValid(refId)) {
      return res.status(400).json({ error: 'invalid refId' });
    }

    const doc = await Inspection.findOne({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const refStr = String(refId);
    doc.links = (doc.links || []).filter(l => !(l.type === type && String(l.refId) === refStr));
    await doc.save();
    res.json(doc.links || []);
  } catch (e) {
    console.error('DELETE /inspections/:id/links error:', e);
    return sendError(res, e);
  }
});

/* ------------------------------ RESTORE ------------------------------ */
// Optional stub (hard delete model)
router.patch('/:id([a-fA-F0-9]{24})/restore', requireAuth, allowRoles('manager', 'admin', 'superadmin'), async (_req, res) => {
  return res.status(400).json({ error: 'restore not supported (hard delete model)' });
});

module.exports = router;
