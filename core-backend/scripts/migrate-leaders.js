// scripts/migrate-leaders.js
const mongoose = require('mongoose');
const Group = require('../core-backend/models/Group');
(async()=>{
  await mongoose.connect(process.env.MONGO_URL);
  const groups = await Group.find({ $or: [
    { leaderUserId: { $exists: true, $ne: null } },
    { leaderUserIds: { $exists: false } },
  ]});
  for (const g of groups) {
    if (g.leaderUserId && (!g.leaderUserIds || g.leaderUserIds.length === 0)) {
      g.leaderUserIds = [g.leaderUserId];
      await g.save();
      console.log('Updated', g.name);
    }
  }
  await mongoose.disconnect();
})();
