import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected, expectedOverview} from './oracle.js';

const key = 'incident-explorer.triage.v1';
const viewsKey = 'incident-explorer.views.v1';
const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8', timeout: 5000}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');

// Bounded polling of observable production DOM; no HTTP interception or fixtures.
async function until(read, wanted) {
  const deadline = Date.now() + 10000;
  let actual;
  do {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(wanted)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, wanted);
}
const text = (page, selector, wanted) => until(() => page.locator(selector).textContent(), wanted);
const attribute = (page, selector, name, wanted) => until(() => page.locator(selector).getAttribute(name), wanted);
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

// Existing production component suites supply precise success/failure/cleanup
// interleavings; here latency and a real stopped server exercise their DOM wiring.
test('real Chromium: overview intent ownership and complete personal triage journeys', {timeout: 120000}, async t => {
  const before = await readFile('.runtime/incidents.json');
  let server, browser, context, port;
  const start = async () => {
    server = await createAppServer();
    server.listen(port || 0, '127.0.0.1');
    await once(server, 'listening', {signal: AbortSignal.timeout(5000)});
    port = server.address().port;
  };
  const stop = () => closeServer(server);
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, timeout: 15000, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext({locale: 'en-US'});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const throttle = latency => cdp.send('Network.emulateNetworkConditions', {offline: false, latency, downloadThroughput: -1, uploadThroughput: -1});
    const base = () => `http://127.0.0.1:${port}`;
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); };
    const overview = async (options = {}) => {
      await attribute(page, '#overview', 'aria-busy', 'false');
      await attribute(page, '#overview', 'data-stale', 'false');
      const oracle = expectedOverview(options);
      assert.deepEqual(await page.locator('#service-cards article').evaluateAll(cards => cards.map(card => ({service: card.querySelector('h4').textContent, values: [...card.querySelectorAll('dd')].map(x => x.textContent)}))), oracle.services.map(service => ({service: service.service, values: [service.incidentCount, service.unresolvedCount, service.highSeverityCount].map(String).concat(service.averageResolutionHours === null ? 'Unavailable' : service.averageResolutionHours.toLocaleString('en-US', {maximumFractionDigits: 2}))})));
      await text(page, '#overview-message', oracle.total ? '' : 'No services match these selections.');
    };
    const ready = async options => {
      await attribute(page, '#results', 'aria-busy', 'false');
      await text(page, '#freshness', 'Current selections');
      await overview(options);
    };
    const details = async row => {
      await until(() => page.locator('#detail-content dd').count(), 11);
      assert.equal(await page.locator('#detail-content dd').first().textContent(), row.id);
      assert.equal(await page.locator('#detail-content dd').nth(2).textContent(), row.description);
    };
    const add = async row => {
      await page.locator(`#rows button[data-incident="${row.id}"]`).click();
      await details(row);
      await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
      await page.keyboard.press('Escape');
    };
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);

    await t.test('loading, full scope, filter update, pagination and sort independence', async () => {
      await throttle(650); await page.goto(base());
      await text(page, '#overview-message', 'Loading service comparison for current filters…');
      await ready({}); await throttle(0);
      const snapshot = await page.locator('#service-cards').textContent();
      const count = requests.filter(url => url.includes('/api/overview?')).length;
      await page.locator('#next').click(); await ready({page: 2});
      await page.locator('#page-size').selectOption('50'); await ready({pageSize: 50});
      await page.locator('#sort').selectOption('severity'); await ready({sort: 'severity', pageSize: 50});
      assert.equal(await page.locator('#service-cards').textContent(), snapshot);
      assert.equal(requests.filter(url => url.includes('/api/overview?')).length, count);
      await search('incident');
      await page.locator('#service').getByLabel('Billing', {exact: true}).check();
      await page.locator('#service').getByLabel('Accounts', {exact: true}).check();
      await page.locator('#status').getByLabel('open', {exact: true}).check();
      await page.locator('#status').getByLabel('resolved', {exact: true}).check();
      await page.locator('#severity').getByLabel('high', {exact: true}).check();
      await page.locator('#severity').getByLabel('critical', {exact: true}).check();
      await page.locator('#from').fill('2026-04-01'); await page.locator('#to').fill('2026-06-29');
      const options = {q: 'incident', service: ['Accounts', 'Billing'], status: ['open', 'resolved'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29'};
      assert.ok(expectedOverview(options).total > 50);
      await ready(options);
      await page.locator('#next').click(); await ready(options);
      await page.goto(`${base()}/?status=open&status=in_progress`); await ready({status: ['open', 'in_progress']});
      assert.ok((await page.locator('#service-cards dd').allTextContents()).includes('Unavailable'));
      await search('no incidents match this'); await ready({q: 'no incidents match this', status: ['open', 'in_progress']});
    });

    await t.test('selection replacement and Back during pending overview, real failure and retry', async () => {
      await page.goto(base()); await ready({});
      await search('Uploads'); await ready({q: 'Uploads'});
      const previous = await page.locator('#service-cards').textContent();
      await throttle(1000);
      const pending = page.waitForRequest(request => request.url().includes('/api/overview?') && new URL(request.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await pending;
      await attribute(page, '#overview', 'aria-busy', 'true');
      await attribute(page, '#overview', 'data-stale', 'true');
      await text(page, '#overview-selection', 'Previous selection: Search: Uploads.');
      assert.equal(await page.locator('#service-cards').textContent(), previous);
      await stop();
      await page.evaluate(() => history.back());
      await until(() => page.locator('#overview-message button').textContent(), 'Retry');
      await attribute(page, '#overview', 'aria-busy', 'false');
      assert.equal(await page.locator('#search').inputValue(), 'Uploads');
      assert.equal(await page.locator('#service-cards').textContent(), previous);
      // A newer failure owns its message even after the superseded request ends.
      await search('Notifications');
      await until(() => page.locator('#overview-message button').textContent(), 'Retry');
      await attribute(page, '#overview', 'data-stale', 'true');
      await text(page, '#overview-selection', 'Previous selection: Search: Uploads.');
      await start(); await throttle(0);
      const length = await page.evaluate(() => history.length);
      await page.locator('#overview-message button').click(); await overview({q: 'Notifications'});
      await page.locator('#result-message button').click(); await ready({q: 'Notifications'});
      assert.equal(await page.evaluate(() => history.length), length);
      await text(page, '#overview-selection', 'Represented selection: Search: Notifications.');
      await page.evaluate(() => history.back()); await ready({q: 'Uploads'});
      await page.evaluate(() => history.forward()); await ready({q: 'Notifications'});
    });

    await t.test('keyboard add, ordered deduplication, text notes, reload and details preserve page/results', async () => {
      await page.goto(`${base()}/?q=incident&page=2`); await ready({q: 'incident', page: 2});
      const first = expected({q: 'incident'}).items[25], second = expected({q: 'incident'}).items[26];
      const button = page.locator('#rows button').first();
      await button.focus(); await button.press('Enter'); await details(first);
      const addButton = page.getByRole('button', {name: 'Add to personal triage', exact: true});
      await addButton.focus();
      assert.notEqual(await addButton.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      await addButton.press('Enter');
      assert.equal(await page.getByRole('button', {name: 'Already in personal triage'}).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await button.evaluate(x => x === document.activeElement), true);
      await add(second);
      const note = '<script>window.triageInjected = true</script> & "quotes"\nNext line';
      await page.getByLabel(`Personal note for ${first.id}`).fill(note);
      assert.equal(await page.getByLabel(`Personal note for ${first.id}`).getAttribute('maxlength'), '1000');
      assert.deepEqual((await stored()).map(entry => entry.id), [first.id, second.id]);
      assert.deepEqual((await stored()).map(({note, ...snapshot}) => snapshot), [first, second].map(row => Object.fromEntries(['id', 'title', 'service', 'severity', 'status', 'openedAt'].map(field => [field, row[field]]))));
      assert.equal((await stored())[0].note, note);
      assert.equal(await page.evaluate(() => window.triageInjected), undefined);
      assert.equal(await page.locator('#triage-list script').count(), 0);
      await page.locator('#view-name').fill('Investigation'); await page.locator('#save-form button').click();
      const views = await page.evaluate(key => localStorage.getItem(key), viewsKey);
      const address = page.url(), results = await page.locator('#rows').textContent();
      await page.reload(); await ready({q: 'incident', page: 2});
      assert.equal(await page.getByLabel(`Personal note for ${first.id}`).inputValue(), note);
      assert.equal(page.url(), address);
      await page.getByRole('button', {name: `Reopen triage incident ${first.id}`}).focus();
      await page.keyboard.press('Enter'); await details(first);
      assert.equal(await page.getByRole('button', {name: 'Already in personal triage'}).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', {name: `Reopen triage incident ${first.id}`}).evaluate(x => x === document.activeElement), true);
      assert.equal(await page.locator('#rows').textContent(), results); assert.equal(page.url(), address);
      assert.equal((await stored()).length, 2);
      await page.getByLabel(`Personal note for ${first.id}`).fill('Edited plain text <b>still text</b>');
      await page.reload(); await ready({q: 'incident', page: 2});
      assert.equal(await page.getByLabel(`Personal note for ${first.id}`).inputValue(), 'Edited plain text <b>still text</b>');
      await page.getByRole('button', {name: `Remove ${first.id} from triage`}).click();
      assert.deepEqual((await stored()).map(entry => entry.id), [second.id]);
      await add(first);
      assert.deepEqual((await stored()).map(entry => entry.id), [second.id, first.id]);
      assert.equal((await stored())[1].note, '');
      await page.getByLabel(`Personal note for ${second.id}`).fill('');
      await page.reload(); await ready({q: 'incident', page: 2});
      assert.ok((await stored()).every(entry => entry.note === ''));
      assert.equal(await page.evaluate(key => localStorage.getItem(key), viewsKey), views);
      assert.equal(page.url(), address);
      assert.ok(requests.every(url => !url.includes('triageInjected') && !url.includes('note=')));
    });

    await t.test('phone service measures and every triage action remain reachable', async () => {
      await page.setViewportSize({width: 375, height: 812});
      await ready({q: 'incident', page: 2});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const measure of await page.locator('#service-cards h4, #service-cards dt, #service-cards dd').all()) {
        await measure.scrollIntoViewIfNeeded();
        const box = await measure.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 375);
      }
      for (const action of await page.locator('#triage-list button, #triage-list textarea').all()) {
        await action.scrollIntoViewIfNeeded();
        const box = await action.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 375);
      }
      const row = expected({q: 'incident'}).items[26];
      const reopen = page.getByRole('button', {name: `Reopen triage incident ${row.id}`});
      await reopen.focus(); await reopen.press('Enter'); await details(row);
      await page.getByRole('button', {name: 'Close details'}).click();
      assert.equal(await reopen.evaluate(x => x === document.activeElement), true);
      const note = page.getByLabel(`Personal note for ${row.id}`);
      await note.focus(); await note.fill('Phone keyboard note');
      const remove = page.getByRole('button', {name: `Remove ${row.id} from triage`});
      await remove.focus(); await remove.press('Enter');
      assert.equal(await page.locator('#triage-title').evaluate(x => x === document.activeElement), true);
      assert.ok(!(await stored()).some(entry => entry.id === row.id));
      // The add action in complete details also fits and operates on the phone.
      const third = expected({q: 'incident'}).items[27];
      await page.locator(`#rows button[data-incident="${third.id}"]`).click(); await details(third);
      const addButton = page.getByRole('button', {name: 'Add to personal triage', exact: true});
      await addButton.scrollIntoViewIfNeeded();
      const box = await addButton.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 375);
      await addButton.focus(); await addButton.press('Enter'); await page.keyboard.press('Escape');
      await page.getByRole('button', {name: `Remove ${third.id} from triage`}).click();
      await page.setViewportSize({width: 1280, height: 900});
    });

    await t.test('malformed storage and later quota failures keep current visit usable and warn about reload', async () => {
      await page.evaluate(key => localStorage.setItem(key, '{malformed'), key);
      await page.reload(); await ready({q: 'incident', page: 2});
      await until(async () => (await page.locator('#triage-message').textContent()).includes('could not be understood'), true);
      const first = expected({q: 'incident'}).items[25], second = expected({q: 'incident'}).items[26];
      await add(first);
      await page.getByLabel(`Personal note for ${first.id}`).fill('Durable note');
      await page.evaluate(key => {
        const original = Storage.prototype.setItem;
        window.restoreStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function(name, value) {
          if (name === key) throw new DOMException('Quota exhausted', 'QuotaExceededError');
          return original.call(this, name, value);
        };
      }, key);
      await add(second);
      await page.getByLabel(`Personal note for ${first.id}`).fill('Visit-only note');
      await until(async () => (await page.locator('#triage-message').textContent()).includes('could not save'), true);
      assert.equal(await page.getByLabel(`Personal note for ${first.id}`).inputValue(), 'Visit-only note');
      await page.getByRole('button', {name: `Remove ${second.id} from triage`}).click();
      assert.equal(await page.getByRole('button', {name: `Reopen triage incident ${second.id}`}).count(), 0);
      assert.equal((await stored())[0].note, 'Durable note');
      await page.evaluate(() => window.restoreStorage());
      await page.getByLabel(`Personal note for ${first.id}`).fill('Recovered note');
      await until(async () => (await page.locator('#triage-message').textContent()).includes('could not save'), false);
      await until(async () => (await page.locator('#triage-message').textContent()).includes('could not be understood'), true);
      await page.reload(); await ready({q: 'incident', page: 2});
      assert.equal(await page.getByLabel(`Personal note for ${first.id}`).inputValue(), 'Recovered note');
      await text(page, '#triage-message', '');
    });

    await t.test('unavailable browser storage supports visit additions, editing, reopening and removal', async () => {
      const limited = await browser.newContext();
      try {
        await limited.addInitScript(key => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          Storage.prototype.getItem = function(name) { if (name === key) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, name); };
          Storage.prototype.setItem = function(name, value) { if (name === key) throw new DOMException('Blocked', 'SecurityError'); return set.call(this, name, value); };
        }, key);
        const tab = await limited.newPage(); tab.setDefaultTimeout(10000);
        await tab.goto(base());
        await attribute(tab, '#results', 'aria-busy', 'false');
        await attribute(tab, '#overview', 'aria-busy', 'false');
        const id = expected().items[0].id;
        await tab.locator('#rows button').first().click();
        await until(() => tab.locator('#detail-content dd').count(), 11);
        await tab.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
        await tab.keyboard.press('Escape');
        await tab.getByLabel(`Personal note for ${id}`).fill('<text> in memory');
        await until(async () => (await tab.locator('#triage-message').textContent()).includes('could not save'), true);
        assert.match(await tab.locator('#triage-message').textContent(), /could not be read/);
        await tab.getByRole('button', {name: `Reopen triage incident ${id}`}).click();
        await until(() => tab.locator('#detail-content dd').count(), 11);
        await tab.keyboard.press('Escape');
        assert.equal(await tab.getByLabel(`Personal note for ${id}`).inputValue(), '<text> in memory');
        await tab.getByRole('button', {name: `Remove ${id} from triage`}).click();
        await text(tab, '#triage-list', 'No incidents in personal triage yet.');
        await tab.reload(); await attribute(tab, '#results', 'aria-busy', 'false');
        await text(tab, '#triage-list', 'No incidents in personal triage yet.');
      } finally { await limited.close(); }
    });
    assert.deepEqual(errors, []);
    assert.ok(requests.every(url => new URL(url).origin === base()), 'all observed application requests stay on the local origin');
  } finally {
    try { await context?.close(); }
    finally { try { await browser?.close(); } finally { await stop(); } }
    assert.deepEqual(await readFile('.runtime/incidents.json'), before);
  }
});
