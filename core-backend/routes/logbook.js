// core-backend/routes/logbook.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ------------------------- model resolution ------------------------- */
// Prefer already-compiled model; only require if missing (prevents OverwriteModelError)
const VehicleLog =
  mongoose.models.VehicleLog || require('../models/VehicleLog');

/* ----------------------------- helpers ------------------------------ */
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) => (isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

// Build an org filter only if your VehicleLog schema has an orgId
function buildOrgFilter(orgId) {
  const path = VehicleLog.schema.path('orgId');
  if (!path) return {}; // schema has no orgId; skip scoping
  const s = String(orgId || '');
  // If schema expects ObjectId, only add when valid; if String, pass through
  if (path.instance === 'ObjectID') {
    return isValidId(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  if (path.instance === 'String') {
    return s ? { orgId: s } : {};
  }
  return {};
}

// Compute distance if both odometers provided
function computeDistance(start, end) {
  if (start == null || end == null) return undefined;
  const s = Number(start), e = Number(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return undefined;
  return Math.max(0, e - s);
}

/* ------------------------------- LIST ------------------------------- */
// GET /logbook?vehicleId=&q=&tag=&from=&to=&minKm=&maxKm=&limit=
router.get('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, q, tag, from, to, minKm, maxKm, limit } = req.query;

    const find = {
      ...buildOrgFilter(req.user?.orgId),
    };

    if (vehicleId) {
      const oid = asObjectId(vehicleId);
      if (!oid) return res.status(400).json({ error: 'invalid vehicleId' });
      find.vehicleId = oid;
    }

    if (q) {
      const rx = new RegExp(String(q), 'i');
      // note: tags is often an array; Mongoose will handle {$in:[q]} fine
      find.$or = [{ title: rx }, { notes: rx }, { tags: q }];
    }

    if (tag) find.tags = tag;

    if (from || to) {
      find.ts = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to   ? { $lte: new Date(to)   } : {}),
      };
    }

    if (minKm || maxKm) {
      find.distance = {};
      if (minKm != null && minKm !== '') find.distance.$gte = Number(minKm);
      if (maxKm != null && maxKm !== '') find.distance.$lte = Number(maxKm);
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 500);
    const rows = await VehicleLog.find(find)
      .sort({ ts: -1, createdAt: -1 })
      .limit(lim)
      .lean();

    res.json(rows);
  } catch (e) {
    console.error('GET /logbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------ CREATE ------------------------------ */
// POST /logbook
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      vehicleId, title, notes = '', tags = [],
      ts, odometerStart, odometerEnd
    } = req.body || {};

    const vid = asObjectId(vehicleId);
    if (!vid) return res.status(400).json({ error: 'vehicleId required/invalid' });
    if (!title) return res.status(400).json({ error: 'title required' });

    const distance = computeDistance(odometerStart, odometerEnd);

    // Base doc
    const doc = {
      vehicleId: vid,
      title: String(title).trim(),
      notes: String(notes || ''),
      tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
      ts: ts ? new Date(ts) : new Date(),
      odometerStart: odometerStart != null && odometerStart !== '' ? Number(odometerStart) : undefined,
      odometerEnd:   odometerEnd   != null && odometerEnd   !== '' ? Number(odometerEnd)   : undefined,
      distance,
      createdBy: req.user?.sub || req.user?._id || 'unknown',
    };

    // If schema has orgId, set it using the correct type
    const orgPath = VehicleLog.schema.path('orgId');
    if (orgPath) {
      if (orgPath.instance === 'ObjectID' && isValidId(req.user?.orgId)) {
        doc.orgId = new mongoose.Types.ObjectId(String(req.user.orgId));
      } else if (orgPath.instance === 'String' && req.user?.orgId) {
        doc.orgId = String(req.user.orgId);
      }
    }

    const row = await VehicleLog.create(doc);
    res.status(201).json(row);
  } catch (e) {
    console.error('POST /logbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- UPDATE ------------------------------ */
// PUT /logbook/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const row = await VehicleLog.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { title, notes, tags, ts, odometerStart, odometerEnd } = req.body || {};

    if (title != null) row.title = String(title).trim();
    if (notes != null) row.notes = String(notes);
    if (Array.isArray(tags)) row.tags = tags.filter(Boolean);
    if (ts != null) row.ts = ts ? new Date(ts) : row.ts;

    if (odometerStart !== undefined) {
      row.odometerStart = odometerStart === '' || odometerStart == null ? undefined : Number(odometerStart);
    }
    if (odometerEnd !== undefined) {
      row.odometerEnd = odometerEnd === '' || odometerEnd == null ? undefined : Number(odometerEnd);
    }
    row.distance = computeDistance(row.odometerStart, row.odometerEnd);

    await row.save();
    res.json(row);
  } catch (e) {
    console.error('PUT /logbook/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- DELETE ------------------------------ */
// DELETE /logbook/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await VehicleLog.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: 'Not found' });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /logbook/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
