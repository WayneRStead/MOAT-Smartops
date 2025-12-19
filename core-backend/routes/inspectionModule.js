// core-backend/routes/inspectionModule.js
const express = require('express');
const mongoose = require('mongoose');

const InspectionForm = require('../models/InspectionForm');
const InspectionSubmission = require('../models/InspectionSubmission');
const User = require('../models/User'); // for performance assessed user lookups
const { requireRole } = require('../middleware/auth');

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */
const CANON_ROLES = ['user','group-leader','project-manager','manager','admin','superadmin'];

function normalizeRole(r){
  if(!r) return 'user';
  let s = String(r).trim().toLowerCase().replace(/\s+/g,'-');
  if(s==='users') s='user';
  return CANON_ROLES.includes(s) ? s : 'user';
}

function userRoles(reqUser){
  const primary = normalizeRole(reqUser?.role);
  const extras = Array.isArray(reqUser?.roles) ? reqUser.roles.map(normalizeRole) : [];
  return Array.from(new Set([primary, ...extras]));
}

function canRunForm(reqUser, form){
  const allowed = Array.isArray(form?.rolesAllowed) ? form.rolesAllowed.filter(Boolean) : [];
  if (allowed.length === 0) return true; // everyone
  const mine = userRoles(reqUser);
  return mine.some(r => allowed.includes(r));
}

