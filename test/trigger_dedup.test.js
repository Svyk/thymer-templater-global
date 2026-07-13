'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.AppPlugin = class AppPlugin {};
global.window = global;
const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const Plugin = new Function(source + '\n;return Plugin;')();

(async () => {
  const plugin = new Plugin();
  plugin._state = {};
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let bodyPresent = false, writes = 0, secondEntered = false;
  const first = plugin._withTargetTemplateLock('TEMPLATE', 'TARGET', async () => {
    assert.strictEqual(bodyPresent, false);
    await held;
    bodyPresent = true; writes++;
    return true;
  });
  const second = plugin._withTargetTemplateLock('TEMPLATE', 'TARGET', async () => {
    secondEntered = true;
    if (bodyPresent) return false;
    writes++; return true;
  });
  await Promise.resolve();
  assert.strictEqual(secondEntered, false, 'competing trigger must wait for the target transaction');
  releaseFirst();
  assert.deepStrictEqual(await Promise.all([first, second]), [true, false]);
  assert.strictEqual(writes, 1, 'schedule+journal discovery may append only once');
  assert.strictEqual(plugin._state.targetTemplateLocks.size, 0, 'lock queue is released');
  console.log('PASS target-template transaction serializes competing automatic triggers and rechecks content');

  // An interrupted first pass wrote two sections. A stale navigation wrapper
  // says the page is empty, but the fresh target proves those sections exist.
  const heading = text => ({ type: 'heading', segments: [{ type: 'text', text }] });
  const stale = { guid: 'TARGET', getLineItems: async () => [] };
  const fresh = { guid: 'TARGET', getLineItems: async () => [heading('Quick Log'), heading('Focus')] };
  plugin.data = { getRecord: () => fresh };
  const remaining = await plugin._mergeFilterBody(stale,
    '## Quick Log\ndc.js: quick\n## Focus\nFocus::\n## Morning check-in\n- Energy::');
  assert.strictEqual(remaining, '## Morning check-in\n- Energy::');
  console.log('PASS automatic append re-resolves stale journals and writes only missing sections');
})().catch(error => { console.error(error); process.exit(1); });
