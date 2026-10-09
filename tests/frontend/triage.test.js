import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriage, isCompleteIncident, triageStorageKey} from '../../public/triage.js';

const incident = id => ({id, title: '<Billing> & "follow up"', description: 'Plain text', service: 'Billing', severity: 'high', status: 'open', openedAt: '2026-04-01T12:00:00.000Z', resolvedAt: null, team: 'Support', region: 'AMER', tags: ['<text>']});
function memory(raw = null) {
  return {raw, getItem(key) { assert.equal(key, triageStorageKey); return this.raw; }, setItem(key, value) { assert.equal(key, triageStorageKey); this.raw = value; }};
}

test('triage preserves insertion order and text notes, deduplicates, reloads and deletes notes on removal', () => {
  const storage = memory(), triage = createTriage(storage);
  assert.equal(triage.add(incident('INC-000002')), true);
  triage.add(incident('INC-000001'));
  const note = '<script>literal</script> & "quotes"\nNext line';
  assert.equal(triage.edit('INC-000002', note), true);
  assert.equal(triage.add({...incident('INC-000002'), title: 'Updated canonical title'}), false);
  assert.deepEqual(triage.entries.map(entry => entry.id), ['INC-000002', 'INC-000001']);
  assert.equal(triage.entries[0].note, note);
  assert.equal(triage.entries[0].title, incident('INC-000002').title);
  assert.deepEqual(createTriage(storage).entries, triage.entries);
  assert.equal(triage.remove('INC-000002'), true);
  triage.add(incident('INC-000002'));
  assert.deepEqual(triage.entries.map(entry => entry.id), ['INC-000001', 'INC-000002']);
  assert.equal(triage.entries[1].note, '');
  assert.equal(createTriage(storage).entries[1].note, '');
  const external = triage.entries; external[0].note = 'unowned mutation';
  assert.equal(triage.entries[0].note, '');
});

test('malformed storage starts usable empty state with a persistent read limitation', () => {
  const valid = {...incident('INC-000001'), note: ''};
  delete valid.description; delete valid.resolvedAt; delete valid.team; delete valid.region; delete valid.tags;
  for (const raw of ['{', 'null', '{}', JSON.stringify([valid, valid]), JSON.stringify([{...valid, note: 4}]), JSON.stringify([{...valid, service: 'Unknown'}]), JSON.stringify([{...valid, openedAt: '2026-02-30T00:00:00Z'}]), JSON.stringify([{...valid, note: 'x'.repeat(1001)}]), JSON.stringify([{...valid, unexpected: true}])]) {
    const triage = createTriage(memory(raw));
    assert.deepEqual(triage.entries, []); assert.match(triage.limitation, /could not be understood/);
    assert.equal(triage.add(incident('INC-000002')), true);
    assert.equal(triage.entries.length, 1); assert.match(triage.limitation, /could not be understood/);
  }
});

test('read and later write failures retain usable visit additions, edits and removals', () => {
  const storage = memory(); let failWrite = false;
  const set = storage.setItem;
  storage.getItem = () => { throw new Error('Read blocked'); };
  storage.setItem = function(...args) { if (failWrite) throw new Error('Quota'); set.apply(this, args); };
  const triage = createTriage(storage);
  assert.match(triage.limitation, /could not be read/);
  triage.add(incident('INC-000001'));
  failWrite = true;
  triage.add(incident('INC-000002')); triage.edit('INC-000001', '<not markup>');
  assert.deepEqual(triage.entries.map(entry => entry.id), ['INC-000001', 'INC-000002']);
  assert.equal(triage.entries[0].note, '<not markup>');
  assert.match(triage.limitation, /could not save/);
  triage.remove('INC-000001');
  assert.deepEqual(triage.entries.map(entry => entry.id), ['INC-000002']);
  failWrite = false; triage.edit('INC-000002', 'Recovered');
  assert.match(triage.limitation, /could not be read/);
  assert.doesNotMatch(triage.limitation, /could not save/);
  assert.equal(JSON.parse(storage.raw)[0].note, 'Recovered');
  assert.equal(createTriage(undefined).add(incident('INC-000003')), true);
});

test('only complete incidents and bounded string notes can mutate triage', () => {
  const triage = createTriage(memory()), full = incident('INC-000001');
  assert.equal(isCompleteIncident(full), true);
  for (const key of Object.keys(full)) {
    const incomplete = {...full}; delete incomplete[key];
    assert.equal(isCompleteIncident(incomplete), false, key);
    assert.equal(triage.add(incomplete), false, key);
  }
  assert.equal(triage.add({...full, status: 'resolved'}), false);
  assert.equal(triage.add({...full, resolvedAt: full.openedAt}), false);
  triage.add(full);
  assert.equal(triage.edit(full.id, 'x'.repeat(1000)), true);
  assert.equal(triage.edit(full.id, 'x'.repeat(1001)), false);
  assert.equal(triage.edit(full.id, {}), false);
  assert.equal(triage.edit('INC-999999', 'missing'), false);
  assert.equal(triage.remove('INC-999999'), false);
  assert.equal(triage.entries[0].note.length, 1000);
});