function asOid(x){
  const s = String(x||'');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function wantsObjectId(model, path){
  const p=model?.schema?.path(path);
  return p && p.instance === 'ObjectId';
}

function orgFilterFromReq(model, req){
  if(!model?.schema?.path('orgId')) return {};
  const raw = req.user?.orgId; if(!raw) return {};
  const s = String(raw);
  return wantsObjectId(model,'orgId')
    ? (mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {})
    : { orgId: s };
}

function ensureOrgOnDoc(model, doc, req){
  const p=model?.schema?.path('orgId'); if(!p) return true;
  if(doc.orgId!=null && String(doc.orgId)!=='') return true;
  const raw=req.user?.orgId; if(!raw) return false; const s=String(raw);
  if(p.instance==='ObjectId'){
    if(!mongoose.Types.ObjectId.isValid(s)) return false;
    doc.orgId=new mongoose.Types.ObjectId(s);
    return true;
  }
  doc.orgId=s; return true;
}

/* --------- scrub form payload, incl. SUBJECT (supports performance) --------- */
function scrubFormPayload(body={}){
  const scope = body.scope || {};
  const rolesAllowed = Array.isArray(body.rolesAllowed) ? body.rolesAllowed.map(normalizeRole).filter(Boolean) : [];

  const items = Array.isArray(body.items) ? body.items.map(it => ({
    label: String(it?.label||'').trim(),
    allowPhoto: !!it?.allowPhoto,
    allowScan: !!it?.allowScan,
    allowNote: it?.allowNote !== undefined ? !!it.allowNote : true,
    requireEvidenceOnFail: !!it?.requireEvidenceOnFail,
    requireCorrectiveOnFail: it?.requireCorrectiveOnFail !== false, // default true
    criticalOnFail: !!it?.criticalOnFail,
  })) : [];

  // Optional scoring config
  const scoring = body.scoring && typeof body.scoring === 'object' ? {
    mode: ['any-fail','tolerance','percent'].includes(String(body.scoring.mode||'').toLowerCase())
      ? String(body.scoring.mode).toLowerCase() : 'any-fail',
    maxNonCriticalFails: Number.isFinite(+body.scoring.maxNonCriticalFails) ? +body.scoring.maxNonCriticalFails : 0,
    minPassPercent: Number.isFinite(+body.scoring.minPassPercent) ? +body.scoring.minPassPercent : 100,
  } : { mode:'any-fail', maxNonCriticalFails:0, minPassPercent:100 };

  // SUBJECT
  const subjIn = body.subject || {};
  const allowedSubjects = ['none','vehicle','asset','performance'];
  const subjType = allowedSubjects.includes(String(subjIn.type||'').toLowerCase())
    ? String(subjIn.type).toLowerCase()
    : 'none';
  const subject = {
    type: subjType,
    lockToId: (subjType==='none' ? undefined : (subjIn.lockToId===''?undefined:subjIn.lockToId)),
    lockLabel: (subjType==='none' ? '' : String(subjIn.lockLabel||'')),
  };

  return {
    title: String(body.title || '').trim(),
    description: String(body.description || ''),
    formType: body.formType === 'signoff' ? 'signoff' : 'standard',
    scope: {
      type: scope.type === 'scoped' ? 'scoped' : 'global',
      projectId: scope.projectId || '',
      taskId: scope.taskId || '',
      milestoneId: scope.milestoneId || '',
      projectName: scope.projectName || '',
      taskName: scope.taskName || '',
      milestoneName: scope.milestoneName || '',
    },
    subject,
    rolesAllowed,
    items,
    scoring,
    isDeleted: !!body.isDeleted,
  };
}

// Which field does this install use for manager notes?
function commentsFieldName(){
  const s = InspectionSubmission?.schema;
  if (s?.path('managerComments')) return 'managerComments';
  if (s?.path('comments')) return 'comments';
  return 'managerComments';
}

// Normalize a doc so the client always sees .managerComments
function aliasManagerComments(doc){
  if (!doc) return doc;
  if (!doc.managerComments && Array.isArray(doc.comments)) {
    doc.managerComments = (doc.comments || []).map(c => ({
      comment: c.comment,
      at: c.createdAt || c.at || c.date || new Date(),
      by: {
        _id: c.userId || c.by?._id,
        name: c.name || c.by?.name || 'Manager',
        role: c.by?.role || 'manager',
        email: c.by?.email || ''
      },
    }));
  }
  return doc;
}

/* ---------- scoring computation ---------- */
function computeScoringSummary(form, items){
  const summary = {
    mode: String(form?.scoring?.mode || 'any-fail').toLowerCase(),
    percentScore: undefined,
    counts: { total: items.length, considered: 0, pass: 0, fail: 0, na: 0, criticalFails: 0, nonCriticalFails: 0 },
  };

  for(const it of items){
    const r = String(it?.result||'').toLowerCase();
    if (r === 'na') { summary.counts.na++; continue; }
    summary.counts.considered++;
    if (r === 'pass') summary.counts.pass++;
    else if (r === 'fail') {
      summary.counts.fail++;
      if (it?.criticalOnFail) summary.counts.criticalFails++;
      else summary.counts.nonCriticalFails++;
    }
  }

  summary.percentScore = summary.counts.considered > 0
    ? (summary.counts.pass / summary.counts.considered) * 100
    : 100;

  return summary;
}

function computeOverallWithScoring(form, items){
  // critical fail always fails overall
  const hasCriticalFail = items.some(it => String(it.result||'').toLowerCase()==='fail' && (it.criticalOnFail === true));
  if (hasCriticalFail) return 'fail';

  const scoring = form?.scoring || {};
  const mode = String(scoring.mode || 'any-fail').toLowerCase();

  // derived counts
  const applicable = items.filter(it => String(it.result||'').toLowerCase() !== 'na');
  const totalApplicable = applicable.length;
  const passCount = applicable.filter(it => String(it.result||'').toLowerCase()==='pass').length;
  const nonCriticalFailCount = applicable.filter(it => String(it.result||'').toLowerCase()==='fail' && !it.criticalOnFail).length;

  if (mode === 'tolerance'){
    const maxFails = Number.isFinite(+scoring.maxNonCriticalFails) ? +scoring.maxNonCriticalFails : 0;
    return nonCriticalFailCount > maxFails ? 'fail' : 'pass';
  }

  if (mode === 'percent'){
    const minPct = Number.isFinite(+scoring.minPassPercent) ? +scoring.minPassPercent : 100;
    const pct = totalApplicable ? (passCount / totalApplicable) * 100 : 100;
    return (pct + 1e-9) >= minPct ? 'pass' : 'fail';
  }

  // default any-fail
  return nonCriticalFailCount > 0 ? 'fail' : 'pass';
}

/* -------- role ordering helpers (for performance assessed users) -------- */
const ROLE_ORDER = {
  'user': 0,
  'group-leader': 1,
  'project-manager': 2,
  'manager': 3,
  'admin': 4,
  'superadmin': 5,
};
function roleRank(r){ return ROLE_ORDER[normalizeRole(r)] ?? 0; }
function isRoleAtLeast(role, min){ return roleRank(role) >= roleRank(min); }

/* =============================== FORMS =============================== */

router.get('/forms', async (req,res,next)=>{
  try{
    const includeDeleted = String(req.query.includeDeleted||'').toLowerCase()==='true';
    const where = { ...orgFilterFromReq(InspectionForm, req) };
    if(!includeDeleted) where.isDeleted = { $ne: true };

    // Optional filter: projectId shows global OR scoped to project
    const { projectId } = req.query || {};
    if (projectId && String(projectId).trim()){
      const projVal = wantsObjectId(InspectionForm, 'scope.projectId') && mongoose.Types.ObjectId.isValid(String(projectId))
        ? new mongoose.Types.ObjectId(String(projectId))
        : String(projectId);
      where.$or = [
        { 'scope.type': { $ne: 'scoped' } },
        { 'scope.projectId': projVal }
      ];
    }

    const rows = await InspectionForm.find(where)
      .select('_id title description formType scope subject isDeleted scoring createdAt updatedAt rolesAllowed')
      .sort({ updatedAt: -1 })
      .lean();

    res.json(rows);
  }catch(err){ next(err); }
});

router.post('/forms', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const payload = scrubFormPayload(req.body||{});
    if(!payload.title) return res.status(400).json({ error:'title is required' });
    if(!Array.isArray(payload.items) || payload.items.length===0) return res.status(400).json({ error:'at least one item is required' });

    const doc = new InspectionForm({
      ...payload,
      createdBy: req.user?._id ? asOid(req.user._id) : undefined,
      updatedBy: req.user?._id ? asOid(req.user._id) : undefined,
    });
    if(!ensureOrgOnDoc(InspectionForm, doc, req)) return res.status(400).json({ error:'orgId is required on InspectionForm; missing/invalid in token' });
    await doc.save();
    res.status(201).json(doc.toObject({ versionKey:false }));
  }catch(err){ next(err); }
});

