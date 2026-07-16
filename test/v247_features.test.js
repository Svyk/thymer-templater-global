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

(async () => {
  const plugin = new Plugin();
  plugin.data = { getActiveUsers: () => [{ guid: 'USER' }] };
  const renderCtx = date => ({
    record: { getJournalDetails: () => ({ date, userGuid: 'USER' }) },
    prompts: {}, vars: {}, templateName: 'test'
  });

  let rendered = await plugin.renderTemplate('{{journal:yesterday}}|{{journal:tomorrow}}|{{journal:+31}}', renderCtx(new Date(2026, 0, 1)));
  assert.strictEqual(plugin.previewText(rendered), '[[2025-12-31]]|[[2026-01-02]]|[[2026-02-01]]', 'journal offsets cross month/year boundaries in local calendar math');
  const firstJournalRef = plugin.parseInlineSegments(rendered)[0];
  assert.strictEqual(firstJournalRef.type, 'ref');
  assert.match(firstJournalRef.text.guid, /-20251231$/, 'journal token emits a real adjacent-day ref GUID');
  rendered = await plugin.renderTemplate('{{journal:tomorrow}}', renderCtx(new Date(2026, 12 - 1, 31)));
  assert.strictEqual(plugin.previewText(rendered), '[[2027-01-01]]');
  const carry = await plugin.renderTemplate('{{carry:unfinished}}', renderCtx(new Date(2026, 0, 1)));
  assert.strictEqual(carry, 'dc: @task and @todo and date=2025-12-31 | list');
  console.log('PASS journal-chain date math and live carry query emission');

  let made = 0;
  const record = {
    guid: 'REC',
    createLineItem: async () => ({ guid: 'LINE' + (++made) })
  };
  const cursorGuids = await plugin.writeBody(record,
    '- second <!--PLEXUS-CURSOR:2-->\n- first <!--PLEXUS-CURSOR:1-->\n- third <!--PLEXUS-CURSOR:3-->', {});
  assert.deepStrictEqual(cursorGuids, ['LINE2', 'LINE1', 'LINE3'], 'cursor GUIDs are ordered by stop number, not source position');
  const anchorLine = { guid: 'ANCHOR' }, positional = [];
  const anchoredRecord = {
    guid: 'REC', getLineItems: async () => [anchorLine],
    createLineItem: async (parent, after, type, segments) => {
      const line = { guid: 'POS' + (positional.length + 1) };
      positional.push({ parent, after, type, text: segments.map(s => s.text).join('') }); return line;
    }
  };
  await plugin.writeBody(anchoredRecord, '- one\n- two', { anchor: { record: anchoredRecord, parentGuid: 'REC', afterLineGuid: 'ANCHOR', lineItem: anchorLine } });
  assert.strictEqual(positional[0].after, anchorLine, 'first inline block is created immediately after the anchor');
  assert.strictEqual(positional[1].after.guid, 'POS1', 'later inline siblings preserve author order');
  console.log('PASS multi-stop cursor ordering');

  plugin.runJsBlock = async () => { throw new Error('dry render executed JS'); };
  plugin.resolveRefGuid = async () => { throw new Error('dry render resolved a side-effecting directive'); };
  const drySource = [
    '{{prompt:Name}} {{suggester:Kind|A,B}} {{prompt.date:Due ?? 2026-07-16}}',
    '{{date:2026-07-16}} {{cursor:2}} {{banner:https://example.com/x.png}}',
    '{{relate:Project=Missing :: create=Projects :: apply=Project}}',
    '{{task: Spawn me}} <!--PLEXUS-PROMOTE-->',
    '<%* tp.thymer.create_record("Notes", "bad") %>'
  ].join('\n');
  const dry = await plugin.renderTemplate(drySource, { prompts: {}, vars: {}, templateName: 'dry' }, { dry: true });
  assert.match(dry, /⟨Name⟩/); assert.match(dry, /⟨Kind⟩/); assert.match(dry, /⟨Due⟩/); assert.match(dry, /⟨js⟩/);
  assert.match(plugin.previewText(dry), /2026-07-16/, 'ordinary date tokens render concretely in dry mode');
  assert.doesNotMatch(dry, /PLEXUS|TMPL-TASK|\{\{(?:banner|relate|task|cursor)/, 'dry output contains no directive markers');
  console.log('PASS dry-render placeholders directives and JS safety');

  const prompts = plugin.collectPrompts('{{suggester:Kind|A,B,C}} {{prompt.date:Due ?? 2026-07-16}}', {});
  assert.deepStrictEqual(prompts.map(p => [p.label, p.kind, p.choices]), [
    ['Kind', 'text', ['A', 'B', 'C']], ['Due', 'date', []]
  ]);
  const dateOnly = await plugin.renderTemplate('- {{prompt.date:Due}}', { prompts: { Due: '2026-07-16' }, vars: {} });
  assert.strictEqual(plugin.parseInlineSegments(dateOnly.replace(/^[-]\s*/, ''))[0].type, 'datetime');
  const dateInText = await plugin.renderTemplate('Due {{prompt.date:Due}} please', { prompts: { Due: '2026-07-16' }, vars: {} });
  assert.strictEqual(dateInText, 'Due 2026-07-16 please');
  console.log('PASS suggester alias and prompt.date segment/text behavior');

  assert.strictEqual(plugin._collectionDefaultDecision({ defaultTemplate: 'Daily', empty: true }), true);
  assert.strictEqual(plugin._collectionDefaultDecision({ defaultTemplate: 'Daily', empty: true, templateCreated: true }), false, 'template-created record never re-fires a default');
  assert.strictEqual(plugin._collectionDefaultDecision({ defaultTemplate: 'Daily', empty: false }), false, 'non-empty record skips its collection default');
  assert.strictEqual(plugin._collectionDefaultDecision({ defaultTemplate: 'Daily', empty: true, hasTrigger: true }), false, 'an authored created-trigger claims precedence');
  console.log('PASS collection-default guard matrix');

  assert.deepStrictEqual(plugin._inlineTriggerMatch(';;daily', ';;'), { escape: false, query: 'daily', prefixText: '', originalText: ';;daily' });
  assert.deepStrictEqual(plugin._inlineTriggerMatch('Before ;;meeting', ';;'), { escape: false, query: 'meeting', prefixText: 'Before ', originalText: 'Before ;;meeting' });
  assert.deepStrictEqual(plugin._inlineTriggerMatch('literal ;;;', ';;'), { escape: true, text: 'literal ;;' });
  assert.strictEqual(plugin._inlineTriggerMatch(';;not;end', ';;'), null);
  console.log('PASS inline-trigger regex escape and mid-line prefix preservation');

  const routed = new Plugin();
  const template = { getName: () => 'Inline', text: () => '' };
  const anchor = { record: { guid: 'REC' }, recordGuid: 'REC', lineGuid: 'LINE', afterLineGuid: 'LINE', prefixText: 'Before ' };
  routed.ui = { getActivePanel: () => ({ getActiveRecord: () => anchor.record, getActiveCollection: () => null }) };
  routed.assembleTemplateSource = async () => '- inserted';
  routed.resolveIncludes = async value => value;
  routed.tField = () => '';
  routed.tTriggers = () => [];
  routed.collectPrompts = () => [];
  routed._restoreInlineAnchor = async () => {};
  routed.renderTemplate = async () => '- inserted';
  let applyOpts = null;
  routed.applyTemplate = async (_template, _rendered, opts) => { applyOpts = opts; return 'REC'; };
  await routed.onTemplatePicked(template, { anchor });
  assert.strictEqual(applyOpts.mode, 'anchor');
  assert.strictEqual(applyOpts.anchor, anchor, 'picker selection routes the remembered anchor into applyTemplate');
  console.log('PASS anchor-mode option routing');
})().catch(error => { console.error(error); process.exit(1); });
