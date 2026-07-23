'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.AppPlugin = class AppPlugin {};
global.CollectionPlugin = class CollectionPlugin {};
global.window = global;
const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const Plugin = new Function(source + '\n;return Plugin;')();

function state() {
  return {
    journalSeen: new Set(),
    journalReconcileRuns: new Map(),
    journalReconcileTimers: new Set(),
    journalReconcileDebounce: new Map(),
  };
}

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] || null,
  };
}

function serialLocks() {
  const tails = new Map();
  return {
    request: async (name, _options, callback) => {
      const prior = tails.get(name) || Promise.resolve();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      tails.set(name, prior.then(() => gate));
      await prior;
      try { return await callback({ name }); }
      finally { release(); }
    },
  };
}

function journalFixture(specs, day = new Date(2026, 6, 23)) {
  const record = {
    guid: 'S-JOURNAL-USER-0-20260723',
    getJournalDetails: () => ({ date: day, userGuid: 'USER' }),
    getLineItems: async () => lines.filter(line => !line.deleted),
  };
  const lines = specs.map(spec => {
    const line = {
      guid: spec.guid,
      type: spec.type || 'ulist',
      parent_guid: spec.parent || record.guid,
      segments: [{ type: 'text', text: spec.text }],
      props: { ...(spec.props || {}) },
      deleted: false,
      setMetaProperties: async patch => {
        line.props = { ...line.props, ...patch };
        return true;
      },
      getTreeContext: async () => {
        const descendants = [];
        const visit = guid => {
          for (const child of lines.filter(item => !item.deleted && item.parent_guid === guid)) {
            descendants.push(child);
            visit(child.guid);
          }
        };
        visit(line.guid);
        return { ancestors: [], descendants };
      },
      move: async (parent, after) => {
        if (spec.move) return await spec.move(line, parent, after);
        line.parent_guid = parent.guid;
        return line;
      },
      delete: async () => {
        if (lines.some(item => !item.deleted && item.parent_guid === line.guid)) return false;
        line.deleted = true;
        return true;
      },
    };
    return line;
  });
  return { record, lines };
}

function retryMoveFixture() {
  const canonical = [
    { guid: 'H-A', type: 'heading', text: 'Time Block', parent_guid: 'S-JOURNAL-USER-0-20260723' },
    { guid: 'A-A', type: 'ulist', text: 'Existing', parent_guid: 'H-A' },
    { guid: 'H-Z', type: 'heading', text: 'Time Block', parent_guid: 'S-JOURNAL-USER-0-20260723' },
    { guid: 'MOVE-Z', type: 'ulist', text: 'Authored', parent_guid: 'H-Z' },
  ];
  const calls = [];
  let snapshots = 0;
  const record = {
    guid: 'S-JOURNAL-USER-0-20260723',
    getJournalDetails: () => ({ date: new Date(2026, 6, 23), userGuid: 'USER' }),
    getLineItems: async () => {
      const snapshot = ++snapshots;
      return canonical.map(spec => {
        const handle = {
          guid: spec.guid,
          type: spec.type,
          parent_guid: spec.parent_guid,
          segments: [{ type: 'text', text: spec.text }],
          props: {},
          snapshot,
        };
        handle.move = async (parent, after) => {
          calls.push({
            snapshot,
            parentGuid: parent && parent.guid || null,
            afterGuid: after && after.guid || null,
          });
          if (calls.length === 1) throw new Error('first shape rejected');
          spec.parent_guid = after && after.parent_guid || parent && parent.guid || spec.parent_guid;
          handle.parent_guid = spec.parent_guid;
          return handle;
        };
        return handle;
      });
    },
  };
  return { record, calls, get snapshots() { return snapshots; } };
}

