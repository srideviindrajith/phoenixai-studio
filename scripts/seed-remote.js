// Seed script to migrate local data.json and uploads to remote storage
// Usage: node --env-file=.env.local scripts/seed-remote.js

require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');

const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
  console.error('ERROR: KV_REST_API_URL and KV_REST_API_TOKEN must be set in .env.local');
  process.exit(1);
}

if (!BLOB_READ_WRITE_TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN must be set in .env.local');
  process.exit(1);
}

console.log('[SEED] Starting remote storage migration...');

// Read local data.json
const DATA_FILE = path.join(__dirname, '../data.json');
if (!fs.existsSync(DATA_FILE)) {
  console.error('ERROR: data.json not found. Run the app locally first to generate it.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
console.log('[SEED] Loaded data.json');

// Upload files to Blob
async function uploadFile(filePath, folder) {
  const { put } = await import('@vercel/blob');
  const filename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  
  const blobPath = `${folder}/${filename}`;
  console.log(`[SEED] Uploading ${filePath} to ${blobPath}...`);
  
  const blob = await put(blobPath, buffer, {
    access: 'public',
    addRandomSuffix: false,
    token: BLOB_READ_WRITE_TOKEN
  });
  
  console.log(`[SEED] Uploaded: ${blob.url}`);
  return blob.url;
}

// Upload all files in uploads/
async function uploadUploads() {
  const uploadsDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.log('[SEED] No uploads directory found, skipping file uploads');
    return {};
  }

  const fileMap = {};
  const files = fs.readdirSync(uploadsDir);
  
  for (const file of files) {
    if (file === 'logo-cutout.png') continue; // Skip default logo
    const filePath = path.join(uploadsDir, file);
    if (fs.statSync(filePath).isFile()) {
      const ext = path.extname(file).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'].includes(ext)) {
        const url = await uploadFile(filePath, 'uploads');
        fileMap[file] = url;
      }
    }
  }
  
  return fileMap;
}

// Rewrite data.json with Blob URLs
function rewriteDataWithBlobUrls(data, fileMap) {
  function rewriteUrl(url) {
    if (!url || !url.startsWith('/uploads/')) return url;
    const filename = url.replace('/uploads/', '');
    return fileMap[filename] || url;
  }

  // Rewrite templates
  if (data.templates) {
    data.templates.forEach(template => {
      template.thumbnail = rewriteUrl(template.thumbnail);
      template.pdf = rewriteUrl(template.pdf);
      if (template.previewImages) {
        template.previewImages = template.previewImages.map(rewriteUrl);
      }
    });
  }

  // Rewrite demo websites
  if (data.demoWebsites) {
    data.demoWebsites.forEach(demo => {
      demo.thumbnail = rewriteUrl(demo.thumbnail);
    });
  }

  // Rewrite AI agents
  if (data.aiAgents) {
    data.aiAgents.forEach(agent => {
      agent.thumbnail = rewriteUrl(agent.thumbnail);
    });
  }

  // Rewrite settings logo
  if (data.settings && data.settings.logo) {
    data.settings.logo = rewriteUrl(data.settings.logo);
  }

  return data;
}

// Save to Redis
async function saveToRedis(key, value) {
  const response = await fetch(KV_REST_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['SET', key, value])
  });

  if (!response.ok) {
    throw new Error(`Redis SET failed: ${response.status}`);
  }

  console.log(`[SEED] Saved ${key} to Redis`);
}

async function main() {
  try {
    // Safety: never overwrite data that is already in Redis unless --force is given.
    const check = await fetch(KV_REST_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', 'phoenixai:data'])
    });
    const checkBody = await check.json();
    if (!check.ok) throw new Error(`Redis GET failed: ${check.status} ${checkBody.error || ''}`);
    if (checkBody.result && !process.argv.includes('--force')) {
      console.error('[SEED] Redis already contains site data. Nothing was changed.');
      console.error('[SEED] Download a backup first (Admin panel -> /api/admin/export), then re-run with --force to overwrite it.');
      process.exit(1);
    }

    // Step 1: Upload files to Blob
    console.log('[SEED] Step 1: Uploading files to Vercel Blob...');
    const fileMap = await uploadUploads();
    console.log(`[SEED] Uploaded ${Object.keys(fileMap).length} files`);

    // Step 2: Rewrite data.json with Blob URLs
    console.log('[SEED] Step 2: Rewriting data.json with Blob URLs...');
    const rewrittenData = rewriteDataWithBlobUrls(data, fileMap);

    // Step 3: Save to Redis
    console.log('[SEED] Step 3: Saving data to Redis...');
    await saveToRedis('phoenixai:data', JSON.stringify(rewrittenData)); // _rev (if any) is kept; the app adds it when missing

    console.log('[SEED] Migration complete!');
    console.log('[SEED] - Files uploaded to Vercel Blob');
    console.log('[SEED] - Data saved to Upstash Redis');
    console.log('[SEED] - /uploads/ URLs rewritten to Blob URLs');
  } catch (error) {
    console.error('[SEED] Migration failed:', error);
    process.exit(1);
  }
}

main();
