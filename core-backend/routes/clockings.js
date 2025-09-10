// core-backend/routes/clockings.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Clocking = require('../models/Clocking');
const { CLOCK_TYPES } = require('../models/Clocking');
const User = require('../models/User');

const router = express.Router();

/* ------------------------- helpers / visibility ------------------------- */

// helper: normalize an id-like value to a real ObjectId or undefined
function asObjectId(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  if (!s || s === 'undefined' || s === 'null') return undefined;
  if (!mongoose.Types.ObjectId.isValid(s)) return undefined;
  return new mongoose.Types.ObjectId(s);
}

// try to get an editor ObjectId from req.user directly
function editorObjectIdQuick(req) {
  const candidates = [req.user?._id, req.user?.id, req.user?.userId].filter(Boolean).map(String);
  for (const c of candidates) {
    if (mongoose.Types.ObjectId.isValid(c)) return new mongoose.Types.ObjectId(c);
  }
  return undefined;
}

// async fallback: resolve editor id by looking up the user by email/username/etc.
const _editorCache = new Map(); // cache by key (email/username) -> ObjectId
async function resolveEditorId(req) {
  // First, any quick ObjectId on the token?
  const fast = editorObjectIdQuick(req);
  if (fast) return fast;

  const keys = [req.user?.sub, req.user?.email, req.user?.username].filter(Boolean).map(String);

  for (const key of keys) {
    if (_editorCache.has(key)) return _editorCache.get(key);

    // Try find by email OR username
    const u = await User.findOne({ $or: [{ email: key }, { username: key }] }, { _id: 1 }).lean();
    if (u?._id) {
      const oid = new mongoose.Types.ObjectId(String(u._id));
      _editorCache.set(key, oid);
      return oid;
    }
  }
  return undefined; // couldn’t resolve
}

// Build a "change" tuple
function makeChange(field, before, after) {
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (same) return null;
  return { field, before, after };
}

// Collect changes across supported fields
function collectChanges(beforeDoc, afterDoc) {
  const changes = [];

  const flatFields = ['type', 'at', 'notes', 'projectId', 'userId'];
  for (const f of flatFields) {
    const ch = makeChange(f, beforeDoc[f], afterDoc[f]);
    if (ch) changes.push(ch);
  }

  const bLoc = beforeDoc.location
    ? {
        lat: beforeDoc.location.lat,
        lng: beforeDoc.location.lng,
        ...(Number.isFinite(beforeDoc.location.acc) ? { acc: beforeDoc.location.acc } : {}),
      }
    : undefined;

  const aLoc = afterDoc.location
    ? {
        lat: afterDoc.location.lat,
        lng: afterDoc.location.lng,
        ...(Number.isFinite(afterDoc.location.acc) ? { acc: afterDoc.location.acc } : {}),
      }
    : undefined;

  const locChange = makeChange('location', bLoc, aLoc);
  if (locChange) changes.push(locChange);

  const summarizeAtt = (arr) =>
    Array.isArray(arr)
      ? arr.map((x) => ({
          filename: x.filename,
          url: x.url,
          mime: x.mime,
          size: x.size,
          uploadedBy: x.uploadedBy,
          uploadedAt: x.uploadedAt ? new Date(x.uploadedAt) : undefined,
        }))
      : undefined;

  const bAtt = summarizeAtt(beforeDoc.attachments);
  const aAtt = summarizeAtt(afterDoc.attachments);
  const attChange = makeChange('attachments', bAtt, aAtt);
  if (attChange) changes.push(attChange);

  return changes;
}

// visibility helpers
function isAdmin(req) {
  return String(req.user?.role || '').toLowerCase() === 'admin';
}

function getAccessibleSet(req) {
  // Prefer middleware-provided list; otherwise fall back to self
  const ids = Array.isArray(req.accessibleUserIds) && req.accessibleUserIds.length
    ? req.accessibleUserIds
    : [editorObjectIdQuick(req)].filter(Boolean);
  const set = new Set(ids.map((x) => String(x)));
  return set;
}

function assertVisibleOr403(req, targetUserId, res) {
  if (isAdmin(req)) return true;
  const set = getAccessibleSet(req);
  const s = String(targetUserId || '');
  if (!s || !set.has(s)) {
    res.status(403).json({ error: 'Forbidden: user not visible' });
    return false;
  }
  return true;
}

