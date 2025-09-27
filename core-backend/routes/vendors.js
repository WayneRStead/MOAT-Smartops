// core-backend/routes/vendors.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

const Vendor = mongoose.models.Vendor || require('../models/Vendor');

const router = express.Router();

function isAdmin(req) {
  const r = String(req.user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}
function escapeRx(s=''){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildOrgFilter(model, orgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return {};
  // This router stores orgId as String
  const s = String(orgId || '');
  return s ? { orgId: s } : {};
}

// LIST
router.get('/', requireAuth, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const find = { ...buildOrgFilter(Vendor, req.user?.orgId) };
    if (q) {
      const rx = new RegExp(escapeRx(q), 'i');
      find.$or = [{ name: rx }, { contact: rx }, { notes: rx }];
    }
    const lim = Math.min(parseInt(limit || '500', 10) || 500, 1000);
    const rows = await Vendor.find(find).sort({ name: 1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error('GET /vendors error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, contact, email, phone, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    const doc = new Vendor({
      name: String(name).trim(),
      contact, email, phone, notes,
      orgId: String(req.user?.orgId || 'root'),
    });
    await doc.save();
    res.status(201).json(doc.toObject());
  } catch (e) {
    console.error('POST /vendors error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const v = await Vendor.findOne({ _id: req.params.id, ...buildOrgFilter(Vendor, req.user?.orgId) });
    if (!v) return res.status(404).json({ error: 'Not found' });

    const { name, contact, email, phone, notes } = req.body || {};
    if (name != null) v.name = String(name).trim();
    if (contact != null) v.contact = contact;
    if (email != null) v.email = email;
    if (phone != null) v.phone = phone;
    if (notes != null) v.notes = notes;

    await v.save();
    res.json(v.toObject());
  } catch (e) {
    console.error('PUT /vendors/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await Vendor.findOneAndDelete({ _id: req.params.id, ...buildOrgFilter(Vendor, req.user?.orgId) });
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /vendors/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