(async () => {
  global.localStorage = storage();
  Object.defineProperty(global, 'navigator', {
    value: { locks: serialLocks() },
    configurable: true,
  });
  const first = new Plugin(), second = new Plugin();
  first._state = state(); second._state = state();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const dayKey = 'S-JOURNAL-USER-0-20260723|20260723';
  const one = first._withJournalOpenLock(dayKey, async () => {
    const lease = JSON.parse(localStorage.getItem('tmpl-jopen:' + dayKey));
    assert.strictEqual(lease.done, undefined, 'lease is written before the first awaited work');
    await held;
    writes++;
    return true;
  });
  const two = second._withJournalOpenLock(dayKey, async () => { writes++; return true; });
  await Promise.resolve();
  release();
  assert.deepStrictEqual(await Promise.all([one, two]), [true, false]);
  assert.strictEqual(writes, 1, 'two tabs run Journal open work exactly once');
  assert.strictEqual(JSON.parse(localStorage.getItem('tmpl-jopen:' + dayKey)).done, true);
  console.log('PASS Journal Web Lock and pre-await two-phase lease serialize a tab race');

  const midnight = new Plugin();
  midnight._state = state();
  const page = { guid: 'S-PAGE', getJournalDetails: () => ({ date: new Date(2026, 6, 23) }) };
  assert.strictEqual(midnight._journalDayKey(page), 'S-PAGE|20260723',
    'day key comes from the page Journal date, not wall-clock now');
  console.log('PASS Journal day key survives a midnight straddle');

  const markerPlugin = new Plugin();
  markerPlugin._state = state();
  const calls = [];
  let created = 0;
  const markedRecord = {
    createLineItem: async (_parent, _after, type) => {
      const line = {
        guid: 'M' + (++created),
        setMetaProperties: async patch => { calls.push(['meta', line.guid, patch]); return true; },
      };
      calls.push(['create', line.guid, type]);
      return line;
    },
  };
  await markerPlugin.writeBody(markedRecord, '## Time Block\n- work', {
    marker: { templateGuid: 'T', pageYmd: '20260723', child: 'T|20260723', heading: 'T|20260723|v1' },
  });
  assert.deepStrictEqual(calls.map(call => call.slice(0, 2)), [
    ['create', 'M1'], ['meta', 'M1'], ['create', 'M2'], ['meta', 'M2'],
  ], 'setMetaProperties runs immediately after each createLineItem');
  assert.deepStrictEqual(calls[1][2], { tp_tmplc: 'T|20260723', tp_tmpl: 'T|20260723|v1' });
  assert.deepStrictEqual(calls[3][2], { tp_tmplc: 'T|20260723' });
  console.log('PASS created headings and children receive immediate line meta markers');

  const base = 'TEMPLATE|20260723';
  const marked = journalFixture([
    { guid: 'H-A', type: 'heading', text: 'Time Block', props: { heading_size: 2, tp_tmpl: base + '|v1', tp_tmplc: base } },
    { guid: 'C-A', text: 'Generated', parent: 'H-A', props: { tp_tmplc: base } },
    { guid: 'H-Z', type: 'heading', text: 'Time Block', props: { heading_size: 2, tp_tmpl: base + '|v1', tp_tmplc: base } },
    { guid: 'C-Z', text: 'Generated', parent: 'H-Z', props: { tp_tmplc: base } },
    { guid: 'USER-Z', text: 'test', parent: 'H-Z' },
  ]);
  const reconcile = new Plugin();
  reconcile._state = state();
  reconcile.data = { getRecord: () => marked.record };
  const emptyCatalog = { byNorm: new Map(), byTemplate: new Map() };
  const report = await reconcile._reconcileJournalRecord(marked.record, { catalog: emptyCatalog, reason: 'test' });
  assert.strictEqual(marked.lines.find(line => line.guid === 'H-Z').deleted, true);
  assert.strictEqual(marked.lines.find(line => line.guid === 'C-Z').deleted, true);
  assert.strictEqual(marked.lines.find(line => line.guid === 'USER-Z').deleted, false);
  assert.strictEqual(marked.lines.find(line => line.guid === 'USER-Z').parent_guid, 'H-A',
    'authored content moves under the smallest-GUID survivor');
  assert.ok(report.deleted >= 2);
  console.log('PASS reconcile deletes only marked twins and preserves authored loser content by move');

  const retry = retryMoveFixture();
  const retryPlugin = new Plugin();
  retryPlugin._state = state();
  retryPlugin.data = { getRecord: () => retry.record };
  const retryItems = await retry.record.getLineItems(false);
  const retryContext = {
    record: retry.record,
    items: retryItems,
    byGuid: new Map(retryItems.map(line => [line.guid, line])),
    children: retryPlugin._journalChildrenMap(retryItems),
  };
  const retried = await retryPlugin._journalMoveLine(
    retryContext,
    retryContext.byGuid.get('MOVE-Z'),
    retryContext.byGuid.get('H-A'),
    retryContext.byGuid.get('A-A')
  );
  assert.strictEqual(retried.shape, 'record-parent+anchor',
    'a rejected line-parent call falls through to the record+anchor shape');
  assert.strictEqual(retry.calls.length, 2);
  assert.notStrictEqual(retry.calls[0].snapshot, retry.calls[1].snapshot,
    'each move attempt uses handles from a new record snapshot');
  assert.deepStrictEqual(retry.calls.map(call => [call.parentGuid, call.afterGuid]), [
    ['H-A', 'A-A'],
    [retry.record.guid, 'A-A'],
  ]);
  assert.strictEqual(retryContext.byGuid.get('MOVE-Z').parent_guid, 'H-A');
  console.log('PASS rejected first move shape re-fetches handles and succeeds with the second shape');

  const probeFixture = retryMoveFixture();
  const probePlugin = new Plugin();
  probePlugin._state = state();
  probePlugin.data = { getRecord: () => probeFixture.record };
  probePlugin.ui = { getActivePanel: () => ({ getActiveRecord: () => probeFixture.record }) };
  const probe = await probePlugin._runJournalMoveProbe({
    lineGuid: 'MOVE-Z',
    targetHeadingGuid: 'H-A',
  });
  assert.strictEqual(probe.ok, true);
  assert.strictEqual(probe.shape, 'record-parent+anchor');
  assert.match(probe.note, /no delete was attempted/);
  console.log('PASS guarded MOVE_PROBE reports the successful live-compatible shape');

  const rejected = journalFixture([
    { guid: 'H-A', type: 'heading', text: 'Time Block', props: { heading_size: 2, tp_tmpl: base + '|v1', tp_tmplc: base } },
    { guid: 'C-A', text: 'Generated', parent: 'H-A', props: { tp_tmplc: base } },
    { guid: 'H-Z', type: 'heading', text: 'Time Block', props: { heading_size: 2, tp_tmpl: base + '|v1', tp_tmplc: base } },
    { guid: 'C-Z', text: 'Generated', parent: 'H-Z', props: { tp_tmplc: base } },
    { guid: 'USER-Z', text: 'keep me', parent: 'H-Z', move: async () => null },
  ]);
  const deferPlugin = new Plugin();
  deferPlugin._state = state();
  deferPlugin.data = { getRecord: () => rejected.record };
  const scheduled = [];
  deferPlugin._scheduleJournalReconcile = (_record, delay, reason) => scheduled.push({ delay, reason });
  const deferred = await deferPlugin._reconcileJournalRecord(rejected.record, {
    catalog: emptyCatalog,
    reason: 'move-rejected',
  });
  assert.strictEqual(rejected.lines.find(line => line.guid === 'USER-Z').deleted, false);
  assert.strictEqual(rejected.lines.find(line => line.guid === 'USER-Z').parent_guid, 'H-Z');
  assert.strictEqual(rejected.lines.find(line => line.guid === 'H-Z').deleted, false,
    'the loser heading remains while its authored child could not move');
  assert.strictEqual(deferred.deferred, 1);
  assert.strictEqual(deferred.moveFailures, 1);
  assert.deepStrictEqual(deferred.errors, []);
  assert.deepStrictEqual(scheduled, [{ delay: 30000, reason: 'move-deferred' }]);
  console.log('PASS exhausted move shapes defer only the group and never delete the failed line');

  const markerless = journalFixture([
    { guid: 'H-1', type: 'heading', text: 'Quick Log', props: { heading_size: 2 } },
    { guid: 'C-1', text: 'Capture', parent: 'H-1' },
    { guid: 'H-2', type: 'heading', text: 'Quick Log', props: { heading_size: 2 } },
    { guid: 'C-2', text: 'Capture', parent: 'H-2' },
  ]);
  const expected = {
    type: 'heading',
    segments: [{ type: 'text', text: 'Quick Log' }],
    props: { heading_size: 2 },
    children: [{
      type: 'ulist',
      segments: [{ type: 'text', text: 'Capture' }],
      props: null,
      children: [],
    }],
  };
  const entry = { templateGuid: 'CLI-TEMPLATE', norm: 'quick log', expected };
  const catalog = {
    byNorm: new Map([['quick log', [entry]]]),
    byTemplate: new Map([['CLI-TEMPLATE|quick log', [entry]]]),
  };
  const adopt = new Plugin();
  adopt._state = state();
  adopt.data = { getRecord: () => markerless.record };
  await adopt._reconcileJournalRecord(markerless.record, { catalog, reason: 'markerless' });
  assert.strictEqual(markerless.lines.find(line => line.guid === 'H-2').deleted, true,
    'unambiguous marker-less CLI section is adopted and reconciled');
  assert.strictEqual(markerless.lines.find(line => line.guid === 'C-2').deleted, true);
  assert.strictEqual(markerless.lines.find(line => line.guid === 'H-1').props.tp_tmpl,
    'CLI-TEMPLATE|20260723|v1');
  console.log('PASS marker-less CLI sections join by unambiguous normalized heading');

  assert.match(source, /_reconcileTodayAtBoot\(\)/);
  assert.match(source, /this\._state\.RECONCILE/);
  assert.match(source, /window\.__TEMPLATER_MOVE_PROBE/);
  assert.match(source, /"lineitem\.created", "lineitem\.undeleted"/);
  assert.match(source, /2000, 'panel\.\+2s'/);
  assert.match(source, /10000, 'panel\.\+10s'/);
  console.log('PASS deploy boot and convergence triggers expose the RECONCILE capability');
})().catch(error => { console.error(error); process.exit(1); });
