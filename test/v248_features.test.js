'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.AppPlugin = class AppPlugin {};
global.CollectionPlugin = class CollectionPlugin {};
global.window = global;
global.DateTime = {
  parseDateTimeString: value => ({ value: () => ({ d: String(value), formatted: String(value) }) })
};
const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const Plugin = new Function(source + '\n;return Plugin;')();

const snippetTemplate = (name = 'Clip') => ({
  guid: 'SNIPPET',
  getName: () => name,
  text: label => label === 'Template Name' ? name : '',
  prop: label => label === 'Type' ? {
    choiceLabel: () => 'Snippet',
    selectedChoiceLabels: () => ['Snippet'],
  } : null,
});

(async () => {
  const plugin = new Plugin();
  plugin._state = { clearing: new Set(), slashCooldown: new Map() };

  const O = String.fromCharCode(1), S = String.fromCharCode(2), C = String.fromCharCode(3);
  const rendered = 'insert ' + O + 'REF' + S + 'TARGET' + S + 'Target' + C + ' ' +
    O + 'DATE' + S + '2026-07-16' + C + ' ' + O + 'TAG' + S + 'native' + C;
  const sourceSegments = [
    { type: 'text', text: 'Before ;;meet after ' },
    { type: 'hashtag', text: '#kept' },
  ];
  const spliced = plugin._spliceInlineSegments(sourceSegments, 7, 13, rendered);
  assert.strictEqual(spliced[0].text, 'Before insert ');
  assert.deepStrictEqual(spliced.slice(1, 6).map(segment => segment.type), ['ref', 'text', 'datetime', 'text', 'hashtag']);
  assert.strictEqual(spliced[1].text.guid, 'TARGET');
  assert.strictEqual(spliced[3].text.formatted, '2026-07-16');
  assert.strictEqual(spliced[5].text, '#native');
  assert.ok(spliced.some(segment => segment.type === 'text' && segment.text.includes(' after ')), 'suffix text survives the splice');
  assert.strictEqual(spliced[spliced.length - 1].text, '#kept', 'existing suffix segments survive the splice');
  console.log('PASS v2.48 single-line splice preserves prefix/suffix and native segments');

  const cursorLine = {
    guid: 'CURSOR', parent_guid: 'REC', segments: [{ type: 'text', text: 'A ;;clip Z' }],
    setSegments: async segments => { cursorLine.segments = segments; return true; },
  };
  const cursorRecord = { guid: 'REC', getLineItems: async () => [cursorLine] };
  const cursorAnchor = {
    record: cursorRecord, recordGuid: 'REC', lineGuid: 'CURSOR', lineItem: cursorLine,
    trigger: ';;', query: 'clip', replaceStart: 2, replaceEnd: 8,
    originalSegments: cursorLine.segments,
  };
  const cursorStops = await plugin._applyInlineAnchorLine(
    cursorRecord,
    cursorAnchor,
    'go <!--PLEXUS-CURSOR:3-->here'
  );
  assert.strictEqual(cursorLine.segments.map(segment => segment.text).join(''), 'A go here Z');
  assert.deepStrictEqual(cursorStops, { stops: [3], segments: cursorLine.segments });
  console.log('PASS v2.48 single-line inline cursor stop survives the splice');

  const retryPlugin = new Plugin();
  retryPlugin._state = { clearing: new Set(), slashCooldown: new Map() };
  let staleWrites = 0, freshWrites = 0;
  const staleLine = {
    guid: 'RETRY', segments: [{ type: 'text', text: 'Before ;;clip after' }],
    setSegments: async () => { staleWrites++; throw new Error('Editor interaction failed'); },
  };
  const freshLine = {
    guid: 'RETRY', segments: [{ type: 'text', text: 'Before ;;clip after' }],
    setSegments: async segments => { freshWrites++; freshLine.segments = segments; return true; },
  };
  const staleRecord = { guid: 'REC', getLineItems: async () => [staleLine] };
  const freshRecord = { guid: 'REC', getLineItems: async () => [freshLine] };
  retryPlugin.data = { getRecord: guid => guid === 'REC' ? freshRecord : null };
  retryPlugin._inlineLiveStateByGuid = () => null;
  const retryAnchor = {
    record: staleRecord, recordGuid: 'REC', lineGuid: 'RETRY', afterLineGuid: 'RETRY', lineItem: staleLine,
    trigger: ';;', query: 'clip', replaceStart: 7, replaceEnd: 13,
    originalSegments: staleLine.segments,
  };
  await retryPlugin._applyInlineAnchorLine(staleRecord, retryAnchor, 'inserted');
  assert.strictEqual(staleWrites, 1, 'the remembered stale line is attempted once');
  assert.strictEqual(freshWrites, 1, 'one retry writes through a freshly resolved line object');
  assert.strictEqual(retryAnchor.lineItem, freshLine, 'successful retry refreshes the remembered anchor object');
  assert.strictEqual(freshLine.segments.map(segment => segment.text).join(''), 'Before inserted after');
  console.log('PASS v2.48.2 stale inline anchor re-resolves once after Editor interaction failed');

  const changedLine = { guid: 'CHANGED', segments: [{ type: 'text', text: 'user edited this line' }], setSegments: async () => true };
  const changedRecord = { guid: 'REC2', getLineItems: async () => [changedLine] };
  retryPlugin.data = { getRecord: () => changedRecord };
  await assert.rejects(
    retryPlugin._applyInlineAnchorLine(changedRecord, {
      record: changedRecord, recordGuid: 'REC2', lineGuid: 'CHANGED', lineItem: changedLine,
      trigger: ';;', query: 'gone', replaceStart: 0, replaceEnd: 6,
      originalSegments: changedLine.segments,
    }, 'nope'),
    /line changed since ;; was typed/i
  );
  console.log('PASS v2.48.2 changed inline line reports a specific stale-trigger failure');

  assert.strictEqual(plugin._nextPreviewOpen(false), true);
  assert.strictEqual(plugin._nextPreviewOpen(true), false);
  assert.strictEqual(plugin._isPreviewKey({ key: 'o', ctrlKey: true }), true);
  assert.strictEqual(plugin._isPreviewKey({ key: 'O', metaKey: true }), true);
  assert.strictEqual(plugin._previewLineLimit(Array.from({ length: 25 }, (_, i) => String(i)).join('\n'), 20).split('\n').length, 20);
  console.log('PASS v2.48.2 preview toggle state, keybind, and 20-line cap');

  const anchorLine = {
    guid: 'ANCHOR', parent_guid: 'REC', segments: [{ type: 'text', text: 'Prefix ;;q' }],
    setSegments: async segments => { anchorLine.segments = segments; return true; },
  };
  const writes = [];
  const record = {
    guid: 'REC',
    getLineItems: async () => [anchorLine],
    createLineItem: async (parent, after, type, segments) => {
      const line = { guid: 'NEW' + (writes.length + 1) };
      writes.push({ parent, after, type, segments });
      return line;
    },
  };
  const anchor = {
    record, recordGuid: 'REC', lineGuid: 'ANCHOR', afterLineGuid: 'ANCHOR', lineItem: anchorLine,
    parentGuid: 'REC', trigger: ';;', query: 'q', replaceStart: 7, replaceEnd: 10,
    prefixText: 'Prefix ', originalSegments: anchorLine.segments,
  };
  assert.strictEqual(plugin._inlineBodyShape('- one\n- two').single, false);
  await plugin._applyInlineAnchorLine(record, anchor, null);
  assert.strictEqual(anchorLine.segments.map(segment => segment.text).join(''), 'Prefix ', 'multi-line mode keeps the prefix on its anchor line');
  await plugin.writeBody(record, '- one\n- two', { anchor });
  assert.strictEqual(writes[0].after, anchorLine, 'multi-line body still starts immediately after the anchor');
  assert.strictEqual(writes[1].after.guid, 'NEW1', 'multi-line sibling order is unchanged');
  console.log('PASS v2.48 multi-line anchor behavior is unchanged');

  const semantics = plugin._templateSemantics(snippetTemplate(), true);
  assert.deepStrictEqual(semantics, {
    snippet: true, inlineOnly: true, allowed: true,
    applyFrontmatter: false, applyDirectives: false, notifySkipped: false,
  });
  assert.strictEqual(plugin._templateSemantics(snippetTemplate(), false).allowed, false, 'snippet cannot enter record create/fill flow');
  assert.strictEqual(plugin._templateSemantics({ prop: () => null, text: () => '' }, false).applyFrontmatter, true, 'normal record template keeps frontmatter semantics');

  const actual = new Plugin();
  actual._state = { clearing: new Set(), slashCooldown: new Map(), applying: new Set(), templaterCreated: new Set() };
  const line = {
    guid: 'LINE', parent_guid: 'REC', segments: [{ type: 'text', text: 'A ;;clip Z' }],
    setSegments: async segments => { line.segments = segments; return true; },
  };
  const target = {
    guid: 'REC', getName: () => 'Target', getJournalDetails: () => null,
    getLineItems: async () => [line], prop: () => null,
  };
  actual.ui = { getActivePanel: () => ({ getActiveRecord: () => target, getActiveCollection: () => null }) };
  actual.data = { getRecord: () => target };
  actual.tTriggers = () => [];
  actual.tField = () => '';
  actual.applyFrontmatter = async () => { throw new Error('snippet applied frontmatter'); };
  actual.spawnRichTask = async () => { throw new Error('snippet spawned task directive'); };
  actual._promoteAfterApply = () => { throw new Error('snippet promoted tasks'); };
  actual.writeAuditRow = async () => {};
  const toasts = []; actual.toast = (...args) => toasts.push(args.join(' '));
  await actual.applyTemplate(snippetTemplate(), [
    '---', 'Mood: Bad', '---',
    'Hello <!--PLEXUS-RELATE:Project=GUID--> <!--PLEXUS-BANNER:https://example.com/a.png--> <!--TMPL-TASK:Spawn--> <!--PLEXUS-PROMOTE-->'
  ].join('\n'), { anchor: {
    record: target, recordGuid: 'REC', lineGuid: 'LINE', afterLineGuid: 'LINE', lineItem: line,
    parentGuid: 'REC', trigger: ';;', query: 'clip', replaceStart: 2, replaceEnd: 8,
    prefixText: 'A ', originalSegments: line.segments,
  } });
  const actualText = line.segments.map(segment => typeof segment.text === 'string' ? segment.text : '').join('');
  assert.match(actualText, /^A Hello\s+Z$/);
  assert.doesNotMatch(actualText, /Mood|PLEXUS|TMPL-TASK|example\.com/);
  assert.ok(!toasts.some(text => /frontmatter skipped/i.test(text)), 'snippet stripping emits no skipped-directive toast');
  console.log('PASS v2.48 snippet semantics strip frontmatter and all record directives');

  assert.deepStrictEqual(plugin._inlineTriggerMatch('literal ;;;', ';;'), { escape: true, text: 'literal ;;' });
  const routing = new Plugin();
  routing._state = { inlineLiveReady: true };
  routing.getConfiguration = () => ({ custom: { inlineLive: false } });
  assert.strictEqual(routing._shouldUseInlineFallback(), true, 'live-off explicitly routes through settled fallback');
  routing.getConfiguration = () => ({ custom: { inlineLive: true } });
  assert.strictEqual(routing._shouldUseInlineFallback(), false, 'installed live listener suppresses settle picker');
  routing._state.inlineLiveReady = false;
  assert.strictEqual(routing._shouldUseInlineFallback(), true, 'failed live initialization routes through settled fallback');

  const recent = { getName: () => 'Recent', text: () => '', prop: () => null };
  const clip = snippetTemplate('Clip');
  plugin.getConfiguration = () => ({ custom: {} });
  assert.deepStrictEqual(plugin._inlineScopedTemplates([recent, clip]), [clip], 'default ;; scope lists snippets only');
  plugin.getConfiguration = () => ({ custom: { inlineScope: 'all' } });
  assert.deepStrictEqual(plugin._inlineScopedTemplates([recent, clip]), [recent, clip], 'all ;; scope preserves v2.48.0 behavior');
  assert.deepStrictEqual(
    plugin._filterInlineCandidates([recent, clip], ''),
    [clip, recent],
    'snippets sort ahead of recent regular templates'
  );
  const older = { getName: () => 'Recent matching template', text: () => '', prop: () => null };
  assert.deepStrictEqual(
    plugin._filterInlineCandidates([recent, older], 'rt'),
    [recent, older],
    'fuzzy filtering preserves loadTemplatesSorted recency order'
  );
  console.log('PASS v2.48 trigger escape, live fallback routing, and snippet-first sorting');
})().catch(error => { console.error(error); process.exit(1); });
