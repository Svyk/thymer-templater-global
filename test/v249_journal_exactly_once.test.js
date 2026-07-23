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
      move: async (parent, _after) => {
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
  assert.match(source, /"lineitem\.created", "lineitem\.undeleted"/);
  assert.match(source, /2000, 'panel\.\+2s'/);
  assert.match(source, /10000, 'panel\.\+10s'/);
  console.log('PASS deploy boot and convergence triggers expose the RECONCILE capability');
})().catch(error => { console.error(error); process.exit(1); });
