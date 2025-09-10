// core-backend/routes/logbook.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');

let VehicleLog;
try { VehicleLog = mongoose.model('VehicleLog'); }
catch { VehicleLog = require('../models/VehicleLog'); }

const router = express.Router();

// Helper: compute distance if both odometers provided
function computeDistance(start, end) {
  if (start == null || end == null) return undefined;
  const s = Number(start), e = Number(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return undefined;
  return Math.max(0, e - s);
}

// GET /api/logbook?vehicleId=&q=&tag=&from=&to=&minKm=&maxKm=&limit=
router.get('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, q, tag, from, to, minKm, maxKm, limit } = req.query;
    const find = {};

    if (vehicleId) {
      if (!mongoose.Types.ObjectId.isValid(vehicleId)) {
        return res.status(400).json({ error: 'invalid vehicleId' });
      }
      find.vehicleId = new mongoose.Types.ObjectId(vehicleId);
    }

    if (q) {
      const rx = new RegExp(q, 'i');
      find.$or = [{ title: rx }, { notes: rx }, { tags: q }];
    }

    if (tag) find.tags = tag;

    if (from || to) {
      find.ts = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to   ? { $lte: new Date(to)   } : {}),
      };
    }

    // Optional distance filter
    if (minKm || maxKm) {
      find.distance = {};
      if (minKm) find.distance.$gte = Number(minKm);
      if (maxKm) find.distance.$lte = Number(maxKm);
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 500);
    const rows = await VehicleLog.find(find).sort({ ts: -1, createdAt: -1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error('GET /logbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/logbook
router.post('/', requireAuth, async (req, res) => {
  try {
    const { vehicleId, title, notes = '', tags = [], ts, odometerStart, odometerEnd } = req.body || {};
    if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId)) {
      return res.status(400).json({ error: 'vehicleId required/invalid' });
    }
    if (!title) return res.status(400).json({ error: 'title required' });

    const distance = computeDistance(odometerStart, odometerEnd);

    const row = await VehicleLog.create({
      vehicleId: new mongoose.Types.ObjectId(vehicleId),
      title: String(title).trim(),
      notes: String(notes || ''),
      tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
      ts: ts ? new Date(ts) : new Date(),
      odometerStart: odometerStart != null && odometerStart !== '' ? Number(odometerStart) : undefined,
      odometerEnd:   odometerEnd   != null && odometerEnd   !== '' ? Number(odometerEnd)   : undefined,
      distance,
      createdBy: req.user?.sub || 'unknown',
    });
    res.status(201).json(row);
  } catch (e) {
    console.error('POST /logbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/logbook/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const row = await VehicleLog.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { title, notes, tags, ts, odometerStart, odometerEnd } = req.body || {};

    if (title != null) row.title = String(title).trim();
    if (notes != null) row.notes = String(notes);
    if (Array.isArray(tags)) row.tags = tags.filter(Boolean);
    if (ts != null) row.ts = ts ? new Date(ts) : row.ts;

    // normalize odometers
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

// DELETE /api/logbook/:id
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