router.get('/forms/:id', async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const doc = await InspectionForm.findOne(where).lean();
    if(!doc || doc.isDeleted) return res.status(404).json({ error:'Not found' });
    res.json(doc);
  }catch(err){ next(err); }
});

router.put('/forms/:id', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const doc = await InspectionForm.findOne(where);
    if(!doc) return res.status(404).json({ error:'Not found' });

    const payload = scrubFormPayload(req.body||{});
    Object.assign(doc, payload, { updatedBy: req.user?._id ? asOid(req.user._id) : undefined });
    await doc.save();
    res.json(doc.toObject({ versionKey:false }));
  }catch(err){ next(err); }
});

router.delete('/forms/:id', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const doc = await InspectionForm.findOne(where);
    if(!doc) return res.status(404).json({ error:'Not found' });
    doc.isDeleted = true; await doc.save();
    res.json({ ok:true });
  }catch(err){ next(err); }
});

router.delete('/forms/:id/hard', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const del = await InspectionForm.deleteOne(where);
    if(del?.deletedCount===0) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(err){ next(err); }
});

// restore (un-delete) a form — secured + tenant-scoped
router.post('/forms/:id/restore', requireRole('admin','superadmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const form = await InspectionForm.findOneAndUpdate(where, { isDeleted: false }, { new: true });
    if (!form) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, form: form.toObject({ versionKey:false }) });
  } catch (e) {
    next(e);
  }
});

/* ============================ RUN / SUBMIT ============================ */

/**
 * Resolve a flat location object:
 *   { lat, lng, accuracy?, altitude?, at? }
 *
 * Supports:
 *   1) body.location = { lat, lng, accuracy?, altitude?, at? }
 *   2) body.location = { type:'Point', coordinates:[lng,lat] } (GeoJSON)
 *   3) body = { lat, lng }  (or latitude/longitude)
 *   4) headers x-lat / x-lng (or x-latitude / x-longitude)
 *
 * Returns: { location, locationMeta }
 * where location is flat { lat, lng, accuracy?, altitude?, at }
 */
