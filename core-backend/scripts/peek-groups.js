// core-backend/scripts/peek-groups.js
require('dotenv').config();
const mongoose = require('mongoose');
const Group = require('../models/Group'); // adjust path if your model file is named differently

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smartops';

(async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  const rows = await Group.find({}).sort({ updatedAt: -1 }).limit(5).lean();
  console.log(JSON.stringify(rows, null, 2));
  await mongoose.disconnect();
})();
