// scripts/print-org-modules.js
const mongoose = require('mongoose');
const Org = require('../models/Org');
(async () => {
  await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost/yourdb');
  const p = Org.schema.path('modules');
  const keys = p?.schema ? Object.keys(p.schema.paths) : [];
  console.log('Org.modules keys:', keys);
  process.exit(0);
})();
