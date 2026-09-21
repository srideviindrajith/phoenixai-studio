#!/usr/bin/env node
// Resets the admin password stored in data.json.
//
//   npm run reset-password -- "MyNewStrongPassword"
//   (or: node scripts/reset-admin-password.js "MyNewStrongPassword")
//
// If you omit the argument, ADMIN_PASSWORD from the environment/.env is used.
// Use this when you're locked out — e.g. you changed ADMIN_PASSWORD in .env
// after data.json already existed (the env value is only used the first time
// data.json is created, so it no longer matches the stored hash).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const password = process.argv[2] || process.env.ADMIN_PASSWORD;

if (!password || password.length < 8) {
  console.error('Please provide a new password of at least 8 characters:');
  console.error('  npm run reset-password -- "MyNewStrongPassword"');
  process.exit(1);
}

if (!fs.existsSync(DATA_FILE)) {
  console.error('data.json not found. Start the server once (npm start) so it is created, then run this again.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
data.settings = data.settings || {};

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
data.settings.adminPassword = `scrypt$${salt}$${hash}`;

const tmpFile = `${DATA_FILE}.tmp`;
fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
fs.renameSync(tmpFile, DATA_FILE);

console.log('Admin password updated. Log in at /admin with the new password.');
