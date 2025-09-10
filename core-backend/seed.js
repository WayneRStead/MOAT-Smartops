// core-backend/seed.js
require('dotenv').config();
const mongoose = require('mongoose');

// ---- Build Mongo URI from .env
const enc = encodeURIComponent;
const MONGO_URI = `mongodb+srv://${enc(process.env.MONGO_USER)}:${enc(process.env.MONGO_PASS)}@${process.env.MONGO_HOST}/${process.env.MONGO_DB}?retryWrites=true&w=majority`;

// ---- Models (exact file names/casing required)
const Org = require('./models/Org');
const User = require('./models/User');
const Project = require('./models/Project');
const Clocking = require('./models/Clocking');
const Asset = require('./models/Asset');
const Vehicle = require('./models/Vehicle');
const Invoice = require('./models/Invoice');
const Inspection = require('./models/Inspection');

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ Connected to MongoDB');

    const CLEAN = process.argv.includes('--clean');
    if (CLEAN) {
      console.log('🧹 Cleaning collections…');
      await Promise.allSettled([
        Org.deleteMany({}),
        User.deleteMany({}),
        Project.deleteMany({}),
        Clocking.deleteMany({}),
        Asset.deleteMany({}),
        Vehicle.deleteMany({}),
        Invoice.deleteMany({}),
        Inspection.deleteMany({})
      ]);
    }

    // --- ORG (singleton)
let org = await Org.findOne();
if (!org) {
  org = await Org.create({
await Org.create({
  name: 'MOAT SmartOps',
  email: 'info@moattechnologies.com',
  website: 'https://moattechnologies.com',
  theme: { mode: 'dark', color: '#2a7fff' },
  settings: { timezone: 'Africa/Johannesburg', locale: 'en-ZA', dateFormat: 'yyyy-MM-dd' },
  billing: { plan: 'starter' },
  modules: { projects:true, users:true, clockings:true, assets:true, vehicles:true, invoices:true, inspections:true }
});

  console.log('🏢 Org created');
} else {
  console.log('🏢 Org exists');
}

// --- USERS
await User.insertMany([
  { name: 'Wayne Stead', role: 'superadmin',  email: 'wayne@moattechnologies.com' },
  { name: 'Sarah Moyo',  role: 'worker', email: 'sarah@example.com' },
  { name: 'John Dlamini',role: 'manager',email: 'john@example.com' }
], { ordered: false }).catch(() => []);
const allUsers = await User.find().lean();
console.log(`👤 Users: ${allUsers.length}`);

const byName = n => allUsers.find(u => u.name === n)?._id;

// --- PROJECTS
await Project.insertMany([
  { name: 'Bridge Repair', status: 'active' },
  { name: 'Road Survey',   status: 'planning' }
], { ordered: false }).catch(() => []);
const allProjects = await Project.find().sort({ createdAt: -1 }).lean();
console.log(`📁 Projects: ${allProjects.length}`);

// --- CLOCKINGS
await Clocking.insertMany([
  { userId: byName('Sarah Moyo'), timestamp: new Date(),                       location: 'Johannesburg', method: 'facial-scan' },
  { userId: byName('John Dlamini'), timestamp: new Date(Date.now() - 3600_000), location: 'Cape Town',    method: 'manual' }
], { ordered: false }).catch(() => []);
const allClockings = await Clocking.find().lean();
console.log(`⏱ Clockings: ${allClockings.length}`);

// --- ASSETS
await Asset.insertMany([
  { name: 'Komatsu Excavator', type: 'Equipment', status: 'active' },
  { name: 'Trimble GPS Unit',  type: 'Tool',      status: 'active' }
], { ordered: false }).catch(() => []);
console.log(`📦 Assets: ${await Asset.countDocuments()}`);

// --- VEHICLES
await Vehicle.insertMany([
  { reg: 'CA123456', make: 'Toyota', model: 'Hilux',  status: 'active'  },
  { reg: 'GP987654', make: 'Ford',   model: 'Ranger', status: 'service' }
], { ordered: false }).catch(() => []);
console.log(`🚚 Vehicles: ${await Vehicle.countDocuments()}`);

// --- INVOICES
const p0 = allProjects[0]?._id;
const p1 = allProjects[1]?._id;
await Invoice.insertMany([
  { number: 'INV-1001', projectId: p0, amount: 12500, status: 'draft' },
  { number: 'INV-1002', projectId: p1, amount:  8800, status: 'sent'  }
], { ordered: false }).catch(() => []);
console.log(`🧾 Invoices: ${await Invoice.countDocuments()}`);

// --- INSPECTIONS
await Inspection.insertMany([
  { projectId: p0, inspector: 'John Dlamini',  notes: 'Initial site check OK',     date: new Date() },
  { projectId: p1, inspector: 'Sarah Moyo',    notes: 'Preliminary hazards logged',date: new Date() }
], { ordered: false }).catch(() => []);
console.log(`🔍 Inspections: ${await Inspection.countDocuments()}`);

    console.log('✅ Seeding complete');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
