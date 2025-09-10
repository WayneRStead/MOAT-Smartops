// core-backend/scripts/seed-billing-usage.js
require('dotenv').config();
const mongoose = require('mongoose');

const Org = require('../models/Org');
const BillingConfig = require('../models/BillingConfig');
const BillingUsage = require('../models/BillingUsage');

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function main() {
  const uri = process.env.MONGO_URI || (
    `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASS)}@${process.env.MONGO_HOST}/${process.env.MONGO_DB}?retryWrites=true&w=majority`
  );
  await mongoose.connect(uri);
  console.log('✅ Connected');

  // Ensure one Org exists
  let org = await Org.findOne();
  if (!org) {
    org = await Org.create({
      name: 'MOAT SmartOps',
      billing: { plan: 'starter' },
      modules: { projects:true, users:true, clockings:true, assets:true, vehicles:true, invoices:true, inspections:true }
    });
    console.log('🏢 Org created');
  } else {
    console.log('🏢 Org exists:', org.name);
  }

  // Ensure default BillingConfig exists
  if (!(await BillingConfig.findOne())) {
    await BillingConfig.create({}); // uses model defaults
    console.log('💳 BillingConfig defaults created');
  } else {
    console.log('💳 BillingConfig exists');
  }

  // Seed usage for current month (tweak numbers as you like)
  const mk = monthKey(); // e.g. '2025-08'
  const meters = {
    mau_mobile: 18,
    events_clockings: 3250,
    events_inspections: 180,
    automation_ocr: 75,
    automation_ai: 120,
    notifications_sms: 340,
    notifications_email: 2100,
    storage_gb_month: 22 // approximate; you can refine via nightly job later
  };

  await BillingUsage.updateOne(
    { orgId: org._id, month: mk },
    { $set: { meters } },
    { upsert: true }
  );
  console.log(`📈 Usage upserted for ${mk}`, meters);

  // Optional: also seed previous month
  const prev = new Date(); prev.setMonth(prev.getMonth() - 1);
  const mkPrev = monthKey(prev);
  const prevMeters = {
    mau_mobile: 12,
    events_clockings: 2100,
    events_inspections: 95,
    automation_ocr: 40,
    automation_ai: 60,
    notifications_sms: 180,
    notifications_email: 1500,
    storage_gb_month: 15
  };
  await BillingUsage.updateOne(
    { orgId: org._id, month: mkPrev },
    { $set: { meters: prevMeters } },
    { upsert: true }
  );
  console.log(`📈 Usage upserted for ${mkPrev}`, prevMeters);

  await mongoose.disconnect();
  console.log('✅ Done');
}

main().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
