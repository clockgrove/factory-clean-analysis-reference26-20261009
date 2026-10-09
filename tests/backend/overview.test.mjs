import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';
import { expected } from '../integration/oracle.js';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);

// Independent reduction: group oracle matches by service, then count and
// average each subset without using the server's aggregation implementation.
function measures(options) {
  const { items } = expected(options);
  const services = [...new Set(items.map(row => row.service))].map(service => {
    const incidents = items.filter(row => row.service === service);
    const resolved = incidents.filter(row => row.status === 'resolved');
    const milliseconds = resolved.reduce((sum, row) => sum + (new Date(row.resolvedAt) - new Date(row.openedAt)), 0);
    return {
      service,
      incidentCount: incidents.length,
      unresolvedCount: incidents.filter(row => ['open', 'in_progress'].includes(row.status)).length,
      highSeverityCount: incidents.filter(row => row.severity === 'critical' || row.severity === 'high').length,
      averageResolutionHours: resolved.length ? milliseconds / resolved.length / 3600000 : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service));
  return { total: items.length, services };
}

function parameters(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

test('whole-result service overview through real loopback HTTP', { timeout: 30000 }, async t => {
  const before = await readFile(dataURL);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening', { signal: AbortSignal.timeout(5000) });
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = path => fetch(base + path, { signal: AbortSignal.timeout(5000) });
    const check = async (options = {}) => {
      const response = await request(`/api/overview?${parameters(options)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const actual = await response.json();
      assert.deepEqual(actual, measures(options));
      assert.equal(actual.services.reduce((sum, service) => sum + service.incidentCount, 0), actual.total);
      return actual;
    };

    await t.test('all canonical measures and unresolved ordering', async () => {
      const actual = await check();
      assert.equal(actual.total, 2400);
      assert.equal(actual.services.length, 6);
      assert.ok(actual.services.every(service => service.averageResolutionHours > 0));
    });
    await t.test('combined filters span pages and ignore pagination and sorting', async () => {
      const options = { q: 'iNcIdEnT', service: ['Accounts', 'Billing'], status: ['open', 'resolved'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29' };
      const baseline = await check(options);
      assert.ok(baseline.total > 50);
      const list = await request(`/api/incidents?${parameters(options)}`);
      const page = await list.json();
      assert.equal(page.total, baseline.total);
      assert.equal(page.items.length, 25);
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          for (const pageSize of [25, 50]) {
            assert.deepEqual(await check({ ...options, sort, direction, pageSize, page: 2 }), baseline);
          }
        }
      }
      assert.deepEqual(await check({ ...options, page: 999999 }), baseline);
      await check({ service: ['Billing', 'Billing', 'Search'] });
    });
    await t.test('literal case-insensitive search across all searchable fields', async () => {
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>', 'retry, then continue', '.*', '[']) await check({ q });
    });
    await t.test('unresolved-only matches have null averages; resolved ties sort by service', async () => {
      for (const status of [['open'], ['in_progress'], ['open', 'in_progress']]) {
        const actual = await check({ status });
        assert.ok(actual.total > 50);
        assert.ok(actual.services.every(service => service.unresolvedCount === service.incidentCount && service.averageResolutionHours === null));
      }
      const resolved = await check({ status: ['resolved'] });
      assert.ok(resolved.services.every(service => service.unresolvedCount === 0));
      assert.deepEqual(resolved.services.map(service => service.service), ['Accounts', 'Billing', 'Integrations', 'Notifications', 'Search', 'Uploads']);
    });
    await t.test('inclusive UTC boundaries, single-ended ranges and empty results', async () => {
      for (const day of ['2026-04-01', '2026-06-29']) {
        assert.ok((await check({ from: day, to: day })).total > 0);
      }
      await check({ from: '2026-06-13' });
      await check({ to: '2026-04-15' });
      for (const options of [{ q: 'no such incident', page: 300 }, { from: '2027-01-01' }, { service: ['Billing'], q: 'INC-000001' }]) {
        assert.deepEqual(await check(options), { total: 0, services: [] });
      }
    });
    await t.test('list validation and error conventions apply even to ignored controls', async () => {
      const invalid = ['unknown=yes', 'q=a&q=b', 'service=billing', 'status=closed', 'severity=urgent', 'from=2026-02-30', 'to=2026-13-01', 'from=', 'from=2026-06-01&to=2026-04-01', 'from=2026-4-01', 'to=a&to=b', 'sort=id', 'sort=severity&sort=openedAt', 'direction=down', 'direction=asc&direction=desc', 'page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'page=1&page=2', 'pageSize=100', 'pageSize=25&pageSize=50'];
      for (const params of invalid) {
        const overview = await request(`/api/overview?${params}`);
        const list = await request(`/api/incidents?${params}`);
        assert.equal(overview.status, 400, params);
        assert.equal(list.status, 400, params);
        const body = await overview.json();
        assert.equal(body.error.code, 'INVALID_QUERY');
        assert.ok(body.error.message.length);
        assert.deepEqual(body, await list.json());
      }
      const response = await fetch(`${base}/api/overview`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.deepEqual(await readFile(dataURL), before);
  }
});
