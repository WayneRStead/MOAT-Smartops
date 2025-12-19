// core-backend/boot/superadmin.js
const mongoose = require('mongoose');
const User = require('../models/User');
let Organization = null;

// Organization model may not exist in some setups, so guard it:
try {
  Organization = require('../models/Organization');
} catch {
  Organization = null;
}

function log(...args) {
  console.log('[superadmin]', ...args);
}

/**
 * Boot script to ensure a global superadmin user exists.
 *
 * Uses env:
 *  - SUPERADMIN_EMAIL
 *  - SUPERADMIN_PASSWORD
 *  - SUPERADMIN_NAME (optional)
 */
async function run() {
  const emailEnv = process.env.SUPERADMIN_EMAIL || '';
  const passwordEnv = process.env.SUPERADMIN_PASSWORD || '';
  const nameEnv = process.env.SUPERADMIN_NAME || 'Global Superadmin';

  const email = emailEnv.trim().toLowerCase();

  if (!email || !passwordEnv) {
    log('SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD missing; skipping boot.');
    return;
  }

  // Find any existing org to attach this user to (User.orgId is required ObjectId)
  let orgId = null;

  if (Organization) {
    const anyOrg = await Organization.findOne().lean();
    if (!anyOrg) {
      log('No organizations found; cannot create superadmin user yet.');
      log('Create an org through the normal flow, then restart the server.');
      return;
    }
    orgId = anyOrg._id;
  } else {
    log('Organization model not available; cannot attach orgId to superadmin user.');
    return;
  }

  // Find existing user by email
  let user = await User.findOne({ email });

  if (!user) {
    // Create new superadmin user
    user = new User({
      orgId,
      email,
      name: nameEnv,
      role: 'superadmin',
      roles: ['superadmin'],
      globalRole: 'superadmin',
      active: true,
      isDeleted: false,
    });

    // Set plain password so User pre-save hook hashes it
    user.password = passwordEnv;

    await user.save();

    log('created global superadmin user:', email, 'orgId:', String(orgId));
  } else {
    // Update existing user to ensure correct flags
    let changed = false;

    if (!user.orgId) {
      user.orgId = orgId;
      changed = true;
    }
    if (user.role !== 'superadmin') {
      user.role = 'superadmin';
      changed = true;
    }

    const rolesSet = new Set((user.roles || []).concat(['superadmin']));
    const newRoles = Array.from(rolesSet);
    if (JSON.stringify(newRoles) !== JSON.stringify(user.roles || [])) {
      user.roles = newRoles;
      changed = true;
    }

    if (user.globalRole !== 'superadmin') {
      user.globalRole = 'superadmin';
      changed = true;
    }

    // Always ensure password matches env (optional, but keeps things in sync)
    user.password = passwordEnv;
    changed = true;

    if (changed) {
      await user.save();
      log('updated global superadmin user:', email, 'orgId:', String(user.orgId));
    } else {
      log('superadmin user already up to date:', email);
    }
  }
}

module.exports = { run };