function resolveLocation(req) {
  const b = req.body || {};

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let lat = null;
  let lng = null;
  let accuracy = null;
  let altitude = null;
  let at = null;
  let source = '';

  // 1) Nested plain lat/lng under body.location OR GeoJSON
  const loc = b.location;
  if (loc && typeof loc === 'object') {
    // a) Plain lat/lng form
    const latNest = toNum(loc.lat ?? loc.latitude);
    const lngNest = toNum(loc.lng ?? loc.lon ?? loc.longitude);
    if (latNest != null && lngNest != null) {
      lat = latNest;
      lng = lngNest;
      accuracy = toNum(loc.accuracy ?? loc.acc);
      altitude = toNum(loc.altitude);
      at = loc.at ? new Date(loc.at) : new Date();
      source = 'body.location';
    } else if (Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
      // b) GeoJSON form
      const lngC = toNum(loc.coordinates[0]);
      const latC = toNum(loc.coordinates[1]);
      if (latC != null && lngC != null) {
        lat = latC;
        lng = lngC;
        accuracy = toNum(loc.accuracy ?? loc.acc);
        altitude = toNum(loc.altitude);
        at = new Date();
        source = 'body.location.coordinates';
      }
    }
  }

  // 2) Top-level lat/lng on body
  if (lat == null || lng == null) {
    const latBody = toNum(b.lat ?? b.latitude);
    const lngBody = toNum(b.lng ?? b.longitude);
    if (latBody != null && lngBody != null) {
      lat = latBody;
      lng = lngBody;
      accuracy = toNum(b.accuracy ?? b.acc) ?? accuracy;
      altitude = toNum(b.altitude) ?? altitude;
      at = new Date();
      source = 'body';
    }
  }

  // 3) x-lat/x-lng headers
  if (lat == null || lng == null) {
    const latHead = toNum(req.headers['x-lat'] ?? req.headers['x-latitude']);
    const lngHead = toNum(req.headers['x-lng'] ?? req.headers['x-longitude']);
    if (latHead != null && lngHead != null) {
      lat = latHead;
      lng = lngHead;
      at = new Date();
      source = 'header';
    }
  }

  if (lat == null || lng == null) {
    return { location: undefined, locationMeta: undefined };
  }

  const location = {
    lat,
    lng,
    accuracy: accuracy != null ? accuracy : undefined,
    altitude: altitude != null ? altitude : undefined,
    at: at || new Date(),
  };

  const locationMeta = {
    capturedAt: location.at,
    source,
    accuracy: location.accuracy,
    altitude: location.altitude,
  };

  return { location, locationMeta };
}

async function validateAssessedUserForPerformance(req, subjectAtRun) {
  // Only required for performance
  if ((subjectAtRun?.type || 'none') !== 'performance') return { ok: true, assessedUserId: undefined, label: '' };

  const idRaw = subjectAtRun?.id;
  const id = asOid(idRaw);
  if (!id) return { ok: false, error: 'assessed user id is required for performance inspections' };

  // Ensure candidate is in same org & has at least group-leader role
  const whereUser = { _id: id, ...orgFilterFromReq(User, req) };
  const u = await User.findOne(whereUser).lean();
  if (!u) return { ok: false, error: 'assessed user not found in your organization' };

  const role = normalizeRole(u.role || 'user');
  if (!isRoleAtLeast(role, 'group-leader')) {
    return { ok: false, error: 'assessed user must be group-leader or above' };
  }

  const label = u.name || u.email || u.username || String(u._id);
  return { ok: true, assessedUserId: id, label };
}

