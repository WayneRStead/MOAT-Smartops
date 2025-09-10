// core-backend/routes/documents.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose'); // <-- added
const { requireAuth, requireRole } = require('../middleware/auth');
const { canReadDoc, canEditDoc, isAdmin } = require('../middleware/acl');
const Document = require('../models/Document');

// Optional usage emitter (guarded if not present)
let emitUsage = () => {};
try {
  ({ emitUsage } = require('../utils/usage'));
} catch (_) { /* no-op */ }

// Files served by: app.use('/files', express.static(path.join(__dirname, 'uploads')))
const uploadsRoot = path.join(__dirname, '..', 'uploads');
const baseDir = path.join(uploadsRoot, 'docs');
fs.mkdirSync(baseDir, { recursive: true });

const router = express.Router();

// Multer storage per-document/version folder
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const docId = req.params.id || '_new';
    const dir = path.join(baseDir, docId, String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

/* ------------------------ Helpers ------------------------ */

function computeLatest(doc) {
  if (!doc.versions || doc.versions.length === 0) return undefined;
  for (let i = doc.versions.length - 1; i >= 0; i--) {
    const v = doc.versions[i];
    if (!v.deletedAt) return v;
  }
  return undefined;
}

function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

/* ------------------------ Routes ------------------------ */

/**
 * GET /documents
 * Filters: q, tag, folder, linkedTo (type:refId), module, uploader, from, to, includeDeleted
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { q, tag, folder, linkedTo, module, uploader, from, to, includeDeleted } = req.query;

    const find = {};
    if (!includeDeleted) {
      find.deletedAt = { $exists: false };
    }

    if (q) {
      const or = [
        { title: new RegExp(q, 'i') },
        { 'latest.filename': new RegExp(q, 'i') },
        { tags: q },
      ];

      // NEW: allow searching by exact _id if q looks like an ObjectId
      if (isValidObjectId(q)) {
        or.push({ _id: new mongoose.Types.ObjectId(q) });
      }
      find.$or = or;
    }

    if (tag) find.tags = tag;
    if (folder) find.folder = folder;
    if (uploader) find['latest.uploadedBy'] = uploader;
    if (from || to) {
      find.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to   ? { $lte: new Date(to)   } : {}),
      };
    }

    // Linking filters (supports both links.type and links.module for compatibility)
    if (module) {
      find.$or = (find.$or || []).concat([
        { 'links.type': module },
        { 'links.module': module },
      ]);
    }
    if (linkedTo) {
      const [type, refId] = String(linkedTo).split(':');
      if (type && refId) {
        find.$and = (find.$and || []).concat([
          {
            $or: [
              { links: { $elemMatch: { type, refId } } },
              { links: { $elemMatch: { module: type, refId } } },
            ],
          },
        ]);
      }
    }

    const docs = await Document.find(find).sort({ updatedAt: -1 }).lean();
    res.json(docs.filter((d) => canReadDoc(req.user, d)));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /documents/:id
 * NEW: direct fetch by id (fixes "Document not found" when navigating from links)
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const doc = await Document.findById(id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!canReadDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    return res.json(doc);
  } catch (e) {
    console.error('GET /documents/:id failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

/**
 * POST /documents
 * Create document metadata
 */
router.post('/', requireAuth, requireRole('admin', 'manager', 'worker'), async (req, res, next) => {
  try {
    const { title, folder = '', tags = [], links = [], access } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    const normLinks = (Array.isArray(links) ? links : []).map((l) => {
      const type = l.type || l.module;
      return { ...l, type, module: type };
    });

    const now = new Date();
    const doc = await Document.create({
      title,
      folder,
      tags,
      links: normLinks,
      access: access || { visibility: 'org', owners: [req.user.sub] },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.sub,
      updatedBy: req.user.sub,
      versions: [],
      latest: undefined,
    });

    res.status(201).json(doc);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /documents/:id/upload
 * Upload a new file version
 */
router.post('/:id/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const doc = await Document.findById(id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    if (!req.file) return res.status(400).json({ error: 'file required' });

    // Build public URL (served via /files)
    const rel = '/files/' + path.relative(uploadsRoot, req.file.path).replace(/\\/g, '/');

    const version = {
      filename: req.file.originalname,
      url: rel,
      mime: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user.sub,
      uploadedAt: new Date(),
    };

    doc.versions = doc.versions || [];
    doc.versions.push(version);
    doc.latest = version;
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub;

    await doc.save();

    try { emitUsage('doc.upload', { docId: String(doc._id), size: req.file.size }); } catch (_) {}

    res.status(201).json(doc);
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /documents/:id
 * Update metadata (title, folder, tags, links, access)
 */
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const doc = await Document.findById(id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    const { title, folder, tags, links, access } = req.body || {};
    if (title != null) doc.title = title;
    if (folder != null) doc.folder = folder;
    if (tags != null) doc.tags = tags;
    if (links != null) {
      const normLinks = (Array.isArray(links) ? links : []).map((l) => {
        const type = l.type || l.module;
        return { ...l, type, module: type };
      });
      doc.links = normLinks;
    }
    if (access != null) doc.access = access;

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub;

    await doc.save();
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /documents/:id
 * Soft delete by default; hard delete with ?hard=1 (admin only)
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const doc = await Document.findById(id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!isAdmin(req.user) && !canEditDoc(req.user, doc)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const hard = String(req.query.hard) === '1';
    if (hard) {
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'Hard delete requires admin' });
      await Document.findByIdAndDelete(doc._id);
      try { emitUsage('doc.delete.hard', { docId: String(doc._id) }); } catch (_) {}
      return res.json({ ok: true, hard: true });
    }

    doc.deletedAt = new Date();
    doc.deletedBy = req.user.sub || req.user._id || null;
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();

    try { emitUsage('doc.delete', { docId: String(doc._id) }); } catch (_) {}

    return res.json({ ok: true, hard: false });
  } catch (e) {
    console.error('DELETE /documents/:id failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

/**
 * PATCH /documents/:id/restore
 * Restore a soft-deleted document
 */
router.patch('/:id/restore', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const doc = await Document.findById(id);
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    doc.deletedAt = undefined;
    doc.deletedBy = undefined;
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();

    return res.json(doc);
  } catch (e) {
    console.error('PATCH /documents/:id/restore failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

/**
 * DELETE /documents/:id/versions/:index
 * Soft-delete a specific version; recompute latest if necessary
 */
router.delete('/:id/versions/:index', requireAuth, async (req, res) => {
  try {
    const { id, index } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'Bad version index' });

    const doc = await Document.findById(id);
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    if (!doc.versions || !doc.versions[i]) {
      return res.status(400).json({ error: 'Bad version index' });
    }

    const v = doc.versions[i];
    v.deletedAt = new Date();
    v.deletedBy = req.user.sub || req.user._id || null;

    // If current latest equals this version, recompute latest
    if (
      doc.latest &&
      v.uploadedAt &&
      doc.latest.uploadedAt &&
      String(new Date(doc.latest.uploadedAt).getTime()) === String(new Date(v.uploadedAt).getTime())
    ) {
      doc.latest = computeLatest(doc);
    }

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();

    try { emitUsage('doc.version.delete', { docId: String(doc._id), versionIndex: i }); } catch (_) {}

    return res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /documents/:id/versions/:index failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

/**
 * PATCH /documents/:id/versions/:index/restore
 * Restore a version; optionally set as latest with ?setLatest=1
 */
router.patch('/:id/versions/:index/restore', requireAuth, async (req, res) => {
  try {
    const { id, index } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'Bad version index' });

    const doc = await Document.findById(id);
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    if (!doc.versions || !doc.versions[i]) {
      return res.status(400).json({ error: 'Bad version index' });
    }

    const v = doc.versions[i];
    v.deletedAt = undefined;
    v.deletedBy = undefined;

    if (String(req.query.setLatest) === '1') {
      doc.latest = v;
    } else if (!doc.latest) {
      doc.latest = computeLatest(doc);
    }

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();

    return res.json(doc);
  } catch (e) {
    console.error('PATCH /documents/:id/versions/:index/restore failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

/**
 * POST /documents/:id/links
 * Body: { type?: string, module?: string, refId: ObjectId }
 * Stores both .type and .module; prevents duplicates
 */
router.post('/:id/links', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const { type, module, refId } = req.body || {};
    const t = type || module;
    if (!t || !refId) return res.status(400).json({ error: 'type/module and refId required' });

    const doc = await Document.findById(id);
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    doc.links = doc.links || [];
    const exists = doc.links.some(
      (l) => (l.type === t || l.module === t) && String(l.refId) === String(refId)
    );
    if (!exists) {
      doc.links.push({ type: t, module: t, refId });
      doc.updatedAt = new Date();
      doc.updatedBy = req.user.sub || req.user._id || null;
      await doc.save();
    }

    res.json(doc.links);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /documents/:id/links
 * Body: { type?: string, module?: string, refId }
 */
router.delete('/:id/links', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id' });

    const { type, module, refId } = req.body || {};
    const t = type || module;
    if (!t || !refId) return res.status(400).json({ error: 'type/module and refId required' });

    const doc = await Document.findById(id);
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'Forbidden' });

    doc.links = (doc.links || []).filter(
      (l) => !((l.type === t || l.module === t) && String(l.refId) === String(refId))
    );
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();

    res.json(doc.links);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
