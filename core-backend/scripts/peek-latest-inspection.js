// core-backend/scripts/peek-latest-inspection.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smartops';

async function main() {
  await mongoose.connect(uri, { autoIndex: true });
  const col = mongoose.connection.collection('inspectionsubmissions'); // Mongoose pluralization

  const [doc] = await col
    .find({}, {
      projection: {
        formTitle: 1,
        createdAt: 1,
        'runBy.name': 1,
        links: 1,
        subjectAtRun: 1,
        overallResult: 1,
        location: 1,
        locationMeta: 1,
      }
    })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  console.log(doc ? JSON.stringify(doc, null, 2) : 'No submissions found.');
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
