#!/usr/bin/env node
// Resets the admin password directly in Upstash Redis (Vercel deployments).
// `npm run reset-password` only edits a local data.json, which Vercel doesn't use.
//
// 1. Link the CORRECT Vercel project and pull its PRODUCTION env vars:
//      npx vercel link            (check `.vercel/project.json` afterwards!)
//      npx vercel env pull .env.local --environment=production
// 2. Run with your new password:
//      node --env-file=.env.local scripts/reset-admin-password-remote.js "MyNewStrongPassword"
//
// Existing admin sessions are signed out too (the session version is bumped).

const crypto = require('crypto');

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_KEY = 'phoenixai:data';
const password = process.argv[2];

if (!REST_URL || !REST_TOKEN) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN not found in the environment.');
  console.error('Pull the PRODUCTION variables of the right project first:');
  console.error('  npx vercel link && npx vercel env pull .env.local --environment=production');
  process.exit(1);
}
if (!password || password.length < 8) {
  console.error('Please provide a new password of at least 8 characters:');
  console.error('  node --env-file=.env.local scripts/reset-admin-password-remote.js "MyNewStrongPassword"');
  process.exit(1);
}

async function redis(command) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(plain, salt, 64).toString('hex')}`;
}

async function main() {
  const raw = await redis(['GET', DATA_KEY]);
  if (!raw) throw new Error('No site data found in this Redis yet, so there is nothing to reset. Check that you linked the right project.');

  const data = JSON.parse(raw);
  data.settings = data.settings || {};
  data.settings.adminPassword = hashPassword(password);
  data.settings.sessionVersion = (Number(data.settings.sessionVersion) || 0) + 1;
  data._rev = (Number(data._rev) || 0) + 1; // keeps the app's compare-and-set consistent

  await redis(['SET', DATA_KEY, JSON.stringify(data)]);
  console.log('Admin password updated in Redis and existing sessions were signed out. Log in at /admin with the new password.');
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
