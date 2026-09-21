#!/usr/bin/env node

/**
 * Smoke test for PhoenixAI Studio deployment
 * Tests critical URLs to ensure they return expected status codes
 */

const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const testUrls = [
  { path: '/', expectedStatus: 200, description: 'Root path (index.html)' },
  { path: '/styles.css', expectedStatus: 200, description: 'CSS file' },
  { path: '/script.js', expectedStatus: 200, description: 'JavaScript file' },
  { path: '/admin', expectedStatus: 200, description: 'Admin portal' },
  { path: '/api/health', expectedStatus: 200, description: 'Health check API' },
  { path: '/api/modules', expectedStatus: 200, description: 'Modules API' },
  { path: '/uploads/logo-cutout.png', expectedStatus: 200, description: 'Upload file' },
  { path: '/nonexistent-path', expectedStatus: 404, description: 'Nonexistent path (should be Express 404)' }
];

function testUrl(urlObj) {
  return new Promise((resolve) => {
    const url = `${BASE_URL}${urlObj.path}`;
    console.log(`Testing: ${url} (${urlObj.description})`);
    
    const req = http.get(url, (res) => {
      const statusCode = res.statusCode;
      const passed = statusCode === urlObj.expectedStatus;
      
      console.log(`  Status: ${statusCode} ${passed ? '✓ PASS' : '✗ FAIL'}`);
      
      if (!passed) {
        console.log(`  Expected: ${urlObj.expectedStatus}`);
      }
      
      resolve({
        path: urlObj.path,
        description: urlObj.description,
        status: statusCode,
        expected: urlObj.expectedStatus,
        passed
      });
    });

    req.on('error', (err) => {
      console.log(`  Error: ${err.message} ✗ FAIL`);
      resolve({
        path: urlObj.path,
        description: urlObj.description,
        status: 'ERROR',
        expected: urlObj.expectedStatus,
        passed: false,
        error: err.message
      });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      console.log(`  Timeout ✗ FAIL`);
      resolve({
        path: urlObj.path,
        description: urlObj.description,
        status: 'TIMEOUT',
        expected: urlObj.expectedStatus,
        passed: false,
        error: 'Timeout'
      });
    });
  });
}

async function runTests() {
  console.log(`\n=== PhoenixAI Studio Smoke Test ===`);
  console.log(`Base URL: ${BASE_URL}\n`);

  const results = [];
  
  for (const urlObj of testUrls) {
    const result = await testUrl(urlObj);
    results.push(result);
  }

  console.log('\n=== Summary ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.path}: ${r.status} (expected ${r.expected})`);
    });
    process.exit(1);
  } else {
    console.log('\n✓ All tests passed!');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
