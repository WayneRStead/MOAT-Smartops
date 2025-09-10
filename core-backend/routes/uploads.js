// core-backend/routes/uploads.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const Inspection = require('../models/Inspection');

const router = express.Router();

// ensure base dir exists
const baseDir = path.join(__dirname, '..', 'uploads', 'inspections');
fs.mkdirSync(baseDir, { recursive: true });

// dynamic per-inspection storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(baseDir, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // keep original name; you can prefix timestamps if you want
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    // accept common images & docs; relax as needed
    const ok = /^(image\/|application\/pdf|text\/plain|application\/vnd.openxmlformats|application\/msword|application\/zip)/.test(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

// POST /api/uploads/inspection/:id  (field name: "file")
router.post('/inspection/:id', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    // public URL under /files (index.js serves /files -> uploads/)
    const rel = `/files/inspections/${req.params.id}/${req.file.originalname}`;

    const doc = await Inspection.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          files: {
            filename: req.file.originalname,
            url: rel,
            mime: req.file.mimetype,
            size: req.file.size,
            uploadedBy: (req.user?.sub || 'unknown'),
            uploadedAt: new Date(),
          }
        }
      },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Inspection not found' });
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

// DELETE /api/uploads/inspection/:id/:filename
const del = require('fs').unlink;

router.delete('/inspection/:id/:filename', requireAuth, async (req, res, next) => {
  try {
    const { id, filename } = req.params;
    const filePath = path.join(baseDir, id, filename);

    // pull from array first
    const doc = await Inspection.findByIdAndUpdate(
      id,
      { $pull: { files: { filename } } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Inspection not found' });

    // best-effort remove from disk
    fs.existsSync(filePath) && del(filePath, () => {});

    res.json(doc);
  } catch (e) { next(e); }
});

module.exports = router;
