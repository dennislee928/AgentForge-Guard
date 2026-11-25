const { test } = require('node:test');
const assert = require('node:assert/strict');

test('adoption observation never turns unavailable data into zero or claims unique users', async () => {
  const { collect } = await import('../../../scripts/n8n-adoption.mjs');
  let calls = 0;
  const snapshot = await collect(async () => {
    calls++;
    return { ok: false, status: 404 };
  }, new Date('2026-11-25T00:00:00Z'));
  assert.equal(calls, 4);
  assert.equal(snapshot.npmVersion, null);
  assert.equal(snapshot.weeklyDownloads, null);
  assert.equal(snapshot.monthlyDownloads, null);
  assert.deepEqual(snapshot.thirdPartyUsageEvidence, []);
  assert.equal(snapshot.downloadsAreNotUniqueUsers, true);
});

test('adoption counts are read only from public APIs and preserve observed values', async () => {
  const { collect, packageName } = await import('../../../scripts/n8n-adoption.mjs');
  const values = [{ name: packageName, version: '0.1.0' }, { downloads: 17 }, { downloads: 39 }, { crate: { max_version: '1.0.0-rc.6' } }];
  const urls = [];
  const snapshot = await collect(async (url, options) => {
    urls.push(url);
    assert.equal(options.method, undefined);
    assert.ok(!url.includes('.tgz'));
    return { ok: true, status: 200, json: async () => values.shift() };
  });
  assert.equal(urls.length, 4);
  assert.equal(snapshot.weeklyDownloads, 17);
  assert.equal(snapshot.monthlyDownloads, 39);
  assert.equal(snapshot.cratesVersion, '1.0.0-rc.6');
});
