// core-backend/routes/groups.js
const express = require('express');
const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/User'); // optional, handy if you later validate users
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
console.log('[routes/groups] mongo-backed groups router loaded');

/* ------------------------------ helpers ------------------------------ */

const asOid = (x) =>
  (mongoose.Types.ObjectId.isValid(String(x)) ? new mongoose.Types.ObjectId(String(x)) : null);

const wantsObjectId = (model, p) => model?.schema?.path(p)?.instance === 'ObjectId';

function orgFilterFromReq(model, req) {
  if (!model?.schema?.path('orgId')) return {};
  const raw = req.user?.orgId;
  if (!raw) return {};
  const s = String(raw);
  // Superadmin / cross-org view
  if (s.toLowerCase() === 'root') return {};
  if (wantsObjectId(model, 'orgId')) {
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  return { orgId: s };
}

/**
 * For writes: decide which orgId to store.
 * - If token has a real orgId => use it.
 * - If token has "root" => accept org from body, headers (x-org-id/x-org/x-orgid), or query (?orgId=).
 * Returns { ok: true, orgId } or { ok: false, error }.
 */
function resolveOrgForWrite(model, req, bodyOrgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return { ok: true, orgId: undefined }; // model not org-scoped

  const tokenOrg = String(req.user?.orgId || '');

  // Normal org-scoped token → use it directly
  if (tokenOrg && tokenOrg.toLowerCase() !== 'root') {
    if (p.instance === 'ObjectId') {
      if (!mongoose.Types.ObjectId.isValid(tokenOrg)) {
        return { ok: false, error: 'Invalid orgId on token' };
      }
      return { ok: true, orgId: new mongoose.Types.ObjectId(tokenOrg) };
    }
    return { ok: true, orgId: tokenOrg };
  }

  // Superadmin ("root") token → allow body, header, or query
  const headerOrg =
    req.headers['x-org-id'] ||
    req.headers['x-org'] ||
    req.headers['x-orgid'];
  const suppliedRaw =
    bodyOrgId != null ? bodyOrgId :
    headerOrg != null ? headerOrg :
    (req.query?.orgId != null ? req.query.orgId : null);

  const supplied = suppliedRaw != null ? String(suppliedRaw) : '';
  if (!supplied) return { ok: false, error: 'orgId is required (superadmin token)' };

  if (p.instance === 'ObjectId') {
    if (!mongoose.Types.ObjectId.isValid(supplied)) {
      return { ok: false, error: 'Invalid orgId format' };
    }
    return { ok: true, orgId: new mongoose.Types.ObjectId(supplied) };
  }
  return { ok: true, orgId: supplied };
}

function ensureOrgOnDoc(model, doc, req, bodyOrgId) {
  const p = model?.schema?.path('orgId');
  if (!p) return true;
  const has = doc.orgId != null && String(doc.orgId) !== '';
  if (has) return true;

  const pick = resolveOrgForWrite(model, req, bodyOrgId);
  if (!pick.ok) return false;
  doc.orgId = pick.orgId;
  return true;
}

function uniqueSet(arr) {
  return Array.from(new Set(arr.map((x) => String(x)))).map((s) => asOid(s) || s);
}

/* ------------------------------- LIST --------------------------------- */
router.get('/', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);

    const role = String(req.user?.role || '').toLowerCase();
    const isAdmin = role === 'admin' || role === 'superadmin';

    const filter = { ...orgFilterFromReq(Group, req), isDeleted: { $ne: true } };
    if (q) filter.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Non-admins: show groups they lead OR belong to
    if (!isAdmin) {
      const me = asOid(req.user?._id) || req.user?._id;
      if (!me) return res.status(401).json({ error: 'Unauthorized' });
      filter.$or = [{ memberUserIds: me }, { leaderUserIds: me }];
    }

    const rows = await Group.find(filter).sort({ name: 1 }).limit(limit).lean();
    res.json(rows);
  } catch (e) {
    console.error('GET /groups error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------------- READ -------------------------------- */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = asOid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid group id' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    }).lean();
    if (!g) return res.status(404).json({ error: 'Not found' });

    // Non-admins must be leaders OR members
    const isAdmin = ['admin', 'superadmin'].includes(String(req.user?.role || '').toLowerCase());
    const me = asOid(req.user?._id) || req.user?._id;
    if (
      !isAdmin &&
      !(
        (g.memberUserIds || []).map(String).includes(String(me)) ||
        (g.leaderUserIds || []).map(String).includes(String(me))
      )
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(g);
  } catch (e) {
    console.error('GET /groups/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- CREATE ------------------------------- */
router.post('/', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, description, leaderUserId, leaderUserIds, memberUserIds, orgId: bodyOrgId } =
      req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    // Normalize leaders array (supports legacy single leaderUserId)
    let leaders = [];
    if (Array.isArray(leaderUserIds)) leaders = leaderUserIds.map(asOid).filter(Boolean);
    if (leaderUserId) leaders = uniqueSet([...(leaders || []), asOid(leaderUserId)].filter(Boolean));

    const members = Array.isArray(memberUserIds)
      ? memberUserIds.map(asOid).filter(Boolean)
      : [];

    const doc = new Group({
      name: String(name).trim(),
      description: description || '',
      leaderUserIds: leaders, // preferred field
      memberUserIds: members,
      isDeleted: false,
      createdBy: req.user?.email || String(req.user?._id || ''),
      updatedBy: req.user?.email || String(req.user?._id || ''),
    });

    if (!ensureOrgOnDoc(Group, doc, req, bodyOrgId)) {
      return res
        .status(400)
        .json({ error: 'orgId missing/invalid (supply body.orgId with superadmin token)' });
    }

    await doc.save();
    res.status(201).json(doc);
  } catch (e) {
    console.error('POST /groups error:', e);
    if (e && e.code === 11000) return res.status(400).json({ error: 'Group name already exists' });
    if (e?.name === 'CastError') return res.status(400).json({ error: 'Invalid ID format' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- UPDATE ------------------------------- */
router.put('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid group id' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    });
    if (!g) return res.status(404).json({ error: 'Not found' });

    const { name, description, leaderUserId, leaderUserIds, memberUserIds, orgId: bodyOrgId } =
      req.body || {};

    if (name !== undefined) g.name = String(name).trim();
    if (description !== undefined) g.description = String(description);

    if (leaderUserIds !== undefined || leaderUserId !== undefined) {
      let leaders = Array.isArray(leaderUserIds)
        ? leaderUserIds.map(asOid).filter(Boolean)
        : g.leaderUserIds || [];
      if (leaderUserId) leaders = uniqueSet([...(leaders || []), asOid(leaderUserId)].filter(Boolean));
      g.leaderUserIds = leaders;
    }

    if (memberUserIds !== undefined) {
      g.memberUserIds = Array.isArray(memberUserIds)
        ? memberUserIds.map(asOid).filter(Boolean)
        : [];
    }

    g.updatedBy = req.user?.email || String(req.user?._id || '');

    // Ensure orgId for legacy docs (or if superadmin wants to assign)
    if (!g.orgId) {
      if (!ensureOrgOnDoc(Group, g, req, bodyOrgId)) {
        return res
          .status(400)
          .json({ error: 'orgId missing/invalid (supply body.orgId with superadmin token)' });
      }
    }

    await g.save();
    res.json(g);
  } catch (e) {
    console.error('PUT /groups/:id error:', e);
    if (e && e.code === 11000) return res.status(400).json({ error: 'Group name already exists' });
    if (e?.name === 'CastError') return res.status(400).json({ error: 'Invalid ID format' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* ----------------------------- SOFT DELETE ---------------------------- */
router.delete('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid group id' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    });
    if (!g) return res.status(404).json({ error: 'Not found' });

    g.isDeleted = true;
    g.updatedBy = req.user?.email || String(req.user?._id || '');
    await g.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /groups/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------ MEMBERS ------------------------------- */
router.post('/:id/members', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid group id' });

    const userId = asOid(req.body?.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    });
    if (!g) return res.status(404).json({ error: 'Not found' });

    g.memberUserIds = uniqueSet([...(g.memberUserIds || []), userId]);
    g.updatedBy = req.user?.email || String(req.user?._id || '');
    await g.save();
    res.json(g);
  } catch (e) {
    console.error('POST /groups/:id/members error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/members/:userId', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id);
    const userId = asOid(req.params.userId);
    if (!id || !userId) return res.status(400).json({ error: 'Invalid id(s)' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    });
    if (!g) return res.status(404).json({ error: 'Not found' });

    g.memberUserIds = (g.memberUserIds || []).filter((u) => String(u) !== String(userId));
    g.updatedBy = req.user?.email || String(req.user?._id || '');
    await g.save();
    res.json(g);
  } catch (e) {
    console.error('DELETE /groups/:id/members/:userId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- LEADERS ------------------------------- */
router.post('/:id/leader', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = asOid(req.params.id);
    const leader = asOid(req.body?.userId); // add single leader (helper)
    if (!id) return res.status(400).json({ error: 'Invalid group id' });

    const g = await Group.findOne({
      _id: id,
      ...orgFilterFromReq(Group, req),
      isDeleted: { $ne: true },
    });
    if (!g) return res.status(404).json({ error: 'Not found' });

    if (leader) {
      g.leaderUserIds = uniqueSet([...(g.leaderUserIds || []), leader]);
    } else {
      g.leaderUserIds = []; // if no userId supplied, clear leaders
    }
    g.updatedBy = req.user?.email || String(req.user?._id || '');
    await g.save();
    res.json(g);
  } catch (e) {
    console.error('POST /groups/:id/leader error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