router.post('/forms/:id/run', async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid form id' });
    const whereForm = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionForm, req) };
    const form = await InspectionForm.findOne(whereForm).lean();
    if(!form || form.isDeleted) return res.status(404).json({ error:'Form not found' });

    // role gate: only allow users whose role is included when rolesAllowed is non-empty
    if (!canRunForm(req.user, form)) return res.status(403).json({ error: 'Not allowed to run this form' });

    const body = req.body || {};
    const itemsIn = Array.isArray(body.items) ? body.items : [];

    // Map template items by _id for robust matching
    const tplById = {};
    (form.items || []).forEach(t => { if (t && t._id) tplById[String(t._id)] = t; });

    const normalizedItems = itemsIn.map((inIt, idx) => {
      const tpl = (inIt?.itemId && tplById[String(inIt.itemId)]) || form.items[idx] || {};
      const result = (inIt?.result || '').toLowerCase(); // pass | na | fail
      const evidence = {
        photoUrl: inIt?.evidence?.photoUrl || '',
        scanRef: inIt?.evidence?.scanRef || '',
        note: inIt?.evidence?.note || '',
      };
      const correctiveAction = result==='fail' ? String(inIt?.correctiveAction || '') : '';

      // Valid ObjectId for itemId (fallback to template _id or generate one)
      let itemId = asOid(inIt?.itemId) || asOid(tpl?._id) || null;
      if (!itemId) { itemId = new mongoose.Types.ObjectId(); }

      // enforce requirements on fail
      if(result==='fail' && (tpl.requireEvidenceOnFail===true)){
        const hasAny = !!(evidence.photoUrl || evidence.scanRef || evidence.note);
        if(!hasAny){ const e = new Error(`Item ${idx+1} requires evidence on fail`); e.status=400; throw e; }
      }
      if(result==='fail' && (tpl.requireCorrectiveOnFail!==false)){
        if(!correctiveAction.trim()){ const e=new Error(`Item ${idx+1} requires corrective action on fail`); e.status=400; throw e; }
      }

      // Persisted flag used by UI:
      const criticalTriggered = (result === 'fail') && !!tpl.criticalOnFail;

      return {
        itemId,
        label: tpl.label || inIt?.label || `Item ${idx+1}`,
        result: ['pass','na','fail'].includes(result) ? result : 'na',
        evidence,
        correctiveAction,
        // used for in-memory scoring (not in schema; mongoose will drop it)
        criticalOnFail: !!tpl.criticalOnFail,
        // saved to DB, used by the submission view UI
        criticalTriggered,
      };
    });

    // subjectAtRun: respect locked subject on the form; otherwise accept client pick (now includes performance)
    const subjectAtRun = (() => {
      const locked = form.subject || { type:'none' };
      if ((['vehicle','asset','performance'].includes(String(locked.type))) && locked.lockToId) {
        return { type: locked.type, id: locked.lockToId, label: String(locked.lockLabel || '') };
      }
      const s = body.subjectAtRun || {};
      const allowed = ['none','vehicle','asset','performance'];
      const t = allowed.includes(String(s.type||'').toLowerCase())
        ? String(s.type).toLowerCase()
        : (locked.type || 'none');
      const out = { type: t, id: undefined, label: '' };
      if (t !== 'none') {
        out.id = (s.id === '' || s.id == null) ? undefined : s.id;
        out.label = typeof s.label === 'string' ? s.label : '';
      }
      return out;
    })();

    // Validate performance assessed user if applicable
    const perf = await validateAssessedUserForPerformance(req, subjectAtRun);
    if (!perf.ok) return res.status(400).json({ error: perf.error });

    // scoring-aware overall + summary
    const overall = computeOverallWithScoring(form, normalizedItems);
    const scoringSummary = computeScoringSummary(form, normalizedItems);

    // Location (flat lat/lng + meta)
    const { location, locationMeta } = resolveLocation(req);

    const submission = new InspectionSubmission({
      formId: form._id,
      formTitle: form.title,
      formType: form.formType || 'standard',
      scopeAtRun: form?.scope?.type || 'global',
      runBy: {
        _id: req.user?._id ? asOid(req.user._id) : undefined,
        userId: req.user?._id ? asOid(req.user._id) : undefined, // legacy compat
        name: req.user?.name || req.user?.email || 'Inspector',
        email: req.user?.email || '',
      },
      links: body.links || { projectId:'', taskId:'', milestoneId:'' },
      subjectAtRun: subjectAtRun.type === 'performance' && perf.label
        ? { ...subjectAtRun, label: perf.label }
        : subjectAtRun,
      assessedUserId: subjectAtRun.type === 'performance' ? perf.assessedUserId : undefined,
      location,
      locationMeta,
      // also mirror to locationAtRun for frontend convenience if schema allows
      locationAtRun: location,
      items: normalizedItems,
      overallResult: overall,
      scoringSummary,
      followUpDate: body.followUpDate || null,
      signoff: {
        confirmed: !!(body?.signoff?.confirmed),
        name: String(body?.signoff?.name || req.user?.name || req.user?.email || ''),
        date: body?.signoff?.date || new Date().toISOString(),
        signatureDataUrl: String(body?.signoff?.signatureDataUrl || ''),
      },
    });

    if(!ensureOrgOnDoc(InspectionSubmission, submission, req))
      return res.status(400).json({ error:'orgId is required on InspectionSubmission; missing/invalid in token' });

    await submission.save();
    res.status(201).json(submission.toObject({ versionKey:false }));
  }catch(err){ next(err); }
});