/* ------------------------------- LIST ------------------------------- */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { projectId, userId, from, to, q, limit, type } = req.query;
    const find = {
      orgId: req.user?.orgId, // org scoping
    };

    const pid = asObjectId(projectId);
    if (pid) find.projectId = pid;

    const uid = asObjectId(userId);

    if (type) find.type = type;

    if (from || to) {
      find.at = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }
    if (q) {
      find.$or = [{ notes: new RegExp(q, 'i') }];
    }

    if (uid) {
      // If a specific userId is requested, enforce visibility for non-admins
      if (!assertVisibleOr403(req, uid, res)) return;
      find.userId = uid;
    } else if (!isAdmin(req)) {
      // Non-admins: restrict to accessibleUserIds
      const ids = Array.from(getAccessibleSet(req)).map((s) => new mongoose.Types.ObjectId(s));
      find.userId = { $in: ids };
    }

    const lim = Math.min(parseInt(limit || '200', 10) || 200, 1000);
    const rows = await Clocking.find(find)
      .sort({ at: -1 })
      .limit(lim)
      .populate('lastEditedBy', 'name email')
      .lean();

    res.json(rows);
  } catch (e) {
    console.error('GET /clockings error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- READ ------------------------------ */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const doc = await Clocking.findOne({ _id: req.params.id, orgId: req.user?.orgId })
      .populate('lastEditedBy', 'name email')
      .lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if (!isAdmin(req) && !assertVisibleOr403(req, doc.userId, res)) return;

    res.json(doc);
  } catch (e) {
    console.error('GET /clockings/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* --------------------------- READ AUDIT ---------------------------- */
router.get('/:id/audit', requireAuth, async (req, res) => {
  try {
    const doc = await Clocking.findOne(
      { _id: req.params.id, orgId: req.user?.orgId },
      { editLog: 1, lastEditedAt: 1, lastEditedBy: 1, userId: 1 }
    )
      .populate('editLog.editedBy', 'name email')
      .populate('lastEditedBy', 'name email')
      .lean();

    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!isAdmin(req) && !assertVisibleOr403(req, doc.userId, res)) return;

    res.json({
      lastEditedAt: doc.lastEditedAt || null,
      lastEditedBy: doc.lastEditedBy || null,
      editLog: doc.editLog || [],
    });
  } catch (e) {
    console.error('GET /clockings/:id/audit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------- helper: build one clocking doc (used for single or bulk) -------- */
function buildClockDoc(body, userIdValue, reqUser, fallbackUserId) {
  const {
    projectId, type, at, notes,
    lat, lng, acc,
    attachment // optional { filename,url,mime,size }
  } = body;

  const resolvedUserId = asObjectId(userIdValue) || fallbackUserId;

  const doc = new Clocking({
    userId: resolvedUserId,
    projectId: asObjectId(projectId),
    type: CLOCK_TYPES.includes(type) ? type : 'present',
    at: at ? new Date(at) : new Date(),
    notes: notes || '',
    createdBy: reqUser?.sub || 'system',
    orgId: reqUser?.orgId || 'root',
  });

  const nLat = lat !== undefined ? Number(lat) : undefined;
  const nLng = lng !== undefined ? Number(lng) : undefined;
  const nAcc = acc !== undefined ? Number(acc) : undefined;
  if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
    doc.location = {
      lat: nLat,
      lng: nLng,
      ...(Number.isFinite(nAcc) ? { acc: nAcc } : {}),
    };
  }

  if (attachment && attachment.url) {
    doc.attachments = [
      {
        filename: attachment.filename || 'file',
        url: attachment.url,
        mime: attachment.mime || 'application/octet-stream',
        size: attachment.size || undefined,
        uploadedBy: reqUser?.sub || 'system',
      },
    ];
  }
  return doc;
}

/* ----------------------- CREATE (single or bulk) ----------------------- */
router.post('/', requireAuth, async (req, res) => {
  try {
    // default target = current user when not specified
    const currentUserId = editorObjectIdQuick(req);

    const { userId, userIds } = req.body || {};

    if (Array.isArray(userIds) && userIds.length) {
      // visibility: non-admin can only create for accessible userIds
      if (!isAdmin(req)) {
        const set = getAccessibleSet(req);
        const blocked = userIds
          .map(asObjectId)
          .filter(Boolean)
          .filter((oid) => !set.has(String(oid)));
        if (blocked.length) {
          return res.status(403).json({ error: 'Forbidden: one or more users not visible for bulk create' });
        }
      }

      const docs = userIds.map((uid) => buildClockDoc(req.body, uid, req.user, currentUserId));
      const saved = await Clocking.insertMany(docs);
      return res.status(201).json(saved);
    }

    const effectiveUserId = asObjectId(userId) || currentUserId;
    if (!effectiveUserId) {
      return res.status(400).json({ error: 'userId required (or must be inferable from auth)' });
    }

    if (!isAdmin(req) && !assertVisibleOr403(req, effectiveUserId, res)) return;

    const one = buildClockDoc(req.body, effectiveUserId, req.user, currentUserId);
    await one.save();
    return res.status(201).json(one);
  } catch (e) {
    console.error('POST /clockings error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- UPDATE (audited; enforces visibility) ---------------- */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const doc = await Clocking.findOne({ _id: req.params.id, orgId: req.user?.orgId });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Non-admin must be able to see this clocking
    if (!isAdmin(req) && !assertVisibleOr403(req, doc.userId, res)) return;

    // Snapshot "before"
    const before = {
      type: doc.type,
      at: doc.at,
      notes: doc.notes,
      projectId: doc.projectId,
      userId: doc.userId,
      location: doc.location ? { ...(doc.location.toObject?.() ?? doc.location) } : undefined,
      attachments: (doc.attachments || []).map((a) => a.toObject?.() ?? a),
    };

    const { type, at, notes, projectId, userId, lat, lng, acc, attachment, editNote } = req.body || {};

    if (type && CLOCK_TYPES.includes(type)) doc.type = type;
    if (at != null) doc.at = new Date(at);
    if (notes != null) doc.notes = notes;

    if (projectId !== undefined) doc.projectId = asObjectId(projectId);
    if (userId !== undefined) {
      const newUid = asObjectId(userId);
      if (!isAdmin(req) && newUid && !assertVisibleOr403(req, newUid, res)) return;
      doc.userId = newUid;
    }

    const hasLocInput = ['lat', 'lng', 'acc'].some((k) => Object.prototype.hasOwnProperty.call(req.body, k));
    if (hasLocInput) {
      const nLat = lat !== undefined ? Number(lat) : undefined;
      const nLng = lng !== undefined ? Number(lng) : undefined;
      const nAcc = acc !== undefined ? Number(acc) : undefined;

      if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
        doc.location = {
          lat: nLat,
          lng: nLng,
          ...(Number.isFinite(nAcc) ? { acc: nAcc } : {}),
        };
      } else {
        doc.location = undefined;
      }
    }

    if (attachment && attachment.url) {
      doc.attachments = [
        {
          filename: attachment.filename || 'file',
          url: attachment.url,
          mime: attachment.mime || 'application/octet-stream',
          size: attachment.size || undefined,
          uploadedBy: req.user?.sub || 'system',
        },
      ];
    }

    // After & diff
    const after = {
      type: doc.type,
      at: doc.at,
      notes: doc.notes,
      projectId: doc.projectId,
      userId: doc.userId,
      location: doc.location ? { ...(doc.location.toObject?.() ?? doc.location) } : undefined,
      attachments: (doc.attachments || []).map((a) => a.toObject?.() ?? a),
    };
    const changes = collectChanges(before, after);

    // Write audit if we have an editor id
    if (changes.length > 0) {
      const editorId = await resolveEditorId(req);

      if (editorId) {
        doc.lastEditedAt = new Date();
        doc.lastEditedBy = editorId;
        doc.editLog = doc.editLog || [];
        doc.editLog.push({
          editedAt: doc.lastEditedAt,
          editedBy: editorId,
          note: editNote || '',
          changes,
        });
      } else {
        // no editor id available — optionally enforce failure
        if (String(process.env.ALLOW_CLOCKING_UPDATE_WITHOUT_EDITOR || '1') !== '1') {
          return res
            .status(400)
            .json({ error: 'editedBy missing — cannot audit update (auth user id not available)' });
        }
        // otherwise, skip audit but save changes
        res.setHeader('X-Audit', 'skipped-no-editor');
      }
    }

    await doc.save();

    // respond with populated doc so UI can show Edited by
    const saved = await Clocking.findById(doc._id).populate('lastEditedBy', 'name email').lean();

    res.json(saved);
  } catch (e) {
    console.error('PUT /clockings/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- DELETE ------------------------------ */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const doc = await Clocking.findOne({ _id: req.params.id, orgId: req.user?.orgId }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if (!isAdmin(req) && !assertVisibleOr403(req, doc.userId, res)) return;

    await Clocking.deleteOne({ _id: req.params.id });
    res.sendStatus(204);
  } catch (e) {
    console.error('DELETE /clockings/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
