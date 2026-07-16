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

  const movedRight = [{ type: 'text', text: 'XX Before ;;meet after' }];
  const movedLeft = [{ type: 'text', text: 'B ;;meet after' }];
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments(movedRight, { trigger: ';;', query: 'meet', replaceStart: 7 }),
    { start: 10, end: 16 },
    'span search tolerates text inserted before the remembered trigger offset'
  );
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments(movedLeft, { trigger: ';;', query: 'meet', replaceStart: 7 }),
    { start: 2, end: 8 },
    'span search tolerates text deleted before the remembered trigger offset'
  );
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments([{ type: 'text', text: 'Before ;; other' }], { trigger: ';;', query: 'meet', replaceStart: 7 }),
    { start: 7, end: 9 },
    'a missing tracked query falls back to the last bare trigger'
  );
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments([{ type: 'text', text: ';;old middle ;;meet tail' }], { trigger: ';;', query: 'meet', replaceStart: 0 }),
    { start: 13, end: 19 },
    'the last full trigger+query wins when the line has multiple triggers'
  );
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments([{ type: 'text', text: ';;old middle ;; tail' }], { trigger: ';;', query: 'missing', replaceStart: 999 }),
    { start: 13, end: 15 },
    'the last bare trigger wins when no full tracked query remains'
  );
  assert.deepStrictEqual(
    plugin._inlineRangeForSegments([
      { type: 'ref', text: { guid: 'PREFIX' } },
      { type: 'text', text: ' prefix ;;meet suffix' },
    ], { trigger: ';;', query: 'meet', replaceStart: 1 }),
    { start: 9, end: 15 },
    'rich prefix segments count as one grapheme without shifting trigger relocation'
  );
  console.log('PASS v2.48.4 trigger span relocation uses the last live full/bare trigger');

  const livePlugin = new Plugin();
  const livePopup = {
    lineGuid: 'LIVE', trigger: ';;', triggerStart: 7, query: '',
    records: [snippetTemplate('Meeting'), snippetTemplate('Clip')],
    active: 1, openedAt: Date.now(), missingSince: 0,
  };
  livePlugin._state = { inlinePopup: livePopup };
  livePlugin._inlineLiveStateByGuid = () => ({
    guid: 'LIVE', text_segments: ['text', 'Before ;;mee after'],
  });
  livePlugin._inlineCaretInfo = () => ({ lineGuid: 'LIVE', offset: 12 });
  livePlugin._renderInlineLive = () => {
    livePopup.filtered = livePlugin._filterInlineCandidates(livePopup.records, livePopup.query);
  };
  const liveSnapshot = livePlugin._syncInlineLiveFromLine(livePopup);
  assert.strictEqual(liveSnapshot.query, 'mee');
  assert.strictEqual(livePopup.query, 'mee', 'popup query is derived from fresh line text up to the native caret');
  assert.deepStrictEqual(livePopup.filtered.map(record => record.getName()), ['Meeting']);
  console.log('PASS v2.48.3 popup live-filters from the current editor line');

  const escPlugin = new Plugin();
  let escWrites = 0, escRemoved = 0;
  const escLine = {
    segments: [{ type: 'text', text: 'Keep ;;typed exactly' }],
    setSegments: async () => { escWrites++; },
  };
  const escPopup = {
    lineItem: escLine, query: 'typed', filtered: [], previewToken: 0,
    pop: { remove: () => { escRemoved++; } }, previewEl: null,
    outside: null, reposition: null, raf: 0, syncTimeout: 0, liveTimer: 0,
  };
  escPlugin._state = { inlinePopup: escPopup };
  let prevented = 0, stopped = 0;
  escPlugin._onInlineLiveKey({
    key: 'Escape', target: null, isComposing: false,
    preventDefault: () => { prevented++; }, stopImmediatePropagation: () => { stopped++; },
  });
  assert.strictEqual(escWrites, 0, 'Escape never restores or rewrites the editor line');
  assert.strictEqual(escLine.segments[0].text, 'Keep ;;typed exactly');
  assert.strictEqual(escRemoved, 1);
  assert.deepStrictEqual([prevented, stopped], [1, 1]);
  await escPlugin._restoreInlineAnchor({ nativeInline: true, lineItem: escLine });
  assert.strictEqual(escWrites, 0, 'native cancel/error cleanup has no restore write');
  console.log('PASS v2.48.3 Escape closes the popup and leaves typed text untouched');

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

  const tokenPlugin = new Plugin();
  tokenPlugin._state = {
    clearing: new Set(), slashCooldown: new Map(), applying: new Set(), templaterCreated: new Set(),
  };
  const tokenLine = {
    guid: 'TOKEN-LINE', parent_guid: 'TOKEN-REC', segments: [{ type: 'text', text: 'Log ;;log' }],
    setSegments: async segments => { tokenLine.segments = segments; return true; },
  };
  const tokenRecord = {
    guid: 'TOKEN-REC', getName: () => 'Token target', getJournalDetails: () => null,
    getLineItems: async () => [tokenLine], prop: () => null,
  };
  const navigations = [];
  const tokenPanel = {
    getActiveRecord: () => tokenRecord,
    getActiveCollection: () => null,
    navigateTo: async options => { navigations.push(options); return true; },
  };
  tokenPlugin.ui = { getActivePanel: () => tokenPanel };
  tokenPlugin.getConfiguration = () => ({ custom: { inlineNavFlash: true } });
  tokenPlugin.data = { getRecord: () => tokenRecord };
  tokenPlugin.assembleTemplateSource = async () => '{{time}} — {{prompt:Entry}} {{cursor}}';
  tokenPlugin.resolveIncludes = async value => value;
  tokenPlugin.tField = () => '';
  tokenPlugin.tTriggers = () => [];
  tokenPlugin.writeAuditRow = async () => {};
  tokenPlugin.toast = () => {};
  let settlePromptFlow;
  const promptFlowDone = new Promise((resolve, reject) => { settlePromptFlow = { resolve, reject }; });
  tokenPlugin.openPromptsModal = (_template, prompts, finalize) => {
    try {
      assert.deepStrictEqual(prompts.map(prompt => prompt.label), ['Entry'], 'inline pick collects prompts from the shared source');
      Promise.resolve(finalize({ Entry: 'logged' })).then(settlePromptFlow.resolve, settlePromptFlow.reject);
    } catch (error) { settlePromptFlow.reject(error); }
  };
  let inlineRenderCalls = 0;
  const renderInlineTemplate = tokenPlugin.renderTemplate.bind(tokenPlugin);
  tokenPlugin.renderTemplate = async (...args) => { inlineRenderCalls++; return renderInlineTemplate(...args); };
  await tokenPlugin.onTemplatePicked(snippetTemplate('Log entry'), { anchor: {
    record: tokenRecord, recordGuid: 'TOKEN-REC', lineGuid: 'TOKEN-LINE', afterLineGuid: 'TOKEN-LINE', lineItem: tokenLine,
    parentGuid: 'TOKEN-REC', trigger: ';;', query: 'log', replaceStart: 4, replaceEnd: 9,
    prefixText: 'Log ', originalSegments: tokenLine.segments,
  } });
  await promptFlowDone;
  const tokenText = tokenLine.segments.map(segment => typeof segment.text === 'string' ? segment.text : '').join('');
  assert.strictEqual(inlineRenderCalls, 1, 'inline pick uses the shared renderTemplate pipeline exactly once');
  assert.match(tokenText, /^Log (?:[01]\d|2[0-3]):[0-5]\d — logged$/, '{{time}} and prompt values render before segment splicing');
  assert.doesNotMatch(tokenText, /\{\{(?:time|prompt|cursor)/, 'no raw inline tokens reach setSegments');
  assert.deepStrictEqual(navigations, [{ itemGuid: 'TOKEN-LINE', highlight: true }], '{{cursor}} navigates to the inline anchor line');
  console.log('PASS v2.48.4 inline pick renders {{time}} and applies the {{cursor}} stop');

  const shiftedLine = {
    guid: 'SHIFTED', parent_guid: 'REC', segments: [{ type: 'text', text: 'XX A ;;clip Z' }],
    setSegments: async segments => { shiftedLine.segments = segments; return true; },
  };
  const shiftedRecord = { guid: 'REC', getLineItems: async () => [shiftedLine] };
  await plugin._applyInlineAnchorLine(shiftedRecord, {
    record: shiftedRecord, recordGuid: 'REC', lineGuid: 'SHIFTED', lineItem: shiftedLine,
    trigger: ';;', query: 'clip', replaceStart: 2, replaceEnd: 8,
    originalSegments: [{ type: 'text', text: 'A ;;clip Z' }],
  }, 'picked');
  assert.strictEqual(shiftedLine.segments.map(segment => segment.text).join(''), 'XX A picked Z');
  console.log('PASS v2.48.3 pick replaces only the fresh trigger span');

  const fallbackLine = {
    guid: 'FALLBACK', parent_guid: 'REC', segments: [{ type: 'text', text: 'first ;;old and latest ;; tail' }],
    setSegments: async segments => { fallbackLine.segments = segments; return true; },
  };
  const fallbackRecord = { guid: 'REC', getLineItems: async () => [fallbackLine] };
  await plugin._applyInlineAnchorLine(fallbackRecord, {
    record: fallbackRecord, recordGuid: 'REC', lineGuid: 'FALLBACK', lineItem: fallbackLine,
    trigger: ';;', query: 'consumed', replaceStart: 0, replaceEnd: 10,
    originalSegments: fallbackLine.segments,
  }, 'picked');
  assert.strictEqual(
    fallbackLine.segments.map(segment => typeof segment.text === 'string' ? segment.text : '').join(''),
    'first ;;old and latest picked tail',
    'a current bare trigger is sufficient; stale numeric offsets and a missing query do not reject the write'
  );
  console.log('PASS v2.48.4 no false stale-line error when any current ;; trigger survives');

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
  assert.strictEqual(staleWrites, 0, 'the remembered stale line object is never used as write authority');
  assert.strictEqual(freshWrites, 1, 'the first write uses a freshly resolved line object');
  assert.strictEqual(retryAnchor.lineItem, freshLine, 'successful write refreshes the remembered anchor object');
  assert.strictEqual(freshLine.segments.map(segment => segment.text).join(''), 'Before inserted after');
  console.log('PASS v2.48.3 stale inline anchor resolves fresh before the first write');

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

  let anchorResolved = 0;
  const anchorLine = {
    guid: 'ANCHOR', parent_guid: 'REC', segments: [{ type: 'text', text: 'Prefix ;;q' }],
    setSegments: async segments => { anchorLine.segments = segments; freshAnchorLine.segments = segments; return true; },
  };
  const freshAnchorLine = { guid: 'ANCHOR', parent_guid: 'REC', segments: anchorLine.segments };
  const writes = [];
  const record = {
    guid: 'REC',
    getLineItems: async () => [anchorResolved++ === 0 ? anchorLine : freshAnchorLine],
    createLineItem: async (parent, after, type, segments) => {
      assert.notStrictEqual(after, anchorLine, 'createLineItem never receives the wrapper used for the guarded span replacement');
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
  assert.strictEqual(writes[0].after, freshAnchorLine, 'multi-line body starts after a freshly resolved post-write anchor');
  assert.strictEqual(writes[1].after.guid, 'NEW1', 'multi-line sibling order is unchanged');
  console.log('PASS v2.48.5 multi-line body creation never reuses the pre-replacement anchor wrapper');

  const empPlugin = new Plugin();
  empPlugin._state = {
    clearing: new Set(), slashCooldown: new Map(), applying: new Set(), templaterCreated: new Set(), cursorStops: null,
  };
  let empAnchorSegments = [{ type: 'text', text: 'Context ;;emp' }];
  let spanWriteWrapper = null;
  const empCreated = [];
  const makeEmpAnchor = () => {
    const wrapper = {
      guid: 'EMP-ANCHOR', parent_guid: 'EMP-REC', segments: empAnchorSegments.map(segment => ({ ...segment })),
      setSegments: async segments => {
        spanWriteWrapper = wrapper;
        empAnchorSegments = segments.map(segment => ({ ...segment }));
        wrapper.segments = empAnchorSegments.map(segment => ({ ...segment }));
        return true;
      },
    };
    return wrapper;
  };
  const empRecord = {
    guid: 'EMP-REC', getName: () => 'EMP target', getJournalDetails: () => null, prop: () => null,
    getLineItems: async () => [makeEmpAnchor(), ...empCreated],
    createLineItem: async (parent, after, type, segments, props) => {
      assert.notStrictEqual(after, spanWriteWrapper, 'EMP body creation rejects the stale span-write wrapper');
      const created = { guid: 'EMP-' + (empCreated.length + 1), parent_guid: parent && parent.guid || 'EMP-REC', type, segments, props };
      empCreated.push(created);
      return created;
    },
  };
  const empNavigations = [];
  empPlugin.ui = { getActivePanel: () => ({
    getActiveRecord: () => empRecord, getActiveCollection: () => null,
    navigateTo: async options => { empNavigations.push(options); return true; },
  }) };
  empPlugin.data = { getRecord: () => empRecord };
  empPlugin.tTriggers = () => [];
  empPlugin.tField = () => '';
  empPlugin.writeAuditRow = async () => {};
  empPlugin.toast = () => {};
  const empRendered = await empPlugin.renderTemplate([
    '## EMP Review',
    '- [ ] Review environmental records',
    '- [ ] Record corrective actions {{cursor}}',
  ].join('\n'), { prompts: {}, vars: {}, templateName: 'EMP Review' });
  await empPlugin.applyTemplate(snippetTemplate('EMP Review'), empRendered, { anchor: {
    record: empRecord, recordGuid: 'EMP-REC', lineGuid: 'EMP-ANCHOR', afterLineGuid: 'EMP-ANCHOR',
    lineItem: makeEmpAnchor(), parentGuid: 'EMP-REC', trigger: ';;', query: 'emp',
    replaceStart: 8, replaceEnd: 13, prefixText: 'Context ', originalSegments: empAnchorSegments,
  } });
  assert.deepStrictEqual(empCreated.map(line => line.type), ['heading', 'task', 'task'], 'EMP Review creates its heading and both checkboxes');
  assert.strictEqual(empCreated[1].parent_guid, empCreated[0].guid, 'EMP checklist nests under its heading');
  assert.strictEqual(empCreated[2].parent_guid, empCreated[0].guid, 'all EMP checklist lines are created');
  assert.deepStrictEqual(empNavigations, [], 'default inlineNavFlash=false emits no navigateTo call for the cursor stop');
  assert.strictEqual(empPlugin._inlineNavFlashEnabled(), false, 'inline navigation flash defaults off');
  empPlugin.getConfiguration = () => ({ custom: { inlineNavFlash: true } });
  assert.strictEqual(empPlugin._inlineNavFlashEnabled(), true, 'inline navigation flash can be explicitly enabled');
  console.log('PASS v2.48.5 EMP Review inserts fully and inlineNavFlash gates highlighted navigation');

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
