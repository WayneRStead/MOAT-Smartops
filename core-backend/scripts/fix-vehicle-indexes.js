// scripts/fix-vehicle-indexes.js
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/MOAT-SmartOps';
  await mongoose.connect(uri);
  console.log('[db] connected');

  // Load model (after connection so it registers on this conn)
  const Vehicle = require('../core-backend/models/Vehicle');

  // Current indexes
  const coll = mongoose.connection.collection('vehicles');
  const idx = await coll.indexes();
  console.log('[db] current indexes:', idx.map(i => i.name));

  // Drop legacy single-field unique indexes if present
  const toDrop = ['reg_1', 'vin_1'];
  for (const name of toDrop) {
    if (idx.find(i => i.name === name)) {
      console.log(`[db] dropping index ${name}`);
      await coll.dropIndex(name).catch(e => console.log(`[db] drop ${name} warn:`, e.message));
    }
  }

  // Ask Mongoose to build the new ones
  await Vehicle.syncIndexes(); // compares schema indexes vs db and fixes
  const after = await coll.indexes();
  console.log('[db] after indexes:', after.map(i => i.name));

  await mongoose.disconnect();
  console.log('[db] done');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
