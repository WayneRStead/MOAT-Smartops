// core-backend/routes/clockings.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Clocking = require('../models/Clocking');
const { CLOCK_TYPES } = require('../models/Clocking');
const User = require('../models/User');
// Safe model reference (avoids OverwriteModelError if loaded elsewhere)
const Group = mongoose.models.Group || require('../models/Group');

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

const hasPath = (model, p) => !!(model && model.schema && model.schema.path && model.schema.path(p));
const wantsObjectId = (model, p) => model?.schema?.path(p)?.instance === 'ObjectId';

// org filter that respects a model's orgId type (String vs ObjectId)
// IMPORTANT: treat token orgId === "root" as cross-org (no filter)
function orgFilterForModel(model, req) {
  if (!hasPath(model, 'orgId')) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  if (s.toLowerCase() === 'root') return {}; // superadmin cross-org
  const asOid = wantsObjectId(model, 'orgId') && mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
  return wantsObjectId(model, 'orgId') ? (asOid ? { orgId: asOid } : {}) : { orgId: s };
}

// org filter for Clocking (uses function above)
function orgFilterFromReq(req) {
  return orgFilterForModel(Clocking, req);
}

// Try to assign doc.orgId using:
// 1) token orgId if it's concrete (and not "root")
// 2) otherwise, infer from the target user (if available)
// 3) otherwise, leave unset (do NOT write "root")
async function assignDocOrgId(doc, reqUser, targetUserId) {
  const path = Clocking.schema.path('orgId');
  if (!path) return; // schema might not have orgId in some forks

  // 1) concrete token orgId
  const tOrg = String(reqUser?.orgId || '');
  if (tOrg && tOrg.toLowerCase() !== 'root') {
    if (path.instance === 'ObjectId') {
      if (mongoose.Types.ObjectId.isValid(tOrg)) {
        doc.orgId = new mongoose.Types.ObjectId(tOrg);
      }
    } else {
      doc.orgId = tOrg;
    }
    return;
  }

  // 2) infer from target user
  const uid = asObjectId(targetUserId);
  if (uid) {
    const u = await User.findById(uid).select('orgId').lean();
    if (u && u.orgId != null) {
      if (path.instance === 'ObjectId') {
        if (mongoose.Types.ObjectId.isValid(String(u.orgId))) {
          doc.orgId = new mongoose.Types.ObjectId(String(u.orgId));
        }
      } else {
        doc.orgId = String(u.orgId);
      }
    }
  }

  // 3) else leave doc.orgId unset intentionally
}

// try to get an editor ObjectId from req.user directly
function editorObjectIdQuick(req) {
  const candidates = [req.user?._id, req.user?.id, req.user?.userId, req.user?.sub].filter(Boolean).map(String);
  for (const c of candidates) {
    if (mongoose.Types.ObjectId.isValid(c)) return new mongoose.Types.ObjectId(c);
  }
  return undefined;
}

