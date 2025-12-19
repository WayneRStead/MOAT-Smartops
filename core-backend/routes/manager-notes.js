// core-backend/routes/manager-notes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// Ensure model is compiled
const ManagerNote = require('../models/ManagerNote'); // exports the model

// Small helpers
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

// GET /tasks/:taskId/manager-notes  -> list notes for a task (newest first)
router.get('/:taskId/manager-notes', async (req, res, next) => {
  try {
    const { taskId } = req.params;
    if (!isValidId(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

    const notes = await ManagerNote.find({ taskId })
      .sort({ at: -1, createdAt: -1, _id: -1 })
      .lean();

    res.json(notes || []);
  } catch (err) {
    next(err);
  }
});

// POST /tasks/:taskId/manager-notes  -> create a new manager note
// Body: { note?: string, status?: string, at?: ISOString }
router.post('/:taskId/manager-notes', async (req, res, next) => {
  try {
    const { taskId } = req.params;
    if (!isValidId(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

    const { note = '', status = '', at } = req.body || {};
    const when = at ? new Date(at) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid at datetime' });

    const actor = req.user || {};
    const doc = await ManagerNote.create({
      taskId,
      note: String(note || ''),
      status: String(status || ''),
      at: when.toISOString(),
      userId: actor._id || actor.id || undefined,
      actorName: actor.name || actor.username || undefined,
      actorEmail: actor.email || undefined,
    });

    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// DELETE /tasks/:taskId/manager-notes/:noteId  -> delete a note
router.delete('/:taskId/manager-notes/:noteId', async (req, res, next) => {
  try {
    const { taskId, noteId } = req.params;
    if (!isValidId(taskId) || !isValidId(noteId)) {
      return res.status(400).json({ error: 'Invalid id(s)' });
    }

    const deleted = await ManagerNote.findOneAndDelete({ _id: noteId, taskId });
    if (!deleted) return res.status(404).json({ error: 'Note not found' });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