/* ===== Normalize old GeoJSON location into flat lat/lng for responses ===== */
function normalizeLocationOut(doc){
  if (!doc || !doc.location) return doc;

  const loc = doc.location;
  const meta = doc.locationMeta || {};

  // Already flat { lat, lng }
  if (typeof loc === 'object' && !Array.isArray(loc.coordinates) && loc.lat != null && loc.lng != null) {
    if (!loc.at) {
      loc.at = meta.capturedAt || meta.at || doc.createdAt || new Date();
    }
    doc.location = loc;
    if (!doc.locationAtRun) doc.locationAtRun = loc;
    if (doc.subjectAtRun && !doc.subjectAtRun.location) {
      doc.subjectAtRun.location = loc;
    }
    return doc;
  }

  // GeoJSON { type:'Point', coordinates:[lng,lat] }
  if (typeof loc === 'object' && loc.type === 'Point' && Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
    const [lng, lat] = loc.coordinates;
    const flat = {
      lat,
      lng,
      accuracy: typeof meta.accuracy === 'number' ? meta.accuracy : undefined,
      altitude: typeof meta.altitude === 'number' ? meta.altitude : undefined,
      at: meta.capturedAt || meta.at || doc.createdAt || new Date(),
    };
    doc.location = flat;
    if (!doc.locationAtRun) doc.locationAtRun = flat;
    if (doc.subjectAtRun && !doc.subjectAtRun.location) {
      doc.subjectAtRun.location = flat;
    }
  }

  return doc;
}

/* ============================= SUBMISSIONS ============================= */

// List (lightweight), default: exclude soft-deleted
router.get('/submissions', async (req,res,next)=>{
  try{
    const where = { ...orgFilterFromReq(InspectionSubmission, req) };
    const { includeDeleted, projectId, taskId, milestoneId, subjectType, subjectId, assessedUserId, limit } = req.query || {};

    if (String(includeDeleted||'').toLowerCase() !== 'true') where.isDeleted = { $ne: true };

    if(projectId) where['links.projectId'] = String(projectId);
    if(taskId) where['links.taskId'] = String(taskId);
    if(milestoneId) where['links.milestoneId'] = String(milestoneId);

    if (subjectType) where['subjectAtRun.type'] = String(subjectType).toLowerCase(); // 'vehicle'|'asset'|'performance'|'none'
    if (subjectId) where['subjectAtRun.id'] = subjectId;

    if (assessedUserId && mongoose.Types.ObjectId.isValid(String(assessedUserId))) {
      where.assessedUserId = new mongoose.Types.ObjectId(String(assessedUserId));
    }

    const lim = Math.min(parseInt(limit||'200',10)||200, 1000);

    const rows = await InspectionSubmission.find(where)
      .select('_id formId formTitle formType scopeAtRun overallResult createdAt runBy links subjectAtRun assessedUserId signoff.confirmed isDeleted scoringSummary location locationMeta')
      .sort({ createdAt:-1 })
      .limit(lim)
      .lean();

    const out = rows.map(r => normalizeLocationOut(aliasManagerComments(r)));

    res.set('Cache-Control','no-store');
    res.json(out);
  }catch(err){ next(err); }
});

// Get one (404 if soft-deleted unless includeDeleted=true)
router.get('/submissions/:id', async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid submission id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionSubmission, req) };
    if (String(req.query.includeDeleted||'').toLowerCase() !== 'true') {
      where.isDeleted = { $ne: true };
    }
    const doc = await InspectionSubmission.findOne(where).lean();
    if(!doc) return res.status(404).json({ error:'Not found' });

    const out = normalizeLocationOut(aliasManagerComments({ ...doc }));
    res.set('Cache-Control','no-store');
    res.json(out);
  }catch(err){ next(err); }
});

