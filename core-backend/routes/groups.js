// routes/groups.js
const express = require('express');
const mongoose = require('mongoose');
const Group = require('../models/group');
const User = require('../models/user');

const router = express.Router();

// All routes assume req.user is populated and scoped by orgId

// Create
router.post('/', async (req, res, next) => {
try {
const { name, description } = req.body;
const group = await Group.create({
orgId: req.user.orgId,
name,
description: description || '',
createdByUserId: req.user._id,
});
res.status(201).json(group);
} catch (err) {
if (err.code === 11000) return res.status(409).json({ error: 'Group name must be unique per org' });
next(err);
}
});

// List
router.get('/', async (req, res, next) => {
try {
const groups = await Group.find({ orgId: req.user.orgId, isDeleted: false }).sort('name');
res.json(groups);
} catch (err) { next(err); }
});

// Read
router.get('/:id', async (req, res, next) => {
try {
const _id = new mongoose.Types.ObjectId(req.params.id);
const group = await Group.findOne({ _id, orgId: req.user.orgId, isDeleted: false });
if (!group) return res.status(404).json({ error: 'Not found' });
res.json(group);
} catch (err) { next(err); }
});

// Update (name/description)
router.patch('/:id', async (req, res, next) => {
try {
const _id = new mongoose.Types.ObjectId(req.params.id);
const update = {};
if (req.body.name !== undefined) update.name = req.body.name;
if (req.body.description !== undefined) update.description = req.body.description;

const group = await Group.findOneAndUpdate(
{ _id, orgId: req.user.orgId, isDeleted: false },
{ $set: update },
{ new: true }
);
if (!group) return res.status(404).json({ error: 'Not found' });
res.json(group);
} catch (err) { next(err); }
});

// Soft delete
router.delete('/:id', async (req, res, next) => {
try {
const _id = new mongoose.Types.ObjectId(req.params.id);
const group = await Group.findOneAndUpdate(
{ _id, orgId: req.user.orgId, isDeleted: false },
{ $set: { isDeleted: true, memberUserIds: [] } },
{ new: true }
);
if (!group) return res.status(404).json({ error: 'Not found' });
res.json({ ok: true });
} catch (err) { next(err); }
});

// Add members
router.post('/:id/members', async (req, res, next) => {
try {
const _id = new mongoose.Types.ObjectId(req.params.id);
const { userIds } = req.body; // array of ObjectId strings

// Validate users belong to org
const users = await User.find({ _id: { $in: userIds }, orgId: req.user.orgId }).select('_id').lean();
const validIds = users.map(u => u._id);

const group = await Group.findOneAndUpdate(
{ _id, orgId: req.user.orgId, isDeleted: false },
{ $addToSet: { memberUserIds: { $each: validIds } } },
{ new: true }
);

if (!group) return res.status(404).json({ error: 'Not found' });
res.json(group);
} catch (err) { next(err); }
});

// Remove a member
router.delete('/:id/members/:userId', async (req, res, next) => {
try {
const _id = new mongoose.Types.ObjectId(req.params.id);
const userId = new mongoose.Types.ObjectId(req.params.userId);


const group = await Group.findOneAndUpdate(
{ _id, orgId: req.user.orgId, isDeleted: false },
{ $pull: { memberUserIds: userId } },
{ new: true }
);

if (!group) return res.status(404).json({ error: 'Not found' });
res.json(group);
} catch (err) { next(err); }
});

module.exports = router;