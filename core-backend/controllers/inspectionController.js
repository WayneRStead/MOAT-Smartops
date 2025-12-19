// core-backend/controllers/inspectionController.js
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const mongoose = require('mongoose');
const InspectionForm = require('../models/InspectionForm');
const InspectionSubmission = require('../models/InspectionSubmission');

function toNum(n){ const x = Number(n); return Number.isFinite(x) ? x : undefined; }

function computeOverall(items, scoring){
  const answered = items.filter(r => String(r.result||'').toLowerCase() !== '' && String(r.result||'').toLowerCase() !== 'na');
  const total = answered.length;
  const passCount = answered.filter(r => r.result === 'pass').length;
  const nonCriticalFails = answered.filter(r => r.result === 'fail' && !r.criticalTriggered).length;

  if ((items||[]).some(r => r.result === 'fail' && r.criticalTriggered)) {
    return { overall: 'fail', pct: total ? (passCount/total)*100 : 100, nonCriticalFails };
  }
  const mode = String(scoring?.mode || 'any-fail');
  if (mode === 'any-fail') {
    return { overall: answered.some(r => r.result === 'fail') ? 'fail' : (total ? 'pass':'na'), pct: total ? (passCount/total)*100:100, nonCriticalFails };
  }
  if (mode === 'percent') {
    const pct = total ? (passCount/total)*100 : 100;
    const min = toNum(scoring?.minPassPercent) ?? 100;
    return { overall: pct >= min ? 'pass' : 'fail', pct, nonCriticalFails };
  }
  if (mode === 'tolerance') {
    const max = toNum(scoring?.maxNonCriticalFails) ?? 0;
    const pct = total ? (passCount/total)*100 : 100;
    return { overall: nonCriticalFails <= max ? 'pass' : 'fail', pct, nonCriticalFails };
  }
  return { overall: 'na', pct: 100, nonCriticalFails };
}

// ---------- RUN FORM (Create Submission) ----------
exports.runForm = async (req, res, next) => {
  try {
    const formId = req.params.id || req.params.formId;
    const form = await InspectionForm.findById(formId).lean();
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const body = req.body || {};

    // Build submission
    const sub = new InspectionSubmission({
      formId: form._id,
      formTitle: form.title,
      formType: form.formType || 'standard',

      links: {
        projectId: body?.links?.projectId ?? null,
        taskId: body?.links?.taskId ?? null,
        milestoneId: body?.links?.milestoneId ?? null,
      },

      subjectAtRun: {
        type: body?.subjectAtRun?.type || 'none',
        id: body?.subjectAtRun?.id ?? null,
        label: body?.subjectAtRun?.label || '',
      },

      // Store LOCATION if provided  <<<<<< IMPORTANT
      location: (body?.location && typeof body.location === 'object') ? {
        lat: toNum(body.location.lat),
        lng: toNum(body.location.lng),
        accuracy: toNum(body.location.accuracy),
        at: body.location.at ? new Date(body.location.at) : new Date(),
      } : {},

      items: Array.isArray(body.items) ? body.items.map(it => ({
        itemId: it.itemId,
        label: it.label, // optional
        result: it.result || 'na',
        evidence: it.evidence || {},
        correctiveAction: it.result === 'fail' ? (it.correctiveAction || '') : '',
        criticalTriggered: !!it.criticalTriggered,
      })) : [],

      followUpDate: body.followUpDate ? new Date(body.followUpDate) : undefined,

      signoff: {
        confirmed: !!body?.signoff?.confirmed,
        name: body?.signoff?.name || '',
        date: body?.signoff?.date ? new Date(body.signoff.date) : new Date(),
        signatureDataUrl: body?.signoff?.signatureDataUrl || '',
      },

      runBy: req.user ? { _id: req.user._id, name: req.user.name, email: req.user.email } : undefined,
    });

    // Compute scoring summary
    const { overall, pct, nonCriticalFails } = computeOverall(sub.items, form.scoring);
    sub.overallResult = overall;
    sub.scoringSummary = { percentScore: pct, counts: { nonCriticalFails } };

    await sub.save();
    res.json(sub);
  } catch (err) { next(err); }
};

// ---------- GET SINGLE ----------
exports.getSubmission = async (req, res, next) => {
  try {
    const sub = await InspectionSubmission.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(sub);
  } catch (err) { next(err); }
};

