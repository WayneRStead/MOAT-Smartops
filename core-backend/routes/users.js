// core-backend/routes/users.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const Group = require('../models/Group');
const { requireAuth, requireRole, resolveOrgContext, requireOrg } = require('../middleware/auth');

/* ----------------------------- role canon ----------------------------- */
const CANON_ROLES = [
  'worker',
  'group-leader',
  'project-manager',
  'manager',
  'admin',
  'superadmin', // <-- org-scoped "superadmin" role; creation gated by global superadmin below
];

function normalizeRole(r) {
  if (!r) return 'worker';
  let s = String(r).trim().toLowerCase().replace(/\s+/g, '-');
  if (s === 'user' || s === 'users') s = 'worker';
  if (!CANON_ROLES.includes(s)) s = 'worker';
  return s;
}

/* ------------------------------ guards ------------------------------- */
// Apply to every route in this file (tenant-scoped)
router.use(requireAuth, resolveOrgContext, requireOrg);

/* ----------------------------- helpers ----------------------------- */
function asOid(x) {
  const s = String(x || '');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Build an org filter that prefers the per-request org (from x-org-id)
 * parsed by resolveOrgContext (req.orgObjectId/req.orgId), falling back
 * to the token’s org (req.user.orgId). Matches the model’s orgId type.
 */
function orgFilterFromReq(model, req) {
  if (!model?.schema?.path('orgId')) return {};
  // precedence: header/query/body -> token
  const explicit = req.orgObjectId || req.orgId;
  const fallback = req.user?.orgId;

  const p = model.schema.path('orgId');
  if (p.instance === 'ObjectId') {
    if (explicit && explicit instanceof mongoose.Types.ObjectId) return { orgId: explicit };
    const s = String(explicit || fallback || '');
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  const s = String(explicit || fallback || '');
  return s ? { orgId: s } : {};
}

/**
 * Ensure the doc has orgId set, preferring request org (header) over token.
 */
function ensureOrgOnDoc(model, doc, req) {
  const p = model?.schema?.path('orgId');
  if (!p) return true;
  const has = doc.orgId != null && String(doc.orgId) !== '';
  if (has) return true;

  const explicit = req.orgObjectId || req.orgId;
  const fallback = req.user?.orgId;

  if (p.instance === 'ObjectId') {
    if (explicit && explicit instanceof mongoose.Types.ObjectId) { doc.orgId = explicit; return true; }
    const s = String(explicit || fallback || '');
    if (!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId = new mongoose.Types.ObjectId(s);
    return true;
  } else {
    const s = String(explicit || fallback || '');
    if (!s) return false;
    doc.orgId = s;
    return true;
  }
}

/** Strip fields we never want to leak from tenant endpoints */
function stripSecrets(u) {
  if (!u) return u;
  const { password, passwordHash, isGlobalSuperadmin, globalRole, ...rest } = u;
  return rest;
}

/* ---------------------- placeholder upload helpers --------------------- */
function mintPhotoObjectId(userId, mimeType) {
  const ext =
    (mimeType && mimeType.includes('jpeg')) ? 'jpg' :
    (mimeType && mimeType.includes('png'))  ? 'png' : 'bin';
  return `${userId}/${Date.now()}.${ext}`;
}

/* --------------------------- safety helpers --------------------------- */
function assertNoGlobalFields(reqBody) {
  if (reqBody == null || typeof reqBody !== 'object') return;
  if ('isGlobalSuperadmin' in reqBody || 'globalRole' in reqBody) {
    const err = new Error('Global fields cannot be set from tenant routes');
    err.status = 403;
    throw err;
  }
}
function forbidSuperadminUnlessGlobal(req, incomingRole) {
  const role = normalizeRole(incomingRole);
  if (role === 'superadmin' && req.user?.isGlobalSuperadmin !== true) {
    const err = new Error('Only a platform global superadmin can assign the role "superadmin"');
    err.status = 403;
    throw err;
  }
}

/* --------------------------- roles endpoint --------------------------- */
router.get('/roles', (_req, res) => {
  res.json(CANON_ROLES);
});

/* ------------------------------- LIST ------------------------------- */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const missingPhoto = String(req.query.missingPhoto || '').toLowerCase() === 'true';

    const roleNorm = normalizeRole(req.user?.role);
    const isAdmin = ['admin','superadmin','manager','project-manager'].includes(roleNorm);

    const scope = orgFilterFromReq(User, req);
    let find = { ...scope, isDeleted: { $ne: true } };

    if (!isAdmin && req.user?._id) {
      const myId = asOid(req.user._id);
      if (!myId) return res.status(401).json({ error: 'Unauthorized' });
      find._id = myId;
    }

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      find.$or = [
        { name: rx },
        { email: rx },
        { username: rx },
        { staffNumber: rx },
        { role: rx },
      ];
    }

    if (status) find['biometric.status'] = status;

    if (missingPhoto) {
      find.$and = (find.$and || []).concat([{
        $or: [
          { photo: { $exists: false } },
          { 'photo.objectId': { $exists: false } },
        ],
      }]);
    }

    const rows = await User.find(find).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows.map(stripSecrets));
  } catch (e) {
    console.error('GET /users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------------- READ ------------------------------- */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid user id' });
    }
    const doc = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req) }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(stripSecrets(doc));
  } catch (e) {
    console.error('GET /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- CREATE ------------------------------ */
router.post('/', requireRole('project-manager','manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { name, email, username, staffNumber, role = 'worker', password, active } = req.body || {};
    if (!email && !username && !staffNumber) {
      return res.status(400).json({ error: 'Provide at least one of: email, username, or staffNumber' });
    }

    forbidSuperadminUnlessGlobal(req, role);

    // normalize identifiers: empty string -> undefined
    const normEmail = email != null ? String(email).trim().toLowerCase() : undefined;
    const normUsername = username != null ? String(username).trim() : undefined;
    const normStaff = staffNumber != null ? String(staffNumber).trim() : undefined;

    const doc = new User({
      name: name || '',
      email: normEmail || undefined,
      username: normUsername || undefined,
      staffNumber: normStaff || undefined,
      role: normalizeRole(role),
      active: active !== undefined ? !!active : true,
      biometric: { status: 'pending', lastUpdatedAt: new Date() },
    });

    if (!ensureOrgOnDoc(User, doc, req)) {
      return res.status(400).json({ error: 'orgId is required on User; include header "x-org-id" or ensure token has orgId' });
    }

    if (password) doc.password = password;

    await doc.save();
    res.status(201).json(stripSecrets(doc.toObject({ versionKey: false })));
  } catch (e) {
    console.error('POST /users error:', e);
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === 11000) return res.status(400).json({ error: 'Email/username/staffNumber already exists in your org' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------- UPDATE ------------------------------ */
router.put('/:id', requireRole('project-manager','manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid user id' });
    }
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req) };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const { name, email, username, staffNumber, role, active, password } = req.body || {};

    if (role !== undefined) {
      forbidSuperadminUnlessGlobal(req, role);
    }

    const normEmail = email !== undefined ? String(email).trim().toLowerCase() : undefined;
    const normUsername = username !== undefined ? String(username).trim() : undefined;
    const normStaff = staffNumber !== undefined ? String(staffNumber).trim() : undefined;

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = normEmail || undefined;
    if (username !== undefined) user.username = normUsername || undefined;
    if (staffNumber !== undefined) user.staffNumber = normStaff || undefined;
    if (role !== undefined) user.role = normalizeRole(role);
    if (active !== undefined) user.active = !!active;
    if (password) user.password = password;

    if (!ensureOrgOnDoc(User, user, req)) {
      return res.status(400).json({ error: 'orgId is required on User; include header "x-org-id" or ensure token has orgId' });
    }

    await user.save();
    res.json(stripSecrets(user.toObject({ versionKey: false })));
  } catch (e) {
    console.error('PUT /users/:id error:', e);
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === 11000) return res.status(400).json({ error: 'Email/username/staffNumber already exists in your org' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* --------------------------- RESET PASSWORD --------------------------- */
router.post('/:id/reset-password', requireRole('admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid user id' });
    }
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'password required (min 6 chars)' });
    }

    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req) };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    if (!ensureOrgOnDoc(User, user, req)) {
      return res.status(400).json({ error: 'orgId is required on User; include header "x-org-id" or ensure token has orgId' });
    }

    user.password = String(password);
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /users/:id/reset-password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ----------------------------- PHOTO FLOW ----------------------------- */
router.post('/:id/photo/upload-init', requireRole('project-manager','manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { mimeType } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });

    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } });
    if (!user) return res.status(404).json({ error: 'Not found' });

    const objectId = mintPhotoObjectId(user._id, mimeType || 'application/octet-stream');

    res.json({
      objectId,
      uploadUrl: `https://placeholder-upload.local/${encodeURIComponent(objectId)}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error('POST /users/:id/photo/upload-init error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/photo/confirm', requireRole('project-manager','manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { objectId, hash, deviceId, url } = req.body || {};
    if (!objectId) return res.status(400).json({ error: 'objectId required' });
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });

    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    user.photo = {
      objectId: String(objectId),
      url: url ? String(url) : undefined,
      uploadedBy: asOid(req.user?._id),
      uploadedAt: new Date(),
      deviceId: deviceId ? String(deviceId) : undefined,
      hash: hash ? String(hash) : undefined,
    };
    await user.save();

    res.json({ ok: true, photo: user.photo });
  } catch (e) {
    console.error('POST /users/:id/photo/confirm error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------------- BIOMETRIC ENROLLMENT FLOW --------------------- */
router.post('/:id/biometric/start', requireRole('project-manager','manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { method = 'self' } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });

    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } };
    const user = await User.findOne(where);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const token = Buffer.from(`${user._id}:${Date.now()}`).toString('base64url');
    const policy = { requireLiveness: true, minLivenessScore: 0.5, autoApprove: false };

    user.biometric = {
      ...(user.biometric || {}),
      status: 'pending',
      lastUpdatedAt: new Date(),
    };
    await user.save();

    res.json({ token, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), policy, method });
  } catch (e) {
    console.error('POST /users/:id/biometric/start error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/biometric/submit', async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { token, templateVersion, embedding, livenessScore, deviceId, appVersion, geo, capturedAt, photoObjectId, consentVersion, consentedAt } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });
    if (!token) return res.status(400).json({ error: 'enrollment token required' });
    if (!templateVersion) return res.status(400).json({ error: 'templateVersion required' });
    if (!embedding) return res.status(400).json({ error: 'embedding (base64) required' });

    const whereUser = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } };
    const user = await User.findOne(whereUser);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const enr = new BiometricEnrollment({
      orgId: user.orgId,
      userId: user._id,
      status: 'pending',
      templateVersion: String(templateVersion),
      embedding: Buffer.from(String(embedding), 'base64'),
      livenessScore: typeof livenessScore === 'number' ? livenessScore : undefined,
      captureMeta: {
        deviceId: deviceId ? String(deviceId) : undefined,
        appVersion: appVersion ? String(appVersion) : undefined,
        geo: geo && typeof geo.lat === 'number' && typeof geo.lon === 'number' ? { lat: geo.lat, lon: geo.lon } : undefined,
        capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
      },
      photoObjectId: photoObjectId ? String(photoObjectId) : undefined,
      consentVersion: consentVersion ? String(consentVersion) : undefined,
      consentedAt: consentedAt ? new Date(consentedAt) : new Date(),
    });
    await enr.save();

    user.biometric = {
      ...(user.biometric || {}),
      status: 'pending',
      templateVersion: String(templateVersion),
      lastLivenessScore: typeof livenessScore === 'number' ? livenessScore : user.biometric?.lastLivenessScore,
      lastUpdatedAt: new Date(),
    };
    await user.save();

    res.status(201).json({ ok: true, enrollmentId: enr._id });
  } catch (e) {
    console.error('POST /users/:id/biometric/submit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/biometric/approve', requireRole('manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { enrollmentId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });
    if (!mongoose.Types.ObjectId.isValid(enrollmentId)) return res.status(400).json({ error: 'invalid enrollment id' });

    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } });
    if (!user) return res.status(404).json({ error: 'Not found' });

    const enr = await BiometricEnrollment.findOne({ _id: new mongoose.Types.ObjectId(enrollmentId), orgId: user.orgId, userId: user._id });
    if (!enr) return res.status(404).json({ error: 'enrollment not found' });

    enr.status = 'enrolled';
    enr.approvedBy = asOid(req.user?._id);
    enr.approvedAt = new Date();
    await enr.save();

    user.biometric = {
      ...(user.biometric || {}),
      status: 'enrolled',
      templateVersion: enr.templateVersion,
      lastLivenessScore: enr.livenessScore,
      lastUpdatedAt: new Date(),
    };
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /users/:id/biometric/approve error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/biometric/reject', requireRole('manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { enrollmentId, reason } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });
    if (!mongoose.Types.ObjectId.isValid(enrollmentId)) return res.status(400).json({ error: 'invalid enrollment id' });

    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } });
    if (!user) return res.status(404).json({ error: 'Not found' });

    const enr = await BiometricEnrollment.findOne({ _id: new mongoose.Types.ObjectId(enrollmentId), orgId: user.orgId, userId: user._id });
    if (!enr) return res.status(404).json({ error: 'enrollment not found' });

    enr.status = 'rejected';
    enr.rejectedBy = asOid(req.user?._id);
    enr.rejectedAt = new Date();
    enr.rejectReason = reason ? String(reason) : undefined;
    await enr.save();

    user.biometric = {
      ...(user.biometric || {}),
      status: 'rejected',
      lastUpdatedAt: new Date(),
    };
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /users/:id/biometric/reject error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/biometric/revoke', requireRole('manager','admin','superadmin'), async (req, res) => {
  try {
    assertNoGlobalFields(req.body);

    const { id } = req.params;
    const { reason } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });

    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } });
    if (!user) return res.status(404).json({ error: 'Not found' });

    await BiometricEnrollment.updateMany(
      { orgId: user.orgId, userId: user._id, status: { $in: ['pending','enrolled'] } },
      { $set: { status: 'revoked', revokedBy: asOid(req.user?._id), revokedAt: new Date(), revokeReason: reason ? String(reason) : undefined } }
    );

    user.biometric = {
      ...(user.biometric || {}),
      status: 'revoked',
      lastUpdatedAt: new Date(),
    };
    await user.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /users/:id/biometric/revoke error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/biometric/status', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid user id' });
    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req), isDeleted: { $ne: true } }).lean();
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { biometric = { status: 'not-enrolled' } } = user;
    res.json({ status: biometric.status, templateVersion: biometric.templateVersion, lastLivenessScore: biometric.lastLivenessScore, lastUpdatedAt: biometric.lastUpdatedAt });
  } catch (e) {
    console.error('GET /users/:id/biometric/status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------ DELETE ------------------------------ */
router.delete('/:id', requireRole('admin','superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid user id' });
    }
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(User, req) };
    const u = await User.findOne(where);
    if (!u) return res.status(404).json({ error: 'Not found' });

    u.isDeleted = true;
    u.active = false;
    u.biometric = { ...(u.biometric || {}), status: 'revoked', lastUpdatedAt: new Date() };
    await u.save();

    await BiometricEnrollment.updateMany(
      { orgId: u.orgId, userId: u._id, status: { $in: ['pending','enrolled'] } },
      { $set: { status: 'revoked', revokedBy: asOid(req.user?._id), revokedAt: new Date(), revokeReason: 'user deleted' } }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------------------- BULK UPLOAD ----------------------------- */
/**
 * Accepts CSV or XLSX with columns:
 *  - name, email, username, staffNumber, role, groupName
 * Behavior:
 *  - Creates or updates users (org-scoped), setting biometric.status='pending' for new users.
 *  - Creates or finds the group by (orgId, groupName).
 *  - If a row role is 'group-leader', that user becomes the group's single leader.
 *  - Adds all users with that groupName to the group's members.
 */
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/bulk-upload', requireRole('project-manager','manager','admin','superadmin'), upload.single('file'), async (req, res) => {
  try {
    const orgScope = orgFilterFromReq(User, req);
    if (!orgScope.orgId) {
      return res.status(400).json({ error: 'orgId missing/invalid; include header "x-org-id"' });
    }

    if (!req.file) return res.status(400).json({ error: 'file required' });

    // --- Parse incoming file ---
    const mime = req.file.mimetype || '';
    let rows = [];

    // Try XLSX if available and mime suggests spreadsheet
    let xlsxTried = false;
    if (/sheet|excel/i.test(mime)) {
      try {
        const xlsx = require('xlsx'); // optional dependency
        const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
        xlsxTried = true;
      } catch {
        // fall back to CSV
      }
    }
    if (!rows.length) {
      // Fallback basic CSV parser (RFC-lite)
      const text = req.file.buffer.toString('utf8');
      rows = csvToJson(text);
    }
    if (!rows.length) {
      return res.status(400).json({ error: xlsxTried ? 'Failed to read spreadsheet (and no CSV fallback)' : 'Empty or invalid CSV' });
    }

    // Normalize headers we care about
    const mapField = (obj, key) => {
      const k = Object.keys(obj).find(h => String(h).trim().toLowerCase() === key);
      return k ? obj[k] : '';
    };

    // We'll accumulate per-group membership/leader decisions
    const byGroup = new Map(); // groupName -> { leaderUserId?: ObjectId, memberUserIds: Set<ObjectId> }

    let created = 0, updated = 0, grouped = 0, groupsTouched = 0, errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const name = String(mapField(r, 'name') || '').trim();
      const email = String(mapField(r, 'email') || '').trim().toLowerCase();
      const username = String(mapField(r, 'username') || '').trim();
      const staffNumber = String(mapField(r, 'staffnumber') || mapField(r, 'staff #') || mapField(r, 'staff_no') || mapField(r, 'staff no') || '').trim();
      const roleIn = String(mapField(r, 'role') || '').trim();
      const groupName = String(mapField(r, 'groupname') || mapField(r, 'group') || '').trim();

      const role = normalizeRole(roleIn || 'worker');
      if (!name || (!email && !username && !staffNumber)) {
        errors.push({ row: i+1, error: 'Name and one of (email|username|staffNumber) required' });
        continue;
      }

      // Only platform global superadmin may bulk-create superadmin
      if (role === 'superadmin' && req.user?.isGlobalSuperadmin !== true) {
        errors.push({ row: i+1, error: 'Role "superadmin" requires platform global superadmin' });
        continue;
      }

      // Find existing user by org + one of unique identifiers in priority order
      const uniqueQuery = { ...orgScope, isDeleted: { $ne: true } };
      const or = [];
      if (email) or.push({ email });
      if (username) or.push({ username });
      if (staffNumber) or.push({ staffNumber });
      if (or.length === 0) {
        errors.push({ row: i+1, error: 'No unique identifier present' });
        continue;
      }
      const existing = await User.findOne({ ...uniqueQuery, $or: or });

      if (!existing) {
        // Create new user
        const doc = new User({
          ...orgScope,
          name,
          email: email || undefined,
          username: username || undefined,
          staffNumber: staffNumber || undefined,
          role,
          active: true,
          biometric: { status: 'pending', lastUpdatedAt: new Date() },
        });
        await doc.save();
        created++;

        if (groupName) {
          upsertGroupAccumulator(byGroup, groupName, doc._id, role);
        }
      } else {
        // Update certain fields, keep role if provided (same guard)
        if (name) existing.name = name;
        if (email) existing.email = email || undefined;
        if (username) existing.username = username || undefined;
        if (staffNumber) existing.staffNumber = staffNumber || undefined;
        if (role) existing.role = role;
        await existing.save();
        updated++;

        if (groupName) {
          upsertGroupAccumulator(byGroup, groupName, existing._id, role);
        }
      }
    }

    // Apply group assignments
    const orgIdValue = orgScope.orgId;
    for (const [gname, info] of byGroup.entries()) {
      // find or create group (org-scoped unique name)
      let g = await Group.findOrCreateByName(orgIdValue, gname, {
        createdBy: req.user?.email || String(req.user?._id || ''),
        updatedBy: req.user?.email || String(req.user?._id || ''),
      });

      // Replace leader if we have one in the batch
      if (info.leaderUserId) {
        g.leaderUserIds = [info.leaderUserId];
      }

      // Merge members
      const set = new Set((g.memberUserIds || []).map(x => String(x)));
      for (const uId of info.memberUserIds) set.add(String(uId));
      g.memberUserIds = Array.from(set)
        .map(s => asOid(s))
        .filter(Boolean); // <- avoid nulls

      g.updatedBy = req.user?.email || String(req.user?._id || '');
      await g.save();

      groupsTouched++;
      grouped += info.memberUserIds.size;
    }

    res.json({ ok: true, created, updated, grouped, groupsTouched, errors });
  } catch (e) {
    console.error('POST /users/bulk-upload error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------- CSV convenience --------------------------- */
function csvToJson(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];
  const parseLine = (s) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        if (inQ && s[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]).map(h => String(h || '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i];
    if (!s || !s.trim()) continue;
    const cols = parseLine(s);
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cols[j] ?? '';
    rows.push(obj);
  }
  return rows;
}

function upsertGroupAccumulator(map, groupName, userId, role) {
  const key = String(groupName).trim();
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, { leaderUserId: null, memberUserIds: new Set() });
  }
  const info = map.get(key);
  info.memberUserIds.add(userId);
  if (role === 'group-leader') {
    info.leaderUserId = userId; // single leader semantics
  }
}

module.exports = router;