// async fallback: resolve editor id by looking up the user by email/username/etc.
const _editorCache = new Map(); // cache by key (email/username) -> ObjectId
async function resolveEditorId(req) {
  const fast = editorObjectIdQuick(req);
  if (fast) return fast;

  const keys = [req.user?.sub, req.user?.email, req.user?.username].filter(Boolean).map(String);

  for (const key of keys) {
    if (_editorCache.has(key)) return _editorCache.get(key);

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
  const r = String(req.user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
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

function intersectIds(a, b) {
  const A = new Set((a || []).map(String));
  const out = [];
  for (const id of (b || [])) if (A.has(String(id))) out.push(id);
  return out;
}

/* ------------------------------- LIST ------------------------------- */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { projectId, userId, groupId, groupIds, from, to, q, limit, type } = req.query;
    const find = { ...orgFilterFromReq(req) };

    const pid = asObjectId(projectId);
    if (pid) find.projectId = pid;

    const uid = asObjectId(userId);

    if (type) find.type = type;

    if (from || to) {
      const fromDate = from ? new Date(from) : undefined;
      const toDate = to ? new Date(to) : undefined;
      find.at = {
        ...(fromDate ? { $gte: fromDate } : {}),
        ...(toDate ? { $lte: toDate } : {}),
      };
    }
    if (q) {
      find.$or = [{ notes: new RegExp(q, 'i') }];
    }

    // Build a restriction set of userIds we’re allowed/requesting to see
    let restrictIds = undefined;

    if (uid) {
      // If a specific userId is requested, enforce visibility for non-admins
      if (!assertVisibleOr403(req, uid, res)) return;
      restrictIds = [uid];
    } else if (!isAdmin(req)) {
      // Non-admins: restrict to accessibleUserIds
      const ids = Array.from(getAccessibleSet(req))
        .map((s) => (mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null))
        .filter(Boolean);
      restrictIds = ids;
    }
    // Admins: no user restriction (org filter only)

    // --- Group filter (supports ?groupId=... OR ?groupIds=a,b,c) ---
    const rawGroupParam = String(groupIds ?? groupId ?? '').trim();
    if (rawGroupParam) {
      const scope = orgFilterForModel(Group, req);
      const gids = rawGroupParam
        .split(',')
        .map((s) => asObjectId(s))
        .filter(Boolean);

      let memberIds = [];
      if (gids.length) {
        const groups = await Group.find({ _id: { $in: gids }, ...scope })
          .select('memberUserIds')
          .lean();

        const all = [];
        for (const g of groups) for (const uid2 of (g.memberUserIds || [])) all.push(uid2);

        // de-dupe
        const uniq = Array.from(new Set(all.map((x) => String(x)))).map(
          (s) => new mongoose.Types.ObjectId(s)
        );
        memberIds = uniq;
      }

      if (!memberIds.length) return res.json([]); // no members in selected group(s)

      // Intersect with visibility for non-admins or with requested uid
      if (restrictIds) {
        restrictIds = intersectIds(restrictIds, memberIds);
        if (!restrictIds.length) return res.json([]);
      } else {
        restrictIds = memberIds;
      }
    }

    if (restrictIds) {
      find.userId = { $in: restrictIds };
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
    const doc = await Clocking.findOne({ _id: req.params.id, ...orgFilterFromReq(req) })
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
      { _id: req.params.id, ...orgFilterFromReq(req) },
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
async function buildClockDoc(body, userIdValue, reqUser, fallbackUserId) {
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
  });

  // orgId (prefer token if concrete; else infer from resolved user)
  await assignDocOrgId(doc, reqUser, resolvedUserId);

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

      const docs = await Promise.all(userIds.map(async (uid) => buildClockDoc(req.body, uid, req.user, currentUserId)));
      const saved = await Clocking.insertMany(docs);
      return res.status(201).json(saved);
    }

    const effectiveUserId = asObjectId(userId) || currentUserId;
    if (!effectiveUserId) {
      return res.status(400).json({ error: 'userId required (or must be inferable from auth)' });
    }

    if (!isAdmin(req) && !assertVisibleOr403(req, effectiveUserId, res)) return;

    const one = await buildClockDoc(req.body, effectiveUserId, req.user, currentUserId);
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
    const doc = await Clocking.findOne({ _id: req.params.id, ...orgFilterFromReq(req) });
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
      doc.userId = newUid || doc.userId;
      // If switching user as superadmin (root), try to align orgId to the new user's org
      await assignDocOrgId(doc, req.user, newUid || doc.userId);
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
        if (String(process.env.ALLOW_CLOCKING_UPDATE_WITHOUT_EDITOR || '1') !== '1') {
          return res
            .status(400)
            .json({ error: 'editedBy missing — cannot audit update (auth user id not available)' });
        }
        res.setHeader('X-Audit', 'skipped-no-editor');
      }
    }

    await doc.save();

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
    const doc = await Clocking.findOne({ _id: req.params.id, ...orgFilterFromReq(req) }).lean();
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