// ---------- LIST SUBMISSIONS (optionally includeDeleted) ----------
exports.listSubmissions = async (req, res, next) => {
  try {
    const includeDeleted = String(req.query.includeDeleted || 'false').toLowerCase() === 'true';
    const q = includeDeleted ? {} : { isDeleted: { $ne: true } };
    const limit = Math.min(1000, parseInt(req.query.limit || '200', 10));
    const rows = await InspectionSubmission.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (err) { next(err); }
};

// ---------- ADD MANAGER COMMENT ----------
exports.addSubmissionComment = async (req, res, next) => {
  try {
    const sub = await InspectionSubmission.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    const by = req.user ? { _id: req.user._id, name: req.user.name, email: req.user.email } : {};
    const comment = String(req.body.comment || '').trim();
    if (!comment) return res.status(400).json({ error: 'Empty comment' });

    sub.managerComments.push({ comment, at: new Date(), by });
    await sub.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ---------- SOFT/HARD DELETE + RESTORE ----------
exports.softDeleteSubmission = async (req, res, next) => {
  try {
    await InspectionSubmission.findByIdAndUpdate(req.params.id, { $set: { isDeleted: true } }, { new: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
exports.restoreSubmission = async (req, res, next) => {
  try {
    await InspectionSubmission.findByIdAndUpdate(req.params.id, { $set: { isDeleted: false } }, { new: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
exports.hardDeleteSubmission = async (req, res, next) => {
  try {
    await InspectionSubmission.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ---------- LIST FORMS (optionally includeDeleted) ----------
exports.listForms = async (req, res, next) => {
  try {
    const includeDeleted = String(req.query.includeDeleted || 'false').toLowerCase() === 'true';
    const q = includeDeleted ? {} : { isDeleted: { $ne: true } };
    const rows = await InspectionForm.find(q).sort({ updatedAt: -1 }).limit(2000).lean();
    res.json(rows);
  } catch (err) { next(err); }
};

// -------------------------------- KMZ EXPORT --------------------------------
// KML helpers
function escapeXml(s){ return String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }

function buildKml(subs){
  const placemarks = [];
  for (const s of subs){
    const loc = s.location || {};
    if (typeof loc !== 'object') continue;
    const lat = Number(loc.lat), lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const lines = [];
    lines.push(`<b>Title:</b> ${escapeXml(s.formTitle || 'Form')}`);
    lines.push(`<b>Date:</b> ${escapeXml(new Date(s.createdAt).toLocaleString())}`);
    const inspector = s?.runBy?.name || s?.signoff?.name || '';
    if (inspector) lines.push(`<b>Inspector:</b> ${escapeXml(inspector)}`);

    const l = s.links || {};
    if (l.projectId)   lines.push(`<b>Project:</b> ${escapeXml(String(l.projectId))}`);
    if (l.taskId)      lines.push(`<b>Task:</b> ${escapeXml(String(l.taskId))}`);
    if (l.milestoneId) lines.push(`<b>Milestone:</b> ${escapeXml(String(l.milestoneId))}`);

    const subj = s.subjectAtRun || {};
    if (subj?.type && subj.type !== 'none') {
      lines.push(`<b>Subject:</b> ${escapeXml(`${subj.type} • ${subj.label || subj.id || ''}`)}`);
    }
    if (s.overallResult) lines.push(`<b>Status:</b> ${escapeXml(String(s.overallResult).toUpperCase())}`);

    const desc = `<div style="font-size:12px">${lines.join('<br/>')}</div>`;

    placemarks.push(`
      <Placemark>
        <name>${escapeXml(s.formTitle || 'Inspection')}</name>
        <description><![CDATA[${desc}]]></description>
        <Point><coordinates>${lng},${lat},0</coordinates></Point>
      </Placemark>
    `);
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
      <name>MOAT SmartOps - Inspections</name>
      <open>1</open>
      ${placemarks.join('\n')}
    </Document>
  </kml>`;
  return kml;
}

exports.exportKMZ = async (req, res, next) => {
  try {
    const includeDeleted = String(req.query.includeDeleted || 'false').toLowerCase() === 'true';
    const q = includeDeleted ? {} : { isDeleted: { $ne: true } };

    // Optional scope filters (match what the list UI can pass)
    const { projectId, taskId, milestoneId } = req.query;
    if (projectId)   q['links.projectId'] = projectId;
    if (taskId)      q['links.taskId'] = taskId;
    if (milestoneId) q['links.milestoneId'] = milestoneId;

    // Optional status filter
    if (req.query.status) q.overallResult = req.query.status;

    // Optional free-text search (simple contains against a few fields)
    if (req.query.q) {
      const needle = String(req.query.q).trim();
      q.$or = [
        { formTitle: new RegExp(needle, 'i') },
        { formType: new RegExp(needle, 'i') },
        { 'runBy.name': new RegExp(needle, 'i') },
        { 'signoff.name': new RegExp(needle, 'i') },
        { 'subjectAtRun.label': new RegExp(needle, 'i') },
      ];
    }

    const rows = await InspectionSubmission.find(q).sort({ createdAt: -1 }).limit(5000).lean();

    // Filter to only those with valid coords
    const withCoords = rows.filter(s => Number.isFinite(Number(s?.location?.lat)) && Number.isFinite(Number(s?.location?.lng)));

    if (!withCoords.length) {
      return res.status(200).json({ ok: true, empty: true, message: 'No submissions with coordinates to export.' });
    }

    const kmlStr = buildKml(withCoords);

    res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
    const filename = `inspections_${Date.now()}.kmz`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream a KMZ (zip) on the fly
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    archive.append(kmlStr, { name: 'doc.kml' });
    await archive.finalize();
  } catch (err) { next(err); }
};
