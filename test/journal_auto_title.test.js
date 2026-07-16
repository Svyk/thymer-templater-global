'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.AppPlugin = class AppPlugin {};
global.CollectionPlugin = class CollectionPlugin {};
global.window = global;
const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const Plugin = new Function(source + '\n;return Plugin;')();

(async () => {
  const plugin = new Plugin();

  const journal = { getJournalDetails: () => ({ date: new Date('2026-07-16T00:00:00') }) };
  assert.deepStrictEqual(plugin._recordApplyContext(journal), { hasRecord: true, isJournal: true });
  const journalOptions = plugin._applyTargetOptions('Thu Jul 16', 'Notes', true, true);
  assert.strictEqual(journalOptions[0].k, 'update', 'Journal fill must remain first even when the template is pinned to Notes');
  assert.match(journalOptions[0].l, /keep date title/i);
  assert.strictEqual(journalOptions[2].k, 'create', 'explicit create remains available');
  const journalFrontmatter = { Title: 'Daily Note', Name: 'Daily Note', Mood: 'Good' };
  assert.deepStrictEqual(plugin._removeJournalTitleFields(journalFrontmatter), { Mood: 'Good' }, 'Journal fill strips every title alias but keeps compatible properties');

  const normalOptions = plugin._applyTargetOptions('Meeting', 'Projects', true, false);
  assert.strictEqual(normalOptions[0].k, 'create', 'normal mismatched records preserve create-first behavior');
  console.log('PASS Journal records enter the chooser with fill-current-page as the safe default');

  let storedTitle = 'Seed';
  const values = { status: ['Open'], owner: ['Alice'] };
  const record = {
    getName: () => storedTitle,
    text: label => label === 'Title' ? storedTitle : '',
    prop: id => {
      if (id === 'Title') return { text: () => storedTitle, set: value => { storedTitle = value; } };
      return { selectedChoiceLabels: () => values[id] || [] };
    },
  };
  const collection = { getGuid: () => 'COLL', getName: () => 'Projects' };
  plugin.getConfiguration = () => ({ custom: { autoTitleRules: {
    COLL: { collectionName: 'Projects', template: '{field:status}?{ · {field:owner}}', normalizeWhitespace: true }
  } } });
  assert.strictEqual(await plugin.applyAutoTitleRule(record, collection), 'Open · Alice');
  assert.strictEqual(storedTitle, 'Open · Alice', 'apply-time rule writes a real title after properties are available');
  values.owner = [];
  assert.strictEqual(await plugin.applyAutoTitleRule(record, collection), 'Open');
  assert.strictEqual(storedTitle, 'Open', 'optional group disappears with its empty property');
  console.log('PASS Auto-title rule tokens compute and write real titles');

  const host = 'class Plugin extends CollectionPlugin { onLoad() { this.existing = true; } }\n';
  const managed = plugin._replaceAutoTitleManagedBlock(host, plugin._autoTitleManagedBlock({ template: '{field:status}' }));
  assert.strictEqual(plugin._assertAutoTitleCollectionCode(managed).ok, true, 'generated collection hook parses with the existing owner code');
  const HookPlugin = new Function('CollectionPlugin', managed + '\nreturn Plugin;')(class CollectionPlugin {});
  const hooked = new HookPlugin(); let titleCallback = null;
  hooked.customizeRecordTitle = callback => { titleCallback = callback; };
  hooked.onLoad();
  assert.strictEqual(hooked.existing, true, 'managed wrapper calls the prior collection onLoad first');
  assert.strictEqual(typeof titleCallback, 'function', 'managed wrapper registers customizeRecordTitle');
  assert.strictEqual(titleCallback({ record }), 'Open', 'display-only hook uses the same property rule renderer');
  const stripped = plugin._stripAutoTitleManagedBlock(managed);
  assert.strictEqual(stripped.changed, true);
  assert.strictEqual(stripped.code, host, 'hook removal preserves every byte of unmarked collection code');
  const ownerless = '// collection notes only';
  const withManagedStub = plugin._replaceAutoTitleManagedBlock(ownerless, plugin._autoTitleManagedBlock({ template: '{field:status}' }, true));
  assert.strictEqual(plugin._stripAutoTitleManagedBlock(withManagedStub).code, ownerless, 'managed stub is removed with the hook');
  const unreadable = await plugin._installAutoTitleHook({}, { template: '{field:status}' });
  assert.strictEqual(unreadable.ok, false, 'hook install refuses collections whose plugin code cannot be read');
  console.log('PASS managed title hook is surgical, removable, and read-defensive');
})().catch(error => { console.error(error); process.exit(1); });
