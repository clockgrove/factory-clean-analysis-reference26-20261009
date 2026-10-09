import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, transition, overviewIdentity, overviewParams, isOverviewCurrent, announcement} from '../../public/state.js';
const send = (s, type, payload = {}) => transition(s, {type, ...payload});
test('overview snapshot excludes sort and pagination but identifies every applied filter', () => {
  let s = send(createState(), 'overview:start');
  const data = {total: 80, services: []};
  s = send(s, 'overview:success', {token: s.overviewOp.token, data});
  const snapshot = s.overview, operation = s.overviewOp;
  for (const patch of [{pageSize: 50}, {sort: 'severity', direction: 'asc'}]) {
    s = send(s, 'intent', {patch});
    assert.equal(s.overview, snapshot); assert.equal(s.overviewOp, operation); assert.equal(isOverviewCurrent(s), true);
  }
  assert.deepEqual([...overviewParams({...s.intent, page: 3}).keys()], []);
  for (const patch of [{q: 'x'}, {service: ['Billing']}, {status: ['open']}, {severity: ['high']}, {from: '2026-04-01'}, {to: '2026-06-01'}]) {
    assert.notEqual(overviewIdentity({...s.intent, ...patch}), overviewIdentity(s.intent));
  }
});
test('filter, recall and navigation replacement reject obsolete success, failure and cleanup after newer failure/retry', () => {
  for (const replacement of [{type: 'intent', patch: {q: 'new'}}, {type: 'restore', view: {q: 'saved'}}, {type: 'address', intent: {q: 'history', page: 3}}]) {
    let s = send(createState(), 'overview:start');
    s = send(s, 'overview:success', {token: s.overviewOp.token, data: {total: 1, services: []}});
    const snapshot = s.overview;
    s = send(s, 'overview:start'); const old = s.overviewOp.token;
    s = transition(s, replacement); s = send(s, 'overview:start'); const failed = s.overviewOp.token;
    s = send(s, 'overview:failure', {token: failed, error: 'Current overview failed'});
    assert.equal(s.overview, snapshot); assert.equal(isOverviewCurrent(s), false);
    for (const type of ['overview:success', 'overview:failure', 'overview:finish']) assert.equal(send(s, type, {token: old, data: {}, error: 'old'}), s);
    s = send(s, 'overview:start');
    assert.equal(overviewParams(s.intent).get('q'), replacement.patch?.q || replacement.view?.q || replacement.intent.q);
    assert.equal(send(s, 'overview:finish', {token: failed}), s); assert.equal(s.overviewOp.pending, true);
    s = send(s, 'overview:success', {token: s.overviewOp.token, data: {total: 0, services: []}});
    assert.equal(isOverviewCurrent(s), true);
  }
});
test('pagination during pending overview keeps ownership and existing error precedence', () => {
  let s = send(createState(), 'result:start');
  s = send(s, 'result:success', {token: s.resultOp.token, data: {page: 1, totalPages: 3, total: 80}});
  s = send(s, 'overview:start'); const op = s.overviewOp;
  s = send(s, 'page', {delta: 1}); assert.equal(s.overviewOp, op);
  s = send(s, 'overview:failure', {token: op.token, error: 'Overview failed'});
  s = send(s, 'export:start'); s = send(s, 'export:failure', {token: s.exportOp.token, error: 'Export failed'});
  assert.equal(announcement(s), 'Export failed');
  s = send(s, 'result:start'); s = send(s, 'result:failure', {token: s.resultOp.token, error: 'Result failed'});
  assert.equal(announcement(s), 'Result failed'); assert.equal(s.overviewOp.error, 'Overview failed');
});

test('history and saved recall supersede pending writers even for matching filters, retaining represented identity', () => {
  for (const event of [{type: 'address', intent: {page: 2}}, {type: 'restore', view: {pageSize: 50}}]) {
    let s = send(createState(), 'overview:start');
    s = send(s, 'overview:success', {token: s.overviewOp.token, data: {total: 80, services: []}});
    const snapshot = s.overview;
    s = send(s, 'overview:start'); const old = s.overviewOp.token;
    s = transition(s, event); assert.equal(s.overview, snapshot); assert.equal(isOverviewCurrent(s), true);
    s = send(s, 'overview:start');
    for (const type of ['overview:success', 'overview:failure', 'overview:finish']) assert.equal(send(s, type, {token: old, data: {}, error: 'obsolete'}), s);
  }
});
