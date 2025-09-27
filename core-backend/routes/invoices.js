// core-backend/routes/invoices.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../middleware/auth');

// Prefer already-compiled model to avoid OverwriteModelError
const Invoice = mongoose.models.Invoice || require('../models/Invoice');

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  return mongoose.Types.ObjectId.isValid(s)
    ? { orgId: new mongoose.Types.ObjectId(s) }
    : { orgId: s };
}

/* -------------------------------- LIST ------------------------------- */
/**
 * GET /invoices
 * Query:
 *   - q: text search (number, customerName, customerEmail, notes)
 *   - status: open/paid/void (or your statuses)
 *   - from, to: date range (applies to issuedAt OR createdAt)
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
        { customerName: rx },
        { customerEmail: rx },
        { notes: rx },
      ];
    }

    const range = {};
    if (from) range.$gte = new Date(from);
    if (to)   range.$lte = new Date(to);
    if (Object.keys(range).length) {
      // Try both issuedAt and createdAt; whichever your schema has will be used by Mongo
      filter.$or = (filter.$or || []).concat([{ issuedAt: range }, { createdAt: range }]);
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 1000);

    const rows = await Invoice.find(filter)
      .sort({ issuedAt: -1, createdAt: -1 })
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
router.post('/', requireAuth, requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const baseOrg = orgScope(req.user?.orgId).orgId;
    const doc = await Invoice.create({ ...req.body, orgId: baseOrg });
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

/* ------------------------------- UPDATE ------------------------------ */
router.put('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const doc = await Invoice.findOneAndUpdate(
      { _id: req.params.id, ...orgScope(req.user?.orgId) },
      req.body,
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) { next(e); }
});

/* ------------------------------- DELETE ------------------------------ */
router.delete('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const r = await Invoice.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user?.orgId) });
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
