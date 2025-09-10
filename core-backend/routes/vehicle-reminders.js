// core-backend/routes/vehicle-reminders.js
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Vehicle = require('../models/Vehicle');

const router = express.Router();

// helper: pick next-due from an array
function computeNextDue(reminders = []) {
  const active = reminders.filter(r => r.active);
  if (!active.length) return null;

  // choose earliest date or smallest odometer threshold among active
  const dateDue = active
    .filter(r => r.kind === 'date' && r.dueDate)
    .sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate))[0];

  const odoDue = active
    .filter(r => r.kind === 'odometer' && Number.isFinite(r.dueOdometer))
    .sort((a,b) => Number(a.dueOdometer) - Number(b.dueOdometer))[0];

  // prefer the one that is "sooner": date closer to now vs smallest odo
  // since we don't track current km on vehicle yet, we just return both candidates
  // Frontend can label them.
  return { dateDue: dateDue || null, odoDue: odoDue || null };
}

// LIST
router.get('/:id/reminders', requireAuth, async (req, res) => {
  try {
    const v = await Vehicle.findById(req.params.id).lean();
    if (!v) return res.status(404).json({ error: 'Not found' });
    const nextDue = computeNextDue(v.reminders || []);
    res.json({ reminders: v.reminders || [], nextDue });
  } catch (e) {
    console.error('GET /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE
router.post('/:id/reminders', requireAuth, async (req, res) => {
  try {
    const { kind, dueDate, dueOdometer, notes, active } = req.body || {};
    if (!['date','odometer'].includes(kind)) {
      return res.status(400).json({ error: 'invalid kind (date|odometer)' });
    }
    if (kind === 'date' && !dueDate) return res.status(400).json({ error: 'dueDate required' });
    if (kind === 'odometer' && (dueOdometer == null || Number.isNaN(Number(dueOdometer)))) {
      return res.status(400).json({ error: 'dueOdometer required (km)' });
    }

    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });

    const r = {
      kind,
      dueDate: kind === 'date' ? new Date(dueDate) : undefined,
      dueOdometer: kind === 'odometer' ? Number(dueOdometer) : undefined,
      notes: notes || '',
      active: active != null ? !!active : true,
      createdAt: new Date(),
    };
    v.reminders.push(r);
    await v.save();

    const nextDue = computeNextDue(v.reminders || []);
    res.status(201).json({ reminders: v.reminders, nextDue });
  } catch (e) {
    console.error('POST /vehicles/:id/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE one reminder
router.put('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const r = v.reminders.id(req.params.rid);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });

    const { kind, dueDate, dueOdometer, notes, active, lastNotifiedAt } = req.body || {};
    if (kind && !['date','odometer'].includes(kind)) {
      return res.status(400).json({ error: 'invalid kind (date|odometer)' });
    }

    if (kind != null) r.kind = kind;
    if (dueDate != null) r.dueDate = dueDate ? new Date(dueDate) : undefined;
    if (dueOdometer != null) r.dueOdometer = Number(dueOdometer);
    if (notes != null) r.notes = notes;
    if (active != null) r.active = !!active;
    if (lastNotifiedAt != null) r.lastNotifiedAt = lastNotifiedAt ? new Date(lastNotifiedAt) : undefined;

    await v.save();
    const nextDue = computeNextDue(v.reminders || []);
    res.json({ reminders: v.reminders, nextDue });
  } catch (e) {
    console.error('PUT /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE one reminder
router.delete('/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const r = v.reminders.id(req.params.rid);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });
    r.deleteOne();
    await v.save();
    const nextDue = computeNextDue(v.reminders || []);
    res.json({ reminders: v.reminders, nextDue });
  } catch (e) {
    console.error('DELETE /vehicles/:id/reminders/:rid error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
