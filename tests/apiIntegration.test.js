process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/api/server');

test('API Integration: Overview and batch parse endpoints', async (t) => {
  const { server } = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  // 1. Check /api/health
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, 'HEALTHY');

  // 2. Check /api/overview
  const overviewRes = await fetch(`${baseUrl}/api/overview`);
  assert.equal(overviewRes.status, 200);
  const overviewData = await overviewRes.json();
  assert.ok(overviewData.metrics);
  assert.ok(Array.isArray(overviewData.timeSeries));
  assert.ok(overviewData.reliability);
  assert.ok(Array.isArray(overviewData.recentActivity));
  assert.equal(overviewData.range, '24H');

  // Test /api/overview with custom range parameter
  const overviewRangeRes = await fetch(`${baseUrl}/api/overview?range=1H`);
  assert.equal(overviewRangeRes.status, 200);
  const overviewRangeData = await overviewRangeRes.json();
  assert.equal(overviewRangeData.range, '1H');

  // 3. Test /api/targets/batch-parse
  const parseRes = await fetch(`${baseUrl}/api/targets/batch-parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: 'https://www.facebook.com/reel/9991234\nhttps://www.facebook.com/watch/?v=8885678'
    })
  });
  assert.equal(parseRes.status, 200);
  const parseData = await parseRes.json();
  assert.equal(parseData.totalCount, 2);
  assert.equal(parseData.items[0].type, 'reel');
  assert.equal(parseData.items[1].type, 'video');
});
