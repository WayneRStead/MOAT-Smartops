// core-backend/routes/users-bulk.js
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { requireAuth, requireRole } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();               // <- you were missing this
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * POST /api/users/bulk-upload
 * Accepts CSV/XLSX and upserts users by email.
 * Columns: name, email, role (optional: others ignored)
 */
router.post('/bulk-upload', requireAuth, requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();

    let rows = [];
    if (ext === 'csv') {
      rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws);
    } else {
      return res.status(400).json({ error: 'Unsupported file type (use .csv or .xlsx)' });
    }

    // normalize & validate
    const toUpsert = [];
    for (const r of rows) {
      const name = String(r.name || '').trim();
      const email = String(r.email || '').trim().toLowerCase();
      const role = String(r.role || 'worker').toLowerCase();
      if (!name || !email) continue;
      toUpsert.push({ name, email, role });
    }
    if (!toUpsert.length) return res.status(400).json({ error: 'No valid rows found' });

    // upsert by email
    const results = [];
    for (const u of toUpsert) {
      const doc = await User.findOneAndUpdate({ email: u.email }, u, { new: true, upsert: true });
      results.push({ _id: doc._id, email: doc.email, role: doc.role });
    }

    res.status(201).json({ count: results.length, results });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
