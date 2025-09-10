// middleware/access.js
const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/User');

/**
* Attaches to req:
* - accessibleUserIds: ObjectId[]
* - myGroupIds: ObjectId[]
* Admins: all users in org.
* Users: self + members of groups they belong to.
*/
async function computeAccessibleUserIds(req, res, next) {
try {
const { user } = req; // expects { _id, orgId, role }
if (!user || !user.orgId) return res.status(401).json({ error: 'Unauthorized' });

const orgId = new mongoose.Types.ObjectId(user.orgId);

if (user.role === 'admin') {
const users = await User.find({ orgId, /* optionally */ isDeleted: { $ne: true } }).select('_id').lean();
req.accessibleUserIds = users.map(u => u._id);
req.myGroupIds = [];
return next();
}

const myGroups = await Group.find({ orgId, isDeleted: false, memberUserIds: user._id })
.select('_id memberUserIds')
.lean();

const set = new Set([String(user._id)]);
const groupIds = [];
for (const g of myGroups) {
groupIds.push(g._id);
for (const uid of g.memberUserIds || []) set.add(String(uid));
}

req.accessibleUserIds = Array.from(set).map(id => new mongoose.Types.ObjectId(id));
req.myGroupIds = groupIds;
next();
} catch (err) {
next(err);
}
}

module.exports = { computeAccessibleUserIds };