// Add manager/admin comment
router.post('/submissions/:id/comments', requireRole('project-manager','manager','admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid submission id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionSubmission, req) };
    const sub = await InspectionSubmission.findOne(where);
    if(!sub) return res.status(404).json({ error:'Not found' });

    const comment = String(req.body?.comment || '').trim();
    if(!comment) return res.status(400).json({ error:'comment is required' });

    const field = commentsFieldName();
    if(!Array.isArray(sub[field])) sub[field] = [];

    if (field === 'comments') {
      // legacy comments: [{ userId, name, comment, createdAt }]
      sub.comments.push({
        userId: req.user?._id ? asOid(req.user._id) : undefined,
        name: req.user?.name || req.user?.email || 'Manager',
        comment,
        createdAt: new Date(),
      });
    } else {
      // managerComments: [{ comment, at, by:{ _id, name, role, email } }]
      sub.managerComments.push({
        comment,
        at: new Date(),
        by: {
          _id: req.user?._id ? asOid(req.user._id) : undefined,
          name: req.user?.name || req.user?.email || 'Manager',
          role: normalizeRole(req.user?.role),
          email: req.user?.email || ''
        },
      });
    }

    await sub.save();
    res.json({ ok:true });
  }catch(err){ next(err); }
});

/* ------- Submissions soft delete / hard delete / restore ------- */

// Soft delete
router.delete('/submissions/:id', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid submission id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionSubmission, req) };
    const sub = await InspectionSubmission.findOne(where);
    if(!sub) return res.status(404).json({ error:'Not found' });
    sub.isDeleted = true; await sub.save();
    res.json({ ok:true });
  }catch(err){ next(err); }
});

// Hard delete
router.delete('/submissions/:id/hard', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid submission id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionSubmission, req) };
    const del = await InspectionSubmission.deleteOne(where);
    if(del?.deletedCount===0) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(err){ next(err); }
});

// Restore soft-deleted
router.post('/submissions/:id/restore', requireRole('admin','superadmin'), async (req,res,next)=>{
  try{
    const { id } = req.params;
    if(!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error:'invalid submission id' });
    const where = { _id: new mongoose.Types.ObjectId(id), ...orgFilterFromReq(InspectionSubmission, req) };
    const sub = await InspectionSubmission.findOneAndUpdate(where, { isDeleted:false }, { new:true });
    if(!sub) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, submission: sub.toObject({ versionKey:false }) });
  }catch(err){ next(err); }
});

/* ====================== Assessed-user candidates (GL+) ====================== */
/**
 * GET /inspections/candidates/assessed-users?minRole=group-leader&limit=500&q=jo
 * Returns org-scoped users whose role >= minRole (default: group-leader).
 */
router.get('/candidates/assessed-users', async (req, res, next) => {
  try {
    const minRole = normalizeRole(req.query.minRole || 'group-leader');
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
    const q = String(req.query.q || '').trim().toLowerCase();

    const where = { ...orgFilterFromReq(User, req), isDeleted: { $ne: true }, active: { $ne: false } };

    // We'll filter by role rank server-side in memory to respect enum/aliases cleanly.
    const rows = await User.find(where)
      .select('_id name email username role roles')
      .sort({ name: 1, email: 1 })
      .limit(5000) // wide fetch; trimmed later
      .lean();

    const filtered = [];
    for (const u of rows) {
      const primary = normalizeRole(u.role);
      const extras = Array.isArray(u.roles) ? u.roles.map(normalizeRole) : [];
      const anyRole = [primary, ...extras];
      if (anyRole.some((r) => isRoleAtLeast(r, minRole))) {
        const txt = `${u.name || ''} ${u.email || ''} ${u.username || ''}`.toLowerCase();
        if (!q || txt.includes(q)) {
          filtered.push({ _id: u._id, name: u.name, email: u.email, username: u.username, role: primary });
          if (filtered.length >= limit) break;
        }
      }
    }

    res.json(filtered);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
