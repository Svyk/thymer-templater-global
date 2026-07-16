// Thymer Templater v2.46.0 — Journal fill fix + per-collection Auto-title rules.
// Full template language: prompt / date / record.Prop / var.NAME / ref / tag /
// include (recursion limit 3) / <%* async js %> with tp.* namespace + blocklist.
// Frontmatter -> properties, title-setting, segment-aware nested body writer, all
// Trigger modes (append/update/collection/auto with loop guard), audit log,
// status-bar quick-template, slash /tmpl, command palette, hot-reload disposal guard.

console.log('%c[Templater] v2.46.0 loaded — Journal fill + per-collection Auto-title rules.', 'color:#10b981;font-weight:bold');
const TEMPLATES_COLL = "Templates";
const AUDIT_COLL_CANDIDATES = ["Template Log", "Template Applications"];
const RECURSION_LIMIT = 3;
const SLASH_RE = /^\/tmpl(?:\s+(.+))?$/;
const SLASH_COOLDOWN_MS = 500;
const AUTO_COOLDOWN_MS = 30000;
const COLL_CACHE_TTL_MS = 30000;
const GUID_RE = /^[A-Z0-9]{26}$/;

// Field labels (read robustly by label, never by id).
const F_NAME = "Template Name";
const F_CONTENT = "Template Content";
const F_VARS = "Variables (JSON)";
const F_TRIGGERS = "Triggers";
const F_VERSION = "Version";
const F_EXTENDS = "Extends";
const F_LASTUSED = "lastUsed";
// Triggers engine (v2.26) — schedule / event / condition based runs.
const F_SCHEDULE = "Schedule";     // "05:00 daily" | "09:00 weekdays" | "Mon,Wed 07:30" | "1 09:00" | "every 30m"
const F_TRIGGERON = "Trigger On";  // comma list of: record.created:<Coll> | record.updated:<Coll> | journal.open | app.open
const F_CONDITION = "Condition";   // predicate gate (Datacore expr, or weekday/day/Prop=val fallback). empty = always.
const F_TARGET = "Target";         // for schedule/app.open: "journal:today" | "collection:<Name>". events use the trigger record.
const F_LASTFIRED = "Last Fired";  // engine-written dedup stamp (datetime, synced; localStorage mirrors it)
const F_TITLEPATTERN = "Title Pattern"; // per-collection title pattern, e.g. "{{Type}} · {{Lead}}" — Rename from properties
const F_AUTOTITLE = "Auto Title";       // choice Off/On — auto-title records of this template's collection (set-once-until-manual)
const AUTO_TITLE_RULES_KEY = "autoTitleRules";
const AUTO_TITLE_PANEL_TYPE = "templater-auto-title-rules";
const AUTO_TITLE_HOOK_NAME = "Templater Auto-title";
const AUTO_TITLE_HOOK_START = "/* " + AUTO_TITLE_HOOK_NAME + ": managed collection hook - begin */";
const AUTO_TITLE_HOOK_END = "/* " + AUTO_TITLE_HOOK_NAME + ": managed collection hook - end */";
const AUTO_TITLE_STUB = "/* Templater Auto-title: managed collection stub */\nclass Plugin extends CollectionPlugin {\n\tonLoad() {}\n\tonUnload() {}\n}";
const AUTOTITLE_DEBOUNCE_MS = 1200;     // per-record debounce for body-strategy auto-title
const SCHED_TICK_MS = 60000;       // schedule engine tick
const TRIGGER_TTL_MS = 30000;      // trigger-index cache TTL
const ATTR_COLL_GUID = "11NPMCN3MWHA6GGQCPSQNZP9TM";  // the Attributes collection ({{attr:Key}} token source)
const JOURNAL_COLL_GUID = "16S1WSXAWSHVHJZ72G6J3JRTCP";

// Non-greedy, sentinel-delimited markers carried through render -> segment writer.
// Encoded as: <U+0001>REF<U+0002><guid><U+0002><label><U+0003>
//             <U+0001>TAG<U+0002><tag><U+0003>
//             <U+0001>DATE<U+0002><date-string><U+0003>
// The sentinel bytes are control chars that cannot appear in template text, so
// re-parsing is unambiguous and bounded — a body line with two refs (or a ref
// followed by text/#tag) segments correctly instead of swallowing to end-of-line.
const M_OPEN = String.fromCharCode(1);
const M_SEP = String.fromCharCode(2);
const M_CLOSE = String.fromCharCode(3);
const MARKER_RE = new RegExp(M_OPEN + "(REF|TAG|DATE)" + M_SEP + "([^" + M_CLOSE + "]*)" + M_CLOSE, "g");

// Core title-rule renderer adopted from akaready/thymer-build-title-from-properties.
// The function is deliberately self-contained: the same source is embedded in the optional
// collection-side customizeRecordTitle() hook, while Templater uses it to write real titles.
function renderTemplaterAutoTitle(record, template, rawConfig, allowGetName) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const separator = typeof config.multiValueSeparator === 'string' ? config.multiValueSeparator : ', ';
  const join = (values) => (values || []).filter(v => v != null && String(v).trim() !== '').map(v => String(v)).join(separator);
  const name = () => {
    for (const label of ['Title', 'Name']) {
      try { const v = record && record.text && record.text(label); if (v != null && String(v).trim()) return String(v); } catch (e) {}
      try { const p = record && record.prop && record.prop(label); const v = p && p.text && p.text(); if (v != null && String(v).trim()) return String(v); } catch (e) {}
    }
    if (allowGetName) { try { const v = record && record.getName && record.getName(); if (v != null) return String(v); } catch (e) {} }
    return '';
  };
  const scalar = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
    if (value.formatted) return String(value.formatted);
    if (value.label) return String(value.label);
    if (value.name) return String(value.name);
    if (value.title) return String(value.title);
    if (value.d && /^\d{8}$/.test(String(value.d))) return String(value.d).slice(0, 4) + '-' + String(value.d).slice(4, 6) + '-' + String(value.d).slice(6, 8);
    try { if (value.getDisplayName) return String(value.getDisplayName() || ''); } catch (e) {}
    try { if (value.getName) return String(value.getName() || ''); } catch (e) {}
    return '';
  };
  const property = (fieldId) => {
    let prop = null; try { prop = record && record.prop && record.prop(fieldId); } catch (e) {}
    if (!prop) return '';
    const readers = [
      () => prop.selectedChoiceLabels && prop.selectedChoiceLabels(),
      () => prop.users && prop.users(),
      () => prop.linkedRecords && prop.linkedRecords(),
      () => prop.datetimes && prop.datetimes(),
      () => prop.dates && prop.dates(),
      () => prop.texts && prop.texts(),
      () => prop.numbers && prop.numbers(),
      () => prop.values && prop.values(),
    ];
    for (const read of readers) {
      try {
        const values = read();
        if (Array.isArray(values) && values.length) { const text = join(values.map(scalar)); if (text) return text; }
      } catch (e) {}
    }
    for (const read of [() => prop.choiceLabel && prop.choiceLabel(), () => prop.text && prop.text(), () => prop.number && prop.number()]) {
      try { const text = scalar(read()); if (text) return text; } catch (e) {}
    }
    return '';
  };
  const resolve = (token) => {
    token = String(token || '').trim();
    if (token === 'name' || token === 'title') return name();
    if (!token.startsWith('field:')) return '';
    return property(token.slice(6).trim());
  };
  const groupClose = (source, openIndex) => {
    let depth = 0;
    for (let i = openIndex; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return i;
    }
    return -1;
  };
  const render = (source, start, stop) => {
    let text = '', hasValue = false, i = start;
    while (i < source.length) {
      const ch = source[i];
      if (stop && ch === stop) return { text, hasValue, index: i + 1 };
      if (ch === '\\' && i + 1 < source.length && '{}[]\\'.includes(source[i + 1])) { text += source[i + 1]; i += 2; continue; }
      if (ch === '?' && source[i + 1] === '{') {
        const end = groupClose(source, i + 1);
        if (end >= 0) { const part = render(source.slice(i + 2, end), 0, null); if (part.hasValue) text += part.text; hasValue = hasValue || part.hasValue; i = end + 1; continue; }
      }
      if (ch === '[') { const part = render(source, i + 1, ']'); if (part.hasValue) text += part.text; hasValue = hasValue || part.hasValue; i = part.index; continue; }
      if (ch === '{') {
        let end = i + 1;
        while (end < source.length && source[end] !== '}') { if (source[end] === '\\') end++; end++; }
        if (end < source.length) { const value = resolve(source.slice(i + 1, end)); if (value) { text += value; hasValue = true; } i = end + 1; continue; }
      }
      text += ch; i++;
    }
    return { text, hasValue, index: i };
  };
  let text = render(String(template || ''), 0, null).text;
  if (config.normalizeWhitespace !== false) text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}

class Plugin extends AppPlugin {
  onLoad() {
    const plugin = this;

    // --- hot-reload disposal guard (GUARDRAIL #1) ---
    try {
      if (window.__templater) {
        (window.__templater.eventIds || []).forEach(id => { try { this.events.off(id); } catch (e) {} });
        (window.__templater.disposers || []).forEach(fn => { try { fn(); } catch (e) {} });
        if (window.__templater.schedTimer) { try { clearInterval(window.__templater.schedTimer); } catch (e) {} } // GUARDRAIL #21: clear leaked interval
        if (window.__templater.autoTitleDebounce) { try { window.__templater.autoTitleDebounce.forEach(h => clearTimeout(h)); } catch (e) {} } // clear leaked debounce timers
      }
    } catch (e) { /* ignore */ }
    const _prev = window.__templater || {};
    window.__templater = {
      eventIds: [],
      disposers: [],
      schedTimer: null,
      autoFired: _prev.autoFired || new Set(),
      autoCooldown: _prev.autoCooldown || new Map(),
      slashCooldown: new Map(),
      clearing: new Set(),
      applying: _prev.applying || new Set(),       // records the engine is writing to — guards self-trigger loops
      lastFired: _prev.lastFired || new Map(),      // tmplGuid -> last-fired occurrence ms (mirrors the Last Fired prop)
      journalSeen: _prev.journalSeen || new Set(),  // "guid|YYYYMMDD" — journal.open dedup per page per day
      scheduleClaimClientId: _prev.scheduleClaimClientId || null,
      scheduleClaimSettleMs: Number.isFinite(_prev.scheduleClaimSettleMs) ? _prev.scheduleClaimSettleMs : 1800,
      appOpenFired: false,
      collCache: null,
      autoIndex: null,
      triggerIndex: null,
      autoTitleIndex: null,                          // {body:{coll→pat}, prop:{coll→pat}} — Auto Title=On templates
      autoTitleDebounce: new Map(),                  // recGuid → setTimeout handle (body-strategy debounce)
      bodyMembers: null,                             // recGuid → {name,pat} membership for body collections (fallback)
      autoTitlePanelRoots: new Set(),                // connected Auto-title settings panel roots
    };
    this._state = window.__templater;
    this._state._instance = this;   // test/debug seam (mirrors __quickadd._instance)

    // --- command palette + sidebar + status bar (GUARDRAIL #6 icons; capture remove()) ---
    // Styles live in plugin.css only (single source — injectCSS stacked across hot reloads).
    try {
      const cmd = this.ui.addCommandPaletteCommand({
        label: "Apply Template...",
        icon: "ti-files",
        onSelected: () => plugin.openPicker()
      });
      if (cmd && cmd.remove) this._state.disposers.push(() => { try { cmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] cmd palette add failed:', e); }

    try {
      const side = this.ui.addSidebarItem({
        label: "Templater",
        icon: "ti-files",
        tooltip: "Render and apply a template",
        onClick: () => plugin.openPicker()
      });
      if (side && side.remove) this._state.disposers.push(() => { try { side.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] sidebar add failed:', e); }

    // TP-17: status-bar item removed by user request — "Apply Template…" lives in the command
    // palette (Cmd+K) and the sidebar ("Templater"); a third bottom-bar copy was redundant.

    // --- slash /tmpl emulation (GUARDRAIL #4) ---
    try {
      const slashId = this.events.on("lineitem.updated", (ev) => plugin.onLineItemUpdated(ev), { collection: '*' });
      this._state.eventIds.push(slashId);
    } catch (e) { console.warn('[Templater] slash handler add failed:', e); }

    // --- auto-apply on record.created (GUARDRAIL #5) ---
    try {
      const autoId = this.events.on("record.created", (ev) => plugin.onRecordCreated(ev), { collection: '*' });
      this._state.eventIds.push(autoId);
    } catch (e) { console.warn('[Templater] auto handler add failed:', e); }

    // --- Triggers engine (v2.26): record.updated + journal.open + schedule + app.open ---
    try {
      const updId = this.events.on("record.updated", (ev) => plugin.onRecordUpdated(ev), { collection: '*' });
      this._state.eventIds.push(updId);
    } catch (e) { console.warn('[Templater] record.updated handler add failed:', e); }
    try {
      const navId = this.events.on("panel.navigated", (ev) => plugin.onPanelNavigated(ev));
      this._state.eventIds.push(navId);
    } catch (e) { console.warn('[Templater] panel.navigated handler add failed:', e); }
    // schedule engine — tick every minute; catch-up once shortly after load (fires any time already passed today)
    try {
      this._state.schedTimer = setInterval(() => { plugin.checkSchedules('tick'); }, SCHED_TICK_MS);
      setTimeout(() => { plugin.checkSchedules('catchup'); }, 1500);
    } catch (e) { console.warn('[Templater] schedule engine start failed:', e); }
    // app.open — fire once per load for templates with Trigger On: app.open
    try { setTimeout(() => { plugin.fireAppOpen(); }, 2000); } catch (e) {}
    // Triggers management command
    try {
      const tcmd = this.ui.addCommandPaletteCommand({ label: "Templater: Triggers", icon: "ti-bolt", onSelected: () => plugin.openTriggersPanel() });
      if (tcmd && tcmd.remove) this._state.disposers.push(() => { try { tcmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] triggers cmd add failed:', e); }
    // Rename-from-properties command — title the open note from its collection's Title Pattern
    try {
      const rcmd = this.ui.addCommandPaletteCommand({ label: "Templater: Rename from properties", icon: "ti-heading", onSelected: () => plugin.renameFromActive() });
      if (rcmd && rcmd.remove) this._state.disposers.push(() => { try { rcmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] rename cmd add failed:', e); }
    // v2.46: GUI for canonical per-collection Auto-title rules + optional display-only hooks.
    try {
      this.ui.registerCustomPanelType(AUTO_TITLE_PANEL_TYPE, (panel) => {
        try { if (panel.setTitle) panel.setTitle('Templater · Auto-title rules'); } catch (e) {}
        const root = panel.getElement();
        if (!root) return;
        this._state.autoTitlePanelRoots.add(root);
        plugin.renderAutoTitleRulesPanel(root);
      });
      const atcmd = this.ui.addCommandPaletteCommand({ label: "Templater: Auto-title rules…", icon: "ti-heading", onSelected: () => plugin.openAutoTitleRulesPanel() });
      if (atcmd && atcmd.remove) this._state.disposers.push(() => { try { atcmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] Auto-title rules UI failed:', e); }
    // AI-title command — title the open note from a 4-6 word AI summary of its body (needs the /llm proxy)
    try {
      const acmd = this.ui.addCommandPaletteCommand({ label: "Templater: AI title this note", icon: "ti-wand", onSelected: () => plugin.aiTitleActive() });
      if (acmd && acmd.remove) this._state.disposers.push(() => { try { acmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] ai-title cmd add failed:', e); }
    // T4: Reload Template Functions — force-expire the tp.user.* cache so edits take effect without a hot-reload
    try {
      const rfcmd = this.ui.addCommandPaletteCommand({ label: "Templater: Reload functions", icon: "ti-refresh", onSelected: () => { plugin._userFnsLoadedAt = 0; console.log('[Templater] tp.user.* cache expired — reloads on next use'); } });
      if (rfcmd && rfcmd.remove) this._state.disposers.push(() => { try { rfcmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] reload-fns cmd add failed:', e); }
    // Template Editor — edit a template's frontmatter + settings via a FORM (no hand-editing the cramped text prop)
    try {
      const ecmd = this.ui.addCommandPaletteCommand({ label: "Templater: Edit template…", icon: "ti-edit", onSelected: () => plugin.editTemplateCommand() });
      if (ecmd && ecmd.remove) this._state.disposers.push(() => { try { ecmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] edit-template cmd add failed:', e); }
    // New-template command — create a template record + open the editor on it
    try {
      const ncmd = this.ui.addCommandPaletteCommand({ label: "Templater: New template…", icon: "ti-plus", onSelected: () => plugin.newTemplateCommand() });
      if (ncmd && ncmd.remove) this._state.disposers.push(() => { try { ncmd.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] new-template cmd add failed:', e); }

    // GAP-5: a palette command PER template ("Templater: Apply 'Daily Note'") — the original's
    // per-template-hotkey analog (the palette is Thymer's hotkey surface). Refreshed (debounced)
    // when the Templates collection changes; all handles disposed on unload.
    this._registerTemplateCommands();
    this.getTemplatesCollection().then((tcol) => {
      try {
        if (!tcol || !this.events || !this.events.on) return;
        for (const ev of ['record.created', 'record.updated']) {
          const id = this.events.on(ev, () => { clearTimeout(this._tmplCmdT); this._tmplCmdT = setTimeout(() => this._registerTemplateCommands(), 1500); }, { collection: tcol.getGuid() });
          this._state.disposers.push(() => { try { this.events.off(id); } catch (e) {} });
        }
        this._state.disposers.push(() => { try { for (const d of (this._tmplCmds || [])) d(); } catch (e) {} });
      } catch (e) {}
    }).catch(() => {});

    // 10X-#9: versioning migration — merge-apply the CURRENT template version onto records the
    // audit log says were born from an older version.
    try {
      const mcmd = this.ui.addCommandPaletteCommand({ label: "Templater: Re-scaffold outdated records…", icon: "ti-git-branch", onSelected: () => plugin.reScaffoldOutdated() });
      if (mcmd && mcmd.remove) this._state.disposers.push(() => { try { mcmd.remove(); } catch (e) {} });
    } catch (e) {}

    // 10X-#3: LLM capture router — raw text in, the right template picked + its prompts pre-filled.
    try {
      const scmd = this.ui.addCommandPaletteCommand({ label: "Templater: Smart capture…", icon: "ti-wand", onSelected: () => plugin.smartCapture() });
      if (scmd && scmd.remove) this._state.disposers.push(() => { try { scmd.remove(); } catch (e) {} });
      this._state.smartCapture = (text) => plugin.smartCapture(text);
    } catch (e) {}

    // 10X-#10: synthesize a reusable template from an EXAMPLE record (AI).
    try {
      const xcmd = this.ui.addCommandPaletteCommand({ label: "Templater: New template from example…", icon: "ti-sparkles", onSelected: () => plugin.newTemplateFromExample() });
      if (xcmd && xcmd.remove) this._state.disposers.push(() => { try { xcmd.remove(); } catch (e) {} });
    } catch (e) {}

    // Programmatic render seam (verification + cross-plugin use): render a template string with
    // pre-supplied prompt answers, no UI. Returns the rendered {title, properties, body} string.
    this._state.render = async (content, prompts) => {
      try {
        return await plugin.renderTemplate(String(content || ''), {
          record: null, collection: null, prompts: prompts || {}, vars: {}, empty: 'skip', templateName: 'spine-render',
        });
      } catch (e) { return { error: String(e && e.message || e) }; }
    };
    this._state.renderTemplateByName = async (name, prompts) => {
      try {
        const records = await plugin.loadTemplatesSorted();
        const tpl = (records || []).find((r) => plugin.tName(r) === name || (r.getName && r.getName() === name));
        if (!tpl) return { error: 'template not found: ' + name };
        const content = await plugin.assembleTemplateSource(tpl);
        return await plugin.renderTemplate(String(content || ''), { record: null, collection: null, prompts: prompts || {}, vars: {}, empty: 'skip', templateName: name });
      } catch (e) { return { error: String(e && e.message || e) }; }
    };
    // APPLY a template by name end-to-end (create/append/update + props + segment body + directives) with
    // pre-supplied prompt values — the full pipeline `onTemplatePicked` runs, minus the UI. Used by the Quick Add
    // plugin's Template choice. opts: { prompts:{label:value}, mode:'create'|'append'|'update', collection:name|obj }.
    // Returns { ok, guid } or { error }.
    this._state.applyTemplateByName = async (name, opts) => {
      try {
        opts = opts || {};
        const records = await plugin.loadTemplatesSorted();
        if (!records) return { error: '"' + TEMPLATES_COLL + '" collection not found' };
        const tpl = records.find((r) => plugin.tName(r) === name || (r.getName && r.getName() === name));
        if (!tpl) return { error: 'template not found: ' + name };
        let content = await plugin.assembleTemplateSource(tpl);
        if (!content) return { error: 'template has no content' };
        try { const ext = (plugin.tField(tpl, F_EXTENDS) || '').trim(); if (ext) { const parent = await plugin.findTemplate(ext); if (parent) { const pc = await plugin.assembleTemplateSource(parent); if (pc) content = pc + "\n" + content; } } } catch (e) {}
        try { content = await plugin.resolveIncludes(content, 0, new Set()); } catch (e) {}
        let vars = { defaults: {}, empty: 'skip' };
        try { const raw = plugin.tField(tpl, F_VARS) || plugin.tField(tpl, 'Variables'); if (raw && raw.trim()) { const p = JSON.parse(raw); if (p && typeof p === 'object') vars = Object.assign({ defaults: {}, empty: 'skip' }, p); } } catch (e) {}
        if (!vars.defaults) vars.defaults = {};
        let collection = null;
        if (opts.collection) collection = (typeof opts.collection === 'string') ? await plugin.collectionByName(opts.collection) : opts.collection;
        if (!collection) { try { const pinned = plugin._templatePinnedCollection(tpl); if (pinned) collection = await plugin.collectionByName(pinned); } catch (e) {} }
        const panel = plugin.ui.getActivePanel && plugin.ui.getActivePanel();
        const activeRecord = panel && panel.getActiveRecord && panel.getActiveRecord();
        const activeCollection = panel && panel.getActiveCollection && panel.getActiveCollection();
        let rendered;
        try {
          rendered = await plugin.renderTemplate(content, {
            record: activeRecord, collection: collection || activeCollection,
            prompts: opts.prompts || {}, vars: vars.defaults || {}, empty: vars.empty || 'skip', templateName: plugin.tName(tpl),
          });
        } catch (e) { return { error: 'render failed: ' + (e && e.message || e) }; }
        let guid = null;
        try { guid = await plugin.applyTemplate(tpl, rendered, { collection, mode: opts.mode || null, preview: false, recordGuid: opts.recordGuid || null, __chainDepth: opts.__chainDepth || 0 }); }
        catch (e) { return { error: 'apply failed: ' + (e && e.message || e) }; }
        return { ok: true, guid: guid || null, name: name };
      } catch (e) { return { error: String(e && e.message || e) }; }
    };

    // Triggers test/diagnostic spine — fire a template's trigger now, or run the schedule check immediately.
    this._state.runTrigger = async (name) => { try { return await plugin.runTriggerByName(name); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.checkSchedulesNow = async () => { try { return await plugin.checkSchedules('manual'); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.listTriggers = async () => { try { return await plugin.describeTriggers(); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.renameActive = async () => { try { return await plugin.renameFromActive(); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.composeTitle = async (guid, pattern) => { try { const r = plugin.data.getRecord(guid); return r ? await plugin.composeTitleFromRecord(r, pattern, null) : null; } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.aiTitleActive = async () => { try { return await plugin.aiTitleActive(); } catch (e) { return { error: String(e && e.message || e) }; } };
    // Auto-title a record by guid (verification seam): pass collName to pick its body/prop pattern from the index.
    this._state.autoTitleByGuid = async (guid, collName) => {
      try {
        const r = plugin.data.getRecord(guid) || await plugin.pollRecord(guid); if (!r) return { error: 'no record' };
        const idx = await plugin.getAutoTitleIndex();
        const pat = (collName && (idx.body[collName] || idx.prop[collName])) || null;
        if (!pat) return { error: 'no Auto-Title pattern for ' + (collName || '(unknown collection)') };
        await plugin.autoTitle(r, collName, pat);
        return { name: (r.getName && r.getName()) || null, pattern: pat };
      } catch (e) { return { error: String(e && e.message || e) }; }
    };

    console.log('[Templater] commands + slash + auto-apply + triggers engine registered.');
  }

  onUnload() {
    try {
      if (this._state) {
        (this._state.eventIds || []).forEach(id => { try { this.events.off(id); } catch (e) {} });
        (this._state.disposers || []).forEach(fn => { try { fn(); } catch (e) {} });
      }
    } catch (e) {}
  }

  // ========================================================================
  // Template loading
  // ========================================================================

  async getTemplatesCollection() {
    const collections = await this.data.getAllCollections();
    return collections.find(c => c && c.getName && c.getName() === TEMPLATES_COLL) || null;
  }

  async getAuditCollection() {
    const collections = await this.data.getAllCollections();
    for (const name of AUDIT_COLL_CANDIDATES) {
      const c = collections.find(cc => cc && cc.getName && cc.getName() === name);
      if (c) return c;
    }
    return null;
  }

  tName(tmpl) {
    try {
      const byLabel = tmpl.text && tmpl.text(F_NAME);
      if (byLabel && byLabel.trim()) return byLabel;
    } catch (e) {}
    try { return tmpl.getName() || "(untitled)"; } catch (e) { return "(untitled)"; }
  }

  tContent(tmpl) {
    // Template Content is many=true. Prefer first text(); join texts() when multi.
    try {
      const all = (tmpl.texts && tmpl.texts(F_CONTENT)) || [];
      if (all.length > 1) return all.join("\n");
      const first = tmpl.text && tmpl.text(F_CONTENT);
      if (first && first.trim()) return first;
      if (all.length) return all.join("\n");
    } catch (e) {}
    return "";
  }

  // The template SOURCE = frontmatter from the `Template Content` text prop + body from EITHER the text prop
  // OR (native-editor authoring) the template record's own nested line items. Frontmatter always stays in the
  // text prop (a short --- block, easy to edit); the body is taken from the record's body line items ONLY when
  // the text-prop body is empty — so existing markdown-text templates are untouched, and a template you author
  // in the normal outliner (drag-to-indent, WYSIWYG) is read back faithfully (Phase-1 heading nesting + the
  // depth-indented serialization round-trip the tree). Returns a markdown string for the normal render pipeline.
  async assembleTemplateSource(tmpl) {
    const text = this.tContent(tmpl) || '';
    let fmBlock = '', textBody = text;
    const m = text.match(/^(---\s*\r?\n[\s\S]*?\r?\n---)\s*\r?\n?([\s\S]*)$/);
    if (m) { fmBlock = m[1]; textBody = m[2]; }
    let body = textBody;
    if (!textBody.trim()) {
      try { const sb = await this.serializeBody(tmpl); if (sb && sb.trim()) body = sb; } catch (e) {}
    }
    return fmBlock ? (fmBlock + '\n' + body) : body;
  }

  // Serialize a template record's body line items -> a markdown string (indentation = tree depth * 2 spaces),
  // so the existing renderTemplate -> parseFrontmatter -> writeBody pipeline reconstructs the same tree.
  async serializeBody(tmpl) {
    let items = [];
    try { items = await tmpl.getLineItems(false); } catch (e) { return ''; }
    if (!items || !items.length) return '';
    const recGuid = tmpl.guid || (tmpl.getGuid && tmpl.getGuid());
    const guidSet = new Set(items.map(it => it && it.guid).filter(Boolean));
    const byParent = new Map();
    for (const it of items) {
      if (!it) continue;
      const p = it.parent_guid;
      const pk = (p == null || p === recGuid || !guidSet.has(p)) ? '__root__' : p;
      if (!byParent.has(pk)) byParent.set(pk, []);
      byParent.get(pk).push(it);
    }
    const out = [];
    const emit = (it, depth) => {
      const md = this._lineItemToMarkdown(it, depth);
      if (md != null) out.push(md);
      for (const k of (byParent.get(it.guid) || [])) emit(k, depth + 1);
    };
    for (const root of (byParent.get('__root__') || [])) emit(root, 0);
    return out.join('\n');
  }

  _lineItemToMarkdown(it, depth) {
    if (!it) return null;
    const indent = '  '.repeat(Math.max(0, depth));
    const text = this._segmentsToText(it.segments || []);
    switch (it.type) {
      case 'heading': {
        const size = (it.props && (it.props.heading_size != null ? it.props.heading_size : it.props.hsize)) || 2;
        return indent + '#'.repeat(Math.min(Math.max(size, 1), 6)) + ' ' + text;
      }
      case 'task': {
        let done = false; try { done = it.getTaskStatus && it.getTaskStatus() === 'done'; } catch (e) {}
        return indent + '- [' + (done ? 'x' : ' ') + '] ' + text;
      }
      case 'ulist': return indent + '- ' + text;
      case 'olist': return indent + '1. ' + text;
      case 'quote': return indent + '> ' + text;
      case 'text': case 'empty': case 'br': return indent + text;
      default: return null; // image/file/ref/table/etc — can't round-trip as template markdown
    }
  }

  _segmentsToText(segs) {
    let out = '';
    for (const s of (segs || [])) {
      if (!s) continue;
      if (typeof s.text === 'string') { out += s.text; continue; }
      const t = s.type;
      if (t === 'hashtag') { const tag = (s.text && (s.text.tag || s.text.title)) || ''; if (tag) out += '#' + String(tag).replace(/^#/, ''); }
      else if (t === 'ref') { const g = s.text && s.text.guid; const title = (s.text && s.text.title) || ''; if (g) out += '{{ref:' + g + '}}'; else if (title) out += '{{ref:' + title + '}}'; } // P2-10: prefer the guid so the exact link round-trips (resolveRefGuid accepts a guid)
      else if (t === 'datetime') { out += (s.text && s.text.formatted) || ''; }
      else if (s.text && typeof s.text === 'object' && s.text.title) { out += s.text.title; }
    }
    return out;
  }

  tField(tmpl, label) {
    try { const v = tmpl.text && tmpl.text(label); return (v == null) ? "" : v; } catch (e) { return ""; }
  }

  tTriggers(tmpl) {
    try {
      const p = tmpl.prop && tmpl.prop(F_TRIGGERS);
      if (p) {
        const labels = p.selectedChoiceLabels ? p.selectedChoiceLabels() : null;
        if (labels && labels.length) return labels.filter(Boolean);
        const texts = p.texts ? p.texts() : null;
        if (texts && texts.length) return texts.filter(Boolean);
      }
    } catch (e) {}
    try {
      const texts = tmpl.texts && tmpl.texts(F_TRIGGERS);
      if (texts && texts.length) return texts.filter(Boolean);
    } catch (e) {}
    return [];
  }

  tVersion(tmpl) {
    try { const v = tmpl.text && tmpl.text(F_VERSION); return (v && v.trim()) ? v.trim() : ""; } catch (e) { return ""; }
  }

  lastUsedTs(tmpl) {
    try {
      const d = tmpl.date && tmpl.date(F_LASTUSED);
      if (d && d.getTime) return d.getTime();
    } catch (e) {}
    return 0;
  }

  async findTemplate(refOrName) {
    const coll = await this.getTemplatesCollection();
    if (!coll) return null;
    const key = (refOrName || "").trim();
    if (GUID_RE.test(key)) {
      try { const r = this.data.getRecord(key); if (r) return r; } catch (e) {}
    }
    const records = await coll.getAllRecords();
    return records.find(r => {
      try { return this.tName(r) === key; } catch (e) { return false; }
    }) || null;
  }

  async loadTemplatesSorted() {
    const coll = await this.getTemplatesCollection();
    if (!coll) return null;
    const records = (await this._getRecordsCached(coll)).slice();
    records.sort((a, b) => {
      const la = this.lastUsedTs(a), lb = this.lastUsedTs(b);
      if (la !== lb) return lb - la;
      return (this.tName(a) || "").localeCompare(this.tName(b) || "");
    });
    return records;
  }

  // ========================================================================
  // Picker
  // ========================================================================

  async openPicker(presetTemplateName) {
    const plugin = this;
    let records;
    try {
      records = await this.loadTemplatesSorted();
      if (records === null) { this.toast("Templater", "\"" + TEMPLATES_COLL + "\" collection not found"); return; }
    } catch (e) {
      console.error('[Templater] failed to load templates:', e);
      this.toast("Templater", "Failed to load: " + (e && e.message || e));
      return;
    }
    if (!records.length) { this.toast("Templater", "No templates yet."); return; }

    if (presetTemplateName) {
      const q = presetTemplateName.toLowerCase();
      const direct = records.find(r => (this.tName(r) || "").toLowerCase() === q);
      if (direct) { this.onTemplatePicked(direct); return; }
      const partial = records.filter(r => (this.tName(r) || "").toLowerCase().includes(q));
      if (partial.length === 1) { this.onTemplatePicked(partial[0]); return; }
      if (partial.length) records = partial;
    }

    const items = records.map(r => {
      const ver = this.tVersion(r);
      const snippet = (this.tContent(r) || "").slice(0, 80).replace(/\s+/g, ' ').trim();
      const desc = (ver ? ("v" + ver + (snippet ? " · " : "")) : "") + snippet;
      return {
        label: this.tName(r),
        icon: "ti-files",
        description: desc,
        onSelected: () => plugin.onTemplatePicked(r)
      };
    });
    try {
      const panel = this.ui.getActivePanel && this.ui.getActivePanel();
      const anchor = (panel && panel.getElement && panel.getElement()) || document.body;
      this.ui.createDropdown({ attachedTo: anchor, options: items, width: 440, inputPlaceholder: "Search templates..." });
    } catch (e) {
      // Fallback to a keyboard-navigable suggester modal.
      this.asyncSuggester("Apply Template", items.map(i => i.label)).then(idx => {
        if (idx >= 0 && items[idx]) items[idx].onSelected();
      });
    }
  }

  async onTemplatePicked(template) {
    let content = await this.assembleTemplateSource(template);
    if (!content) { this.toast("Templater", "Template has no content."); return; }

    // Inheritance: Extends -> prepend parent content (one level).
    try {
      const extendsRef = (this.tField(template, F_EXTENDS) || "").trim();
      if (extendsRef) {
        const parent = await this.findTemplate(extendsRef);
        if (parent) {
          const parentContent = await this.assembleTemplateSource(parent);
          if (parentContent) content = parentContent + "\n" + content;
          console.log('[Templater] inheritance: prepended parent "' + this.tName(parent) + '"');
        } else {
          console.warn('[Templater] Extends "' + extendsRef + '" did not resolve.');
        }
      }
    } catch (e) { console.warn('[Templater] inheritance failed:', e); }

    // Resolve includes (recursion-limited) before prompt collection so nested prompts surface.
    try { content = await this.resolveIncludes(content, 0, new Set()); }
    catch (e) { console.warn('[Templater] include resolution failed:', e); }

    // Variables JSON
    let vars = { defaults: {}, empty: "skip" };
    try {
      const raw = this.tField(template, F_VARS) || this.tField(template, "Variables");
      if (raw && raw.trim()) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') vars = Object.assign({ defaults: {}, empty: "skip" }, parsed); }
    } catch (e) { console.warn('[Templater] invalid Variables JSON, ignoring:', e); }
    if (!vars.defaults) vars.defaults = {};

    const panel = this.ui.getActivePanel && this.ui.getActivePanel();
    const activeRecord = panel && panel.getActiveRecord && panel.getActiveRecord();
    const activeCollection = panel && panel.getActiveCollection && panel.getActiveCollection();
    const triggers = this.tTriggers(template);
    const appendMode = triggers.some(t => /^append to current record$/i.test(t));
    const updateMode = triggers.some(t => /^update current record$/i.test(t));

    // Flow: [pick collection] -> fill prompts -> create + fill + open. No preview step.
    const proceed = async (chosenCollection, mode) => {
      const prompts = this.collectPrompts(content, vars.defaults);
      // Pre-load record options for {{prompt.record:...}} prompts -> dropdown of record names.
      for (const pr of prompts) {
        if (pr.recordCollection) {
          try {
            const coll = await this.collectionByName(pr.recordCollection);
            if (coll) {
              const recs = await coll.getAllRecords();
              pr.choices = recs.map(r => { try { return r.getName(); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => a.localeCompare(b));
            }
          } catch (e) { console.warn('[Templater] record options load failed:', e); }
        }
      }
      const finalize = async (promptValues) => {
        if (promptValues == null) return;
        // TP-16: resolve "＋ New …" record picks — prompt for a name, create the record in the
        // target collection, and substitute its name so the relation resolves on render.
        for (const pr of prompts) {
          if (!pr.recordCollection) continue;
          const mk = async (val) => {
            if (val !== '__CREATE_NEW__') return val;
            const nm = await this.asyncPrompt('New ' + pr.recordCollection.replace(/s$/, '') + ' name', '');
            if (!nm || !nm.trim()) return '';
            try { const coll = await this.collectionByName(pr.recordCollection); if (coll) { const g = coll.createRecord(nm.trim()); if (g) await this.pollRecord(g); } } catch (e) { console.warn('[Templater] create-new failed', e); }
            return nm.trim();
          };
          const cur = promptValues[pr.label];
          if (Array.isArray(cur)) { const out = []; for (const x of cur) { const r = await mk(x); if (r) out.push(r); } promptValues[pr.label] = out; }
          else promptValues[pr.label] = await mk(cur);
        }
        let rendered;
        try {
          rendered = await this.renderTemplate(content, {
            record: activeRecord,
            collection: chosenCollection || activeCollection,
            prompts: promptValues || {},
            vars: vars.defaults || {},
            empty: vars.empty || "skip",
            templateName: this.tName(template),
          });
        } catch (e) {
          console.error('[Templater] render failed:', e);
          this.toast("Templater", "Render failed: " + (e && e.message || e));
          return;
        }
        try {
          await this.applyTemplate(template, rendered, { collection: chosenCollection, mode, preview: vars.preview });
        } catch (e) {
          console.error('[Templater] apply failed:', e);
          this.toast("Apply failed", String(e && e.message || e));
        }
      };
      if (!prompts.length) finalize({});
      else this.openPromptsModal(template, prompts, finalize);
    };

    // Author-fixed Append/Update triggers still win (respect an explicitly-tagged template).
    if (appendMode) { proceed(null, 'append'); return; }
    if (updateMode) { proceed(null, 'update'); return; }

    // Where would a NEW record go? (trigger-named collection > Variables.collection pin.)
    let pinned = await this.resolveTargetCollection(triggers, null);
    if (!pinned && vars.collection) { try { pinned = await this.collectionByName(String(vars.collection)); } catch (e) {} }

    const applyContext = this._recordApplyContext(activeRecord);

    // TP-19: SCHEMA FORM mode — a pinned template with Variables JSON {"form": true} shows ONE
    // typed form rendered from the collection schema (date pickers / choice dropdowns / record
    // pickers / number) instead of chained {{prompt}} dialogs. (Create-new only; opt-in per template.)
    // Journal fill must win even when Daily Note was authored as a schema-form create template.
    if (vars.form && pinned && !applyContext.isJournal) { try { await this.applySchemaForm(template, pinned, content, vars); } catch (e) { console.warn('[Templater] schema form failed', e); this.toast('Templater', 'Schema form error: ' + (e && e.message || e)); } return; }

    // TP-13/v2.46: every open record — including a synthetic Journal day record — enters the
    // fill-vs-create chooser. Journal used to be explicitly excluded here, which silently sent a
    // pinned Daily Note template down the create-in-Notes path even though getActiveRecord worked.
    if (applyContext.hasRecord) {
      const activeName = (activeRecord.getName && activeRecord.getName()) || 'current record';
      const pinName = pinned && pinned.getName && pinned.getName();
      const activeCollName = activeCollection && activeCollection.getName && activeCollection.getName();
      // A Journal page is a valid fill target regardless of the template's create collection.
      // Keep Fill first/default; Create remains an explicit alternative.
      const mismatch = !applyContext.isJournal && !!(pinName && activeCollName && pinName !== activeCollName);
      const mode = await this.chooseApplyTarget(this.tName(template), activeName, pinName, mismatch, applyContext.isJournal);
      if (mode == null) return;                       // dismissed -> no-op
      if (mode === 'append' || mode === 'update') { proceed(null, mode); return; }
      // mode === 'create' falls through to the create flow below.
    }

    // CREATE: pinned collection, else the active collection, else ask.
    if (pinned) { proceed(pinned, 'create'); return; }
    if (activeCollection) { proceed(activeCollection, 'create'); return; }
    this.openCollectionPicker((col) => proceed(col, 'create'));
  }

  // TP-13: runtime "where does this template go?" chooser. Returns 'update' | 'append' | 'create' | null.
  // Thin wrapper over the existing asyncSuggester modal (arrow-key + click + Esc -> -1). First option is
  // the safe default. When the template is pinned to a DIFFERENT collection than the open record, lead
  // with Create so we never silently rewrite a record of the wrong type.
  _recordApplyContext(record) {
    let isJournal = false;
    try { isJournal = !!(record && record.getJournalDetails && record.getJournalDetails()); } catch (e) {}
    return { hasRecord: !!record, isJournal };
  }

  _removeJournalTitleFields(frontmatter) {
    if (!frontmatter || typeof frontmatter !== 'object') return frontmatter;
    for (const key of Object.keys(frontmatter)) if (/^(title|name)$/i.test(key)) delete frontmatter[key];
    return frontmatter;
  }

  _applyTargetOptions(recordName, pinnedCollName, mismatch, isJournal) {
    const fill   = { k: 'update', l: isJournal
      ? ('Fill this journal page — keep date title (' + recordName + ')')
      : ('Fill this record — set properties, replace title (' + recordName + ')') };
    const append = { k: 'append', l: 'Append to this record — keep title, add below' };
    const create = { k: 'create', l: mismatch
      ? ('Create a NEW record in "' + pinnedCollName + '" instead')
      : (pinnedCollName ? ('Create a NEW record in "' + pinnedCollName + '"') : 'Create a NEW record') };
    return mismatch && !isJournal ? [create, fill, append] : [fill, append, create];
  }

  async chooseApplyTarget(templateName, recordName, pinnedCollName, mismatch, isJournal) {
    const opts = this._applyTargetOptions(recordName, pinnedCollName, mismatch, isJournal);
    const idx = await this.asyncSuggester('Apply "' + templateName + '"', opts.map(o => o.l));
    if (idx < 0 || !opts[idx]) return null;
    return opts[idx].k;
  }

  // Searchable target-collection picker (Thymer-native dropdown — spaces work in its input).
  // Calls onPick(collection) on selection; does nothing if dismissed (callback style, no hang).
  openCollectionPicker(onPick) {
    this.data.getAllCollections().then(all => {
      const cols = (all || []).filter(c => {
        const n = c && c.getName && c.getName();
        return n && n !== TEMPLATES_COLL && AUDIT_COLL_CANDIDATES.indexOf(n) === -1;
      });
      cols.sort((a, b) => (a.getName() || "").localeCompare(b.getName() || ""));
      const options = cols.map(c => ({ label: c.getName(), icon: "ti-folder", onSelected: () => onPick(c) }));
      const panel = this.ui.getActivePanel && this.ui.getActivePanel();
      const anchor = (panel && panel.getElement && panel.getElement()) || document.body;
      try {
        this.ui.createDropdown({ attachedTo: anchor, options, width: 380, inputPlaceholder: "Create in which collection?" });
      } catch (e) {
        this.asyncSuggester("Create in which collection?", cols.map(c => c.getName())).then(idx => {
          if (idx >= 0 && cols[idx]) onPick(cols[idx]);
        });
      }
    }).catch(e => console.warn('[Templater] collection picker failed:', e));
  }

  // ========================================================================
  // Auto-title rules (v2.46) — canonical global config + optional collection hook
  // ========================================================================

  _autoTitleRules() {
    try {
      const conf = this.getConfiguration && this.getConfiguration();
      const custom = conf && conf.custom && typeof conf.custom === 'object' ? conf.custom : {};
      const rules = custom[AUTO_TITLE_RULES_KEY];
      return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
    } catch (e) { return {}; }
  }

  _autoTitleRuleForCollection(collection) {
    if (!collection) return null;
    const rules = this._autoTitleRules();
    let guid = '', name = '';
    try { guid = collection.getGuid ? collection.getGuid() : ''; } catch (e) {}
    try { name = collection.getName ? collection.getName() : ''; } catch (e) {}
    const direct = guid && rules[guid];
    if (direct && typeof direct === 'object' && direct.template) return direct;
    // Name fallback keeps a rule usable if an export/import changed collection GUIDs.
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (rule && rule.collectionName === name && rule.template) return rule;
    }
    return null;
  }

  async applyAutoTitleRule(record, collection) {
    const rule = this._autoTitleRuleForCollection(collection);
    if (!rule || !rule.template) return null;
    const title = renderTemplaterAutoTitle(record, rule.template, rule, true).trim();
    if (!title) return null;
    let current = ''; try { current = (record.getName && record.getName()) || ''; } catch (e) {}
    if (title === current.trim()) return title;
    return (await this.trySetRecordTitle(record, title)) ? title : null;
  }

  async _ownConfigApi() {
    if (typeof this.saveConfiguration === 'function') return this;
    try {
      const all = this.data && this.data.getAllGlobalPlugins ? await this.data.getAllGlobalPlugins() : [];
      const mine = (all || []).find(p => p && p.getName && p.getName() === 'Templater');
      if (mine && typeof mine.saveConfiguration === 'function') return mine;
    } catch (e) {}
    return null;
  }

  async _saveAutoTitleRules(rules) {
    const api = await this._ownConfigApi();
    if (!api) throw new Error('Templater configuration is not writable on this Thymer build.');
    const current = (api.getConfiguration && api.getConfiguration()) || (this.getConfiguration && this.getConfiguration()) || {};
    const custom = current.custom && typeof current.custom === 'object' ? current.custom : {};
    await api.saveConfiguration(Object.assign({}, current, {
      version: '2.46.0',
      custom: Object.assign({}, custom, { [AUTO_TITLE_RULES_KEY]: rules })
    }));
  }

  async openAutoTitleRulesPanel() {
    try {
      const active = this.ui.getActivePanel && this.ui.getActivePanel();
      const panel = await this.ui.createPanel(active ? { afterPanel: active } : undefined);
      if (panel) await panel.navigateToCustomType(AUTO_TITLE_PANEL_TYPE);
    } catch (e) { this.toast('Templater', 'Could not open Auto-title rules: ' + (e && e.message || e)); }
  }

  async renderAutoTitleRulesPanel(root) {
    root.classList.add('tmpl-auto-title-panel');
    root.textContent = 'Loading collections…';
    let collections = [];
    try { collections = await this.data.getAllCollections(); } catch (e) {}
    collections = (collections || []).filter(c => {
      try { const n = c.getName && c.getName(); return n && n !== TEMPLATES_COLL && !AUDIT_COLL_CANDIDATES.includes(n); } catch (e) { return false; }
    }).sort((a, b) => (a.getName() || '').localeCompare(b.getName() || ''));
    if (!root.isConnected) return;
    root.replaceChildren();

    const title = document.createElement('h2'); title.textContent = 'Auto-title rules'; root.appendChild(title);
    const intro = document.createElement('p'); intro.className = 'tmpl-auto-title-help';
    intro.textContent = 'Build real titles after Templater fills properties. Optional live mode installs a marked, removable display-only hook in that collection plugin.';
    root.appendChild(intro);
    if (!collections.length) { const empty = document.createElement('p'); empty.textContent = 'No collections available.'; root.appendChild(empty); return; }

    const selectLabel = document.createElement('label'); selectLabel.className = 'tmpl-auto-title-label'; selectLabel.textContent = 'Collection'; root.appendChild(selectLabel);
    const collSelect = document.createElement('select'); collSelect.className = 'tmpl-auto-title-input';
    collections.forEach(c => { const o = document.createElement('option'); o.value = c.getGuid(); o.textContent = c.getName(); collSelect.appendChild(o); });
    root.appendChild(collSelect);

    const editor = document.createElement('div'); editor.className = 'tmpl-auto-title-editor'; root.appendChild(editor);
    const status = document.createElement('div'); status.className = 'tmpl-auto-title-status'; root.appendChild(status);
    const setStatus = (message, error) => { status.textContent = message || ''; status.classList.toggle('is-error', !!error); };

    const renderEditor = async () => {
      editor.replaceChildren(); setStatus('', false);
      const collection = collections.find(c => c.getGuid() === collSelect.value) || collections[0];
      if (!collection) return;
      const existingRule = this._autoTitleRuleForCollection(collection) || {};
      let fields = [];
      try { const cfg = collection.getConfiguration && collection.getConfiguration(); fields = cfg && Array.isArray(cfg.fields) ? cfg.fields : []; } catch (e) {}

      const ruleLabel = document.createElement('label'); ruleLabel.className = 'tmpl-auto-title-label'; ruleLabel.textContent = 'Title rule'; editor.appendChild(ruleLabel);
      const ruleInput = document.createElement('input'); ruleInput.className = 'tmpl-auto-title-input'; ruleInput.type = 'text'; ruleInput.spellcheck = false;
      ruleInput.placeholder = '{field:status}?{ · {field:owner}}'; ruleInput.value = existingRule.template || ''; this.attachInputGuards(ruleInput); editor.appendChild(ruleInput);

      const syntax = document.createElement('div'); syntax.className = 'tmpl-auto-title-help';
      syntax.textContent = '{name} = current stored title · {field:FIELD_ID} = property · ?{ … } = include only when a property has a value · \\{ = literal brace'; editor.appendChild(syntax);

      const chips = document.createElement('div'); chips.className = 'tmpl-auto-title-chips'; editor.appendChild(chips);
      const insert = (token) => {
        const start = Number.isFinite(ruleInput.selectionStart) ? ruleInput.selectionStart : ruleInput.value.length;
        const end = Number.isFinite(ruleInput.selectionEnd) ? ruleInput.selectionEnd : start;
        ruleInput.value = ruleInput.value.slice(0, start) + token + ruleInput.value.slice(end);
        ruleInput.focus(); try { ruleInput.setSelectionRange(start + token.length, start + token.length); } catch (e) {}
      };
      const addChip = (label, token, icon) => {
        const b = document.createElement('button'); b.className = 'tmpl-auto-title-chip'; b.type = 'button'; b.textContent = (icon ? icon + ' ' : '') + label;
        b.title = token; b.onclick = () => insert(token); chips.appendChild(b);
      };
      addChip('Name', '{name}', 'Aa');
      addChip('Optional group', '?{}', '…');
      for (const f of fields) {
        if (!f || !f.id || !f.label || /^(title|name)$/i.test(f.label)) continue;
        addChip(f.label, '{field:' + f.id + '}', '');
      }

      const liveRow = document.createElement('label'); liveRow.className = 'tmpl-auto-title-live';
      const live = document.createElement('input'); live.type = 'checkbox'; live.checked = existingRule.live === true;
      liveRow.appendChild(live); liveRow.appendChild(document.createTextNode(' Display-only live mode (managed customizeRecordTitle hook)')); editor.appendChild(liveRow);
      const liveNote = document.createElement('div'); liveNote.className = 'tmpl-auto-title-help';
      liveNote.textContent = 'For live mode, property-only rules are safest. A rule containing {name} is still applied as a real title, but the live hook stays neutral to prevent repeated title expansion.'; editor.appendChild(liveNote);

      const actions = document.createElement('div'); actions.className = 'tmpl-auto-title-actions'; editor.appendChild(actions);
      const save = document.createElement('button'); save.className = 'tmpl-btn primary'; save.textContent = 'Save rule'; actions.appendChild(save);
      const removeHook = document.createElement('button'); removeHook.className = 'tmpl-btn'; removeHook.textContent = 'Remove title hook'; actions.appendChild(removeHook);
      const deleteRule = document.createElement('button'); deleteRule.className = 'tmpl-btn'; deleteRule.textContent = 'Delete rule'; actions.appendChild(deleteRule);

      save.onclick = async () => {
        const template = ruleInput.value.trim();
        if (!template) { setStatus('Enter a title rule first.', true); return; }
        save.disabled = removeHook.disabled = deleteRule.disabled = true; setStatus('Saving…', false);
        const rules = Object.assign({}, this._autoTitleRules());
        let liveSaved = !!live.checked, hookMessage = '';
        try {
          if (liveSaved) {
            const hook = await this._installAutoTitleHook(collection, { template, multiValueSeparator: ', ', normalizeWhitespace: true });
            if (!hook.ok) { liveSaved = false; hookMessage = ' Rule saved, but live hook was not installed: ' + hook.message; }
          } else {
            const removed = await this._removeAutoTitleHook(collection);
            if (!removed.ok) hookMessage = ' Rule saved; hook removal failed: ' + removed.message;
          }
          rules[collection.getGuid()] = { collectionName: collection.getName(), template, live: liveSaved, multiValueSeparator: ', ', normalizeWhitespace: true };
          await this._saveAutoTitleRules(rules);
          setStatus('Saved for ' + collection.getName() + '.' + hookMessage, !!hookMessage);
        } catch (e) { setStatus('Could not save: ' + (e && e.message || e), true); }
        save.disabled = removeHook.disabled = deleteRule.disabled = false;
      };
      removeHook.onclick = async () => {
        save.disabled = removeHook.disabled = deleteRule.disabled = true; setStatus('Removing managed hook…', false);
        try {
          const result = await this._removeAutoTitleHook(collection);
          if (!result.ok) throw new Error(result.message);
          const rules = Object.assign({}, this._autoTitleRules());
          if (rules[collection.getGuid()]) rules[collection.getGuid()] = Object.assign({}, rules[collection.getGuid()], { live: false });
          await this._saveAutoTitleRules(rules);
          live.checked = false; setStatus(result.changed ? 'Title hook removed. Apply-time rule kept.' : 'No Templater title hook was installed.', false);
        } catch (e) { setStatus('Could not remove hook: ' + (e && e.message || e), true); }
        save.disabled = removeHook.disabled = deleteRule.disabled = false;
      };
      deleteRule.onclick = async () => {
        save.disabled = removeHook.disabled = deleteRule.disabled = true; setStatus('Deleting rule…', false);
        try {
          const removed = await this._removeAutoTitleHook(collection); if (!removed.ok) throw new Error(removed.message);
          const rules = Object.assign({}, this._autoTitleRules()); delete rules[collection.getGuid()];
          await this._saveAutoTitleRules(rules); ruleInput.value = ''; live.checked = false; setStatus('Rule and managed hook removed.', false);
        } catch (e) { setStatus('Could not delete: ' + (e && e.message || e), true); }
        save.disabled = removeHook.disabled = deleteRule.disabled = false;
      };
    };
    collSelect.onchange = () => { renderEditor().catch(e => setStatus(String(e), true)); };
    await renderEditor();
  }

  _autoTitleManagedBlock(rule, includeStub) {
    const safeRule = JSON.stringify({
      template: String(rule.template || ''),
      multiValueSeparator: typeof rule.multiValueSeparator === 'string' ? rule.multiValueSeparator : ', ',
      normalizeWhitespace: rule.normalizeWhitespace !== false,
    }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    // Hook mechanism and marker convention adopted from akaready/thymer-build-title-from-properties.
    return AUTO_TITLE_HOOK_START + "\n" + (includeStub ? (AUTO_TITLE_STUB + "\n") : '') +
`(function () {
\ttry {
\t\tif (typeof Plugin === 'undefined' || !Plugin || !Plugin.prototype) return;
\t\tvar __proto = Plugin.prototype;
\t\tvar __prev = __proto.onLoad;
\t\tif (typeof __prev !== 'function') return;
\t\t__proto.onLoad = function () {
\t\t\t__prev.call(this);
\t\t\ttry {
\t\t\t\tvar __rule = ${safeRule};
\t\t\t\tthis.customizeRecordTitle(function (a) {
\t\t\t\t\tif (/(^|[^\\\\])\\{\\s*(name|title)\\s*\\}/.test(__rule.template)) return null;
\t\t\t\t\tvar __title = renderTemplaterAutoTitle(a && a.record, __rule.template, __rule, false);
\t\t\t\t\treturn __title || null;
\t\t\t\t});
\t\t\t} catch (e) {}
\t\t};
\t} catch (e) {}
})();
${renderTemplaterAutoTitle.toString()}
` + AUTO_TITLE_HOOK_END;
  }

  _replaceAutoTitleManagedBlock(code, block) {
    const text = String(code);
    const start = text.indexOf(AUTO_TITLE_HOOK_START), end = text.indexOf(AUTO_TITLE_HOOK_END);
    if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + AUTO_TITLE_HOOK_END.length);
    // Exactly one separator newline belongs to the managed insertion and is removed with it.
    return text + '\n' + block;
  }

  _stripAutoTitleManagedBlock(code) {
    let text = String(code);
    const start = text.indexOf(AUTO_TITLE_HOOK_START), end = text.indexOf(AUTO_TITLE_HOOK_END);
    if (start < 0 || end <= start) return { code: text, changed: false };
    const ownedStart = start > 0 && text[start - 1] === '\n' ? start - 1 : start;
    text = text.slice(0, ownedStart) + text.slice(end + AUTO_TITLE_HOOK_END.length);
    // Remove only our exact marked stub; no unmarked collection code is rewritten.
    const stubAt = text.indexOf(AUTO_TITLE_STUB);
    if (stubAt >= 0) text = text.slice(0, stubAt) + text.slice(stubAt + AUTO_TITLE_STUB.length);
    return { code: text, changed: true };
  }

  _assertAutoTitleCollectionCode(code) {
    try { new Function(String(code)); } catch (e) { return { ok: false, message: 'generated collection code would not parse: ' + (e && e.message || e) }; }
    if (!/\bclass\s+Plugin\b|\bvar\s+Plugin\s*=|\bPlugin\s*=\s*class\b/.test(String(code))) return { ok: false, message: 'collection code declares no Plugin class' };
    return { ok: true };
  }

  async _readCollectionPlugin(collection) {
    if (!collection || typeof collection.getExistingCodeAndConfig !== 'function') return { ok: false, message: 'collection plugin code cannot be read on this Thymer build' };
    let existing;
    try { existing = await collection.getExistingCodeAndConfig(); } catch (e) { return { ok: false, message: 'collection plugin code could not be read' }; }
    if (!existing || typeof existing.code !== 'string') return { ok: false, message: 'collection plugin returned no readable code' };
    if (typeof collection.savePlugin !== 'function') return { ok: false, message: 'collection plugin code is not writable on this Thymer build' };
    const json = existing.json && typeof existing.json === 'object' ? existing.json : (collection.getConfiguration ? collection.getConfiguration() : null);
    if (!json || typeof json !== 'object') return { ok: false, message: 'collection plugin configuration could not be read' };
    return { ok: true, code: existing.code, json };
  }

  async _installAutoTitleHook(collection, rule) {
    const existing = await this._readCollectionPlugin(collection); if (!existing.ok) return existing;
    const hasOwner = /\bclass\s+Plugin\b|\bvar\s+Plugin\s*=|\bPlugin\s*=\s*class\b/.test(existing.code);
    const next = this._replaceAutoTitleManagedBlock(existing.code, this._autoTitleManagedBlock(rule, !hasOwner));
    const safe = this._assertAutoTitleCollectionCode(next); if (!safe.ok) return safe;
    try { const ok = await collection.savePlugin(existing.json, next); return ok ? { ok: true, changed: next !== existing.code } : { ok: false, message: 'Thymer rejected the collection plugin save' }; }
    catch (e) { return { ok: false, message: e && e.message || String(e) }; }
  }

  async _removeAutoTitleHook(collection) {
    const existing = await this._readCollectionPlugin(collection); if (!existing.ok) return existing;
    const stripped = this._stripAutoTitleManagedBlock(existing.code);
    if (!stripped.changed) return { ok: true, changed: false };
    // Removal is intentionally surgical: only our exact markers/stub are deleted.
    try { const ok = await collection.savePlugin(existing.json, stripped.code); return ok ? { ok: true, changed: true } : { ok: false, message: 'Thymer rejected the collection plugin save' }; }
    catch (e) { return { ok: false, message: e && e.message || String(e) }; }
  }

  // ========================================================================
  // include resolution (recursion limit 3)
  // ========================================================================

  async resolveIncludes(content, depth, stack) {
    if (depth >= RECURSION_LIMIT) {
      return content.replace(/\{\{include:([^}]+?)\}\}/g, () => "[include blocked: recursion limit " + RECURSION_LIMIT + "]");
    }
    const re = /\{\{include:([^}]+?)\}\}/g;
    if (!re.test(content)) return content;
    re.lastIndex = 0;
    let out = "";
    let last = 0, m;
    while ((m = re.exec(content)) !== null) {
      out += content.slice(last, m.index);
      const name = m[1].trim();
      if (stack.has(name.toLowerCase())) {
        out += "[include cycle: " + name + "]";
      } else {
        let sub = "";
        try {
          const child = await this.findTemplate(name);
          if (child) {
            sub = this.tContent(child) || "";
            const nextStack = new Set(stack); nextStack.add(name.toLowerCase());
            sub = await this.resolveIncludes(sub, depth + 1, nextStack);
          } else {
            sub = "[include not found: " + name + "]";
          }
        } catch (e) {
          sub = "[include error: " + (e && e.message || e) + "]";
        }
        out += sub;
      }
      last = m.index + m[0].length;
    }
    out += content.slice(last);
    return out;
  }

  // ========================================================================
  // Prompt collection
  // ========================================================================

  collectPrompts(content, defaults) {
    const stripped = content.replace(/<%\*[\s\S]*?%>/g, '');
    const seen = new Map(); // label -> { defaultValue, choices }
    let m;
    // Choice prompts FIRST so they win the dedup: {{prompt.choice:LABEL :: a, b, c}} (inline
    // options -> dropdown). A bare {{prompt.choice:LABEL}} with no options degrades to text.
    const choiceRe = /\{\{prompt\.choice:([^}]+?)\}\}/g;
    while ((m = choiceRe.exec(stripped)) !== null) {
      const dd = m[1].trim().split(/\s*::\s*/);
      const label = dd[0].trim();
      const choices = dd[1] ? dd[1].split(',').map(s => s.trim()).filter(Boolean) : [];
      if (!seen.has(label)) {
        seen.set(label, { defaultValue: choices[0] || (defaults && defaults[label]) || "", choices });
      } else if (choices.length && !(seen.get(label).choices || []).length) {
        seen.get(label).choices = choices;
      }
    }
    // Record-reference prompts: {{prompt.record:LABEL :: Collection}} (single) or
    // {{prompt.records:LABEL :: Collection}} (MANY -> multi-select). Dropdown of that
    // collection's records; resolves to clickable ref(s) / a relation in a record property.
    const recordRe = /\{\{prompt\.record(s)?:([^}]+?)\}\}/g;
    while ((m = recordRe.exec(stripped)) !== null) {
      const multi = !!m[1];
      const dd = m[2].trim().split(/\s*::\s*/);
      const label = dd[0].trim();
      const recordCollection = dd[1] ? dd[1].trim() : "";
      if (!seen.has(label)) seen.set(label, { defaultValue: "", choices: [], recordCollection, multi });
      else { const sv = seen.get(label); if (recordCollection && !sv.recordCollection) sv.recordCollection = recordCollection; if (multi) sv.multi = true; }
    }
    // Plain prompts: {{prompt:LABEL ?? def}}
    const re = /\{\{prompt:([^}]+?)\}\}/g;
    while ((m = re.exec(stripped)) !== null) {
      const [labelPart, defaultPart] = m[1].trim().split(/\s*\?\?\s*/);
      const label = labelPart.trim();
      if (!seen.has(label)) {
        const dflt = (defaultPart !== undefined) ? defaultPart.trim() : ((defaults && defaults[label]) || "");
        seen.set(label, { defaultValue: dflt, choices: [] });
      }
    }
    return Array.from(seen, ([label, v]) => ({ label, defaultValue: v.defaultValue, choices: v.choices || [], recordCollection: v.recordCollection || "", multi: v.multi || false }));
  }

  // ========================================================================
  // Rendering — token resolution (async: {{date}} parse + ref resolve + JS blocks)
  // ========================================================================

  // 10X-#7/#2 — Conditional sections: {{if:<cond>}} … {{else}} … {{endif}} (non-nested).
  // Cond forms:
  //   Field=Value / Field!=Value            — reads the target record's property (choiceLabel/text/number)
  //   attr:Key>N|<N|>=N|<=N|=V|!=V          — live Attributes value via _attrValue (numeric when both sides numeric)
  // WHOOP daily-note use: {{if:attr:Recovery>66}}## Deep work…{{else}}## Admin…{{endif}}.
  // Unknown/unreadable → false. Runs FIRST in renderTemplate. Limitation (documented): prompt
  // COLLECTION happens before render, so keep {{prompt:}} tokens outside conditional branches.
  async resolveConditionals(content, ctx) {
    if (!content || content.indexOf('{{if:') === -1) return content;
    const evalCond = async (cond) => {
      try {
        cond = String(cond || '').trim();
        let m = cond.match(/^attr:([^<>=!]+?)\s*(>=|<=|!=|=|>|<)\s*(.+)$/);
        if (m) {
          const raw = await this._attrValue(m[1].trim(), 'latest');
          const a = parseFloat(raw), b = parseFloat(m[3].trim());
          const num = !isNaN(a) && !isNaN(b);
          switch (m[2]) {
            case '>': return num && a > b;
            case '<': return num && a < b;
            case '>=': return num && a >= b;
            case '<=': return num && a <= b;
            case '!=': return num ? a !== b : String(raw).trim().toLowerCase() !== m[3].trim().toLowerCase();
            default: return num ? a === b : String(raw).trim().toLowerCase() === m[3].trim().toLowerCase();
          }
        }
        m = cond.match(/^([^<>=!]+?)\s*(!=|=)\s*(.+)$/);
        if (m && ctx && ctx.record) {
          let v = null;
          try { const p = ctx.record.prop && ctx.record.prop(m[1].trim()); if (p) { if (p.choiceLabel) v = p.choiceLabel(); if (v == null && p.text) v = p.text(); if (v == null && p.number) v = p.number(); } } catch (e) {}
          const eq = String(v == null ? '' : v).trim().toLowerCase() === m[3].trim().toLowerCase();
          return m[2] === '!=' ? !eq : eq;
        }
      } catch (e) {}
      return false;
    };
    return await this.replaceAsync(content, /\{\{if:([^}]+?)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{endif\}\}/g,
      async (_, cond, yes, no) => (await evalCond(cond)) ? yes : (no || ''));
  }

  async renderTemplate(content, ctx) {
    let out = await this.resolveConditionals(content, ctx);   // 10X-#7: conditionals first — dropped branches never render

    // {{prompt.choice:LABEL :: opts}} -> the picked value (shares the LABEL prompt answer).
    // Resolved before the plain {{prompt:...}} rule so the `.choice` form is consumed first.
    out = out.replace(/\{\{prompt\.choice:([^}]+?)\}\}/g, (_, body) => {
      const label = body.split(/\s*::\s*/)[0].trim();
      const v = ctx.prompts && ctx.prompts[label];
      return (v != null && v !== "") ? v : "";
    });

    // {{prompt:LABEL ?? def}}  (an array value, from a multi-record prompt, joins with ', ')
    out = out.replace(/\{\{prompt:([^}]+?)\}\}/g, (_, body) => {
      const [labelPart, defPart] = body.split(/\s*\?\?\s*/);
      const label = labelPart.trim();
      const v = ctx.prompts && ctx.prompts[label];
      if (Array.isArray(v)) return v.join(', ');
      if (v != null && v !== "") return v;
      return (defPart !== undefined) ? defPart.trim() : "";
    });

    // {{prompt.record:LABEL :: Collection}} (single) / {{prompt.records:...}} (many) -> ref
    // marker(s) for the picked record(s), concatenated so a frontmatter relation captures all guids.
    out = await this.replaceAsync(out, /\{\{prompt\.record(s)?:([^}]+?)\}\}/g, async (_, plural, body) => {
      const label = body.split(/\s*::\s*/)[0].trim();
      const v = ctx.prompts && ctx.prompts[label];
      const names = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
      let outRefs = "";
      for (const nm of names) {
        const name = String(nm).trim();
        if (!name) continue;
        const guid = await this.resolveRefGuid(name);
        outRefs += guid ? (M_OPEN + "REF" + M_SEP + guid + M_SEP + name + M_CLOSE) : name;
      }
      return outRefs;
    });

    // {{record.PropName}}
    out = out.replace(/\{\{record\.([^}]+?)\}\}/g, (_, prop) => {
      if (!ctx.record || !ctx.record.prop) return "";
      try {
        const p = ctx.record.prop(prop.trim());
        if (!p) return "";
        if (p.choiceLabel) { const cl = p.choiceLabel(); if (cl) return cl; }
        if (p.text) { const t = p.text(); if (t != null && t !== "") { const ts = String(t); if (/^\[?\s*"?[A-Z0-9]{20,32}"?/.test(ts.trim())) { const rel = this._relationNames(p); if (rel) return rel; } return ts; } } // a relation reads back as a guid / ["guid",…] blob → resolve to name(s)
        if (p.number) { const n = p.number(); if (n != null) return String(n); }
        if (p.date) { const d = p.date(); if (d) return this.formatDate(d, null); }
        const rel = this._relationNames(p); if (rel) return rel; // relation/record prop → linked record name(s)
        return "";
      } catch (e) { return ""; }
    });

    // {{var.NAME}}
    out = out.replace(/\{\{var\.([^}]+?)\}\}/g, (_, name) => {
      const v = ctx.vars && ctx.vars[name.trim()];
      return v == null ? "" : String(v);
    });

    // {{date}} and {{date:FMT|natural-language}} -> survivable DATE marker (becomes a
    // datetime segment in body context; collapses to plain text in frontmatter/preview).
    // TP-12: also resolves relative-offset milestone dates ({{date:+7}}, {{date:+7@Start Date}}) — ctx-aware.
    out = out.replace(/\{\{date(?::([^}]+))?\}\}/g, (_, fmt) => {
      const ds = this.dateStringForSegment(fmt, ctx);
      return M_OPEN + "DATE" + M_SEP + ds + M_CLOSE;
    });

    // {{ref:Name or GUID}} -> survivable REF marker carrying the resolved guid + label.
    out = await this.replaceAsync(out, /\{\{ref:([^}]+?)\}\}/g, async (_, nameOrGuid) => {
      const key = nameOrGuid.trim();
      const guid = await this.resolveRefGuid(key);
      if (guid) return M_OPEN + "REF" + M_SEP + guid + M_SEP + key + M_CLOSE;
      return "[ref not found: " + key + "]";
    });

    // {{tag:foo}} -> survivable TAG marker
    out = out.replace(/\{\{tag:([^}]+?)\}\}/g, (_, t) => {
      const tag = t.trim().replace(/^#/, '');
      return M_OPEN + "TAG" + M_SEP + "#" + tag + M_CLOSE;
    });

    // TP-1 alias: {{schedule:…}} / {{datetime:…}} behave like {{date:…}} (a real datetime segment that schedules).
    out = out.replace(/\{\{(?:schedule|datetime):([^}]+)\}\}/g, (_, fmt) => M_OPEN + "DATE" + M_SEP + this.dateStringForSegment(fmt) + M_CLOSE);

    // TP-3: {{cursor}} -> a marker; the line carrying it is navigated-to (highlighted) after apply.
    out = out.replace(/\{\{cursor\}\}/g, '<!--PLEXUS-CURSOR-->');

    // TS-10: {{banner:URL}} -> a directive; the image is fetched + set as the new record's banner after apply.
    out = out.replace(/\{\{banner:(https?:\/\/[^}]+)\}\}/g, (_, url) => `<!--PLEXUS-BANNER:${url.trim()}-->`);

    // TS-3: {{relate:Field=Name}} -> a directive that sets a typed record-RELATION property after create (the new
    // record drops straight into the Plexus Brain graph). Resolved to the target GUID here.
    // 10X-#4 CASCADE extensions: {{relate:Field=Name :: create=Collection :: apply=Template}} —
    // creates the target when missing, then (optionally) merge-applies a template onto it, so one
    // apply can scaffold a whole linked subgraph. apply is depth-capped via __chainDepth.
    out = await this.replaceAsync(out, /\{\{relate:([^=}]+)=([^}]+)\}\}/g, async (_, field, spec) => {
      const parts = String(spec).split(/\s*::\s*/);
      const nameOrGuid = parts[0].trim();
      let createColl = null, applyTmpl = null;
      for (const p of parts.slice(1)) { const m = p.match(/^(create|apply)\s*=\s*(.+)$/i); if (m) { if (/^create$/i.test(m[1])) createColl = m[2].trim(); else applyTmpl = m[2].trim(); } }
      let guid = await this.resolveRefGuid(nameOrGuid);
      if (!guid && createColl) {
        try { const coll = await this.collectionByName(createColl); if (coll) { const ng = coll.createRecord(nameOrGuid); if (ng && await this.pollRecord(ng)) guid = ng; } } catch (e) { console.warn('[Templater] relate create failed', e); }
      }
      if (guid && applyTmpl) {
        const g2 = guid, t2 = applyTmpl;
        setTimeout(() => { try { this._state.applyTemplateByName(t2, { mode: 'merge', recordGuid: g2, prompts: {}, __chainDepth: 2 }).then(r => { if (r && r.error) console.warn('[Templater] relate apply →', t2, r.error); }); } catch (e) { console.warn('[Templater] relate apply failed', e); } }, 700);
      }
      return guid ? `<!--PLEXUS-RELATE:${field.trim()}=${guid}-->` : '';
    });

    // TP-20: {{ai:: <instruction>}} -> text generated by the local /llm endpoint, inserted inline.
    // Plugin-side fetch (the <%* %> blocklist only gates the sandbox). Best-effort: a down proxy
    // resolves to '' so the rest of the template still applies.
    out = await this.replaceAsync(out, /\{\{ai::\s*([\s\S]+?)\}\}/g, async (_, instr) => {
      const t = await this._llm(String(instr).trim(), false);
      return (t && t.text != null) ? String(t.text).trim() : '';
    });

    // TP-15: {{task: Title | status=To Do | priority=High | context=Computer | due=+3 days}}
    // A directive that becomes a real Rich Tasks RECORD after apply (linked to the new record),
    // NOT a body line item. The title may use {{prompt:…}} (already resolved above). Encoded so
    // commas/pipes survive into the post-apply spawner; stripped from the body before it is written.
    out = out.replace(/\{\{task:([^}]+?)\}\}/g, (_, body) => '<!--TMPL-TASK:' + encodeURIComponent(body.trim()) + '-->');

    // {{attr:Key}} / {{attr:Key:latest|avg|avgN|trend|min|max|sum|count}} -> a LIVE value pulled from the
    // Attributes collection (the Attributes Engine plugin's index). Lets weekly-review templates auto-embed
    // metric summaries — e.g. {{attr:Weight}}, {{attr:Energy:avg7}}, {{attr:Mood:trend}}.
    out = await this.replaceAsync(out, /\{\{attr:([^}:]+?)(?::([^}]+?))?\}\}/g, async (_, key, mod) => {
      try { return await this._attrValue(String(key).trim(), (mod || 'latest').trim()); } catch (e) { return ''; }
    });

    // <%* js %> sandbox (async tp.* namespace)
    out = await this.replaceAsync(out, /<%\*([\s\S]*?)%>/g, async (_, code) => {
      return await this.runJsBlock(code, ctx);
    });

    // GAP-1 (original-Templater parity): <% expr %> INTERPOLATION — a plain expression whose value
    // is inserted, e.g. `<% tp.date.now("YYYY-MM-DD") %>` or `<% tp.file.title %>`. Runs AFTER the
    // <%* pass so only non-star forms remain; accepts and strips the original's whitespace-control
    // markers (<%- … -%>, <%_ … _%>) and the <%+ dynamic marker (evaluated once — Thymer bodies are
    // live documents, so "dynamic" re-render doesn't apply). runJsBlock auto-wraps bare expressions.
    out = await this.replaceAsync(out, /<%(?!\*)[-_+]?([\s\S]*?)[-_]?%>/g, async (_, code) => {
      return await this.runJsBlock(code, ctx);
    });

    return out;
  }

  // resolve an Attributes key to a value for the {{attr:}} token. mod: latest(default)/avg/avgN/trend/min/max/sum/count.
  async _attrColl() {
    if (this._attrCollCache) return this._attrCollCache;
    try { const cols = await this.getCollectionsCached(); this._attrCollCache = cols.find(c => { try { return c.getGuid() === ATTR_COLL_GUID || c.getName() === 'Attributes'; } catch (e) { return false; } }) || null; } catch (e) {}
    return this._attrCollCache;
  }
  async _attrValue(key, mod) {
    const coll = await this._attrColl(); if (!coll) return '';
    const recs = await this._getRecordsCached(coll);
    const rows = [];
    for (const r of (recs || [])) {
      let k = ''; try { k = r.text('Key') || ''; } catch (e) {}
      if (k !== key) continue;
      let num = null, val = '', date = 0;
      try { num = r.number('Number'); } catch (e) {}
      try { val = r.text('Value') || ''; } catch (e) {}
      try { const d = r.date('Date'); if (d) date = d.getTime(); } catch (e) {}
      rows.push({ num: (typeof num === 'number' && isFinite(num)) ? num : null, val, date });
    }
    if (!rows.length) return '';
    rows.sort((a, b) => a.date - b.date);
    const nums = rows.map(r => r.num).filter(x => x != null);
    const m = String(mod || 'latest').toLowerCase();
    const fmt = (n) => (Math.round(n * 100) / 100).toString();
    const mean = (a) => a.length ? fmt(a.reduce((s, x) => s + x, 0) / a.length) : '';
    if (m === 'avg' || m === 'mean') return mean(nums);
    const am = m.match(/^avg(\d+)$/); if (am) return mean(nums.slice(-parseInt(am[1], 10)));
    if (m === 'trend') { if (nums.length < 2) return '0'; const d = nums[nums.length - 1] - nums[0]; return (d >= 0 ? '+' : '') + fmt(d); }
    if (m === 'min') return nums.length ? fmt(Math.min(...nums)) : '';
    if (m === 'max') return nums.length ? fmt(Math.max(...nums)) : '';
    if (m === 'sum') return nums.length ? fmt(nums.reduce((s, x) => s + x, 0)) : '';
    if (m === 'count') return String(rows.length);
    const last = rows[rows.length - 1]; return last.num != null ? fmt(last.num) : last.val; // latest
  }

  // T3: one shared records snapshot per collection (TTL + event-invalidated) reused by all index builders +
  // the {{attr:}} token, instead of each calling getAllRecords() independently on its own cache miss.
  async _getRecordsCached(coll) {
    if (!coll) return [];
    let g = ''; try { g = coll.getGuid(); } catch (e) {}
    if (!this._recSnap) this._recSnap = new Map();
    const e = g && this._recSnap.get(g);
    if (e && (Date.now() - e.ts) < TRIGGER_TTL_MS) return e.records;
    let recs = []; try { recs = await coll.getAllRecords(); } catch (err) { return e ? e.records : []; }
    if (g) this._recSnap.set(g, { ts: Date.now(), records: recs });
    return recs;
  }

  // Resolve a {{date:...}} payload into a Thymer-parseable date STRING.
  // Bare {{date}} -> "today"; natural language passes through verbatim ("tomorrow",
  // "next monday", "+3 days"); only an explicit strftime-style FMT is pre-resolved to ISO.
  dateStringForSegment(fmt, ctx) {
    if (!fmt) return "today";
    const f = String(fmt).trim();
    if (!f) return "today";
    // TP-12 relative-offset milestones (resolved to a concrete ISO so they become real schedulable dates):
    //   {{date:+7@Start Date}} / {{date:+7 from Start Date}}  -> N days from the prompted "Start Date" answer
    //   {{date:+7}} / {{date:-3}}                              -> today ± N days
    // A whole milestone schedule keys off ONE prompted start date instead of each line off "today".
    let mo = f.match(/^([+-]?\d+)\s*(?:@|from\s+)\s*(.+)$/i);
    if (mo) return this._isoOffset(this._resolveAnchorDate(mo[2].trim(), ctx), parseInt(mo[1], 10));
    // Relative offset from today: "+7", "-3", "+7 days", "+2 weeks", "+3 months", "5 days".
    mo = f.match(/^([+-]?\d+)\s*(day|days|week|weeks|month|months|year|years)$/i) || f.match(/^([+-]\d+)$/);
    if (mo) {
      let n = parseInt(mo[1], 10); const u = (mo[2] || 'day').toLowerCase();
      if (u.startsWith('week')) n *= 7; else if (u.startsWith('month')) n *= 30; else if (u.startsWith('year')) n *= 365;
      return this._isoOffset(new Date(), n);
    }
    // strftime-ish format string -> resolve now to a concrete date. (Single M/D omitted from
    // detection to avoid catching natural language; they still RESOLVE in formatDate.)
    if (/(YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|HH|mm|ss)/.test(f)) {
      return this.formatDate(new Date(), f);
    }
    // Natural-language / relative: hand the raw string to Thymer's parser.
    return f;
  }
  // TP-12: the date answered in the prompt labelled <label> (parsed to a JS Date); falls back to today
  // when the anchor is unanswered/unparseable, so an offset milestone always resolves to a real date.
  _resolveAnchorDate(label, ctx) {
    let s = ctx && ctx.prompts && ctx.prompts[label];
    if (Array.isArray(s)) s = s[0];
    if (s == null || !String(s).trim()) return new Date();
    s = String(s).trim();
    try { if (typeof DateTime !== 'undefined' && DateTime.parseDateTimeString) { const dt = DateTime.parseDateTimeString(s); if (dt && dt.toDate && dt.toDate()) return dt.toDate(); } } catch (_e) {}
    // A bare ISO 'YYYY-MM-DD' must parse as LOCAL midnight, not UTC (new Date('2026-07-01')
    // is UTC -> reads back as the previous day in Pacific; recurring PDT/UTC off-by-one).
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    const d = new Date(s); return isNaN(d.getTime()) ? new Date() : d;
  }
  _isoOffset(base, n) {
    const d = base ? new Date(base) : new Date();
    d.setDate(d.getDate() + (n || 0));
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  formatDate(d, fmt) {
    if (!fmt) {
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      return `${dow} ${mon} ${d.getDate()}`;
    }
    const pad = (n, w) => String(n).padStart(w, '0');
    const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const WDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MOL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const MOS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const map = {
      YYYY: String(d.getFullYear()),
      YY: pad(d.getFullYear() % 100, 2),
      MMMM: MOL[d.getMonth()],
      MMM: MOS[d.getMonth()],
      MM: pad(d.getMonth() + 1, 2),
      M: String(d.getMonth() + 1),
      DD: pad(d.getDate(), 2),
      D: String(d.getDate()),
      dddd: WDL[d.getDay()],
      ddd: WDS[d.getDay()],
      HH: pad(d.getHours(), 2),
      mm: pad(d.getMinutes(), 2),
      ss: pad(d.getSeconds(), 2),
    };
    // Single pass, longest tokens first so MMM/MM/M (and dddd/ddd, YYYY/YY, DD/D) don't collide.
    return String(fmt).replace(/YYYY|MMMM|dddd|MMM|ddd|YY|MM|DD|HH|mm|ss|M|D/g, t => map[t]);
  }

  async resolveRefGuid(key) {
    if (GUID_RE.test(key)) {
      try { const r = this.data.getRecord(key); if (r) return key; } catch (e) {}
      return key; // assume a valid guid even if not yet resolvable locally
    }
    try {
      const res = await this.data.searchByQuery(key, 20);
      if (res && res.records && res.records.length) {
        const k = key.toLowerCase();
        const exact = res.records.find(r => {
          try { return (r.getName && r.getName() || "").toLowerCase() === k; } catch (e) { return false; }
        });
        if (exact) return exact.guid;
        // Prefer an exact match; if none, do NOT guess — emit [ref not found].
        return null;
      }
    } catch (e) {}
    return null;
  }

  async replaceAsync(str, regex, asyncFn) {
    const matches = [];
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(str)) !== null) {
      matches.push({ match: m[0], groups: m.slice(1), index: m.index });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    if (!matches.length) return str;
    let out = "";
    let last = 0;
    for (const mm of matches) {
      out += str.slice(last, mm.index);
      try { out += await asyncFn(mm.match, ...mm.groups); }
      catch (e) { out += "[error: " + (e && e.message || e) + "]"; }
      last = mm.index + mm.match.length;
    }
    out += str.slice(last);
    return out;
  }

  // ========================================================================
  // JS sandbox  <%* ... %>  — async tp.* namespace + forbidden-id blocklist
  // ========================================================================

  async runJsBlock(code, ctx) {
    const blockedRe = /\b(eval|Function|window|globalThis|localStorage|sessionStorage|XMLHttpRequest)\b|document\s*\.\s*write|import\s*\(|require\s*\(|fetch\s*\(/;
    try {
      if (blockedRe.test(code)) return "[js blocked: forbidden identifier]";
      await this._ensureUserFns(); // TS-5: load tp.user.* from the Template Functions collection
      const tp = this.buildTp(ctx);
      // Support both `return expr` style and statement bodies.
      let body = code;
      if (!/\breturn\b/.test(body) && !/[;\n]/.test(body.trim())) {
        body = "return (" + body + ")";
      }
      const fn = new Function(
        "tp", "ctx",
        '"use strict"; return (async () => { ' + body + ' })();'
      );
      const result = await fn(tp, ctx);
      return result == null ? "" : String(result);
    } catch (e) {
      return "[js error: " + (e && e.message || e) + "]";
    }
  }

  // TS-5: load reusable JS functions from a `Template Functions` collection (record name = fn name; body = the
  // record's body line items or a Body/Function/Code text property). Trusted plugin-side eval. Cached per session.
  async _ensureUserFns() {
    if (this._userFnsLoadedAt && (Date.now() - this._userFnsLoadedAt) < COLL_CACHE_TTL_MS) return; // T4: TTL so edited Template Functions reload (was cached forever)
    this._userFnsLoadedAt = Date.now(); this._userFns = {};
    try {
      const cols = await this.data.getAllCollections();
      const col = (cols || []).find((c) => { try { return /^template functions$/i.test(c.getName()); } catch (_e) { return false; } });
      if (!col) return;
      const recs = await col.getAllRecords();
      for (const r of (recs || [])) {
        try {
          const name = (r.getName && r.getName()) || ''; if (!name) continue;
          let body = '';
          try { const bp = r.prop && (r.prop('Body') || r.prop('Function') || r.prop('Code')); if (bp && bp.text) body = bp.text() || ''; } catch (_e) {}
          if (!body.trim()) { try { const items = await r.getLineItems(); body = (items || []).map((li) => (li.segments || []).map((s) => (typeof s.text === 'string' ? s.text : (s.text && s.text.title) || '')).join('')).join('\n'); } catch (_e) {} }
          if (!body.trim()) continue;
          const safe = name.replace(/[^A-Za-z0-9_$]/g, '_');
          this._userFns[safe] = new Function('tp', 'ctx', 'args', '"use strict"; return (async () => { ' + body + ' })();');
        } catch (_e) {}
      }
    } catch (_e) {}
  }
  buildTp(ctx) {
    const plugin = this;
    const fmt = (d, f) => plugin.formatDate(d, f || null);
    const parse = (s) => {
      try {
        if (typeof DateTime !== 'undefined' && DateTime.parseDateTimeString) {
          const dt = DateTime.parseDateTimeString(String(s));
          if (dt && dt.toDate) return dt.toDate();
        }
      } catch (e) {}
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };
    const weekdayName = (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];

    const _tp = {
      config: {
        run_mode: "apply",
        templateName: ctx.templateName || "",
        activeRecord: ctx.record || null,
        activeCollection: ctx.collection || null,
      },
      file: {
        title: (() => { try { return ctx.record ? ctx.record.getName() : ""; } catch (e) { return ""; } })(),
      },
      date: {
        now: (f) => fmt(new Date(), f),
        today: (f) => fmt(new Date(), f),
        tomorrow: (f) => { const d = new Date(); d.setDate(d.getDate() + 1); return fmt(d, f); },
        yesterday: (f) => { const d = new Date(); d.setDate(d.getDate() - 1); return fmt(d, f); },
        weekday: (offset, f) => {
          const d = new Date();
          const n = Number(offset);
          if (!isNaN(n) && n) d.setDate(d.getDate() + n);
          return f ? fmt(d, f) : weekdayName(d);
        },
        parse: (s, f) => { const d = parse(s); return d ? fmt(d, f) : ""; },
      },
      system: {
        prompt: async (label, dflt) => await plugin.asyncPrompt(String(label || "Input"), dflt != null ? String(dflt) : ""),
        suggester: async (items, labels) => {
          const opts = (labels || items) || [];
          const idx = await plugin.asyncSuggester("Choose", opts.map(String));
          return idx >= 0 ? (items ? items[idx] : opts[idx]) : null;
        },
        // GAP-3: REAL multi-select (checkbox modal) — was a single-select stub returning [one].
        multi_suggester: async (items, labels) => {
          const opts = (labels || items) || [];
          const idxs = await plugin.asyncMultiSuggester("Choose (multi)", opts.map(String));
          return idxs.map(i => (items ? items[i] : opts[i]));
        },
        clipboard: async () => { try { return await navigator.clipboard.readText(); } catch (e) { return ""; } },
      },
      // GAP-2: tp.web.* — plugin-side fetch surfaced to template authors (user code can't call fetch
      // directly; these run in the plugin closure). request() returns parsed JSON when the response
      // is JSON, else text.
      web: {
        request: async (url, opts) => { try { const r = await fetch(String(url), (opts && typeof opts === 'object') ? opts : undefined); const ct = (r.headers.get('content-type') || ''); return ct.includes('application/json') ? await r.json() : await r.text(); } catch (e) { return "[web error: " + (e && e.message || e) + "]"; } },
        daily_quote: async () => { try { const r = await fetch('https://api.quotable.io/random'); const j = await r.json(); return '> ' + j.content + '\n> — ' + j.author; } catch (e) { return ''; } },
        random_picture: async (size) => { const s = String(size || '1600x900').split('x'); return 'https://picsum.photos/' + (parseInt(s[0], 10) || 1600) + '/' + (parseInt(s[1], 10) || 900); },
      },
      // GAP-4: tp.hooks.on_all_templates_executed(cb) — cb runs once, after the whole apply pipeline
      // (properties + body + tasks + relations) finishes. Queued on the PLUGIN (render ctx doesn't
      // reach applyTemplate); drained there. Render-only paths without an apply just leave the
      // queue for the next apply — same single-shot semantics as the original.
      hooks: {
        on_all_templates_executed: (cb) => { try { if (typeof cb === 'function') (plugin._pendingHooks = plugin._pendingHooks || []).push(cb); } catch (e) {} },
      },
      thymer: {
        query: async (collectionName) => {
          try {
            const cols = await plugin.data.getAllCollections();
            const c = cols.find(cc => cc && cc.getName && cc.getName() === collectionName);
            if (!c) return [];
            return await c.getAllRecords();
          } catch (e) { return []; }
        },
        ref: async (nameOrGuid) => {
          const g = await plugin.resolveRefGuid(String(nameOrGuid).trim());
          return g ? (M_OPEN + "REF" + M_SEP + g + M_SEP + String(nameOrGuid).trim() + M_CLOSE) : ("[ref not found: " + nameOrGuid + "]");
        },
        setProperty: (name, val) => {
          try {
            if (ctx.record && ctx.record.prop) {
              const p = ctx.record.prop(String(name));
              if (p) { plugin.applyPropertyValue(p, String(name), String(val)); return true; }
            }
          } catch (e) {}
          return false;
        },
        create_record: async (collectionName, title) => {
          try {
            const cols = await plugin.data.getAllCollections();
            const c = cols.find(cc => cc && cc.getName && cc.getName() === collectionName);
            if (!c) return null;
            return c.createRecord(String(title || "Untitled"));
          } catch (e) { return null; }
        },
      },
    };
    // TS-5: tp.user.<name>(...args) — reusable functions loaded from a `Template Functions` collection.
    _tp.user = {};
    for (const name of Object.keys(plugin._userFns || {})) { _tp.user[name] = (...args) => plugin._userFns[name](_tp, ctx, args); }
    // tp.datacore.* — run live Plexus Datacore queries AT APPLY TIME so a template computes from real
    // data: <%* tp.set('n', await tp.datacore.count('@task and not $done')) %> or tp.datacore.names(q).
    // No-ops gracefully if the Datacore plugin isn't loaded.
    _tp.datacore = {
      query: async (q) => { try { const dc = (typeof window !== 'undefined') ? window.__plexusDatacore : null; return (dc && dc.query) ? (await dc.query(String(q || ''))) : []; } catch (e) { return []; } },
      count: async (q) => { try { const dc = (typeof window !== 'undefined') ? window.__plexusDatacore : null; return (dc && dc.count) ? (await dc.count(String(q || ''))) : 0; } catch (e) { return 0; } },
      names: async (q) => { try { const dc = (typeof window !== 'undefined') ? window.__plexusDatacore : null; if (!dc || !dc.query) return []; const ids = await dc.query(String(q || '')); const inst = dc._instance; return (ids || []).map((g) => { try { return inst._refName(g); } catch (e) { return g; } }); } catch (e) { return []; } },
      evaluate: (expr, ix) => { try { const dc = (typeof window !== 'undefined') ? window.__plexusDatacore : null; return (dc && dc.evaluate) ? dc.evaluate(String(expr || ''), ix || null) : null; } catch (e) { return null; } },
    };
    // TS-9: tp.brain.* — the note is born summarizing its own graph context (neighbours + its open tasks).
    _tp.brain = {
      neighbours: async () => {
        const rec = ctx.record; if (!rec) return []; const out = [];
        try { const back = await rec.getBackReferences(); for (const br of (back || [])) { const r = br && br.record; if (r && r.getName) out.push(r.getName()); } } catch (e) {}
        try { const items = await rec.getLineItems(); for (const li of (items || [])) for (const s of (li.segments || [])) { if (s && s.type === 'ref' && s.text && s.text.guid) { try { const t = await plugin.data.getRecord(s.text.guid); if (t && t.getName) out.push(t.getName()); } catch (e) {} } } } catch (e) {}
        return [...new Set(out.filter(Boolean))];
      },
      openTasks: async () => {
        const rec = ctx.record; if (!rec) return []; const out = [];
        try { const items = await rec.getLineItems(); for (const li of (items || [])) { let st = null; try { st = li.getTaskStatus && li.getTaskStatus(); } catch (e) {} if (st != null && st !== 'done') out.push((li.segments || []).map((s) => (typeof s.text === 'string' ? s.text : (s.text && s.text.title) || '')).join('').trim()); } } catch (e) {}
        return out.filter(Boolean);
      },
    };
    return _tp;
  }

  // ========================================================================
  // Modal: async prompt (single input)
  // ========================================================================

  asyncPrompt(label, dflt) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'tmpl-overlay';
      const modal = document.createElement('div');
      modal.className = 'tmpl-modal';
      modal.innerHTML = `<h2>${this.escape(label)}</h2>`;
      const wrap = document.createElement('div');
      wrap.className = 'tmpl-field';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = dflt || "";
      this.attachInputGuards(input);
      wrap.appendChild(input);
      modal.appendChild(wrap);
      const actions = document.createElement('div');
      actions.className = 'tmpl-actions';
      const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.className = 'tmpl-btn primary'; ok.textContent = 'OK';
      actions.appendChild(cancel); actions.appendChild(ok);
      modal.appendChild(actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
      let done = false;
      const close = (val) => { if (done) return; done = true; try { document.body.removeChild(overlay); } catch (e) {} resolve(val); };
      cancel.onclick = () => close("");
      ok.onclick = () => close(input.value);
      overlay.onclick = (e) => { if (e.target === overlay) close(""); };
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); close(""); }
      });
    });
  }

  // ========================================================================
  // GAP-5: (re)register one palette command per template. Prior handles removed first (refresh-safe).
  async _registerTemplateCommands() {
    try { for (const d of (this._tmplCmds || [])) { try { d(); } catch (e) {} } } catch (e) {}
    this._tmplCmds = [];
    try {
      const tcol = await this.getTemplatesCollection(); if (!tcol) return;
      const recs = await tcol.getAllRecords();
      const plugin = this;
      for (const t of (recs || []).slice(0, 40)) {
        let name = ''; try { name = this.tName(t); } catch (e) {}
        if (!name) continue;
        const cmd = this.ui.addCommandPaletteCommand({
          label: 'Templater: Apply "' + name + '"', icon: 'ti-files',
          onSelected: () => { try { plugin._state.applyTemplateByName(name, {}); } catch (e) { console.warn('[Templater] per-template cmd', e); } }
        });
        if (cmd && cmd.remove) this._tmplCmds.push(() => { try { cmd.remove(); } catch (e) {} });
      }
    } catch (e) {}
  }

  // GAP-3: multi-select suggester modal (checkbox list + OK/Cancel). Resolves an array of chosen
  // indices ([] on cancel/Esc/click-outside). Enter = OK.
  asyncMultiSuggester(title, labels) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div'); overlay.className = 'tmpl-overlay';
      const modal = document.createElement('div'); modal.className = 'tmpl-modal';
      modal.innerHTML = '<h2>' + this.escape(title) + '</h2>';
      const list = document.createElement('div'); list.style.cssText = 'max-height:46vh;overflow-y:auto;margin:4px 0 8px;';
      const boxes = [];
      (labels || []).forEach((l) => {
        const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:5px 2px;cursor:pointer;font-weight:400;';
        const cb = document.createElement('input'); cb.type = 'checkbox'; boxes.push(cb);
        row.appendChild(cb); row.appendChild(document.createTextNode(String(l)));
        list.appendChild(row);
      });
      modal.appendChild(list);
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';
      const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.className = 'tmpl-btn primary'; ok.textContent = 'OK';
      actions.appendChild(cancel); actions.appendChild(ok); modal.appendChild(actions);
      overlay.appendChild(modal); document.body.appendChild(overlay);
      const close = (v) => { try { document.body.removeChild(overlay); } catch (e) {} resolve(v); };
      cancel.onclick = () => close([]);
      ok.onclick = () => close(boxes.map((b, i) => b.checked ? i : -1).filter(i => i >= 0));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close([]); });
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close([]); if (e.key === 'Enter') ok.onclick(); });
      setTimeout(() => { const f = modal.querySelector('input'); if (f) f.focus(); }, 30);
    });
  }

  // Modal: async suggester (keyboard-navigable). Resolves the chosen index, or -1.
  // Uses a stable named keydown handler + explicit teardown in every close path,
  // and registers teardown on _state.disposers so an outer tear-down can't leak it.
  // ========================================================================

  asyncSuggester(title, labels) {
    return new Promise((resolve) => {
      let active = 0;
      let done = false;
      const overlay = document.createElement('div');
      overlay.className = 'tmpl-overlay';
      const modal = document.createElement('div');
      modal.className = 'tmpl-modal';
      modal.innerHTML = `<h2>${this.escape(title)}</h2>`;
      const ul = document.createElement('ul');
      ul.className = 'tmpl-sugg-list';

      const onKey = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, labels.length - 1); refresh(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); refresh(); }
        else if (e.key === 'Enter') { e.preventDefault(); close(active); }
        else if (e.key === 'Escape') { e.preventDefault(); close(-1); }
      };

      let teardownFn = null;
      const close = (idx) => {
        if (done) return;
        done = true;
        try { document.removeEventListener('keydown', onKey, true); } catch (e) {}
        try {
          if (teardownFn && this._state && this._state.disposers) {
            const at = this._state.disposers.indexOf(teardownFn);
            if (at >= 0) this._state.disposers.splice(at, 1);
          }
        } catch (e) {}
        try { document.body.removeChild(overlay); } catch (e) {}
        resolve(idx);
      };

      (labels || []).forEach((lab, i) => {
        const li = document.createElement('li');
        li.className = 'tmpl-sugg-item' + (i === 0 ? ' active' : '');
        li.textContent = lab;
        li.onclick = () => close(i);
        ul.appendChild(li);
      });
      const refresh = () => {
        Array.from(ul.children).forEach((c, i) => c.classList.toggle('active', i === active));
      };
      modal.appendChild(ul);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.onclick = (e) => { if (e.target === overlay) close(-1); };
      document.addEventListener('keydown', onKey, true);

      // Track teardown so an outer overlay tear-down (hot-reload onUnload) can't leak it.
      try {
        if (this._state && this._state.disposers) {
          teardownFn = () => close(-1);
          this._state.disposers.push(teardownFn);
        }
      } catch (e) {}
    });
  }

  // ========================================================================
  // Prompts modal (multi-field). Choice + record prompts render as a <select> dropdown.
  // ========================================================================

  openPromptsModal(template, prompts, onSubmit) {
    const tName = (template && template.__inlineName) ? template.__inlineName : this.tName(template);
    const overlay = document.createElement('div');
    overlay.className = 'tmpl-overlay';
    const modal = document.createElement('div');
    modal.className = 'tmpl-modal';
    modal.innerHTML = `<h2>Apply: ${this.escape(tName)}</h2><div class="tmpl-sub">${prompts.length} variable${prompts.length === 1 ? '' : 's'} to fill in</div>`;
    const fields = [];
    prompts.forEach(({ label, defaultValue, choices, multi, recordCollection }) => {
      const wrap = document.createElement('div');
      wrap.className = 'tmpl-field';
      const labelEl = document.createElement('label');
      labelEl.textContent = multi ? (label + " (⌘-click for multiple)") : label;
      wrap.appendChild(labelEl);
      let input;
      if (choices && choices.length) {
        // Choice / record property -> dropdown. Multi-record -> multi-select.
        input = document.createElement('select');
        if (multi) { input.multiple = true; input.size = Math.min(Math.max(choices.length + 1, 2), 7); }
        // TP-16: a record-relation prompt that isn't applicable -> "— none —" (single only);
        // and a "＋ New …" choice that creates the record on the fly (handled in finalize).
        const singular = recordCollection ? recordCollection.replace(/s$/, '') : '';
        if (recordCollection && !multi) {
          const none = document.createElement('option'); none.value = ''; none.textContent = '— none —';
          if (!defaultValue) none.selected = true;
          input.appendChild(none);
        }
        choices.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (!multi && opt === defaultValue) o.selected = true;
          input.appendChild(o);
        });
        if (recordCollection) {
          const nw = document.createElement('option'); nw.value = '__CREATE_NEW__'; nw.textContent = '＋ New ' + (singular || 'record') + '…';
          input.appendChild(nw);
        }
      } else {
        const low = label.toLowerCase();
        const isLong = low.includes('description') || low.includes('details') || low.includes('notes') || label.length > 30;
        input = document.createElement(isLong ? 'textarea' : 'input');
        if (!isLong) input.type = 'text';
        if (defaultValue) input.value = defaultValue;
        this.attachInputGuards(input);
      }
      wrap.appendChild(input);
      fields.push({ label, input, multi });
      modal.appendChild(wrap);
    });
    const actions = document.createElement('div');
    actions.className = 'tmpl-actions';
    const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
    const submit = document.createElement('button'); submit.className = 'tmpl-btn primary'; submit.textContent = 'Next →';
    actions.appendChild(cancel); actions.appendChild(submit);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => { try { fields[0] && fields[0].input.focus(); } catch (e) {} }, 0);
    let done = false;
    const close = () => { try { document.body.removeChild(overlay); } catch (e) {} };
    cancel.onclick = () => { if (done) return; done = true; close(); onSubmit(null); };
    overlay.onclick = (e) => { if (e.target === overlay) { if (done) return; done = true; close(); onSubmit(null); } };
    submit.onclick = () => {
      if (done) return; done = true;
      const values = {};
      for (const { label, input, multi } of fields) {
        values[label] = (multi && input.multiple) ? Array.from(input.selectedOptions).map(o => o.value) : input.value;
      }
      close();
      onSubmit(values);
    };
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    });
  }

  // ========================================================================
  // TP-19: Schema Form — one typed modal rendered from the collection schema
  // ========================================================================

  // The settable user fields of a collection, typed, from collection.getConfiguration().fields.
  // Excludes system + dynamic/formula + read-only + inactive + the plugin-internal columns.
  async _collectionFields(collection) {
    let cfg = null; try { cfg = collection.getConfiguration(); } catch (_) {}
    const fields = (cfg && cfg.fields) || [];
    const SYS = new Set(['title', 'icon', 'created_at', 'updated_at', 'banner', 'collection', 'parent_page']);
    const SKIP = new Set(['SC Relatedness', 'Scene', 'Canvas Text', 'Source Line']);
    const TYPES = new Set(['text', 'number', 'choice', 'datetime', 'record', 'url']);
    let colMap = null;
    const out = [];
    for (const f of fields) {
      if (!f || f.active === false || f.read_only === true) continue;
      if (SYS.has(f.id) || SKIP.has(f.label)) continue;
      if (!TYPES.has(f.type)) continue;                       // skip dynamic / file / image / user / banner
      let targetCollection = '';
      if (f.type === 'record' && f.filter_colguid) {
        if (!colMap) { colMap = {}; try { for (const c of (await this.data.getAllCollections())) { try { colMap[c.getGuid()] = c.getName(); } catch (_) {} } } catch (_) {} }
        targetCollection = colMap[f.filter_colguid] || '';
      }
      out.push({ id: f.id, label: f.label, type: f.type, many: !!f.many, choices: ((f.choices || []).map(c => c && c.label).filter(Boolean)), targetCollection });
    }
    return out;
  }

  // Pre-fill values pulled from the template's frontmatter: literal values, {{prompt:.. ?? DEF}}
  // defaults, and {{date}} -> today for datetime fields. Plus a __title from the Title: line literal.
  _schemaFormDefaults(content, fields) {
    const d = {}; const byLabel = new Set(fields.map(f => f.label));
    const text = String(content || ''); if (!/^---\s*\r?\n/.test(text)) return d;
    const lines = text.split('\n'); let end = -1;
    for (let i = 1; i < lines.length; i++) { if (/^---\s*$/.test(lines[i])) { end = i; break; } }
    if (end < 0) return d;
    for (let i = 1; i < end; i++) {
      const m = lines[i].match(/^\s*([^:]+?)\s*:\s*(.*)$/); if (!m) continue;
      const key = m[1].trim(); const val = m[2].trim();
      if (key === 'Title' || key === 'title') { const lit = val.replace(/\{\{[^}]*\}\}/g, '').replace(/<%[\s\S]*?%>/g, '').replace(/[·—–-]\s*$/, '').trim(); if (lit) d.__title = lit; continue; }
      if (!byLabel.has(key)) continue;
      if (/\{\{date(?::[^}]*)?\}\}/.test(val)) { const f = fields.find(x => x.label === key); d[key] = (f && f.type === 'datetime') ? this._isoOffset(new Date(), 0) : ''; continue; }
      const pm = val.match(/\{\{prompt[^:]*:[^}]*\?\?\s*([^}]*)\}\}/);
      if (pm) { const def = pm[1].trim(); if (def && !/\{\{/.test(def)) d[key] = def; continue; }
      if (val && !/\{\{|<%/.test(val)) d[key] = val;       // literal default
    }
    return d;
  }

  openSchemaForm(template, fields, defaults, recordOptions, onSubmit) {
    const overlay = document.createElement('div'); overlay.className = 'tmpl-overlay';
    const modal = document.createElement('div'); modal.className = 'tmpl-modal';
    const tName = this.tName(template);
    modal.innerHTML = '<h2>New ' + this.escape(tName) + '</h2><div class="tmpl-sub">' + fields.length + ' field' + (fields.length === 1 ? '' : 's') + ' from the collection schema</div>';
    const inputs = [];
    const titleWrap = document.createElement('div'); titleWrap.className = 'tmpl-field';
    const titleLbl = document.createElement('label'); titleLbl.textContent = 'Title'; titleWrap.appendChild(titleLbl);
    const titleIn = document.createElement('input'); titleIn.type = 'text'; if (defaults.__title) titleIn.value = defaults.__title; this.attachInputGuards(titleIn); titleWrap.appendChild(titleIn); modal.appendChild(titleWrap);
    for (const f of fields) {
      const wrap = document.createElement('div'); wrap.className = 'tmpl-field';
      const lbl = document.createElement('label'); lbl.textContent = f.label + (f.many ? ' (⌘-click for multiple)' : ''); wrap.appendChild(lbl);
      let input; const dv = defaults[f.label];
      if (f.type === 'choice' && f.choices.length) {
        input = document.createElement('select');
        if (f.many) { input.multiple = true; input.size = Math.min(Math.max(f.choices.length + 1, 2), 7); }
        else { const none = document.createElement('option'); none.value = ''; none.textContent = '— none —'; if (!dv) none.selected = true; input.appendChild(none); }
        f.choices.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; if (!f.many && o === dv) op.selected = true; input.appendChild(op); });
      } else if (f.type === 'record') {
        input = document.createElement('select'); if (f.many) { input.multiple = true; input.size = 5; }
        else { const none = document.createElement('option'); none.value = ''; none.textContent = '— none —'; none.selected = true; input.appendChild(none); }
        (recordOptions[f.label] || []).forEach(nm => { const op = document.createElement('option'); op.value = nm; op.textContent = nm; input.appendChild(op); });
        const nw = document.createElement('option'); nw.value = '__CREATE_NEW__'; nw.textContent = '＋ New ' + (f.targetCollection ? f.targetCollection.replace(/s$/, '') : 'record') + '…'; input.appendChild(nw);
      } else if (f.type === 'datetime') {
        input = document.createElement('input'); input.type = 'date'; if (dv) input.value = dv;
      } else if (f.type === 'number') {
        input = document.createElement('input'); input.type = 'number'; if (dv) input.value = dv; this.attachInputGuards(input);
      } else {
        const isLong = /description|notes|details|summary/i.test(f.label);
        input = document.createElement(isLong ? 'textarea' : 'input'); if (!isLong) input.type = (f.type === 'url' ? 'url' : 'text'); if (dv) input.value = dv; this.attachInputGuards(input);
      }
      wrap.appendChild(input); inputs.push({ field: f, input }); modal.appendChild(wrap);
    }
    const actions = document.createElement('div'); actions.className = 'tmpl-actions';
    // TP-20: AI-fill — a one-line brief populates every typed input via /llm.
    const aifill = document.createElement('button'); aifill.className = 'tmpl-btn'; aifill.textContent = '✨ AI fill';
    aifill.onclick = async () => {
      const brief = await this.asyncPrompt('Describe it in one line — AI fills the form', '');
      if (!brief || !brief.trim()) return;
      const desc = fields.map(f => '- "' + f.label + '" (' + f.type + (f.many ? ', multi' : '') + ')' + (f.choices && f.choices.length ? ' one of: ' + f.choices.join(' | ') : '')).join('\n');
      const prompt = 'Fill a form from a brief. Return ONLY a JSON object mapping field label to value — no prose, no code fence. Rules: a choice field MUST use one of its listed options verbatim (a multi field: comma-separated); a date field uses YYYY-MM-DD; a record field gives a likely record NAME; omit any field you cannot reasonably infer; include a "Title" key with a short scannable title.\nFields:\n' + desc + '\nBrief: ' + brief.trim();
      aifill.textContent = '… thinking'; aifill.disabled = true;
      let obj = null; try { const r = await this._llm(prompt, false); obj = (r && r.text) ? this._parseJsonLoose(r.text) : null; } catch (_) {}
      aifill.textContent = '✨ AI fill'; aifill.disabled = false;
      if (!obj || typeof obj !== 'object') { this.toast('Templater', 'AI fill unavailable — is the /llm proxy on :8787 running?'); return; }
      if (obj.Title != null && !titleIn.value) titleIn.value = String(obj.Title);
      for (const { field, input } of inputs) {
        const v = obj[field.label]; if (v == null || v === '') continue;
        try {
          if (input.tagName === 'SELECT') {
            if (field.many) { const want = String(v).split(/[,;]/).map(s => s.trim().toLowerCase()); Array.from(input.options).forEach(o => { o.selected = want.includes(o.value.toLowerCase()); }); }
            else { const m = Array.from(input.options).find(o => o.value.toLowerCase() === String(v).trim().toLowerCase()); if (m) input.value = m.value; }
          } else { input.value = String(v); }
        } catch (_) {}
      }
    };
    const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
    const submit = document.createElement('button'); submit.className = 'tmpl-btn primary'; submit.textContent = 'Create →';
    actions.appendChild(aifill); actions.appendChild(cancel); actions.appendChild(submit); modal.appendChild(actions);
    overlay.appendChild(modal); document.body.appendChild(overlay);
    setTimeout(() => { try { titleIn.focus(); } catch (_) {} }, 0);
    let done = false; const close = () => { try { document.body.removeChild(overlay); } catch (_) {} };
    cancel.onclick = () => { if (done) return; done = true; close(); onSubmit(null); };
    overlay.onclick = (e) => { if (e.target === overlay) { if (done) return; done = true; close(); onSubmit(null); } };
    submit.onclick = () => {
      if (done) return; done = true;
      const out = { __title: titleIn.value, values: {} };
      for (const { field, input } of inputs) { out.values[field.label] = (field.many && input.multiple) ? Array.from(input.selectedOptions).map(o => o.value).filter(Boolean) : input.value; }
      close(); onSubmit(out);
    };
    modal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); } if (e.key === 'Escape') { e.preventDefault(); cancel.click(); } });
  }

  async applySchemaForm(template, collection, content, vars) {
    const fields = await this._collectionFields(collection);
    if (!fields.length) { this.toast('Templater', 'No settable fields on "' + (collection.getName ? collection.getName() : 'collection') + '".'); return; }
    const recordOptions = {};
    for (const f of fields) {
      if (f.type === 'record' && f.targetCollection) {
        try { const c = await this.collectionByName(f.targetCollection); if (c) { const recs = await c.getAllRecords(); recordOptions[f.label] = recs.map(r => { try { return r.getName(); } catch (_) { return null; } }).filter(Boolean).sort((a, b) => a.localeCompare(b)); } } catch (_) {}
      }
    }
    const defaults = this._schemaFormDefaults(content, fields);
    this.openSchemaForm(template, fields, defaults, recordOptions, async (res) => {
      if (res == null) return;
      // Resolve "＋ New" record picks: create the record, substitute its name.
      for (const f of fields) {
        if (f.type !== 'record') continue;
        const mk = async (v) => {
          if (v !== '__CREATE_NEW__') return v;
          const nm = await this.asyncPrompt('New ' + (f.targetCollection ? f.targetCollection.replace(/s$/, '') : 'record') + ' name', '');
          if (!nm || !nm.trim()) return '';
          try { const c = await this.collectionByName(f.targetCollection); if (c) { const g = c.createRecord(nm.trim()); if (g) await this.pollRecord(g); } } catch (_) {}
          return nm.trim();
        };
        const cur = res.values[f.label];
        if (Array.isArray(cur)) { const o = []; for (const x of cur) { const r = await mk(x); if (r) o.push(r); } res.values[f.label] = o; }
        else res.values[f.label] = await mk(cur);
      }
      // Render ONCE with the form values as prompt answers — resolves a computed Title
      // (e.g. <%* tp.user.eventId() %>) and the body together.
      let rendered = '';
      try { rendered = await this.renderTemplate(content, { record: null, collection, prompts: Object.assign({}, res.values), vars: (vars.defaults || {}), empty: (vars.empty || 'skip'), templateName: this.tName(template) }); } catch (e) { console.warn('[Templater] schema-form render', e); }
      const parsedSF = this.parseFrontmatter(rendered);
      const fmT = parsedSF.frontmatter && (parsedSF.frontmatter.Title || parsedSF.frontmatter.title);
      const renderedTitle = (fmT == null ? '' : String(fmT)).replace(/\s{2,}/g, ' ').replace(/\s*[·—–-]\s*$/, '').trim();
      const userTitle = (res.__title || '').trim();
      const title = (userTitle && userTitle !== (defaults.__title || '').trim()) ? userTitle : (renderedTitle || userTitle || this.tName(template));
      let guid; try { guid = collection.createRecord(title); } catch (e) { this.toast('Apply failed', String(e && e.message || e)); return; }
      if (!guid) { this.toast('Apply failed', 'createRecord returned no GUID'); return; }
      const rec = await this.pollRecord(guid);
      if (!rec) { this.toast('Apply failed', 'could not fetch the new record'); return; }
      // Set the typed properties from the form.
      for (const f of fields) {
        const v = res.values[f.label];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        try {
          const p = rec.prop && rec.prop(f.label); if (!p) continue;
          if (f.type === 'record') {
            const names = Array.isArray(v) ? v : [v]; const guids = [];
            for (const nm of names) { const g = await this.resolveRefGuid(String(nm).trim()); if (g) guids.push(g); }
            if (guids.length && p.set) p.set(guids.length === 1 ? guids[0] : guids);
          } else {
            this.applyPropertyValue(p, f.label, Array.isArray(v) ? v.join(', ') : v);
          }
        } catch (_) {}
      }
      let finalTitle = title;
      try { const ruled = await this.applyAutoTitleRule(rec, collection); if (ruled) finalTitle = ruled; }
      catch (e) { console.warn('[Templater] schema-form Auto-title rule failed', e); }
      // Write the BODY (already rendered above; frontmatter + directive markers stripped).
      const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(parsedSF.body || '');
      try {
        const body = (parsedSF.body || '').replace(/<!--TMPL-TASK:[^>]*?-->/g, '').replace(/<!--PLEXUS-[^>]*?-->/g, '');
        if (body.trim()) await this.writeBody(rec, body, { flat: vars && vars.nest === 'flat' });
      } catch (e) { console.warn('[Templater] schema-form body write failed', e); }
      if (wantPromote) this._promoteAfterApply(rec);
      try { const p = template.prop && template.prop(F_LASTUSED); if (p && p.setFromDate) p.setFromDate(new Date()); } catch (_) {}
      this.writeAuditRow(template, rec.guid, collection, finalTitle, '(schema form)').catch(() => {});
      this.toast('Applied: ' + this.tName(template), 'Created "' + finalTitle + '" in ' + (collection.getName ? collection.getName() : ''));
      try { const np = this.ui.getActivePanel && this.ui.getActivePanel(); if (np && np.navigateTo) await np.navigateTo({ itemGuid: guid, highlight: true }); } catch (_) {}
    });
  }

  // ========================================================================
  // Template Editor (v2.32) — edit a template's frontmatter + settings via a FORM, so the cramped
  // Template Content text property never has to be hand-edited. The BODY stays edited natively in
  // the outliner; this dialog only rewrites the leading `---` frontmatter block + the settings props.
  // ========================================================================

  async editTemplateCommand() {
    let tmpl = null;
    try {
      const panel = this.ui.getActivePanel && this.ui.getActivePanel();
      const ar = panel && panel.getActiveRecord && panel.getActiveRecord();
      const ac = panel && panel.getActiveCollection && panel.getActiveCollection();
      if (ar && ac && ac.getName && ac.getName() === TEMPLATES_COLL) tmpl = ar;
    } catch (e) {}
    if (tmpl) return this.openTemplateEditor(tmpl);
    const recs = (await this.loadTemplatesSorted()) || [];
    const names = ['＋ New template…'].concat(recs.map(r => this.tName(r)));
    const idx = await this.asyncSuggester('Edit a template (or create one)', names);
    if (idx == null || idx < 0) return;
    if (idx === 0) return this.newTemplateCommand();
    if (recs[idx - 1]) this.openTemplateEditor(recs[idx - 1]);
  }

  // Create a brand-new template record and open the editor on it.
  async newTemplateCommand() {
    const name = await this.asyncPrompt('New template name', '');
    if (!name || !name.trim()) return;
    const coll = await this.collectionByName(TEMPLATES_COLL);
    if (!coll) { this.toast('Templater', '"' + TEMPLATES_COLL + '" collection not found.'); return; }
    let guid; try { guid = coll.createRecord(name.trim()); } catch (e) { this.toast('Templater', 'Could not create the template.'); return; }
    if (!guid) { this.toast('Templater', 'Could not create the template.'); return; }
    const rec = await this.pollRecord(guid);
    if (!rec) { this.toast('Templater', 'Created, but could not load it — open it from the Templates collection.'); return; }
    try { const p = rec.prop(F_NAME); if (p && p.set) p.set(name.trim()); } catch (e) {}
    this.openTemplateEditor(rec);
  }

  // split a Template Content string into the leading ---…--- block (raw) + the body remainder.
  _splitFrontmatter(text) {
    text = String(text || '');
    const m = text.match(/^(---\s*\r?\n[\s\S]*?\r?\n---)\s*\r?\n?([\s\S]*)$/);
    if (m) return { fmBlock: m[1], body: m[2] };
    return { fmBlock: '', body: text };
  }
  // raw Key: value rows out of a frontmatter block (values kept verbatim — NOT marker-processed).
  _parseFmRaw(fmBlock) {
    const out = [];
    for (const ln of String(fmBlock || '').split('\n')) {
      if (/^---\s*$/.test(ln) || !ln.trim()) continue;
      const m = ln.match(/^\s*([^:]+?)\s*:\s*([\s\S]*)$/);
      if (m) out.push({ key: m[1].trim(), value: m[2] });
    }
    return out;
  }
  // a raw frontmatter value -> {mode, value}. A single recognized token gets a friendly mode; anything
  // else (composite "{{a}} · {{b}}", literals) becomes 'static' (verbatim) so editing is always lossless.
  _parseFmValue(raw) {
    const v = String(raw == null ? '' : raw).trim();
    // ONLY a value that is exactly ONE clean {{…}} token gets a typed mode; a composite ("{{a}} · {{b}}")
    // or anything with trailing text falls through to 'static' (verbatim, lossless, never mis-parsed).
    const single = (v.match(/\{\{/g) || []).length === 1 && /^\{\{/.test(v) && v.indexOf('}}') === v.length - 2;
    if (single) {
      let m;
      if ((m = v.match(/^\{\{prompt\.choice:\s*([\s\S]+?)\s*\}\}$/))) return { mode: 'choice', value: m[1].trim() };
      if ((m = v.match(/^\{\{prompt\.records:\s*([\s\S]+?)\s*\}\}$/))) return { mode: 'records', value: m[1].trim() };
      if ((m = v.match(/^\{\{prompt\.record:\s*([\s\S]+?)\s*\}\}$/))) return { mode: 'record', value: m[1].trim() };
      if ((m = v.match(/^\{\{prompt:\s*([\s\S]+?)\s*\}\}$/))) return { mode: 'prompt', value: m[1].trim() };
      if ((m = v.match(/^\{\{date(?::\s*([\s\S]*?))?\s*\}\}$/))) return { mode: 'date', value: (m[1] || '').trim() };
    }
    return { mode: 'static', value: v };
  }
  _serializeFmRow(key, mode, value) {
    const v = String(value == null ? '' : value).trim();
    switch (mode) {
      case 'prompt':  return key + ': {{prompt:' + v + '}}';
      case 'choice':  return key + ': {{prompt.choice:' + v + '}}';
      case 'record':  return key + ': {{prompt.record:' + v + '}}';
      case 'records': return key + ': {{prompt.records:' + v + '}}';
      case 'date':    return key + ': ' + (v ? ('{{date:' + v + '}}') : '{{date}}');
      default:        return key + ': ' + (value == null ? '' : String(value));
    }
  }
  // a sensible default row when the user adds a schema field: choice→its options, record→target coll, etc.
  _defaultRowForField(f) {
    if (!f) return { key: '', mode: 'prompt', value: '' };
    if (f.type === 'choice' && f.choices && f.choices.length) return { key: f.label, mode: 'choice', value: f.label + ' :: ' + f.choices.join(', ') };
    if (f.type === 'record') return { key: f.label, mode: f.many ? 'records' : 'record', value: f.label + ' :: ' + (f.targetCollection || '') };
    if (f.type === 'datetime') return { key: f.label, mode: 'date', value: '' };
    return { key: f.label, mode: 'prompt', value: f.label };
  }

  async openTemplateEditor(template) {
    const MODES = [['prompt', 'Prompt'], ['choice', 'Choice'], ['date', 'Date'], ['record', 'Record (one)'], ['records', 'Records (many)'], ['static', 'Static text']];
    const PLACEHOLD = { prompt: 'prompt label (e.g. Title  or  Source ?? )', choice: 'Label :: opt1, opt2, opt3', record: 'Label :: TargetCollection', records: 'Label :: TargetCollection', date: 'format e.g. YYYY-MM-DD (blank = today)', static: 'literal value' };
    // current state
    const content = this.tContent(template) || '';
    const split = this._splitFrontmatter(content);
    const startRows = this._parseFmRaw(split.fmBlock).map(r => { const pv = this._parseFmValue(r.value); return { key: r.key, mode: pv.mode, value: pv.value }; });
    let targetColl = this._templatePinnedCollection(template) || '';
    if (targetColl === TEMPLATES_COLL) targetColl = '';
    const titlePattern = this.titlePatternOf(template);
    let autoTitle = 'Off'; try { const p = template.prop(F_AUTOTITLE); const cl = p && p.choiceLabel && p.choiceLabel(); if (cl) autoTitle = cl; } catch (e) {}
    const triggerOn = this.tField(template, F_TRIGGERON) || '';
    const autoApply = /record\.created\s*:/i.test(triggerOn);
    let allColls = []; try { allColls = (await this.data.getAllCollections()).map(c => { try { return c.getName(); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => a.localeCompare(b)); } catch (e) {}
    let schemaFields = []; try { const c = targetColl && await this.collectionByName(targetColl); if (c) schemaFields = await this._collectionFields(c); } catch (e) {}
    // body state — MUST match assembleTemplateSource's precedence: the Template Content TEXT body
    // wins; the native outline is used only when the text body is empty. (This was INVERTED: a
    // template with both showed only the stale native fragment in the editor — the real template
    // body was invisible/uneditable — and saving in that state rewrote Template Content to
    // frontmatter-only, DESTROYING the template body. Found on the Daily Note template 2026-07-01.)
    let nativeBody = ''; try { nativeBody = await this.serializeBody(template); } catch (e) {}
    const hasNativeBody = !!(nativeBody && nativeBody.trim());
    const hasTextBody = !!(split.body && split.body.trim());
    const loadedBody = hasTextBody ? split.body : nativeBody;
    const startStorage = hasTextBody ? 'text' : 'native';
    const rawVars = this.tField(template, F_VARS) || '';
    // autocomplete context (live — re-read schemaFields/allColls which change on target switch)
    const getFields = () => schemaFields.map(f => f.label);
    const getColls = () => allColls.slice();

    const overlay = document.createElement('div'); overlay.className = 'tmpl-overlay';
    const modal = document.createElement('div'); modal.className = 'tmpl-modal';
    modal.innerHTML = '<h2>Edit template: ' + this.escape(this.tName(template)) + '</h2><div class="tmpl-sub">Full control — properties, body, settings, Variables JSON. Type <code>{{</code> for tokens, <code>dc: @</code> for collections. Body can also be edited in the normal outliner.</div>';
    // target collection
    const tcWrap = document.createElement('div'); tcWrap.className = 'tmpl-field';
    const tcLbl = document.createElement('label'); tcLbl.textContent = 'Fills a new record in'; tcWrap.appendChild(tcLbl);
    const tcSel = document.createElement('select');
    if (!allColls.includes(targetColl) && targetColl) allColls = [targetColl].concat(allColls);
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '— none (ask which collection on apply) —'; if (!targetColl) noneOpt.selected = true; tcSel.appendChild(noneOpt);
    allColls.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; if (n === targetColl) o.selected = true; tcSel.appendChild(o); });
    tcWrap.appendChild(tcSel); modal.appendChild(tcWrap);
    // properties section
    const propsLbl = document.createElement('label'); propsLbl.className = 'tmpl-field'; propsLbl.textContent = 'Properties set on create'; propsLbl.style.fontWeight = '600'; modal.appendChild(propsLbl);
    const rowsHost = document.createElement('div'); modal.appendChild(rowsHost);
    const rowCtls = [];
    const propOptions = () => { const set = []; const seen = new Set(); const push = (n) => { if (n && !seen.has(n)) { seen.add(n); set.push(n); } }; push('Title'); schemaFields.forEach(f => push(f.label)); rowCtls.forEach(rc => push(rc.propSel.value)); startRows.forEach(r => push(r.key)); return set; };
    const fillPropSel = (sel, current) => { sel.innerHTML = ''; const opts = propOptions(); if (current && !opts.includes(current)) opts.unshift(current); opts.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; if (n === current) o.selected = true; sel.appendChild(o); }); };
    const addRow = (row) => {
      row = row || { key: '', mode: 'prompt', value: '' };
      const r = document.createElement('div'); r.style.display = 'flex'; r.style.gap = '6px'; r.style.marginBottom = '6px'; r.style.alignItems = 'center';
      const propSel = document.createElement('select'); propSel.style.flex = '0 0 28%';
      const modeSel = document.createElement('select'); modeSel.style.flex = '0 0 22%'; MODES.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === row.mode) o.selected = true; modeSel.appendChild(o); });
      const valIn = document.createElement('input'); valIn.type = 'text'; valIn.style.flex = '1 1 auto'; valIn.value = row.value || ''; valIn.placeholder = PLACEHOLD[row.mode] || ''; this.attachInputGuards(valIn); this._attachAutocomplete(valIn, getFields, getColls);
      modeSel.onchange = () => { valIn.placeholder = PLACEHOLD[modeSel.value] || ''; };
      const del = document.createElement('button'); del.className = 'tmpl-btn'; del.textContent = '×'; del.title = 'Remove'; del.style.flex = '0 0 auto';
      del.onclick = () => { const i = rowCtls.findIndex(x => x.propSel === propSel); if (i >= 0) rowCtls.splice(i, 1); try { rowsHost.removeChild(r); } catch (e) {} };
      r.appendChild(propSel); r.appendChild(modeSel); r.appendChild(valIn); r.appendChild(del);
      rowsHost.appendChild(r); rowCtls.push({ propSel, modeSel, valIn });
      fillPropSel(propSel, row.key);
    };
    startRows.forEach(addRow);
    const addBtn = document.createElement('button'); addBtn.className = 'tmpl-btn'; addBtn.textContent = '+ add property'; addBtn.style.marginBottom = '10px';
    addBtn.onclick = () => { const used = new Set(rowCtls.map(rc => rc.propSel.value)); const f = schemaFields.find(x => !used.has(x.label)); addRow(this._defaultRowForField(f)); };
    modal.appendChild(addBtn);
    // re-fetch schema + rebuild prop dropdowns + sync Variables JSON collection when target changes
    tcSel.onchange = async () => { try { const c = tcSel.value && await this.collectionByName(tcSel.value); schemaFields = c ? await this._collectionFields(c) : []; } catch (e) { schemaFields = []; } rowCtls.forEach(rc => fillPropSel(rc.propSel, rc.propSel.value)); try { autoChk.disabled = !tcSel.value; if (!tcSel.value) autoChk.checked = false; } catch (e) {} try { const vo = JSON.parse(varsTa.value || '{}'); if (tcSel.value) vo.collection = tcSel.value; else delete vo.collection; varsTa.value = JSON.stringify(vo, null, 2); } catch (e) {} };
    // body (full control) — markdown textarea + a Native/Text storage toggle. Native = editable here AND in the doc.
    const bodyWrap = document.createElement('div'); bodyWrap.className = 'tmpl-field';
    const bodyLbl = document.createElement('label'); bodyLbl.textContent = "Body (the new record's outline)"; bodyWrap.appendChild(bodyLbl);
    const bodyTa = document.createElement('textarea'); bodyTa.className = 'tmpl-body'; bodyTa.value = loadedBody; bodyTa.rows = 8; this.attachInputGuards(bodyTa); this._attachAutocomplete(bodyTa, getFields, getColls); bodyWrap.appendChild(bodyTa);
    // 10X-#6: one-click starters for the power tokens (Datacore blocks, live attrs, conditionals,
    // task/relate directives) — inserted at the caret; the autocomplete refines from there.
    const insSnip = (txt) => { const s = bodyTa.selectionStart || 0, e = bodyTa.selectionEnd || 0; bodyTa.value = bodyTa.value.slice(0, s) + txt + bodyTa.value.slice(e); bodyTa.focus(); bodyTa.selectionStart = bodyTa.selectionEnd = s + txt.length; };
    const snipRow = document.createElement('div'); snipRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center;';
    const snipLbl = document.createElement('span'); snipLbl.textContent = 'Insert:'; snipLbl.style.cssText = 'font-size:11px;color:var(--color-text-600,#9aa0aa);'; snipRow.appendChild(snipLbl);
    const SNIPS = [
      ['dc table', 'dc: @"Collection" and Field = "Value" | table: $name, Field | sort Field desc'],
      ['dc list', 'dc: @Captures and `Captured At` >= date(today) | list'],
      ['{{attr}}', '{{attr:Key:avg7}}'],
      ['{{if}}', '{{if:attr:Recovery>66}}\n## Deep work\n{{else}}\n## Admin\n{{endif}}'],
      ['{{task}}', '{{task: Title | status=To Do | priority=High | due=+3 days}}'],
      ['{{relate+}}', '{{relate:Project=Name :: create=Projects :: apply=Project Starter}}'],
    ];
    for (const [lbl, txt] of SNIPS) { const b = document.createElement('button'); b.className = 'tmpl-btn'; b.textContent = lbl; b.title = txt; b.onclick = (ev) => { ev.preventDefault(); insSnip(txt); }; snipRow.appendChild(b); }
    bodyWrap.appendChild(snipRow);
    const stoWrap = document.createElement('div'); stoWrap.className = 'tmpl-storage'; stoWrap.appendChild(document.createTextNode('Store body as: '));
    const mkRadio = (val, label) => { const id = 'tmpl-sto-' + val; const rb = document.createElement('input'); rb.type = 'radio'; rb.name = 'tmpl-body-storage'; rb.value = val; rb.id = id; if (val === startStorage) rb.checked = true; const lb = document.createElement('label'); lb.setAttribute('for', id); lb.textContent = ' ' + label + '   '; lb.style.display = 'inline'; lb.style.fontWeight = '400'; stoWrap.appendChild(rb); stoWrap.appendChild(lb); };
    mkRadio('native', 'Native outline (editable in the doc)'); mkRadio('text', 'Text (in Template Content)');
    bodyWrap.appendChild(stoWrap);
    // both stores populated → tell the user which one is live and that saving as Text heals it
    if (hasTextBody && hasNativeBody) {
      const warn = document.createElement('div');
      warn.style.cssText = 'margin-top:6px;font-size:12px;color:var(--color-text-600,#9aa0aa);border:1px solid var(--cards-border-color,#3a3f4b);border-radius:8px;padding:6px 9px;';
      warn.textContent = '⚠ This record also has a native outline body (' + nativeBody.split('\n').length + ' lines) which apply IGNORES while Template Content has a body. Saving with "Text" storage removes that stale outline.';
      bodyWrap.appendChild(warn);
    }
    modal.appendChild(bodyWrap);
    const getStorage = () => { const r = stoWrap.querySelector('input[name="tmpl-body-storage"]:checked'); return r ? r.value : startStorage; };
    // settings
    const mkText = (labelText, val) => { const w = document.createElement('div'); w.className = 'tmpl-field'; const l = document.createElement('label'); l.textContent = labelText; w.appendChild(l); const i = document.createElement('input'); i.type = 'text'; i.value = val || ''; this.attachInputGuards(i); w.appendChild(i); modal.appendChild(w); return i; };
    const autoWrap = document.createElement('div'); autoWrap.className = 'tmpl-check';
    const autoChk = document.createElement('input'); autoChk.type = 'checkbox'; autoChk.checked = autoApply; autoChk.id = 'tmpl-autoapply'; autoChk.disabled = !targetColl;
    const autoLbl = document.createElement('label'); autoLbl.setAttribute('for', 'tmpl-autoapply'); autoLbl.textContent = 'Auto-apply — scaffold this template automatically whenever a new record is created in the target collection (no prompts). Needs a target collection above.';
    autoWrap.appendChild(autoChk); autoWrap.appendChild(autoLbl); modal.appendChild(autoWrap);
    // 10X-#1: surface the TP-19 typed schema form (was a hand-edited Variables JSON {"form":true} opt-in)
    const formWrap = document.createElement('div'); formWrap.className = 'tmpl-check';
    const formChk = document.createElement('input'); formChk.type = 'checkbox'; formChk.id = 'tmpl-schemaform';
    try { formChk.checked = !!JSON.parse(rawVars || '{}').form; } catch (e) { formChk.checked = false; }
    const formLbl = document.createElement('label'); formLbl.setAttribute('for', 'tmpl-schemaform'); formLbl.textContent = 'Typed schema FORM on apply — ONE form built from the collection schema (date pickers / choice dropdowns / record pickers / number inputs + AI-fill) instead of chained prompts. Needs a target collection.';
    formWrap.appendChild(formChk); formWrap.appendChild(formLbl); modal.appendChild(formWrap);
    const atWrap = document.createElement('div'); atWrap.className = 'tmpl-field'; const atL = document.createElement('label'); atL.textContent = 'Auto Title'; atWrap.appendChild(atL);
    const atSel = document.createElement('select'); ['Off', 'On'].forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === autoTitle) op.selected = true; atSel.appendChild(op); }); atWrap.appendChild(atSel); modal.appendChild(atWrap);
    const tpIn = mkText('Title Pattern (optional, e.g. {{firstline}} or {{Type}} · {{Lead}})', titlePattern);
    this._attachAutocomplete(tpIn, getFields, getColls);
    // advanced — raw Variables (JSON), editable
    const adv = document.createElement('details'); adv.className = 'tmpl-details';
    const advS = document.createElement('summary'); advS.textContent = 'Advanced — Variables (JSON)'; adv.appendChild(advS);
    const varsTa = document.createElement('textarea'); varsTa.className = 'tmpl-body'; varsTa.rows = 4; varsTa.spellcheck = false;
    try { varsTa.value = rawVars && rawVars.trim() ? JSON.stringify(JSON.parse(rawVars), null, 2) : (rawVars || ''); } catch (e) { varsTa.value = rawVars || ''; }
    this.attachInputGuards(varsTa);
    const advHint = document.createElement('div'); advHint.className = 'tmpl-sub'; advHint.innerHTML = 'Keys: <code>collection</code>, <code>nest:"flat"</code>, <code>empty:"skip"|"keep"</code>, <code>preview:true</code>, <code>defaults:{Name:value}</code> (→ <code>{{var.Name}}</code>).';
    adv.appendChild(varsTa); adv.appendChild(advHint); modal.appendChild(adv);
    // language reference
    const ref = document.createElement('details'); ref.className = 'tmpl-details';
    const refS = document.createElement('summary'); refS.textContent = 'Template language reference'; ref.appendChild(refS);
    const refList = document.createElement('div'); refList.className = 'tmpl-ref';
    this._templateTokens().forEach(t => { const row = document.createElement('div'); row.className = 'tmpl-ref-row'; row.innerHTML = '<code>' + this.escape(t.insert) + '</code> <span>' + this.escape(t.hint || '') + '</span>'; refList.appendChild(row); });
    ref.appendChild(refList); modal.appendChild(ref);
    // actions
    const actions = document.createElement('div'); actions.className = 'tmpl-actions';
    const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
    const save = document.createElement('button'); save.className = 'tmpl-btn primary'; save.textContent = 'Save';
    actions.appendChild(cancel); actions.appendChild(save); modal.appendChild(actions);
    overlay.appendChild(modal); document.body.appendChild(overlay);
    let done = false; const close = () => { try { document.body.removeChild(overlay); } catch (e) {} };
    cancel.onclick = () => { if (done) return; done = true; close(); };
    overlay.onclick = (e) => { if (e.target === overlay) { if (done) return; done = true; close(); } };
    modal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); } if (e.key === 'Escape') { e.preventDefault(); cancel.click(); } });
    save.onclick = async () => {
      if (done) return;
      // validate Variables JSON BEFORE committing — abort (keep modal open) on bad JSON
      let vo = {};
      const vraw = (varsTa.value || '').trim();
      if (vraw) { try { vo = JSON.parse(vraw); if (!vo || typeof vo !== 'object') throw new Error('not an object'); } catch (e) { this.toast('Templater', 'Variables (JSON) is not valid — fix or clear it.'); return; } }
      done = true;
      try {
        const tcoll = tcSel.value || targetColl;
        // frontmatter block from the rows
        const fmLines = ['---'];
        for (const rc of rowCtls) { const key = (rc.propSel.value || '').trim(); if (!key) continue; fmLines.push(this._serializeFmRow(key, rc.modeSel.value, rc.valIn.value)); }
        fmLines.push('---');
        const fmBlock = fmLines.length > 2 ? fmLines.join('\n') : '';
        // body — by storage mode; only rebuild native lines when the body actually changed
        const storage = getStorage();
        const bodyVal = bodyTa.value || '';
        const bodyChanged = (bodyVal !== loadedBody) || (storage !== startStorage);
        if (storage === 'text') {
          const newContent = fmBlock ? (bodyVal.trim() ? (fmBlock + '\n' + bodyVal) : fmBlock) : bodyVal;
          try { const p = template.prop(F_CONTENT); if (p && p.set) p.set(newContent); } catch (e) { console.warn('[Templater] editor: content set', e); }
          if (hasNativeBody) { try { await this._clearBody(template); } catch (e) { console.warn('[Templater] clearBody', e); } } // body now lives in text — drop native dup
        } else { // native
          try { const p = template.prop(F_CONTENT); if (p && p.set) p.set(fmBlock); } catch (e) { console.warn('[Templater] editor: content set', e); }
          if (bodyChanged) { try { await this._clearBody(template); } catch (e) { console.warn('[Templater] clearBody', e); } if (bodyVal.trim()) { try { await this.writeBody(template, bodyVal, { flat: vo && vo.nest === 'flat' }); } catch (e) { console.warn('[Templater] writeBody', e); } } }
        }
        // settings
        try { const p = template.prop(F_TITLEPATTERN); if (p && p.set) p.set((tpIn.value || '').trim()); } catch (e) {}
        try { const p = template.prop(F_AUTOTITLE); if (p && p.setChoice) p.setChoice(atSel.value); } catch (e) {}
        try { const p = template.prop(F_TRIGGERON); if (p && p.set) p.set(autoChk.checked && tcoll ? ('record.created:' + tcoll) : ''); } catch (e) {}
        // Variables JSON (validated above) — force collection = the dropdown, then write verbatim
        try { if (formChk.checked) vo.form = true; else delete vo.form; } catch (e) {}   // 10X-#1
        try { if (tcoll) vo.collection = tcoll; else delete vo.collection; const vp = template.prop(F_VARS); if (vp && vp.set) vp.set(JSON.stringify(vo)); } catch (e) {}
        close();
        this.toast('Templater', 'Saved "' + this.tName(template) + '"');
      } catch (e) { console.warn('[Templater] editor save failed', e); this.toast('Templater', 'Save failed — see console.'); }
    };
  }

  // Delete a record's body line items, deepest-first (the SDK rejects deleting an item that still has children).
  async _clearBody(record) {
    let items = []; try { items = await record.getLineItems(false); } catch (e) { return; }
    if (!items || !items.length) return;
    const recGuid = record.guid || (record.getGuid && record.getGuid());
    const byGuid = new Map(items.map(it => [it.guid, it]));
    const depth = (it) => { let d = 0, p = it.parent_guid, n = 0; while (p && p !== recGuid && byGuid.has(p) && n++ < 64) { d++; p = byGuid.get(p).parent_guid; } return d; };
    items.sort((a, b) => depth(b) - depth(a));
    for (const it of items) { try { await it.delete(); } catch (e) {} }
  }

  // The full template-language vocabulary — drives the editor autocomplete AND the in-dialog reference.
  _templateTokens() {
    return [
      { key: 'prompt:', insert: '{{prompt:Label}}', caret: 'Label', hint: 'ask for text (?? default optional)' },
      { key: 'prompt.choice:', insert: '{{prompt.choice:Label :: A, B, C}}', caret: 'Label', hint: 'pick one of a list' },
      { key: 'prompt.record:', insert: '{{prompt.record:Label :: Collection}}', caret: 'Label', hint: 'pick one record' },
      { key: 'prompt.records:', insert: '{{prompt.records:Label :: Collection}}', caret: 'Label', hint: 'pick records (multi)' },
      { key: 'date', insert: '{{date}}', hint: 'today (date segment)' },
      { key: 'date:', insert: '{{date:YYYY-MM-DD}}', caret: 'YYYY-MM-DD', hint: 'formatted / natural / +7 / +7@Start Date' },
      { key: 'record.', insert: '{{record.Property}}', caret: 'Property', hint: 'value from the target record' },
      { key: 'var.', insert: '{{var.Name}}', caret: 'Name', hint: 'from Variables JSON defaults' },
      { key: 'attr:', insert: '{{attr:Key}}', caret: 'Key', hint: 'live Attributes value (:avg/:avg7/:trend/:min/:max)' },
      { key: 'ref:', insert: '{{ref:Name}}', caret: 'Name', hint: 'reference a record (segment)' },
      { key: 'tag:', insert: '{{tag:tag}}', caret: 'tag', hint: 'hashtag segment' },
      { key: 'ai::', insert: '{{ai:: instruction}}', caret: 'instruction', hint: 'inline AI text (needs /llm)' },
      { key: 'task:', insert: '{{task:Title | due=+3 days}}', caret: 'Title', hint: 'spawn a linked Rich Task' },
      { key: 'cursor', insert: '{{cursor}}', hint: 'place the cursor here after apply' },
      { key: 'banner:', insert: '{{banner:https://}}', caret: 'https://', hint: 'set the record banner from a URL' },
      { key: 'relate:', insert: '{{relate:Field=Name}}', caret: 'Field', hint: 'set a relation property' },
      { key: 'include:', insert: '{{include:Template}}', caret: 'Template', hint: 'inline another template' },
      { key: 'schedule:', insert: '{{schedule:date}}', caret: 'date', hint: 'datetime segment (alias of date)' },
      { key: 'firstline', insert: '{{firstline}}', hint: 'first body line (Title Pattern)' },
      { key: 'body', insert: '{{body}}', hint: 'whole body text (Title Pattern)' },
      { key: 'summary', insert: '{{summary}}', hint: 'AI summary (Title Pattern)' },
    ];
  }

  // Lightweight autocomplete on an <input>/<textarea>: {{ token menu · {{record. fields · dc: @ collections.
  _attachAutocomplete(el, getFields, getColls) {
    const tokens = this._templateTokens();
    let menu = null, items = [], active = -1;
    const esc = (s) => this.escape(String(s == null ? '' : s));
    const closeMenu = () => { if (menu) { try { menu.remove(); } catch (e) {} } menu = null; items = []; active = -1; el._acCtx = null; };
    const render = () => {
      if (!menu) { menu = document.createElement('div'); menu.className = 'tmpl-ac'; document.body.appendChild(menu); }
      menu.innerHTML = '';
      items.forEach((it, i) => { const d = document.createElement('div'); d.className = 'tmpl-ac-item' + (i === active ? ' active' : ''); d.innerHTML = '<span class="tmpl-ac-k">' + esc(it.label) + '</span>' + (it.hint ? '<span class="tmpl-ac-h">' + esc(it.hint) + '</span>' : ''); d.onmousedown = (ev) => { ev.preventDefault(); accept(i); }; menu.appendChild(d); });
      const r = el.getBoundingClientRect(); menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 2) + 'px'; menu.style.minWidth = Math.max(240, r.width) + 'px';
    };
    const ctx = () => {
      const before = el.value.slice(0, el.selectionStart || 0);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      let m;
      if (/^\s*dc(\.js)?:/i.test(line) && (m = before.match(/@"?([\w ]*)$/))) { const part = m[1] || ''; const cs = (getColls && getColls()) || []; return { re: /@"?[\w ]*$/, opts: cs.filter(c => c.toLowerCase().includes(part.toLowerCase())).map(c => ({ label: c, insert: '@' + (/\s/.test(c) ? ('"' + c + '"') : c) })) }; }
      if ((m = before.match(/\{\{record\.([\w ]*)$/))) { const part = m[1] || ''; const fs = (getFields && getFields()) || []; return { re: /\{\{record\.[\w ]*$/, opts: fs.filter(f => f.toLowerCase().includes(part.toLowerCase())).map(f => ({ label: f, insert: '{{record.' + f + '}}' })) }; }
      if ((m = before.match(/\{\{prompt\.records?:[^}]*::\s*([\w ]*)$/))) { const part = m[1] || ''; const cs = (getColls && getColls()) || []; return { re: /[\w ]*$/, opts: cs.filter(c => c.toLowerCase().includes(part.toLowerCase())).map(c => ({ label: c, insert: c })) }; }
      if ((m = before.match(/\{\{([\w.:]*)$/))) { const part = (m[1] || '').toLowerCase(); return { re: /\{\{[\w.:]*$/, opts: tokens.filter(t => t.key.toLowerCase().startsWith(part)).map(t => ({ label: t.insert, hint: t.hint, insert: t.insert, caret: t.caret })) }; }
      return null;
    };
    const update = () => { const c = ctx(); if (!c || !c.opts.length) { closeMenu(); return; } items = c.opts.slice(0, 9); active = 0; el._acCtx = c; render(); };
    const accept = (i) => {
      const c = el._acCtx; if (!c || !items[i]) { closeMenu(); return; }
      const it = items[i]; const caret = el.selectionStart || 0; const before = el.value.slice(0, caret), after = el.value.slice(caret);
      const newBefore = before.replace(c.re, it.insert); el.value = newBefore + after;
      if (it.caret) { const idx = newBefore.lastIndexOf(it.caret); if (idx >= 0) { try { el.setSelectionRange(idx, idx + it.caret.length); } catch (e) {} closeMenu(); el.focus(); return; } }
      const pos = newBefore.length; try { el.setSelectionRange(pos, pos); } catch (e) {} closeMenu(); el.focus();
    };
    el.addEventListener('input', update);
    el.addEventListener('keydown', (ev) => {
      if (!menu) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); active = (active + 1) % items.length; render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); active = (active - 1 + items.length) % items.length; render(); }
      else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); accept(active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
    });
    el.addEventListener('blur', () => setTimeout(closeMenu, 150));
  }

  // TP-20: best-effort call to the local generative endpoint (task-search proxy /llm on :8787).
  // Returns the parsed {text, items?} or null. Plugin-side fetch (the blocklist only gates <%* %>).
  async _llm(prompt, wantJson) {
    try {
      const url = (this._cfg && this._cfg.llmUrl) || 'http://localhost:8787/llm';
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: String(prompt || ''), json: !!wantJson }) });
      if (!resp || !resp.ok) return null;
      return await resp.json();
    } catch (e) { console.warn('[Templater] /llm failed', e); return null; }
  }

  // Parse a JSON object out of an LLM reply (tolerates ```json fences + surrounding prose).
  _parseJsonLoose(text) {
    let s = String(text || '').trim();
    if (s.indexOf('```') >= 0) { s = s.replace(/^[\s\S]*?```[a-z]*\s*/i, '').replace(/```[\s\S]*$/, '').trim(); }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  // ========================================================================
  // TP-21: Schema-validating dry-run preview (resolve true=create / false=cancel)
  // ========================================================================

  // Flags any frontmatter key that is NOT a real property on the target collection (the silent-fail
  // class — a key that doesn't match a label fills nothing), plus read-only/computed targets.
  openSchemaPreview(title, frontmatter, body, collection, tName) {
    return new Promise((resolve) => {
      let cfg = null; try { cfg = collection && collection.getConfiguration(); } catch (_) {}
      const fmap = {}; for (const f of ((cfg && cfg.fields) || [])) { if (f && f.label) fmap[f.label] = { type: f.type, ro: (f.read_only === true || f.type === 'dynamic') }; }
      const esc = (s) => this.escape(String(s == null ? '' : s));
      const overlay = document.createElement('div'); overlay.className = 'tmpl-overlay';
      const modal = document.createElement('div'); modal.className = 'tmpl-modal';
      let html = '<h2>Preview: ' + esc(tName) + '</h2><div class="tmpl-sub">' + esc((collection && collection.getName && collection.getName()) || '') + ' — nothing is written until you confirm</div>';
      html += '<div class="tmpl-field"><label>Title</label><div class="tmpl-preview">' + esc(title || '(untitled)') + '</div></div>';
      let rows = ''; let warns = 0;
      for (const k of Object.keys(frontmatter || {})) {
        if (/^(title|name|plexus)$/i.test(k)) continue;
        const raw = frontmatter[k];
        const disp = (raw && typeof raw === 'object' && raw.__relation != null) ? ('&rarr; ' + (Array.isArray(raw.__relation) ? raw.__relation.length + ' link(s)' : '1 link')) : esc(this.previewText(String(raw == null ? '' : raw)));
        const meta = fmap[k]; let tag;
        if (!meta) { tag = '⚠ not a property on this collection — will be IGNORED'; warns++; }
        else if (meta.ro) { tag = '⚠ read-only / computed — will be ignored'; warns++; }
        else tag = '✓ ' + esc(meta.type);
        rows += '<div class="tmpl-field"><label>' + esc(k) + ' — ' + tag + '</label><div class="tmpl-preview">' + (disp || '<i>(empty)</i>') + '</div></div>';
      }
      html += rows || '<div class="tmpl-sub">no properties set</div>';
      const bt = this.previewText(body || '').trim();
      html += '<div class="tmpl-field"><label>Body</label><div class="tmpl-preview">' + esc(bt.slice(0, 1500)) + (bt.length > 1500 ? '…' : '') + '</div></div>';
      modal.innerHTML = html;
      const actions = document.createElement('div'); actions.className = 'tmpl-actions';
      const cancel = document.createElement('button'); cancel.className = 'tmpl-btn'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.className = 'tmpl-btn primary'; ok.textContent = warns ? ('Create anyway (' + warns + ' ⚠)') : 'Create →';
      actions.appendChild(cancel); actions.appendChild(ok); modal.appendChild(actions);
      overlay.appendChild(modal); document.body.appendChild(overlay);
      let done = false; const close = (v) => { if (done) return; done = true; try { document.body.removeChild(overlay); } catch (_) {} resolve(v); };
      cancel.onclick = () => close(false); ok.onclick = () => close(true);
      overlay.onclick = (e) => { if (e.target === overlay) close(false); };
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(true); } });
    });
  }

  // ========================================================================
  // Preview modal (kept for manual use; not in the default apply flow)
  // ========================================================================

  openPreview(template, rendered) {
    const plugin = this;
    const tName = this.tName(template);
    const display = this.previewText(rendered);
    const overlay = document.createElement('div');
    overlay.className = 'tmpl-overlay';
    const modal = document.createElement('div');
    modal.className = 'tmpl-modal';
    modal.innerHTML = `<h2>Preview: ${this.escape(tName)}</h2><div class="tmpl-sub">Apply commits the template; an audit row is written if a log collection exists.</div><div class="tmpl-preview">${this.escape(display)}</div>`;
    const actions = document.createElement('div');
    actions.className = 'tmpl-actions';
    const closeBtn = document.createElement('button'); closeBtn.className = 'tmpl-btn'; closeBtn.textContent = 'Cancel';
    const copyBtn = document.createElement('button'); copyBtn.className = 'tmpl-btn'; copyBtn.textContent = 'Copy';
    const applyBtn = document.createElement('button'); applyBtn.className = 'tmpl-btn primary'; applyBtn.textContent = 'Apply';
    actions.appendChild(copyBtn); actions.appendChild(closeBtn); actions.appendChild(applyBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const close = () => { try { document.body.removeChild(overlay); } catch (e) {} };
    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(display); this.toast("Copied", "Rendered template on clipboard."); }
      catch (e) { this.toast("Copy blocked", "Clipboard API unavailable in this context."); }
    };
    applyBtn.onclick = async () => {
      applyBtn.disabled = true; applyBtn.textContent = 'Applying...';
      try {
        await plugin.applyTemplate(template, rendered);
        close();
      } catch (e) {
        console.error('[Templater] apply failed:', e);
        plugin.toast("Apply failed", String(e && e.message || e));
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';
      }
    };
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); applyBtn.click(); }
    });
  }

  // Convert internal sentinel markers to readable text for preview / copy / titles.
  // The bounded MARKER_RE never spans into following text, so multi-ref/tag lines
  // round-trip cleanly.
  previewText(rendered) {
    return String(rendered == null ? "" : rendered).replace(MARKER_RE, (full, kind, payload) => {
      if (kind === "REF") {
        const parts = payload.split(M_SEP);
        const label = parts.length > 1 ? parts.slice(1).join(M_SEP) : parts[0];
        return "[[" + label + "]]";
      }
      if (kind === "TAG") return payload;
      if (kind === "DATE") return payload;
      return full;
    });
  }

  // ========================================================================
  // Apply — title + frontmatter -> properties + nested body line items + audit
  // ========================================================================

  // 10X-#10: synthesize a reusable template FROM an example record — the LLM turns instance
  // values into {{prompt:}}/{{date:}} tokens and keeps structure + dc:/{{attr:}} lines verbatim.
  // Creates a DRAFT record in Templates and opens the editor on it for review.
  async newTemplateFromExample() {
    try {
      const cols = await this.getCollectionsCached();
      const names = (cols || []).map(c => { try { return c.getName(); } catch (e) { return null; } }).filter(Boolean);
      const ci = await this.asyncSuggester('Example record from which collection?', names);
      if (ci < 0) return;
      const coll = (cols || []).find(c => { try { return c.getName() === names[ci]; } catch (e) { return false; } });
      if (!coll) return;
      const recs = await coll.getAllRecords();
      const rnames = (recs || []).slice(0, 40).map(r => { try { return r.getName() || '(untitled)'; } catch (e) { return '(untitled)'; } });
      if (!rnames.length) { this.toast('Templater', 'No records in that collection.'); return; }
      const ri = await this.asyncSuggester('Pick the example record', rnames);
      if (ri < 0) return;
      const rec = recs[ri];
      let propsTxt = '';
      try {
        const cfg = coll.getConfiguration && coll.getConfiguration();
        for (const f of ((cfg && cfg.fields) || [])) {
          if (/^(title|banner|icon|collection|created_at|updated_at)$/i.test(f.id || '')) continue;
          let v = null; try { const p = rec.prop(f.label); if (p) { if (p.choiceLabel) v = p.choiceLabel(); if (v == null && p.text) v = p.text(); if (v == null && p.number) v = p.number(); } } catch (e) {}
          if (v != null && String(v).trim()) propsTxt += f.label + (f.type === 'choice' && f.choices ? ' (choice of: ' + (f.choices || []).map(c => c && c.label).filter(Boolean).join(', ') + ')' : '') + ': ' + String(v).slice(0, 120) + '\n';
        }
      } catch (e) {}
      let bodyTxt = ''; try { bodyTxt = await this.serializeBody(rec) || ''; } catch (e) {}
      this.toast('Templater', 'Synthesizing template from "' + (rec.getName ? rec.getName() : '') + '"…');
      const req = 'Turn this EXAMPLE record into a REUSABLE template. Replace instance-specific values with {{prompt:Label}} (use {{prompt.choice:Label :: a, b, c}} for the choice fields whose options are shown), dates with {{date:YYYY-MM-DD}}. KEEP structure, headings, and any lines starting with dc: or containing {{attr: VERBATIM. Output format EXACTLY:\n---\nTitle: <title pattern>\n<Prop>: <value or token>\n---\n<body markdown>\n\nEXAMPLE — collection "' + names[ci] + '":\nTitle: ' + (rec.getName ? rec.getName() : '') + '\n' + propsTxt + '\nBODY:\n"""\n' + bodyTxt.slice(0, 5000) + '\n"""\n\nReply with ONLY the template text.';
      const r = await this._llm(req, false);
      const content = (r && r.text) ? String(r.text).trim() : '';
      if (!content) { this.toast('Templater', 'AI synthesis unavailable — is the /llm proxy running?'); return; }
      const tcol = await this.getTemplatesCollection(); if (!tcol) { this.toast('Templater', 'Templates collection not found.'); return; }
      const tname = ((rec.getName ? rec.getName() : names[ci]) + ' Template').slice(0, 80);
      const ng = tcol.createRecord(tname); if (!ng) { this.toast('Templater', 'createRecord failed.'); return; }
      const trec = await this.pollRecord(ng); if (!trec) { this.toast('Templater', 'New template record did not resolve.'); return; }
      const set = (l, v) => { try { const p = trec.prop(l); if (p && p.set) p.set(v); } catch (e) {} };
      set('Template Name', tname); set(F_CONTENT, content);
      set('Purpose', 'Synthesized from example "' + (rec.getName ? rec.getName() : '') + '" (' + names[ci] + ') — review before use.');
      set('Version', '1.0');
      this.toast('Templater', 'Draft "' + tname + '" created — review it.');
      try { await this.openTemplateEditor(trec); } catch (e) {}
    } catch (e) { console.warn('[Templater] newTemplateFromExample', e); this.toast('Templater', 'Synthesis failed — see console.'); }
  }

  // 10X-#3: Smart capture — type/paste a raw thought; the LLM picks the best template AND fills
  // its prompts from the text; graceful fallback to a manual picker when the /llm proxy is down.
  async smartCapture(presetText) {
    try {
      const text = (presetText && String(presetText).trim()) || await this.asyncPrompt('Smart capture — describe it', '');
      if (!text || !String(text).trim()) return;
      const records = await this.loadTemplatesSorted(); if (!records || !records.length) { this.toast('Templater', 'No templates.'); return; }
      const metas = [];
      for (const r of records.slice(0, 30)) {
        const nm = this.tName(r); if (!nm) continue;
        let content = ''; try { content = await this.assembleTemplateSource(r) || ''; } catch (e) {}
        const prompts = []; const re = /\{\{prompt(?:\.\w+)?:([^}]+?)\}\}/g; let m;
        while ((m = re.exec(content)) !== null) { const lbl = m[1].split(/\s*::\s*/)[0].split(/\s*\?\?\s*/)[0].trim(); if (lbl && !prompts.includes(lbl)) prompts.push(lbl); }
        let purpose = ''; try { purpose = (r.text && r.text('Purpose')) || ''; } catch (e) {}
        metas.push({ name: nm, purpose: String(purpose || '').slice(0, 140), prompts });
      }
      const req = 'Pick the SINGLE best template for this capture and fill its prompts from the text (leave a prompt out if the text doesn\'t answer it). Templates:\n' +
        metas.map(t => '- ' + t.name + (t.purpose ? ' — ' + t.purpose : '') + (t.prompts.length ? ' (prompts: ' + t.prompts.join(', ') + ')' : '')).join('\n') +
        '\n\nCapture:\n"""\n' + String(text).slice(0, 4000) + '\n"""\n\nReply ONLY JSON: {"template":"Name","prompts":{"Label":"value"}}';
      let pick = null;
      try { const r = await this._llm(req, false); pick = (r && r.text) ? this._parseJsonLoose(r.text) : null; } catch (e) {}
      if (pick && pick.template && metas.find(t => t.name === pick.template)) {
        this.toast('Templater', 'Smart capture → "' + pick.template + '"');
        const res = await this._state.applyTemplateByName(pick.template, { prompts: (pick.prompts && typeof pick.prompts === 'object') ? pick.prompts : {} });
        if (res && res.error) this.toast('Templater', 'Apply failed: ' + res.error);
        return;
      }
      const idx = await this.asyncSuggester('LLM unavailable — pick a template for this capture', metas.map(t => t.name));
      if (idx >= 0) await this._state.applyTemplateByName(metas[idx].name, {});
    } catch (e) { console.warn('[Templater] smartCapture', e); this.toast('Templater', 'Smart capture failed — see console.'); }
  }

  // 10X-#9: find audit rows for a chosen template recorded with an OLDER version and merge-apply
  // the current version onto those records (adds missing sections / fills empty props only; prompts
  // render empty — migration is structural; Field= conditionals eval against the ACTIVE record, a
  // documented limitation). Capped at 25 per run, confirm before writing.
  async reScaffoldOutdated() {
    try {
      const records = await this.loadTemplatesSorted(); if (!records || !records.length) { this.toast('Templater', 'No templates.'); return; }
      const names = records.map(r => this.tName(r));
      const idx = await this.asyncSuggester('Re-scaffold records born from…', names);
      if (idx < 0) return;
      const tpl = records[idx], tplName = names[idx];
      const curVer = this.tVersion(tpl) || '';
      let tguid = ''; try { tguid = tpl.guid || ''; } catch (e) {}
      const audit = await this.getAuditCollection();
      if (!audit) { this.toast('Templater', 'No audit collection ("Template Log") — nothing recorded.'); return; }
      const rows = await audit.getAllRecords();
      const targets = new Map();   // target record guid -> recorded version
      for (const r of (rows || [])) {
        let tf = ''; try { tf = (r.text && r.text('Template')) || ''; } catch (e) {}
        if (!tf || (tguid ? tf.indexOf(tguid) === -1 : tf.indexOf(tplName) !== 0)) continue;
        const vm = tf.match(/\sv([\w.\-]+)\s*\(/); const ver = vm ? vm[1] : '';
        if (curVer && ver === curVer) continue;                       // already current
        let tr = ''; try { tr = (r.text && r.text('Target Record')) || ''; } catch (e) {}
        const gm = tr.match(/\(([A-Z0-9]{10,})\)\s*$/); if (!gm) continue;
        targets.set(gm[1], ver || '?');
      }
      if (!targets.size) { this.toast('Templater', 'No outdated records found for "' + tplName + '" (v' + (curVer || '?') + ').'); return; }
      const guids = [...targets.keys()].slice(0, 25);
      const ok = await this.asyncSuggester('Merge-apply v' + (curVer || '?') + ' of "' + tplName + '" onto ' + guids.length + ' outdated record(s)?', ['Yes — re-scaffold ' + guids.length, 'Cancel']);
      if (ok !== 0) return;
      let done = 0, failed = 0;
      for (const g of guids) {
        try { const r = await this._state.applyTemplateByName(tplName, { mode: 'merge', recordGuid: g, prompts: {} }); if (r && r.ok) done++; else failed++; }
        catch (e) { failed++; }
      }
      this.toast('Templater', 'Re-scaffolded ' + done + '/' + guids.length + (failed ? (' — ' + failed + ' failed, see console') : '') + '.');
    } catch (e) { console.warn('[Templater] reScaffoldOutdated', e); this.toast('Templater', 'Re-scaffold failed — see console.'); }
  }

  // 10X-#8: merge-filter — keep only top-level sections (a #-heading line + everything until the
  // next heading) whose heading TEXT is absent from the record. Preamble (before the first heading)
  // is written only onto an empty record. Comparison: whitespace-collapsed, case-insensitive.
  async _mergeFilterBody(record, body) {
    const existing = new Set();
    let hadAny = false;
    try {
      const items = await this._freshLineItems(record, true);
      hadAny = !!(items && items.length);
      for (const li of (items || [])) {
        try {
          const isH = (li.type === 'heading') || (li.getHeadingSize && li.getHeadingSize());
          if (!isH) continue;
          const t = (li.segments || []).map(s => (typeof s.text === 'string' ? s.text : (s.text && s.text.title) || '')).join('').replace(/\s+/g, ' ').trim().toLowerCase();
          if (t) existing.add(t);
        } catch (e) {}
      }
    } catch (e) {}
    const lines = String(body || '').split('\n');
    const out = [];
    let keep = !hadAny;   // preamble only onto an empty record
    for (const ln of lines) {
      const h = ln.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) keep = !existing.has(h[1].replace(/\s+/g, ' ').trim().toLowerCase());
      if (keep) out.push(ln);
    }
    return out.join('\n');
  }

  // A journal wrapper captured during panel navigation can briefly expose an
  // empty pre-replication body even when the page already has content. Re-read
  // the exact target and give an empty snapshot a short bounded settle window.
  // A populated page normally returns on the first attempt.
  async _freshLineItems(record, settleEmpty) {
    let guid = null;
    try { guid = record && (record.guid || (record.getGuid && record.getGuid())); } catch (_e) {}
    let items = [];
    const waits = settleEmpty ? [80, 160, 320] : [];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      let current = record;
      if (guid) {
        try { let resolved = this.data && this.data.getRecord && this.data.getRecord(guid); if (resolved && resolved.then) resolved = await resolved; if (resolved) current = resolved; } catch (_e) {}
      }
      try { items = current && current.getLineItems ? await current.getLineItems(false) : []; } catch (_e) { items = []; }
      if ((items && items.length) || attempt === waits.length) return items || [];
      await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
    return items || [];
  }

  async applyTemplate(template, rendered, opts) {
    const triggers = this.tTriggers(template);
    // P0: `vars` (the template's Variables JSON) is read later as {flat: vars.nest==='flat'} but was never
    // declared in this scope → ReferenceError aborted EVERY interactive apply of a body template (picker /
    // applyTemplateByName spine / preview). Declare it here, mirroring fireTemplate.
    let vars = {};
    try { const raw = this.tField(template, F_VARS) || this.tField(template, 'Variables'); if (raw && raw.trim()) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') vars = parsed; } } catch (e) {}
    const panel = this.ui.getActivePanel && this.ui.getActivePanel();
    const activeRecord = panel && panel.getActiveRecord && panel.getActiveRecord();
    const activeCollection = panel && panel.getActiveCollection && panel.getActiveCollection();

    // Effective mode: an explicit runtime choice (from the picker chooser) wins; otherwise fall
    // back to the template's authored Triggers (keeps the auto / record-created path unchanged).
    const triggerAppend = triggers.some(t => /^append to current record$/i.test(t));
    const triggerUpdate = triggers.some(t => /^update current record$/i.test(t));
    const optMode = opts && opts.mode;
    const appendMode = optMode ? optMode === 'append' : triggerAppend;
    const updateMode = optMode ? optMode === 'update' : triggerUpdate;
    const mergeMode = optMode === 'merge';   // 10X-#8: idempotent re-apply — add only what's missing

    // Parse frontmatter + strip from body.
    const parsed = this.parseFrontmatter(rendered);
    const frontmatter = parsed.frontmatter;
    let bodyAll = parsed.body;
    // IO-5/TS-1 + TS-8: `plexus: hybrid|mindmap` is a DIRECTIVE (flip the new record to a drawing / build a mind map),
    // not a record property. TS-3/TS-10: collect {{relate}}/{{banner}} directive markers to apply after create.
    const plexusDir = frontmatter ? String(frontmatter.plexus || '').trim().toLowerCase() : '';
    const wantMindmap = /^mind ?map$/.test(plexusDir);
    const wantHybrid = /^(hybrid|drawing|canvas|true|yes)$/.test(plexusDir);
    if (frontmatter && 'plexus' in frontmatter) delete frontmatter.plexus;
    const relates = []; const RELATE_RE = /<!--PLEXUS-RELATE:([^=]+)=([^>]+?)-->/g; let _rm;
    while ((_rm = RELATE_RE.exec(bodyAll)) !== null) relates.push({ field: _rm[1].trim(), guid: _rm[2].trim() });
    let bannerUrl = null; const _bm = bodyAll.match(/<!--PLEXUS-BANNER:(https?:\/\/[^>]+?)-->/); if (_bm) bannerUrl = _bm[1];
    // TP-15: collect {{task:…}} directives — spawned as Rich Tasks records (linked to this record) after apply.
    const taskDirectives = []; const TASK_RE = /<!--TMPL-TASK:([^>]*?)-->/g; let _tk;
    while ((_tk = TASK_RE.exec(bodyAll)) !== null) { try { taskDirectives.push(decodeURIComponent(_tk[1])); } catch (e) { taskDirectives.push(_tk[1]); } }

    // Title: prefer an explicit frontmatter `Title:` (composed from the record's properties),
    // else fall back to the first non-empty body line. When the title comes from frontmatter,
    // the first body line is REAL content and must NOT be stripped.
    const bodyLines = bodyAll.split('\n');
    const titleLineRaw = bodyLines.find(l => l.trim()) || this.tName(template);
    const fmTitle = frontmatter && (frontmatter.Title || frontmatter.title || frontmatter.Name || frontmatter.name);
    let title, dropTitleLine;
    if (fmTitle != null && typeof fmTitle === 'string' && fmTitle.trim()) {
      // Clean up separators left dangling when an optional token rendered empty
      // (e.g. "1:1 · " when Attendees was skipped).
      title = String(fmTitle)
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*[·—–-]\s*([·—–-]\s*)+/g, ' · ')  // collapse doubled separators (empty middle)
        .replace(/[·—–-]\s*$/, '')                     // trailing separator
        .replace(/^\s*[·—–-]\s*/, '')                  // leading separator
        .trim()
        .slice(0, 200) || this.tName(template);
      dropTitleLine = false;
    } else {
      title = this.deriveTitle(titleLineRaw);
      dropTitleLine = true;
    }

    let targetRecord = null;
    let targetCollection = null;
    let createdNewGuid = null;
    let bodyForWrite = bodyAll;
    let targetIsJournal = false;

    if (appendMode || updateMode || mergeMode) {
      // 10X-#8/#9: merge (and migration) can target a record by guid, headless — else the active one.
      let tr = activeRecord;
      if (opts && opts.recordGuid) { try { tr = await this.pollRecord(opts.recordGuid); } catch (e) { tr = null; } }
      if (!tr) { this.toast("Templater", "No target record — open a record first."); return; }
      targetRecord = tr;
      targetCollection = (opts && opts.recordGuid) ? null : activeCollection;
      targetIsJournal = this._recordApplyContext(targetRecord).isJournal;
      if (mergeMode) {
        // props: fill EMPTY only (never overwrite user values, never rename)
        if (frontmatter) {
          for (const k of Object.keys(frontmatter)) {
            if (/^(title|name)$/i.test(k)) { delete frontmatter[k]; continue; }
            try {
              const p = targetRecord.prop && targetRecord.prop(k);
              if (p) {
                let has = false;
                // short-circuit ladder: choice label, else text, else number. nm can be boolean false
                // (short-circuit residue) — harmless: has is already decided by then. Edit with care.
                try { const cl = p.choiceLabel && p.choiceLabel(); const tx = cl == null && p.text && p.text(); const nm = (cl == null && !tx) && p.number && p.number(); has = !!(cl || (tx && String(tx).trim()) || (nm != null && nm !== '' && !isNaN(nm))); } catch (e) {}
                if (has) delete frontmatter[k];
              }
            } catch (e) {}
          }
        }
        // body: only sections whose top-level heading is absent from the record
        bodyForWrite = await this._mergeFilterBody(targetRecord, dropTitleLine ? this.stripTitleLine(bodyAll, titleLineRaw) : bodyAll);
        // directives: RE-COLLECT from the filtered body — a re-apply must not respawn Rich Tasks /
        // relations / banner from sections the record already has.
        relates.length = 0; RELATE_RE.lastIndex = 0; let _rm2;
        while ((_rm2 = RELATE_RE.exec(bodyForWrite)) !== null) relates.push({ field: _rm2[1].trim(), guid: _rm2[2].trim() });
        taskDirectives.length = 0; TASK_RE.lastIndex = 0; let _tk2;
        while ((_tk2 = TASK_RE.exec(bodyForWrite)) !== null) { try { taskDirectives.push(decodeURIComponent(_tk2[1])); } catch (e) { taskDirectives.push(_tk2[1]); } }
        if (!/<!--PLEXUS-BANNER:/.test(bodyForWrite)) bannerUrl = null;
        if (!bodyForWrite.trim() && !(frontmatter && Object.keys(frontmatter).length)) {
          this.toast('Templater', 'Merge: nothing missing — "' + (targetRecord.getName ? targetRecord.getName() : '') + '" already has every section.');
          return targetRecord.guid;
        }
      }
      // Update-mode rename: PluginRecord has no setName. Only a Name/Title text PROPERTY
      // can be written; if none exists, update-mode cannot rename — we skip silently.
      // When update-mode sets the title, drop the title line from the body too (it now lives
      // as the record name). Journal day titles are host-owned dates: never write them, but still
      // consume a body-derived title line so "Daily Note" does not become a stray first bullet.
      // Append-mode keeps it (the record's own name is left untouched).
      if (updateMode) {
        if (!targetIsJournal) await this.trySetRecordTitle(targetRecord, title);
        if (dropTitleLine) bodyForWrite = this.stripTitleLine(bodyAll, titleLineRaw);
      }
    } else {
      // CREATE: explicitly chosen collection (picker) wins; else trigger-named or active.
      targetCollection = (opts && opts.collection) || await this.resolveTargetCollection(triggers, activeCollection);
      if (!targetCollection) { this.toast("Templater", "No target collection — pick one, or open a collection first."); return; }
      // TP-21: schema-validating dry-run preview (opt-in via Variables JSON {"preview": true}).
      if (opts && opts.preview) { const ok = await this.openSchemaPreview(title, frontmatter, bodyForWrite, targetCollection, this.tName(template)); if (!ok) return; }
      createdNewGuid = targetCollection.createRecord(title);
      if (!createdNewGuid) throw new Error("createRecord returned no GUID");
      targetRecord = await this.pollRecord(createdNewGuid);
      if (!targetRecord) throw new Error("Could not fetch new record after createRecord");
      targetIsJournal = this._recordApplyContext(targetRecord).isJournal;
      // Drop the title line from the body only when the title CAME from the first body line.
      if (dropTitleLine) bodyForWrite = this.stripTitleLine(bodyAll, titleLineRaw);
    }

    // Journal date titles are host-owned. Frontmatter Title/Name would otherwise reach the same
    // writable property path as trySetRecordTitle and rename the day despite the guard above.
    if (targetIsJournal) this._removeJournalTitleFields(frontmatter);

    // Frontmatter -> properties (CORE).
    if (frontmatter && Object.keys(frontmatter).length) {
      await this.applyFrontmatter(targetRecord, frontmatter);
    }

    // v2.46 Auto-title rules: after frontmatter lands, compute a REAL title from the target
    // collection's canonical Templater rule. Applies to create/fill, never append/merge, and never
    // to host-owned Journal date titles. The optional collection hook below is display-only.
    if (!targetIsJournal && (createdNewGuid || updateMode) && targetCollection) {
      try {
        const ruledTitle = await this.applyAutoTitleRule(targetRecord, targetCollection);
        if (ruledTitle) title = ruledTitle;
      } catch (e) { console.warn('[Templater] Auto-title rule apply failed:', e); }
    }

    // Body -> native nested line items (segment-aware). Strip the directive markers first (not content).
    if (relates.length) bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-RELATE:[^>]+?-->/g, '');
    if (bannerUrl) bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-BANNER:[^>]+?-->/g, '');
    if (taskDirectives.length) bodyForWrite = bodyForWrite.replace(/<!--TMPL-TASK:[^>]*?-->/g, '');
    const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(bodyForWrite);
    bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-PROMOTE-->/gi, '');
    let cursorGuid = null;
    if (bodyForWrite.trim()) {
      // createLineItem(null, null, ...) prepends the first root line, so a Journal fill lands at
      // the page top; writeBody then chains siblings in author order beneath that first line.
      cursorGuid = await this.writeBody(targetRecord, bodyForWrite, { flat: vars && vars.nest === 'flat' }); // TP-3: {{cursor}} target line
    }
    if (wantPromote) this._promoteAfterApply(targetRecord);

    // TP-15: spawn Rich Tasks records from {{task:}} directives, each linked to the new/target record.
    let spawnedTasks = 0;
    for (const td of taskDirectives) { const g = await this.spawnRichTask(td, targetRecord, targetCollection); if (g) spawnedTasks++; }

    // TS-3: relation-wiring — set typed record-relation properties (Brain reads these as edges).
    for (const rel of relates) {
      try { const p = targetRecord.prop && targetRecord.prop(rel.field); if (p) { if (p.addValue) p.addValue(rel.guid); else if (p.set) p.set(rel.guid); } } catch (e) { console.warn('[Templater] relate failed', rel, e); }
    }
    // TS-10: fetch the {{banner:URL}} image and set the record banner (best-effort; CORS/blocked URLs degrade).
    if (bannerUrl && targetRecord.setBannerFromBlob) {
      try { const resp = await fetch(bannerUrl); if (resp && resp.ok) { const ab = await resp.blob(); const blob = await this.data.uploadBlob(new File([ab], 'banner.png', { type: ab.type || 'image/png' })); if (blob) targetRecord.setBannerFromBlob(blob); } } catch (e) { console.warn('[Templater] banner fetch failed:', e); }
    }

    // Update lastUsed on the template.
    try {
      const p = template.prop && template.prop(F_LASTUSED);
      if (p && p.setFromDate) p.setFromDate(new Date());
    } catch (e) { /* best-effort */ }

    // Audit (best-effort, not awaited — keeps the apply hot path off the audit poll).
    this.writeAuditRow(template, targetRecord.guid, targetCollection, title, this.previewText(rendered))
      .catch(e => console.warn('[Templater] audit write failed:', e));

    this.toast(
      "Applied: " + this.tName(template),
      (createdNewGuid ? ("Created \"" + title + "\"") : (updateMode ? ("Updated \"" + (targetRecord.getName ? targetRecord.getName() : title) + "\"") : "Appended to current record")) +
      (targetCollection && targetCollection.getName ? (" in " + targetCollection.getName()) : "")
    );

    // GAP-4: drain tp.hooks.on_all_templates_executed callbacks — the full pipeline (props, body,
    // tasks, relations, banner) is done; runs BEFORE the mindmap/hybrid/nav early-returns so every
    // exit path fires the hooks. Each cb gets the target record guid.
    if (this._pendingHooks && this._pendingHooks.length) {
      const hooks = this._pendingHooks.splice(0);
      for (const cb of hooks) { try { await cb(targetRecord.guid); } catch (e) { console.warn('[Templater] on_all_templates_executed hook failed:', e); } }
    }

    // 10X-#5: trigger chains — Variables JSON {"then":"Next Template"} applies the next template
    // after this one completes, MERGE-mode onto the record just created/updated (so a chain can
    // only add, never duplicate). Depth-capped at 3; self-chains ignored.
    try {
      const chainNext = vars && (vars.then || vars.chain);
      const chainDepth = (opts && opts.__chainDepth) || 0;
      if (chainNext && typeof chainNext === 'string' && chainNext.trim() && chainDepth < 3 && chainNext.trim() !== this.tName(template)) {
        const nextName = chainNext.trim(), tguid2 = targetRecord.guid;
        setTimeout(() => { try { this._state.applyTemplateByName(nextName, { mode: 'merge', recordGuid: tguid2, prompts: {}, __chainDepth: chainDepth + 1 }).then(r => { if (r && r.error) console.warn('[Templater] chain →', nextName, r.error); }); } catch (e) { console.warn('[Templater] chain failed', e); } }, 500);
      }
    } catch (e) {}

    // TS-8: "born as a mind map" — flip the new record into a drawing AND build a mind map from its headings.
    if (wantMindmap && createdNewGuid) {
      try { if (typeof window !== 'undefined' && window.__plexusCanvas && window.__plexusCanvas.mindMapFromNote) { await window.__plexusCanvas.mindMapFromNote(targetRecord.guid); return targetRecord.guid; } this.toast("Templater", "plexus: mindmap needs the Plexus Canvas plugin installed."); } catch (e) { console.warn('[Templater] mindMapFromNote failed:', e); }
    }
    // IO-5/TS-1: "born hybrid" — flip the new record into a Plexus drawing via the cross-plugin seam.
    if (wantHybrid && createdNewGuid) {
      try { if (typeof window !== 'undefined' && window.__plexusCanvas && window.__plexusCanvas.attachScene) { await window.__plexusCanvas.attachScene(targetRecord.guid, true); return targetRecord.guid; } this.toast("Templater", "plexus: hybrid needs the Plexus Canvas plugin installed."); } catch (e) { console.warn('[Templater] attachScene failed:', e); }
    }
    // TP-3: if the template had a {{cursor}}, jump to that line (highlighted) so the user lands ready to type.
    if (cursorGuid) {
      try { const cp = this.ui.getActivePanel && this.ui.getActivePanel(); if (cp && cp.navigateTo) { const ok = await cp.navigateTo({ itemGuid: cursorGuid, highlight: true }); if (ok !== false) return targetRecord.guid; } } catch (e) { console.warn('[Templater] cursor nav failed:', e); }
    }

    // Navigate to the new record (GUARDRAIL #3 — await Promise<boolean>).
    if (createdNewGuid) {
      try {
        const navPanel = this.ui.getActivePanel && this.ui.getActivePanel();
        if (navPanel && typeof navPanel.navigateTo === 'function') {
          const ok = await navPanel.navigateTo({ itemGuid: createdNewGuid, highlight: true });
          if (ok === false) console.warn('[Templater] navigateTo could not resolve new record', createdNewGuid);
        }
      } catch (e) { console.warn('[Templater] post-apply navigate failed:', e); }
    }

    return targetRecord.guid;
  }

  // TP-15: create one Rich Tasks record from a `Title | key=val | …` directive, linked to the
  // record the template just produced. status/priority/context/energy map to the Rich Tasks
  // choice props (labels match exactly); due is any datetime string ("+3 days", "next friday").
  async spawnRichTask(directive, targetRecord, targetCollection) {
    try {
      const parts = String(directive).split('|').map(s => s.trim());
      const title = (parts[0] || '').trim();
      if (!title) return null;
      const attrs = {};
      for (const seg of parts.slice(1)) { const i = seg.indexOf('='); if (i > 0) attrs[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim(); }
      const coll = await this.collectionByName('Rich Tasks');
      if (!coll) { this.toast('Templater', 'No "Rich Tasks" collection — task not created.'); return null; }
      const guid = coll.createRecord(title);
      if (!guid) return null;
      const rec = await this.pollRecord(guid);
      if (!rec) return guid;
      const set = (label, val) => { if (val == null || val === '') return; try { const p = rec.prop && rec.prop(label); if (p) this.applyPropertyValue(p, label, String(val)); } catch (e) {} };
      set('Task Status', attrs.status || 'To Do');
      set('Priority', attrs.priority);
      set('Context', attrs.context);
      set('Energy', attrs.energy);
      // Resolve a relative due ("+3 days", "+2 weeks", "today") to a concrete date before setting.
      set('Due', attrs.due ? this.dateStringForSegment(attrs.due, {}) : '');
      // Link to the record we just created: Project relation for a Project, Area relation for an Area.
      try {
        const cn = targetCollection && targetCollection.getName && targetCollection.getName();
        const linkField = (cn === 'Projects') ? 'Project' : (cn === 'Areas' ? 'Area' : null);
        if (linkField && targetRecord && targetRecord.guid) { const lp = rec.prop && rec.prop(linkField); if (lp && lp.set) lp.set(targetRecord.guid); }
      } catch (e) {}
      return guid;
    } catch (e) { console.warn('[Templater] spawnRichTask failed', e); return null; }
  }

  async resolveTargetCollection(triggers, activeCollection) {
    const special = /^(append to current record|update current record)$/i;
    for (const t of (triggers || [])) {
      if (special.test(t)) continue;
      if (/^auto:/i.test(t)) {
        const name = t.replace(/^auto:/i, '').trim();
        const c = await this.collectionByName(name);
        if (c) return c;
        continue;
      }
      const c = await this.collectionByName(String(t).trim());
      if (c) return c;
    }
    return activeCollection || null;
  }

  async collectionByName(name) {
    try {
      const cols = await this.data.getAllCollections();
      return cols.find(c => c && c.getName && c.getName() === name) || null;
    } catch (e) { return null; }
  }

  async pollRecord(guid) {
    let delay = 50;
    for (let i = 0; i < 14; i++) {
      let rec = null;
      try { rec = this.data.getRecord(guid); } catch (e) {}
      if (rec) return rec;
      await new Promise(r => setTimeout(r, delay));
      if (delay < 200) delay *= 2;
    }
    return null;
  }

  deriveTitle(line) {
    // Markers -> readable text first (so refs/tags in a title line don't corrupt it).
    return this.previewText(String(line || ""))
      .replace(/^#+\s*/, '')
      .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^>\s+/, '')
      .trim()
      .slice(0, 200) || "Untitled";
  }

  stripTitleLine(body, titleLineRaw) {
    const lines = body.split('\n');
    let consumed = false;
    const out = [];
    for (const l of lines) {
      if (!consumed && l.trim() === titleLineRaw.trim()) { consumed = true; continue; }
      out.push(l);
    }
    return out.join('\n').replace(/^\n+/, '');
  }

  async trySetRecordTitle(record, title) {
    // PluginRecord has NO setName/setTitle. Only a Name/Title text PROPERTY is settable;
    // if neither exists, update-mode cannot rename the record — return false, don't pretend.
    for (const label of ["Name", "Title"]) {
      try {
        const p = record.prop && record.prop(label);
        if (p && p.set) { p.set(title); return true; }
      } catch (e) {}
    }
    return false;
  }

  // ========================================================================
  // Rename from properties (v2.27) — title a note from its own property values
  // ========================================================================

  // Resolve a relation/record property to the linked record name(s). GUARDRAIL 13: read p.values()
  // (linkedRecords() can read back []), normalise the guid shapes (incl. a JSON-blob-in-array from MCP writes).
  _relationNames(p) {
    const guids = [];
    const push = (v) => {
      if (v == null) return;
      if (typeof v === 'string') { const s = v.trim(); if (s.charAt(0) === '[') { try { JSON.parse(s).forEach(push); return; } catch (e) {} } if (/^[A-Z0-9]{20,32}$/.test(s)) guids.push(s); return; }
      if (Array.isArray(v)) { v.forEach(push); return; }
      if (typeof v === 'object') { if (v.guid) guids.push(v.guid); else if (v.getGuid) { try { guids.push(v.getGuid()); } catch (e) {} } }
    };
    try { const raw = p.values ? p.values() : null; if (Array.isArray(raw)) raw.forEach(push); else push(raw); } catch (e) {}
    if (!guids.length) {
      try { const lr = p.linkedRecords ? p.linkedRecords() : null; if (lr && lr.length) return lr.map(r => { try { return r.getName(); } catch (e) { return ''; } }).filter(Boolean).join(', '); } catch (e) {}
      return '';
    }
    const names = [];
    for (const g of guids) { try { const r = this.data.getRecord(g); if (r && r.getName) { const n = r.getName(); if (n) names.push(n); } } catch (e) {} }
    return names.join(', ');
  }

  titlePatternOf(tmpl) { return (this.tField(tmpl, F_TITLEPATTERN) || '').trim(); }

  // The collection a template is pinned to: Variables JSON {"collection":"X"} OR the `collection` choice label.
  _templatePinnedCollection(tmpl) {
    try { const raw = this.tField(tmpl, F_VARS) || this.tField(tmpl, 'Variables'); if (raw && raw.trim()) { const v = JSON.parse(raw); if (v && v.collection) return String(v.collection); } } catch (e) {}
    try { const p = tmpl.prop && tmpl.prop('collection'); if (p) { if (p.choiceLabel) { const cl = p.choiceLabel(); if (cl) return cl; } if (p.text) { const t = p.text(); if (t) return t; } } } catch (e) {}
    return null;
  }

  // collName → its template's Title Pattern (first template pinned to that collection with a non-empty pattern). 30s TTL.
  async findTitlePatternFor(collName) {
    if (!collName) return null;
    const st = this._state;
    if (!st.titlePatIndex || (Date.now() - st.titlePatIndex.ts) > TRIGGER_TTL_MS) {
      const map = {};
      try {
        const cols = await this.getCollectionsCached();
        const coll = cols.find(c => c && c.getName && c.getName() === TEMPLATES_COLL) || null;
        if (coll) { for (const r of await this._getRecordsCached(coll)) { const pat = this.titlePatternOf(r); if (!pat) continue; const tc = this._templatePinnedCollection(r); if (tc && !map[tc]) map[tc] = pat; } }
      } catch (e) {}
      st.titlePatIndex = { ts: Date.now(), map };
    }
    return st.titlePatIndex.map[collName] || null;
  }

  // Joined body text (one getLineItems), markers/tags stripped per line — context for {{firstline}}/{{body}}/AI.
  async _bodyText(record) {
    try {
      const items = await record.getLineItems(false);
      const out = [];
      for (const li of (items || [])) {
        let t = '';
        for (const s of (li.segments || [])) { if (s && typeof s.text === 'string') t += s.text; }
        t = t.replace(/^#+\s*/, '').replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\d+\.\s+/, '').replace(/^>\s+/, '').trim();
        if (t) out.push(t);
      }
      return out.join('\n');
    } catch (e) { return ''; }
  }

  // AI title from body text via the local /llm proxy (on-demand only — never the auto engine).
  async _aiTitle(body) {
    const b = String(body || '').slice(0, 1500);
    if (!b) return '';
    const prompt = 'Write a concise 4-6 word title for this note. Reply with ONLY the title — no quotes, no trailing punctuation.\n\nNote:\n' + b;
    try {
      const r = await this._llm(prompt, false);
      let t = (r && r.text) ? String(r.text).trim() : '';
      t = t.replace(/^["'`]+|["'`]+$/g, '').replace(/[.]+$/, '').replace(/[\r\n]+/g, ' ').trim();
      return t.slice(0, 80);
    } catch (e) { return ''; }
  }

  // Pre-expand {{Bare}} → {{record.Bare}} (skip reserved tokens), render against the record, clean to a title.
  // Body tokens {{firstline}}/{{body}}/{{summary}} resolve first (one getLineItems), then the prop/date render pass.
  async composeTitleFromRecord(record, pattern, collection) {
    if (!record || !pattern) return null;
    let pat = String(pattern);
    if (/\{\{\s*(firstline|body|summary)\s*\}\}/i.test(pat)) {
      const body = await this._bodyText(record);
      const safe = (s) => String(s || '').replace(/[{}]/g, '').trim();   // strip braces so inserted text isn't re-parsed as a token
      if (/\{\{\s*firstline\s*\}\}/i.test(pat)) { const fl = safe((body.split('\n').find(Boolean)) || ''); pat = pat.replace(/\{\{\s*firstline\s*\}\}/gi, fl); }
      if (/\{\{\s*summary\s*\}\}/i.test(pat)) { const s = safe(await this._aiTitle(body)); pat = pat.replace(/\{\{\s*summary\s*\}\}/gi, s); }
      if (/\{\{\s*body\s*\}\}/i.test(pat)) { pat = pat.replace(/\{\{\s*body\s*\}\}/gi, safe(body.replace(/\n+/g, ' ')).slice(0, 200)); }
    }
    const RESERVED = /^(date[:}]|prompt|var\.|ref:|tag:|ai::|include:|cursor|banner:|relate:|task:|record\.|schedule:|datetime:)/i;
    pat = pat.replace(/\{\{\s*([^}|]+?)\s*\}\}/g, (m, inner) => RESERVED.test(inner.trim()) ? m : ('{{record.' + inner.trim() + '}}'));
    let rendered = '';
    try { rendered = await this.renderTemplate(pat, { record, collection: collection || null, prompts: {}, vars: {}, empty: 'skip', templateName: 'rename' }); } catch (e) { return null; }
    let title = this.deriveTitle(this.previewText(rendered));
    title = title.replace(/\s{2,}/g, ' ').replace(/\s*[·—–\-:|/]+\s*$/, '').replace(/^\s*[·—–\-:|/]+\s*/, '').trim();
    return (title && title !== 'Untitled') ? title : null;
  }

  // Manual command — rename the OPEN record from its collection's Title Pattern.
  async renameFromActive() {
    const panel = this.ui.getActivePanel && this.ui.getActivePanel();
    const record = panel && panel.getActiveRecord && panel.getActiveRecord();
    const collection = panel && panel.getActiveCollection && panel.getActiveCollection();
    if (!record) { this.toast('Templater', 'No active record — open a note first.'); return; }
    const collName = (collection && collection.getName && collection.getName()) || null;
    const pattern = await this.findTitlePatternFor(collName);
    if (!pattern) { this.toast('Templater', 'No Title Pattern for "' + (collName || 'this collection') + '" — set one on its template (e.g. {{Type}} · {{Lead}}).'); return; }
    const title = await this.composeTitleFromRecord(record, pattern, collection);
    if (!title) { this.toast('Templater', 'Pattern produced no value — fill the properties it references.'); return; }
    const cur = (record.getName && record.getName()) || '';
    if (title === cur) { this.toast('Templater', 'Title already up to date.'); return; }
    const ok = await this.trySetRecordTitle(record, title);
    this.toast('Templater', ok ? ('Renamed → ' + title) : 'Could not rename (collection has no Name/Title field).');
  }

  // ========================================================================
  // Auto-title engine (v2.28) — type the body, the title builds itself (set-once-until-manual)
  // ========================================================================

  // Is this template's Auto Title choice "On"?
  _autoTitleOn(tmpl) {
    try {
      const p = tmpl.prop && tmpl.prop(F_AUTOTITLE);
      if (p) { if (p.choiceLabel) { const cl = p.choiceLabel(); if (cl) return /^on$/i.test(cl); } if (p.text) { const t = p.text(); if (t) return /^on$/i.test(t); } }
    } catch (e) {}
    return false;
  }

  // Templates with Auto Title=On, bucketed by inferred strategy (firstline/body/summary tokens → body, else prop).
  // { body: {collName→pattern}, prop: {collName→pattern} }. 30s TTL.
  async getAutoTitleIndex() {
    const st = this._state;
    if (st.autoTitleIndex && (Date.now() - st.autoTitleIndex.ts) < TRIGGER_TTL_MS) return st.autoTitleIndex.idx;
    const idx = { body: {}, prop: {} };
    try {
      const cols = await this.getCollectionsCached();
      const coll = cols.find(c => c && c.getName && c.getName() === TEMPLATES_COLL) || null;
      if (coll) {
        for (const r of await this._getRecordsCached(coll)) {
          if (!this._autoTitleOn(r)) continue;
          const pat = this.titlePatternOf(r); if (!pat) continue;
          const tc = this._templatePinnedCollection(r); if (!tc) continue;
          const bucket = /\{\{\s*(firstline|body|summary)\s*\}\}/i.test(pat) ? idx.body : idx.prop;
          if (!bucket[tc]) bucket[tc] = pat;
        }
      }
    } catch (e) { console.warn('[Templater] getAutoTitleIndex', e); }
    st.autoTitleIndex = { ts: Date.now(), idx };
    st.hasBodyAutoTitle = Object.keys(idx.body).length > 0; // P1-2: cheap gate for the per-keystroke path
    return idx;
  }

  _collByName(name) {
    return this.getCollectionsCached().then(cols => cols.find(c => c && c.getName && c.getName() === name) || null);
  }

  // The "leave my title alone" gate: only auto-title while the title is auto-OWNED —
  // empty / default-ish (Untitled, New …) OR equal to the last value the engine stamped (localStorage).
  _titleIsAutoOwned(record, guid) {
    let cur = '';
    try { cur = (record.getName && record.getName()) || ''; } catch (e) {}
    cur = cur.trim();
    if (!cur) return true;
    if (/^untitled\b/i.test(cur) || /^new\s/i.test(cur)) return true;
    try { const last = localStorage.getItem('tmpl-autotitle-' + guid); if (last != null && last === cur) return true; } catch (e) {}
    return false;
  }

  // Compose + set the title for a record IF it's still auto-owned. Loop-safe via _applying.
  async autoTitle(record, collName, pattern) {
    try {
      if (!record || !pattern) return;
      const guid = record.guid || (record.getGuid && record.getGuid()); if (!guid) return;
      if (this._state.applying.has(guid)) return;
      if (!this._titleIsAutoOwned(record, guid)) return;   // user typed their own title → locked
      const title = await this.composeTitleFromRecord(record, pattern, await this._collByName(collName));
      if (!title) return;
      let cur = ''; try { cur = (record.getName && record.getName()) || ''; } catch (e) {}
      if (title === cur.trim()) { try { localStorage.setItem('tmpl-autotitle-' + guid, title); } catch (e) {} return; }
      this._state.applying.add(guid);
      try {
        const ok = await this.trySetRecordTitle(record, title);
        if (ok) { try { localStorage.setItem('tmpl-autotitle-' + guid, title); } catch (e) {} }
      } finally { setTimeout(() => { try { this._state.applying.delete(guid); } catch (e) {} }, 4000); }
    } catch (e) { console.warn('[Templater] autoTitle', e); }
  }

  // Body-strategy hook off lineitem.updated: resolve the edited line's record + collection, debounce per record.
  async _maybeAutoTitleFromLine(ev) {
    try {
      // P1-2: cheap synchronous gate — skip the async index + getLineItem/getRecord/collection resolution that
      // used to run on EVERY keystroke. hasBodyAutoTitle is recomputed when the index (re)builds; null=unknown
      // (evaluate once), false=no body-auto-title templates exist (bail instantly).
      if (this._state.hasBodyAutoTitle === false) return;
      if (this._state.hasBodyAutoTitle == null) { const idx0 = await this.getAutoTitleIndex(); this._state.hasBodyAutoTitle = Object.keys(idx0.body).length > 0; if (!this._state.hasBodyAutoTitle) return; }
      const lineGuid = ev && ev.lineItemGuid; if (!lineGuid) return;
      if (!this._state.autoTitleDebounce) this._state.autoTitleDebounce = new Map();
      const dk = 'body:' + lineGuid;
      const prev = this._state.autoTitleDebounce.get(dk); if (prev) clearTimeout(prev);
      // Defer ALL resolution into the debounced callback — nothing heavy runs per keystroke.
      const h = setTimeout(async () => {
        try {
          this._state.autoTitleDebounce.delete(dk);
          const idx = await this.getAutoTitleIndex(); if (!Object.keys(idx.body).length) return;
          let li = ev && ev.getLineItem ? ev.getLineItem() : null; if (li && li.then) li = await li; if (!li) return;
          const rec = li.getRecord ? li.getRecord() : null; if (!rec) return;
          const guid = rec.guid || (rec.getGuid && rec.getGuid()); if (!guid) return;
          let collName = ev.collectionGuid ? await this.collectionNameByGuid(ev.collectionGuid) : null;
          let pat = collName ? idx.body[collName] : null;
          if (!pat) { const found = await this._bodyCollForRecord(guid, idx); if (found) { collName = found.name; pat = found.pat; } }
          if (!pat) return;
          await this.autoTitle(rec, collName, pat);
        } catch (e) {}
      }, AUTOTITLE_DEBOUNCE_MS);
      this._state.autoTitleDebounce.set(dk, h);
    } catch (e) { console.warn('[Templater] _maybeAutoTitleFromLine', e); }
  }

  // Fallback when the lineitem event carries no usable collectionGuid: find which body-strategy collection owns this record.
  // Cached guid→{name,pat} per body collection (60s) so we don't scan all records per keystroke.
  async _bodyCollForRecord(recGuid, idx) {
    try {
      const st = this._state;
      if (!st.bodyMembers || (Date.now() - st.bodyMembers.ts) > COLL_CACHE_TTL_MS) {
        const map = new Map();
        const cols = await this.getCollectionsCached();
        for (const cn of Object.keys(idx.body)) {
          const col = cols.find(c => c && c.getName && c.getName() === cn); if (!col) continue;
          try { for (const r of await this._getRecordsCached(col)) { const g = r.guid || (r.getGuid && r.getGuid()); if (g) map.set(g, { name: cn, pat: idx.body[cn] }); } } catch (e) {}
        }
        st.bodyMembers = { ts: Date.now(), map };
      }
      return st.bodyMembers.map.get(recGuid) || null;
    } catch (e) { return null; }
  }

  // AI on-demand command — title the OPEN record from a 4-6 word AI summary of its body. Sets regardless of the owned-guard.
  async aiTitleActive() {
    const panel = this.ui.getActivePanel && this.ui.getActivePanel();
    const record = panel && panel.getActiveRecord && panel.getActiveRecord();
    if (!record) { this.toast('Templater', 'No active record — open a note first.'); return; }
    const collection = panel && panel.getActiveCollection && panel.getActiveCollection();
    this.toast('Templater', 'Generating AI title…');
    const title = await this.composeTitleFromRecord(record, '{{summary}}', collection);
    if (!title) { this.toast('Templater', 'No AI title — check the note has body text and the /llm proxy (:8787) is running.'); return; }
    const guid = record.guid || (record.getGuid && record.getGuid());
    if (guid) this._state.applying.add(guid);
    try {
      const ok = await this.trySetRecordTitle(record, title);
      if (ok && guid) { try { localStorage.setItem('tmpl-autotitle-' + guid, title); } catch (e) {} }
      this.toast('Templater', ok ? ('Titled → ' + title) : 'Could not set title (collection has no Name/Title field).');
    } finally { if (guid) setTimeout(() => { try { this._state.applying.delete(guid); } catch (e) {} }, 4000); }
  }

  // Auto-rename path (Target: rename) — used by the Triggers engine on a record.created/updated trigger.
  async _fireRename(tmpl, opts) {
    opts = opts || {};
    let record = opts.record || null, recGuid = opts.recGuid || null;
    if (!record && recGuid) { record = this.data.getRecord(recGuid) || await this.pollRecord(recGuid); }
    if (!record) return false;
    if (!recGuid) recGuid = record.guid;
    const pattern = this.titlePatternOf(tmpl); if (!pattern) return false;
    const title = await this.composeTitleFromRecord(record, pattern, opts.targetCollection || null);
    if (!title) return false;
    const cur = (record.getName && record.getName()) || '';
    if (title === cur) return false; // idempotent — no write, no loop
    if (recGuid) this._state.applying.add(recGuid);
    try {
      const ok = await this.trySetRecordTitle(record, title);
      if (ok) { this.stampLastFired(tmpl); console.log('[Templater] renamed "' + cur + '" → "' + title + '" (' + (opts.reason || '') + ')'); }
      return ok;
    } finally { if (recGuid) setTimeout(() => { try { this._state.applying.delete(recGuid); } catch (e) {} }, 4000); }
  }

  // ----- frontmatter -----

  parseFrontmatter(rendered) {
    const text = String(rendered || "");
    if (!/^---\s*\r?\n/.test(text)) return { frontmatter: null, body: text };
    const lines = text.split('\n');
    // lines[0] === '---'
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end === -1) return { frontmatter: null, body: text };
    const fm = {};
    for (let i = 1; i < end; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const m = raw.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Frontmatter property values are PLAIN-TEXT typed properties. A resolved ref marker
      // in a frontmatter value collapses to its [[label]] display text (documented behavior:
      // frontmatter sets text/choice/datetime props, not relation/ref props). The bounded
      // marker regex means only the marker is replaced — surrounding value text is preserved.
      // A value that is PURELY a record ref -> keep the guid so a record-type (relation)
      // property gets a real link. previewText would otherwise collapse it to plain text.
      // One-or-more PURE record refs (nothing else) -> keep guid(s) for a record (relation)
      // property: a single guid, or an array for a many-relation.
      const refRe = new RegExp(M_OPEN + 'REF' + M_SEP + '([^' + M_SEP + M_CLOSE + ']+)(?:' + M_SEP + '[^' + M_CLOSE + ']*)?' + M_CLOSE, 'g');
      const refGuids = []; let rmm, refLen = 0;
      while ((rmm = refRe.exec(val)) !== null) { refGuids.push(rmm[1]); refLen += rmm[0].length; }
      if (refGuids.length && refLen === val.length) { if (key) fm[key] = { __relation: refGuids.length === 1 ? refGuids[0] : refGuids }; continue; }
      val = this.previewText(val);
      val = val.replace(/^\[\[(.+)\]\]$/, '$1');  // a non-pure ref in a property -> plain name
      if (key) fm[key] = val;
    }
    const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
    return { frontmatter: fm, body };
  }

  async applyFrontmatter(record, fm) {
    for (const key of Object.keys(fm)) {
      try {
        const p = record.prop && record.prop(key);
        if (!p) { console.warn('[Templater] frontmatter prop not found:', key); continue; }
        this.applyPropertyValue(p, key, fm[key]);
      } catch (e) { console.warn('[Templater] frontmatter set failed for', key, e); }
    }
  }

  applyPropertyValue(p, key, value) {
    // Relation: a record-type property set to the picked record's GUID. set(guid) on a record
    // property creates the link (linkedRecord() may read back null even when stored — verify
    // via get_record_properties, not the resolver). Accepts a guid or array of guids.
    if (value && typeof value === 'object' && value.__relation != null) {
      try { p.set(value.__relation); } catch (e) { console.warn('[Templater] relation set failed', key, e); }
      return;
    }
    if (value == null || value === "") return;

    // Choice? — choices() is non-null only for choice properties.
    try {
      if (p.choices) {
        const choices = p.choices();
        if (choices && choices.length) {
          if (/[,;]/.test(value)) {
            const parts = value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
            p.setChoice(parts);
          } else {
            p.setChoice(value);
          }
          return;
        }
      }
    } catch (e) {}

    // Datetime? Only attempt a datetime write when the property is plausibly a datetime
    // property AND the value parses. The key heuristic (or a date-looking value) gates the
    // attempt; on any failure fall back to p.set(String(value)). This avoids writing a
    // DateTimeValue object into a text field (the old `p.datetime || p.date` guard was a
    // no-op because those methods always exist on every PluginProperty).
    const keyLooksDate = /date|due|\bat\b|when|scheduled|time|start|end|birthday|contact/i.test(key);
    const valLooksDate = /^\d{4}-\d{2}-\d{2}/.test(value) ||
      /\b(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(value) ||
      /\b(next|last)\b/i.test(value) || /\d+\s*(day|days|week|weeks|month|months|year|years)\b/i.test(value);
    if (keyLooksDate || valLooksDate) {
      try {
        if (typeof DateTime !== 'undefined' && DateTime.parseDateTimeString) {
          const dt = DateTime.parseDateTimeString(value);
          if (dt && dt.value) {
            // If the prop rejects the DateTimeValue (it's actually a text prop), the set()
            // throws and we fall through to the plain-text write below.
            try { p.set(dt.value()); return; }
            catch (e2) { /* fall through to text */ }
          }
        }
      } catch (e) { /* fall through */ }
    }

    // Number?
    if (/^-?\d+(\.\d+)?$/.test(value) && p.number) {
      try { p.set(Number(value)); return; } catch (e) {}
    }

    // Plain text.
    try { p.set(String(value)); } catch (e) { console.warn('[Templater] set text prop failed', key, e); }
  }

  // A template body may carry the directive <!--PLEXUS-PROMOTE--> to mean "after applying, promote my
  // native tasks → Rich Tasks (linked to this record) via the Task Engine". The new record doesn't exist
  // at <%* %> render time (the body renders with record:null before createRecord), so this runs POST-apply.
  async _promoteAfterApply(record) {
    try {
      const te = (typeof window !== 'undefined') ? window.__taskEngine : null;
      if (!record || !record.guid || !te || typeof te.promoteRecordTasks !== 'function') return;
      await new Promise(r => setTimeout(r, 700)); // let the freshly-written native task lines settle
      await te.promoteRecordTasks(record.guid);
    } catch (e) { console.warn('[Templater] post-apply promote failed', e); }
  }

  // ----- body writer (segment-aware, nested) -----

  async writeBody(record, body, opts) {
    const flat = !!(opts && opts.flat);
    const lines = body.split('\n');
    // Track parents per indent LEVEL so nested bullets nest correctly. Indent is normalized
    // to a level (2 spaces or 1 tab = one level) before the stack comparison, so 2-space and
    // 4-space markdown both nest to the author's intent. createLineItem(parent, null, ...)
    // PREPENDS at the parent's start, so each new sibling lands ABOVE the previous one and the
    // whole body renders REVERSED. To append in author order, pass the previous sibling under
    // the same parent as afterItem. lastChildOf maps a parent (or ROOT) -> its last inserted child.
    const stack = []; // [{level, item}] — bullet/list indentation WITHIN the current heading scope
    const headingStack = []; // [{size, item}] — heading outline scopes; a heading PARENTS the lines beneath it
    const ROOT = {};
    const lastChildOf = new Map();
    let cursorGuid = null; // TP-3: the line carrying {{cursor}} (navigated-to after apply)
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const indentMatch = raw.match(/^([\t ]*)/);
      const indentStr = indentMatch ? indentMatch[1] : "";
      const spaces = indentStr.replace(/\t/g, '  ').length;
      const level = Math.floor(spaces / 2);
      let line = raw.trim();
      let wantCursor = false;
      if (line.includes('<!--PLEXUS-CURSOR-->')) { wantCursor = true; line = line.replace(/<!--PLEXUS-CURSOR-->/g, '').trim(); }

      let type = 'text';
      let content = line;
      let props = null;

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        type = 'heading';
        content = headingMatch[2];
        props = { heading_size: Math.min(headingMatch[1].length, 6) };
      } else if (/^>\s+/.test(line)) {
        type = 'quote';
        content = line.replace(/^>\s+/, '');
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        // Markdown horizontal rule (`---`, `***`, `___`) — checked BEFORE the bullet rules
        // so `---` isn't mis-read as an empty bullet. The SDK's PluginLineItemType enum has
        // NO 'hr' member (createLineItem(type='hr') is rejected), so render it as a plain
        // `text` divider (a supported type) — the rule survives in the written output.
        type = 'text';
        content = '———';
      } else if (/^[-*+]\s*\[[ xX]\]/.test(line)) {
        // Task — content OPTIONAL. `- [ ]` with no trailing text => a real EMPTY task line
        // (was previously dropped to a "[ ]" plain bullet because the old regex demanded text).
        type = 'task';
        content = line.replace(/^[-*+]\s*\[[ xX]\]\s*/, '');
      } else if (/^[-*+](?:\s+.*)?$/.test(line)) {
        // Bullet — content OPTIONAL. A bare `-` / `- ` => a real EMPTY bullet line (was
        // previously written as the literal text "-"). `---` is handled by the HR branch above.
        type = 'ulist';
        content = line.replace(/^[-*+]\s*/, '');
      } else if (/^\d+\.(?:\s+.*)?$/.test(line)) {
        type = 'olist';
        content = line.replace(/^\d+\.\s*/, '');
      }

      const nestable = (type === 'ulist' || type === 'olist' || type === 'task');
      let parentItem = null;
      if (flat) {
        // legacy: bullets nest under bullets by indent; headings/text/quote reset to root ({"nest":"flat"})
        if (nestable) {
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          parentItem = stack.length ? stack[stack.length - 1].item : null;
        } else { stack.length = 0; }
      } else if (type === 'heading') {
        // a heading opens an outline scope: it nests under any SHALLOWER heading, else the root.
        const size = props.heading_size;
        while (headingStack.length && headingStack[headingStack.length - 1].size >= size) headingStack.pop();
        parentItem = headingStack.length ? headingStack[headingStack.length - 1].item : null;
        stack.length = 0; // new heading scope resets bullet nesting
      } else {
        // non-heading lines parent under the current heading scope (or root when no heading yet).
        const scopeParent = headingStack.length ? headingStack[headingStack.length - 1].item : null;
        if (nestable) {
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          parentItem = stack.length ? stack[stack.length - 1].item : scopeParent;
        } else { stack.length = 0; parentItem = scopeParent; }
      }

      let segments = this.parseInlineSegments(content);
      if (!segments.length) segments = [{ type: 'text', text: '' }];  // empty bullet/task still needs a segment
      const parentKey = parentItem || ROOT;
      const afterItem = lastChildOf.get(parentKey) || null;
      let created = null;
      try {
        // parentItem + afterItem are PluginLineItem OBJECTS (or null). afterItem = the previous
        // sibling under this parent, so lines append in author order instead of reversing.
        created = await record.createLineItem(parentItem, afterItem, type, segments, props);
      } catch (e) {
        console.warn('[Templater] createLineItem failed for', type, line, e);
      }
      if (created) {
        lastChildOf.set(parentKey, created);
        if (type === 'heading' && !flat) headingStack.push({ size: props.heading_size, item: created });
        else if (nestable) stack.push({ level, item: created });
        if (wantCursor && created.guid) cursorGuid = created.guid; // TP-3
      }
    }
    return cursorGuid;
  }

  // Segment-aware tokenizer. Emits ref / datetime / hashtag / bold / italic / code segments
  // from the bounded sentinel markers (REF/TAG/DATE) and inline markdown; everything else is text.
  // The bounded marker class never swallows trailing content, so a line with two refs
  // (or a ref followed by text/#tag/date) segments correctly.
  parseInlineSegments(line) {
    const str = String(line || "");
    const segments = [];
    // Composite, in priority order: sentinel marker (1,2) | **bold** (3) | `code` (4) |
    // *italic* (5) | inline #hashtag (6). Bold is matched before italic so `**` is consumed
    // as one token, not two italics. Non-greedy inner classes keep each token bounded.
    const re = new RegExp(
      M_OPEN + "(REF|TAG|DATE)" + M_SEP + "([^" + M_CLOSE + "]*)" + M_CLOSE +
      "|\\*\\*([^*]+?)\\*\\*" +
      "|`([^`]+)`" +
      "|\\*([^*]+?)\\*" +
      "|(#[^\\s#" + M_OPEN + M_SEP + M_CLOSE + "]+)",
      "g"
    );
    let last = 0, m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) segments.push({ type: 'text', text: str.slice(last, m.index) });
      if (m[1] === "REF") {
        const parts = m[2].split(M_SEP);
        const guid = parts[0];
        const label = parts.length > 1 ? parts.slice(1).join(M_SEP).trim() : "";
        const refText = { guid: guid };
        if (label) refText.title = label;
        segments.push({ type: 'ref', text: refText });
      } else if (m[1] === "TAG") {
        let tag = m[2].trim();
        if (!tag.startsWith('#')) tag = '#' + tag;
        segments.push({ type: 'hashtag', text: tag });
      } else if (m[1] === "DATE") {
        // TP-1: datetime segment — prefer the canonical DateTime.parseDateTimeString().value() object (rule 42:
        // a bare string can render blank / not schedule); fall back to the raw string if DateTime is unavailable.
        let val = null; try { if (typeof DateTime !== 'undefined' && DateTime.parseDateTimeString) val = DateTime.parseDateTimeString(m[2]).value(); } catch (_e) {}
        // Parses to a real datetime -> a schedulable date chip. Otherwise (a display-only format
        // like "Fri, Jun 19" with no year) emit the formatted string as PLAIN TEXT, NOT a blank
        // datetime segment (rule 42: a bare-string datetime renders blank).
        segments.push(val ? { type: 'datetime', text: val } : { type: 'text', text: m[2] });
      } else if (m[3] !== undefined) {
        segments.push({ type: 'bold', text: m[3] });
      } else if (m[4] !== undefined) {
        segments.push({ type: 'code', text: m[4] });
      } else if (m[5] !== undefined) {
        segments.push({ type: 'italic', text: m[5] });
      } else if (m[6] !== undefined) {
        segments.push({ type: 'hashtag', text: m[6] });
      }
      last = m.index + m[0].length;
    }
    if (last < str.length) segments.push({ type: 'text', text: str.slice(last) });
    if (!segments.length) segments.push({ type: 'text', text: '' });
    return segments;
  }

  // ----- audit -----

  async writeAuditRow(template, targetRecordGuid, targetColl, title, renderedText) {
    const auditColl = await this.getAuditCollection();
    if (!auditColl) { console.warn('[Templater] no audit collection — skipped'); return; }
    const tName = this.tName(template);
    const auditTitle = (tName + " → " + title).slice(0, 200);
    const newGuid = auditColl.createRecord(auditTitle);
    if (!newGuid) return;
    const auditRec = await this.pollRecord(newGuid);
    if (!auditRec) return;
    const set = (label, value) => {
      try {
        const p = auditRec.prop && auditRec.prop(label);
        if (!p) return;
        if (label === "Applied At") {
          if (p.setFromDate) { p.setFromDate(new Date()); return; }
        }
        if (p.set) p.set(value);
      } catch (e) {}
    };
    let tguid = "";
    try { tguid = template.guid || ""; } catch (e) {}
    const ver = this.tVersion(template);
    set("Template", tName + (ver ? (" v" + ver) : "") + (tguid ? (" (" + tguid + ")") : ""));
    set("Target Record", title + (targetRecordGuid ? (" (" + targetRecordGuid + ")") : ""));
    set("Target Collection", (targetColl && targetColl.getName) ? targetColl.getName() : "?");
    set("Applied At", new Date());
    set("Rendered Output", String(renderedText || "").slice(0, 4000));
  }

  // ========================================================================
  // Slash /tmpl emulation
  // ========================================================================

  onLineItemUpdated(ev) {
    try {
      if (!ev || !ev.hasSegments || !ev.hasSegments()) return;
      const guid = ev.lineItemGuid;
      if (!guid) return;
      if (this._state.clearing.has(guid)) return;
      const lastFire = this._state.slashCooldown.get(guid) || 0;
      if (Date.now() - lastFire < SLASH_COOLDOWN_MS) return;

      const segs = ev.getSegments ? ev.getSegments() : null;
      if (!segs) return;
      // P1-2: cheap pre-check — a /tmpl slash command always begins with '/'. Skip the join+regex for ordinary
      // lines (the common case) and go straight to the now-cheap auto-title path.
      const first = (segs.length && segs[0] && typeof segs[0].text === 'string') ? segs[0].text.replace(/^\s+/, '') : '';
      if (first.charAt(0) !== '/') { this._maybeAutoTitleFromLine(ev); return; }
      const text = segs.map(s => (s && typeof s.text === 'string' ? s.text : '')).join('').trim();
      const m = text.match(SLASH_RE);
      if (!m) { this._maybeAutoTitleFromLine(ev); return; }   // not a /tmpl slash → maybe auto-title from the body

      const query = (m[1] || '').trim();
      this._state.slashCooldown.set(guid, Date.now());
      this._state.clearing.add(guid);

      // Clear the /tmpl text from the line, then open the picker.
      const li = ev.getLineItem ? ev.getLineItem() : null;
      const after = () => {
        setTimeout(() => { try { this._state.clearing.delete(guid); this._state.slashCooldown.delete(guid); } catch (e) {} }, SLASH_COOLDOWN_MS + 50);
        this.openPicker(query || null);
      };
      if (li && li.then) {
        li.then((item) => {
          if (item && item.setSegments) {
            item.setSegments([{ type: 'text', text: '' }]).catch(() => {});
          }
          after();
        }).catch(() => { after(); });
      } else {
        after();
      }
    } catch (e) {
      console.warn('[Templater] slash handler error:', e);
    }
  }

  // ========================================================================
  // Auto-apply on record.created  (Triggers auto:<Collection>)
  // ========================================================================

  // TS-7: does a record carry the #auto (or #templater/auto) sentinel that opts a REMOTE creation into auto-apply?
  async recordHasAutoSentinel(r) {
    try { const items = await r.getLineItems(); for (const li of (items || [])) for (const s of (li.segments || [])) { if (s && s.type === 'hashtag' && /^#(auto|templater\/auto)$/i.test(String(s.text || ''))) return true; } } catch (e) {}
    return false;
  }
  // P1-3: a template edit must clear the derived index caches (they have their own 30s TTL, so edits to
  // Trigger On / Title Pattern / Auto Title were ignored for up to 30s even though _recSnap was invalidated).
  _invalidateTemplateIndexes() {
    const st = this._state; if (!st) return;
    st.triggerIndex = null; st.autoTitleIndex = null; st.titlePatIndex = null; st.autoIndex = null; st.bodyMembers = null;
    st.hasBodyAutoTitle = null; // re-evaluate on next keystroke (a template may have gained/lost body auto-title)
  }
  async onRecordCreated(ev) {
    try {
      if (!ev) return;
      try { if (ev.collectionGuid && this._recSnap) this._recSnap.delete(ev.collectionGuid); } catch (e) {} // T3: invalidate snapshot for the changed collection
      // Only react to LOCAL creations by default — a '*' listener fires on every connected client. TS-7: a
      // REMOTE creation (MCP agent / cron) auto-applies only when the new record carries an explicit #auto tag.
      const remote = ev.source && ev.source.isLocal === false;
      const recGuid = ev.recordGuid, collGuid = ev.collectionGuid;
      if (!recGuid || !collGuid) return;
      if (this._state.applying.has(recGuid)) return;      // the engine's own create (create-mode) → don't re-fire
      if (this._state.autoFired.has(recGuid)) return;

      const collName = await this.collectionNameByGuid(collGuid);
      if (!collName) return;
      if (collName === TEMPLATES_COLL || AUDIT_COLL_CANDIDATES.includes(collName)) { if (collName === TEMPLATES_COLL) this._invalidateTemplateIndexes(); return; }

      // Unified index: legacy auto:<Coll> (Triggers) + new Trigger On: record.created:<Coll>.
      const idx = await this.getTriggerIndex();
      const tmpls = idx.byEvent['record.created'][collName] || [];
      if (!tmpls.length) return;
      if (remote) { let ok = false; try { const r = await this.data.getRecord(recGuid); if (r) ok = await this.recordHasAutoSentinel(r); } catch (e) {} if (!ok) return; }

      // Loop prevention: per-RECORD sentinel + cooldown.
      const lastRec = this._state.autoCooldown.get(recGuid) || 0;
      if (Date.now() - lastRec < AUTO_COOLDOWN_MS) return;
      this._state.autoFired.add(recGuid);
      this._state.autoCooldown.set(recGuid, Date.now());
      setTimeout(() => { try { this._state.autoFired.delete(recGuid); this._state.autoCooldown.delete(recGuid); } catch (e) {} }, AUTO_COOLDOWN_MS);

      const record = await this.pollRecord(recGuid);
      if (!record) return;
      const cols = await this.getCollectionsCached();
      const targetCollection = cols.find(c => { try { return c.getGuid && c.getGuid() === collGuid; } catch (e) { return false; } }) || null;

      for (const tmpl of tmpls) {
        try {
          if (!(await this.evalCondition(this.conditionOf(tmpl), recGuid))) continue;
          await this.fireTemplate(tmpl, { record, recGuid, targetCollection, mode: 'update', reason: 'record.created' });
        } catch (e) { console.warn('[Templater] created-trigger error', e); }
      }
    } catch (e) {
      console.warn('[Templater] auto-apply error:', e);
    }
  }

  // Collection list + auto-template trigger index, cached on _state with a short TTL —
  // record.created fires on every local creation and must not pay 3x getAllCollections
  // plus a full Templates scan per event.
  async getCollectionsCached() {
    const st = this._state;
    if (st.collCache && (Date.now() - st.collCache.ts) < COLL_CACHE_TTL_MS) return st.collCache.cols;
    const cols = (await this.data.getAllCollections()) || [];
    st.collCache = { ts: Date.now(), cols };
    return cols;
  }

  async getAutoTemplateIndex() {
    const st = this._state;
    if (st.autoIndex && (Date.now() - st.autoIndex.ts) < COLL_CACHE_TTL_MS) return st.autoIndex.map;
    const map = new Map();
    try {
      const cols = await this.getCollectionsCached();
      const coll = cols.find(c => c && c.getName && c.getName() === TEMPLATES_COLL) || null;
      if (coll) {
        const records = await coll.getAllRecords();
        for (const r of records) {
          for (const t of this.tTriggers(r)) {
            if (/^auto:/i.test(t)) {
              const name = t.replace(/^auto:/i, '').trim();
              if (name && !map.has(name)) map.set(name, r);
            }
          }
        }
      }
    } catch (e) {}
    st.autoIndex = { ts: Date.now(), map };
    return map;
  }

  async collectionNameByGuid(guid) {
    try {
      const cols = await this.getCollectionsCached();
      const c = cols.find(cc => { try { return cc.getGuid && cc.getGuid() === guid; } catch (e) { return false; } });
      return c ? c.getName() : null;
    } catch (e) { return null; }
  }

  async findAutoTemplateFor(collName) {
    try {
      const map = await this.getAutoTemplateIndex();
      return map.get(collName) || null;
    } catch (e) { return null; }
  }

  // ========================================================================
  // Triggers engine (v2.26) — schedule / event / condition based runs
  // ========================================================================

  // --- trigger-config readers (text props; empty = unset) ---
  schedOf(tmpl) { return (this.tField(tmpl, F_SCHEDULE) || '').trim(); }
  triggerOnOf(tmpl) { return (this.tField(tmpl, F_TRIGGERON) || '').trim(); }
  conditionOf(tmpl) { return (this.tField(tmpl, F_CONDITION) || '').trim(); }
  targetOf(tmpl) { return (this.tField(tmpl, F_TARGET) || '').trim(); }
  guidOf(tmpl) { try { return tmpl.guid || (tmpl.getGuid && tmpl.getGuid()) || null; } catch (e) { return null; } }

  // Last-Fired dedup stamp — in-memory map (fast) + localStorage mirror + the synced datetime prop.
  stampLastFired(tmpl) {
    const now = Date.now(); const g = this.guidOf(tmpl);
    if (g) { this._state.lastFired.set(g, now); try { localStorage.setItem('tmpl-fired-' + g, String(now)); } catch (e) {} }
    try { const p = tmpl.prop && tmpl.prop(F_LASTFIRED); if (p && p.setFromDate) p.setFromDate(new Date(now)); } catch (e) {}
  }
  readLastFired(tmpl) {
    const g = this.guidOf(tmpl);
    if (g && this._state.lastFired.has(g)) return this._state.lastFired.get(g);
    if (g) { try { const ls = localStorage.getItem('tmpl-fired-' + g); if (ls) { const n = parseInt(ls, 10); if (!isNaN(n)) { this._state.lastFired.set(g, n); return n; } } } catch (e) {} }
    try { const d = tmpl.date && tmpl.date(F_LASTFIRED); if (d && d.getTime) return d.getTime(); } catch (e) {}
    return 0;
  }

  // Direct synced read, deliberately bypassing this client's in-memory/localStorage mirrors.
  // It is used only by the distributed schedule claim below, where every independent Thymer
  // client must observe the single scalar value that won host convergence.
  _readSyncedLastFired(tmpl) {
    try {
      const d = tmpl && tmpl.date && tmpl.date(F_LASTFIRED);
      if (!d) return 0;
      if (typeof d.getTime === 'function') { const n = Number(d.getTime()); return Number.isFinite(n) ? n : 0; }
      if (typeof d.value === 'function') {
        const v = d.value();
        if (v && typeof v.getTime === 'function') { const n = Number(v.getTime()); return Number.isFinite(n) ? n : 0; }
        const n = Number(v); if (Number.isFinite(n)) return n;
      }
    } catch (_e) {}
    return 0;
  }

  _scheduleClaimId() {
    if (this._state.scheduleClaimClientId) return this._state.scheduleClaimClientId;
    const key = 'templater-schedule-client-v1';
    let id = '';
    try { id = localStorage.getItem(key) || ''; } catch (_e) {}
    if (!id) {
      try { id = crypto.randomUUID(); } catch (_e) { id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
      try { localStorage.setItem(key, id); } catch (_e) {}
    }
    this._state.scheduleClaimClientId = id;
    return id;
  }

  _scheduleClaimMs(due) {
    const text = this._scheduleClaimId() + '|' + String(due);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    // The claim remains strictly BEFORE the due occurrence, so a crashed claimant never suppresses
    // the next retry. Second precision survives Thymer datetime normalization; 50k slots make an
    // accidental same-occurrence collision between independent clients vanishingly unlikely.
    return Number(due) - (1 + ((hash >>> 0) % 50000)) * 1000;
  }

  async _claimScheduleOccurrence(tmpl, due) {
    const guid = this.guidOf(tmpl);
    let prop = null;
    try { prop = tmpl && tmpl.prop && tmpl.prop(F_LASTFIRED); } catch (_e) {}
    if (!guid || !prop || typeof prop.setFromDate !== 'function') return { claimed: true, fallback: 'local-only' };
    const claimMs = this._scheduleClaimMs(due);
    try {
      const write = prop.setFromDate(new Date(claimMs));
      if (write && typeof write.then === 'function') await write;
    } catch (_e) { return { claimed: true, fallback: 'claim-write-unavailable' }; }

    // Async settling never blocks editor interaction. It gives Desktop and browser clients time to
    // converge their competing scalar claims before either creates a Journal line.
    const settleMs = Math.max(0, Number(this._state.scheduleClaimSettleMs) || 0);
    await new Promise(resolve => setTimeout(resolve, settleMs));
    let current = tmpl;
    try {
      let resolved = this.data && this.data.getRecord && this.data.getRecord(guid);
      if (resolved && typeof resolved.then === 'function') resolved = await resolved;
      if (resolved) current = resolved;
    } catch (_e) {}
    const observed = this._readSyncedLastFired(current);
    if (observed) this._state.lastFired.set(guid, observed);
    return { claimed: Math.abs(observed - claimMs) < 1000, fallback: null, claimMs, observed };
  }

  // Parse the comma list of event specs from Trigger On + legacy auto:<Coll> in the Triggers choice.
  triggerEventSpecs(tmpl) {
    const out = [], seen = new Set();
    const add = (type, coll) => { const k = type + '|' + (coll || ''); if (!seen.has(k)) { seen.add(k); out.push({ type, coll: coll || null }); } };
    for (let tok of this.triggerOnOf(tmpl).split(',')) {
      tok = tok.trim(); if (!tok) continue; let m;
      if ((m = tok.match(/^record\.created\s*:\s*(.+)$/i))) add('record.created', m[1].trim());
      else if ((m = tok.match(/^record\.updated\s*:\s*(.+)$/i))) add('record.updated', m[1].trim());
      else if (/^journal\.open$/i.test(tok)) add('journal.open');
      else if (/^app\.open$/i.test(tok)) add('app.open');
    }
    try { for (const t of this.tTriggers(tmpl)) { const mm = String(t).match(/^auto:\s*(.+)$/i); if (mm) add('record.created', mm[1].trim()); } } catch (e) {}
    return out;
  }

  // One scan of the Templates collection → schedules[] + events grouped by type/collection. 30 s TTL.
  async getTriggerIndex() {
    const st = this._state;
    if (st.triggerIndex && (Date.now() - st.triggerIndex.ts) < TRIGGER_TTL_MS) return st.triggerIndex.idx;
    const idx = { schedules: [], byEvent: { 'record.created': {}, 'record.updated': {}, 'journal.open': [], 'app.open': [] } };
    try {
      const cols = await this.getCollectionsCached();
      const coll = cols.find(c => c && c.getName && c.getName() === TEMPLATES_COLL) || null;
      if (coll) {
        const records = await this._getRecordsCached(coll);
        for (const r of records) {
          const sched = this.schedOf(r);
          if (sched) { const spec = this.parseSchedule(sched); if (spec) idx.schedules.push({ tmpl: r, spec }); }
          for (const ev of this.triggerEventSpecs(r)) {
            if (ev.type === 'record.created' || ev.type === 'record.updated') { const b = idx.byEvent[ev.type]; (b[ev.coll] = b[ev.coll] || []).push(r); }
            else if (ev.type === 'journal.open') idx.byEvent['journal.open'].push(r);
            else if (ev.type === 'app.open') idx.byEvent['app.open'].push(r);
          }
        }
      }
    } catch (e) { console.warn('[Templater] getTriggerIndex', e); }
    st.triggerIndex = { ts: Date.now(), idx };
    return idx;
  }

  // --- schedule parsing + most-recent-due computation ---
  parseSchedule(str) {
    const s = (str || '').trim().toLowerCase(); if (!s) return null; let m;
    if ((m = s.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/))) {
      const n = parseInt(m[1], 10), ms = (m[2][0] === 'h') ? n * 3600000 : n * 60000;
      if (ms >= 60000) return { kind: 'interval', ms, graceMs: ms, raw: str };
    }
    const tm = s.match(/(\d{1,2}):(\d{2})/);
    const hh = tm ? Math.min(23, parseInt(tm[1], 10)) : 9, mm = tm ? Math.min(59, parseInt(tm[2], 10)) : 0;
    const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    if (/\bweekdays?\b/.test(s)) return { kind: 'dow', days: [1, 2, 3, 4, 5], hh, mm, graceMs: 18 * 3600000, raw: str };
    if (/\bweekends?\b/.test(s)) return { kind: 'dow', days: [0, 6], hh, mm, graceMs: 18 * 3600000, raw: str };
    const days = [];
    for (const tok of s.split(/[,\s]+/)) { const r = tok.match(/^(\w{3})-(\w{3})$/); if (r && (r[1] in WD) && (r[2] in WD)) { for (let i = WD[r[1]]; ; i = (i + 1) % 7) { days.push(i); if (i === WD[r[2]]) break; } } else if (tok.slice(0, 3) in WD) days.push(WD[tok.slice(0, 3)]); }
    if (days.length) return { kind: 'dow', days: [...new Set(days)], hh, mm, graceMs: 18 * 3600000, raw: str };
    const dm = s.match(/^(\d{1,2})\s+\d{1,2}:\d{2}/); // "1 09:00" -> monthly day-of-month
    if (dm) { const d = parseInt(dm[1], 10); if (d >= 1 && d <= 31) return { kind: 'monthday', day: d, hh, mm, graceMs: 18 * 3600000, raw: str }; }
    return { kind: 'daily', hh, mm, graceMs: 18 * 3600000, raw: str };
  }
  lastDue(spec, nowMs) {
    if (!spec) return null;
    if (spec.kind === 'interval') return Math.floor(nowMs / spec.ms) * spec.ms;
    const at = ( d) => { const x = new Date(d); x.setHours(spec.hh, spec.mm, 0, 0); return x.getTime(); };
    if (spec.kind === 'daily') { const t = at(new Date(nowMs)); return t <= nowMs ? t : at(new Date(nowMs - 86400000)); }
    if (spec.kind === 'dow') { for (let b = 0; b < 8; b++) { const d = new Date(nowMs - b * 86400000); if (spec.days.indexOf(d.getDay()) >= 0) { const t = at(d); if (t <= nowMs) return t; } } return null; }
    if (spec.kind === 'monthday') {
      const now = new Date(nowMs); let y = now.getFullYear(), mo = now.getMonth();
      let cand = new Date(y, mo, spec.day, spec.hh, spec.mm, 0, 0);
      if (cand.getTime() > nowMs || cand.getMonth() !== mo) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } cand = new Date(y, mo, spec.day, spec.hh, spec.mm, 0, 0); }
      return cand.getTime();
    }
    return null;
  }
  nextDue(spec, nowMs) {
    if (!spec) return null;
    if (spec.kind === 'interval') return (Math.floor(nowMs / spec.ms) + 1) * spec.ms;
    const at = (d) => { const x = new Date(d); x.setHours(spec.hh, spec.mm, 0, 0); return x.getTime(); };
    if (spec.kind === 'daily') { const t = at(new Date(nowMs)); return t > nowMs ? t : at(new Date(nowMs + 86400000)); }
    if (spec.kind === 'dow') { for (let f = 0; f < 8; f++) { const d = new Date(nowMs + f * 86400000); if (spec.days.indexOf(d.getDay()) >= 0) { const t = at(d); if (t > nowMs) return t; } } return null; }
    if (spec.kind === 'monthday') { const ld = this.lastDue(spec, nowMs); const d = new Date(ld); let mo = d.getMonth() + 1, y = d.getFullYear(); if (mo > 11) { mo = 0; y += 1; } return new Date(y, mo, spec.day, spec.hh, spec.mm, 0, 0).getTime(); }
    return null;
  }

  // --- condition evaluator: empty -> true; weekday/day local fallbacks; Datacore; Prop=val ---
  _truthy(v) { if (v == null) return false; if (typeof v === 'boolean') return v; if (typeof v === 'number') return v !== 0; if (Array.isArray(v)) return v.length > 0; const s = String(v).trim().toLowerCase(); return s !== '' && s !== '0' && s !== 'false' && s !== 'no'; }
  _evalWeekdayDay(s) {
    const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; const now = new Date(); let m;
    if ((m = s.match(/^weekday\s*(=|in|!=)\s*(.+)$/i))) {
      const today = WD[now.getDay()]; const set = m[2].toLowerCase().replace(/weekdays?/g, 'mon-fri').replace(/weekends?/g, 'sat,sun'); const days = [];
      for (const tok of set.split(/[,\s]+/)) { const r = tok.match(/^(\w{3})-(\w{3})$/); if (r) { const a = WD.indexOf(r[1]), b = WD.indexOf(r[2]); if (a >= 0 && b >= 0) for (let i = a; ; i = (i + 1) % 7) { days.push(WD[i]); if (i === b) break; } } else if (WD.indexOf(tok.slice(0, 3)) >= 0) days.push(tok.slice(0, 3)); }
      const hit = days.indexOf(today) >= 0; return m[1] === '!=' ? !hit : hit;
    }
    if ((m = s.match(/^day\s*(=|!=)\s*(\d+)$/i))) { const hit = now.getDate() === parseInt(m[2], 10); return m[1] === '!=' ? !hit : hit; }
    return null;
  }
  _evalRecordProp(s, recordGuid) {
    if (!recordGuid) return null;
    const pm = s.match(/^`?([^`=!<>]+?)`?\s*(=|==|!=)\s*"?([^"]*)"?$/); if (!pm) return null;
    try { const rec = this.data.getRecord(recordGuid); if (!rec) return null; let val = ''; try { val = (rec.text && rec.text(pm[1].trim())) || ''; } catch (e) {} const eq = String(val).trim() === pm[3].trim(); return pm[2] === '!=' ? !eq : eq; } catch (e) { return null; }
  }
  async evalCondition(expr, recordGuid) {
    const s = (expr || '').trim(); if (!s) return true;
    const wd = this._evalWeekdayDay(s); if (wd !== null) return wd;
    try {
      const dc = window.__plexusDatacore;
      if (dc) {
        if (/^@/.test(s) && typeof dc.count === 'function') { const n = await dc.count(s); return (typeof n === 'number') ? n > 0 : this._truthy(n); }
        if (typeof dc.evaluate === 'function') { let r = await dc.evaluate(s, recordGuid || null); if (r && typeof r === 'object' && ('value' in r)) r = r.error ? undefined : r.value; if (r !== undefined) return this._truthy(r); }
      }
    } catch (e) {}
    const pr = this._evalRecordProp(s, recordGuid); if (pr !== null) return pr;
    return false; // condition specified but unevaluable → don't fire (safe)
  }

  // --- target resolution + journal record ---
  async getTodayJournalRecord() {
    try {
      const cols = await this.getCollectionsCached();
      const journal = cols.find(c => { try { return c.isJournalPlugin && c.isJournalPlugin(); } catch (e) { return false; } })
        || cols.find(c => { try { return c.getGuid && c.getGuid() === JOURNAL_COLL_GUID; } catch (e) { return false; } });
      if (!journal || !journal.getJournalRecord) return { journal, record: null };
      const user = (this.data.getActiveUsers && this.data.getActiveUsers()[0]) || null; if (!user) return { journal, record: null };
      const dt = (typeof DateTime !== 'undefined' && DateTime.parseDateTimeString) ? DateTime.parseDateTimeString('today') : undefined;
      const record = await journal.getJournalRecord(user, dt);
      return { journal, record: record || null };
    } catch (e) { console.warn('[Templater] getTodayJournalRecord', e); return { journal: null, record: null }; }
  }
  async resolveTarget(tmpl) {
    let tgt = this.targetOf(tmpl); if (!tgt) tgt = 'journal:today';
    if (/^rename$/i.test(tgt)) return null; // rename needs an existing record (event/manual only) — schedules skip it
    if (/^journal(:today|:?$)?$|^today$/i.test(tgt) || /^journal:today$/i.test(tgt)) {
      const j = await this.getTodayJournalRecord(); if (!j.record) return null;
      return { record: j.record, recGuid: j.record.guid, targetCollection: j.journal, mode: 'append' };
    }
    const cm = tgt.match(/^collection:\s*(.+)$/i);
    if (cm) { const name = cm[1].trim(); const cols = await this.getCollectionsCached(); const col = cols.find(c => c && c.getName && c.getName().toLowerCase() === name.toLowerCase()) || null; if (!col) return null; return { record: null, recGuid: null, targetCollection: col, mode: 'create' }; }
    return null;
  }

  // --- the shared render+apply (extracted from onRecordCreated) used by every trigger path ---
  // Strip dangling separators from auto-rendered (prompt-less) frontmatter values; drop any that go empty.
  // Mirrors the manual title cleanup (separator set [·—–|-]) so a value like " · " / "Note · " becomes
  // "" / "Note". A relation marker object is passed through untouched.
  _cleanAutoFrontmatter(fm) {
    const out = {};
    for (const k of Object.keys(fm)) {
      const v = fm[k];
      if (v && typeof v === 'object') { out[k] = v; continue; }
      const s = String(v == null ? '' : v)
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*[·—–|-]\s*([·—–|-]\s*)+/g, ' · ')
        .replace(/[·—–|-]\s*$/, '')
        .replace(/^\s*[·—–|-]\s*/, '')
        .trim();
      if (s) out[k] = s;
    }
    return out;
  }

  async fireTemplate(tmpl, opts) {
    opts = opts || {};
    if (opts.mode === 'rename' || /^rename$/i.test(this.targetOf(tmpl))) return await this._fireRename(tmpl, opts); // Target: rename → title from properties
    const mode = opts.mode || 'update';
    let record = opts.record || null, recGuid = opts.recGuid || null, targetCollection = opts.targetCollection || null;
    if (mode === 'create') {
      if (!targetCollection) return false;
      let guid = null; try { guid = targetCollection.createRecord(this.tName(tmpl) || 'Untitled'); } catch (e) {}
      if (!guid) return false; recGuid = guid; record = await this.pollRecord(guid); if (!record) return false;
    }
    if (!record) return false; if (!recGuid) recGuid = record.guid;
    if (recGuid) this._state.applying.add(recGuid); // guard: our own writes must not re-trigger record.updated/lineitem
    try {
      let content = await this.assembleTemplateSource(tmpl); if (!content) return false;
      try { const ext = (this.tField(tmpl, F_EXTENDS) || '').trim(); if (ext) { const p = await this.findTemplate(ext); if (p) { const pc = await this.assembleTemplateSource(p); if (pc) content = pc + "\n" + content; } } } catch (e) {}
      try { content = await this.resolveIncludes(content, 0, new Set()); } catch (e) {}
      let vars = { defaults: {} };
      try { const raw = this.tField(tmpl, F_VARS) || this.tField(tmpl, 'Variables'); if (raw && raw.trim()) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') vars = Object.assign({ defaults: {} }, parsed); } } catch (e) {}
      if (!vars.defaults) vars.defaults = {};
      const rendered = await this.renderTemplate(content, { record, collection: targetCollection, prompts: {}, vars: vars.defaults, empty: vars.empty || 'skip', templateName: this.tName(tmpl) });
      const parsed = this.parseFrontmatter(rendered);
      const targetIsJournal = this._recordApplyContext(record).isJournal;
      // Trigger/schedule renders run with NO prompt answers, so an interactive template's frontmatter
      // (e.g. `Title: {{prompt:Type}} · {{prompt:Title}}`) collapses to dangling separators (" · ").
      // Clean each value the way the manual title path does and DROP any that reduce to empty — so an
      // auto-applied template lays down a clean SCAFFOLD instead of clobbering the title with junk.
      if (parsed.frontmatter) parsed.frontmatter = this._cleanAutoFrontmatter(parsed.frontmatter);
      if (targetIsJournal) this._removeJournalTitleFields(parsed.frontmatter);
      const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(parsed.body || '');
      const originalBody = (parsed.body || '').replace(/<!--PLEXUS-PROMOTE-->/gi, '');
      // Append triggers are resumable and idempotent at the section boundary.
      // This second proof runs inside the target+template lock, after rendering,
      // so an interrupted earlier run or stale pre-lock probe cannot duplicate
      // sections that already landed; missing later sections are repaired.
      const body = mode === 'append' ? await this._mergeFilterBody(record, originalBody) : originalBody;
      if (mode === 'append' && !body.trim()) { this.stampLastFired(tmpl); return false; }
      if (mode !== 'append' && parsed.frontmatter && Object.keys(parsed.frontmatter).length) { try { await this.applyFrontmatter(record, parsed.frontmatter); } catch (e) {} }
      if (!targetIsJournal && (mode === 'create' || mode === 'update') && targetCollection) {
        try { await this.applyAutoTitleRule(record, targetCollection); } catch (e) { console.warn('[Templater] trigger Auto-title rule failed', e); }
      }
      if (body.trim()) await this.writeBody(record, body, { flat: vars && vars.nest === 'flat' });
      if (wantPromote) this._promoteAfterApply(record);
      try { const p = tmpl.prop && tmpl.prop(F_LASTUSED); if (p && p.setFromDate) p.setFromDate(new Date()); } catch (e) {}
      this.stampLastFired(tmpl);
      try { await this.writeAuditRow(tmpl, recGuid, targetCollection, (record.getName ? record.getName() : '(trigger)'), this.previewText(rendered)); } catch (e) {}
      console.log('[Templater] trigger fired "' + this.tName(tmpl) + '" (' + (opts.reason || '') + ' · ' + mode + ')');
      return true;
    } finally { if (recGuid) setTimeout(() => { try { this._state.applying.delete(recGuid); } catch (e) {} }, 4000); }
  }

  // --- schedule engine: fire any schedule whose most-recent occurrence hasn't fired yet (catch-up) ---
  async checkSchedules(reason) {
    let fired = 0;
    try {
      const idx = await this.getTriggerIndex(); const now = Date.now();
      for (const { tmpl, spec } of idx.schedules) {
        try {
          const due = this.lastDue(spec, now); if (due == null) continue;
          if (now - due > (spec.graceMs || 18 * 3600000)) continue;     // too stale → skip (don't fire a week of missed days)
          if (this.readLastFired(tmpl) >= due) continue;                 // cheap pre-check (already fired this occurrence)
          const gkey = this.guidOf(tmpl); if (!gkey) continue;
          // MULTI-CLIENT DEDUP: with 2+ Thymer tabs open, both instances tick on the same
          // minute and both pass readLastFired (the stamp only lands at the END of
          // fireTemplate), so a scheduled/daily template posts twice. Serialize the fire
          // across tabs of the same browser with an EXCLUSIVE per-occurrence Web Lock; the
          // re-check inside means a serialized second tab sees the first's stamp and skips.
          await this._withScheduleLock(gkey, due, async () => {
            if (this.readLastFired(tmpl) >= due) return;                 // another tab already fired + stamped this occurrence
            if (!(await this.evalCondition(this.conditionOf(tmpl)))) return;
            const tgt = await this.resolveTarget(tmpl); if (!tgt) { console.warn('[Templater] schedule: no target for "' + this.tName(tmpl) + '"'); return; }
            const claim = await this._claimScheduleOccurrence(tmpl, due);
            if (!claim.claimed) return;                                  // another Desktop/browser client won host convergence
            await this._withTargetTemplateLock(gkey, tgt.recGuid, async () => {
              if (tgt.mode === 'append' && await this._journalAlreadyHas(tgt.record, tmpl)) { this.stampLastFired(tmpl); return false; }
              if (await this.fireTemplate(tmpl, Object.assign({ reason: 'schedule:' + (reason || '') }, tgt))) { fired++; return true; }
              return false;
            });
          });
        } catch (e) { console.warn('[Templater] schedule fire error', e); }
      }
    } catch (e) { console.warn('[Templater] checkSchedules error', e); }
    return { fired };
  }

  // Cross-tab exclusive lock for ONE schedule occurrence — stops N open Thymer tabs
  // (same browser) from each firing a daily/scheduled template N times. The Web Locks
  // API grants an exclusive lock to exactly one tab per origin; ifAvailable:true means
  // if another tab already holds it the callback runs with lock===null and we return
  // WITHOUT firing (that other tab is doing it). Falls back to a synchronous
  // localStorage claim (also browser-shared) when Web Locks is unavailable.
  async _withScheduleLock(guid, due, fn) {
    const name = 'templater-sched-' + guid + '-' + due;
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        let ran = false;
        await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) return;              // another tab owns this occurrence — skip
          ran = true; await fn();
        });
        return ran;
      }
    } catch (e) { /* fall through to the localStorage claim */ }
    // Fallback (Web Locks absent): one key per template holding the last-claimed
    // occurrence; a tab claims by advancing it, others see it and skip.
    try {
      const key = 'tmpl-claim-' + guid;
      const prev = parseInt(localStorage.getItem(key) || '0', 10);
      if (prev >= due) return false;      // this occurrence already claimed by another tab
      localStorage.setItem(key, String(due));
    } catch (e) {}
    await fn();
    return true;
  }
  // Serialize every automatic append for one template+target, regardless of
  // which trigger discovered it (journal.open, schedule, or app.open). The old
  // locks were trigger-specific, so schedule and journal.open could both pass
  // the body probe before either had written its first line and append the same
  // dashboard twice. The content proof is deliberately re-read INSIDE this
  // transaction by each caller.
  async _withTargetTemplateLock(templateGuid, targetGuid, fn) {
    if (!templateGuid || !targetGuid || typeof fn !== 'function') return false;
    const name = 'templater-target-' + templateGuid + '-' + targetGuid;
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        let result = false;
        await navigator.locks.request(name, { mode: 'exclusive' }, async () => { result = await fn(); });
        return result;
      }
    } catch (_e) { /* fall through to this instance's promise queue */ }
    const locks = this._state.targetTemplateLocks || (this._state.targetTemplateLocks = new Map());
    const prior = locks.get(name) || Promise.resolve();
    let release; const gate = new Promise(resolve => { release = resolve; });
    const holder = prior.then(() => gate); locks.set(name, holder);
    try { await prior; return await fn(); }
    finally { release(); if (locks.get(name) === holder) locks.delete(name); }
  }
  // append-mode idempotence: skip if the day page already contains the template's first real heading text
  // (belt-and-suspenders behind the per-occurrence Last Fired dedup — so a lost stamp can't double-append).
  async _journalAlreadyHas(record, tmpl) {
    try {
      const probe = this._templateProbe(tmpl); if (!probe) return false;
      const items = await this._freshLineItems(record, true);
      for (const li of (items || [])) { let t = ''; for (const s of (li.segments || [])) if (s && typeof s.text === 'string') t += s.text; if (t.indexOf(probe) >= 0) return true; }
    } catch (e) {}
    return false;
  }
  // First distinctive content line of a template: skip frontmatter, heading markers, {{tokens}}, leading
  // symbols/emoji, and dc:/<%* lines — so the probe is a real heading like "Quick Log", not "---".
  _templateProbe(tmpl) {
    const lines = (this.tContent(tmpl) || '').split('\n'); let i = 0;
    if (lines[0] && lines[0].trim() === '---') { i = 1; while (i < lines.length && lines[i].trim() !== '---') i++; i++; }
    for (; i < lines.length; i++) {
      let ln = lines[i].replace(/^#+\s*/, '').replace(/\{\{[^}]*\}\}/g, '').replace(/^[^\w]+/, '').trim();
      if (/^(dc(\.js)?\s*:|<%)/i.test(ln) || ln === '---') continue;
      if (ln.length >= 4) return ln.slice(0, 28);
    }
    return '';
  }

  // --- event handlers ---
  async onRecordUpdated(ev) {
    try {
      try { if (ev && ev.collectionGuid && this._recSnap) this._recSnap.delete(ev.collectionGuid); } catch (e) {} // T3: invalidate snapshot for the changed collection
      if (!ev) return; const recGuid = ev.recordGuid, collGuid = ev.collectionGuid; if (!recGuid || !collGuid) return;
      if (this._state.applying.has(recGuid)) return;                    // our own write → ignore
      const collName = await this.collectionNameByGuid(collGuid); if (!collName) return;
      if (collName === TEMPLATES_COLL || AUDIT_COLL_CANDIDATES.includes(collName)) { if (collName === TEMPLATES_COLL) this._invalidateTemplateIndexes(); return; }
      // Auto Title (property strategy) — fill from props while still auto-owned. P2-9: debounce per record so a
      // burst of property edits collapses to one compose+set (was running on every record.updated).
      try {
        const ati = await this.getAutoTitleIndex(); const apat = ati.prop[collName];
        if (apat) {
          const dmap = this._state.autoTitleDebounce; const dk = 'prop:' + recGuid;
          if (dmap && dmap.has(dk)) clearTimeout(dmap.get(dk));
          const run = async () => { try { if (dmap) dmap.delete(dk); const arec = await this.pollRecord(recGuid); if (arec) await this.autoTitle(arec, collName, apat); } catch (e) {} };
          if (dmap && typeof dmap.set === 'function') dmap.set(dk, setTimeout(run, 800)); else await run();
        }
      } catch (e) {}
      const idx = await this.getTriggerIndex(); const tmpls = idx.byEvent['record.updated'][collName] || []; if (!tmpls.length) return;
      const last = this._state.autoCooldown.get('upd:' + recGuid) || 0; if (Date.now() - last < AUTO_COOLDOWN_MS) return;
      this._state.autoCooldown.set('upd:' + recGuid, Date.now()); setTimeout(() => { try { this._state.autoCooldown.delete('upd:' + recGuid); } catch (e) {} }, AUTO_COOLDOWN_MS);
      const record = await this.pollRecord(recGuid); if (!record) return;
      const cols = await this.getCollectionsCached(); const targetCollection = cols.find(c => { try { return c.getGuid && c.getGuid() === collGuid; } catch (e) { return false; } }) || null;
      for (const tmpl of tmpls) { try { if (!(await this.evalCondition(this.conditionOf(tmpl), recGuid))) continue; await this.fireTemplate(tmpl, { record, recGuid, targetCollection, mode: 'update', reason: 'record.updated' }); } catch (e) { console.warn('[Templater] updated-trigger error', e); } }
    } catch (e) { console.warn('[Templater] onRecordUpdated error', e); }
  }
  async onPanelNavigated(ev) {
    try {
      const panel = ev && ev.panel; if (!panel) return;
      const rec = (panel.getActiveRecord && panel.getActiveRecord()) || null; if (!rec) return;
      let jd = null; try { jd = rec.getJournalDetails && rec.getJournalDetails(); } catch (e) {}
      if (!jd) return;
      const idx = await this.getTriggerIndex(); const tmpls = idx.byEvent['journal.open']; if (!tmpls || !tmpls.length) return;
      const recGuid = rec.guid; const dayKey = recGuid + '|' + this._ymd(new Date());
      if (this._state.journalSeen.has(dayKey)) return;
      // CROSS-TAB dedup (v2.44.1): journalSeen is per-instance, so every open browser tab
      // fired the journal.open templates once → N tabs = N duplicate template blocks. A
      // localStorage claim is shared across all tabs of the SAME browser, so the first tab
      // to open the day wins and every other tab skips. (The content re-check below still
      // backstops cross-device races.) TTL-stamped so the key set can't grow unbounded.
      try {
        const LK = 'tmpl-jopen:' + dayKey;
        if (localStorage.getItem(LK)) { this._state.journalSeen.add(dayKey); return; }
        localStorage.setItem(LK, String(Date.now()));
        // opportunistic GC of claims older than 2 days
        try { const cutoff = Date.now() - 2 * 864e5; for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.indexOf('tmpl-jopen:') === 0) { const v = +localStorage.getItem(k); if (v && v < cutoff) localStorage.removeItem(k); } } } catch (_e) {}
      } catch (_e) {}
      this._state.journalSeen.add(dayKey);
      const cols = await this.getCollectionsCached(); const jcol = cols.find(c => { try { return c.isJournalPlugin && c.isJournalPlugin(); } catch (e) { return false; } }) || null;
      for (const tmpl of tmpls) { try {
        if (!(await this.evalCondition(this.conditionOf(tmpl), recGuid))) continue;
        const templateGuid = this.guidOf(tmpl); if (!templateGuid) continue;
        await this._withTargetTemplateLock(templateGuid, recGuid, async () => {
          if (await this._journalAlreadyHas(rec, tmpl)) return false;
          return await this.fireTemplate(tmpl, { record: rec, recGuid, targetCollection: jcol, mode: 'append', reason: 'journal.open' });
        });
      } catch (e) { console.warn('[Templater] journal-open trigger error', e); } }
    } catch (e) { console.warn('[Templater] onPanelNavigated error', e); }
  }
  async fireAppOpen() {
    try {
      if (this._state.appOpenFired) return; this._state.appOpenFired = true;
      const idx = await this.getTriggerIndex(); const tmpls = idx.byEvent['app.open']; if (!tmpls || !tmpls.length) return;
      for (const tmpl of tmpls) { try {
        if (!(await this.evalCondition(this.conditionOf(tmpl)))) continue;
        const tgt = await this.resolveTarget(tmpl), templateGuid = this.guidOf(tmpl); if (!tgt || !templateGuid) continue;
        await this._withTargetTemplateLock(templateGuid, tgt.recGuid, async () => {
          if (tgt.mode === 'append' && await this._journalAlreadyHas(tgt.record, tmpl)) return false;
          return await this.fireTemplate(tmpl, Object.assign({ reason: 'app.open' }, tgt));
        });
      } catch (e) { console.warn('[Templater] app.open trigger error', e); } }
    } catch (e) { console.warn('[Templater] fireAppOpen error', e); }
  }
  _ymd(d) { return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

  // --- diagnostics / management ---
  async runTriggerByName(name) {
    const tmpl = await this.findTemplate(name); if (!tmpl) return { error: 'template not found: ' + name };
    const tgt = await this.resolveTarget(tmpl); if (!tgt) return { error: 'no resolvable Target (set Target=journal:today or collection:<Name>)' };
    const ok = await this.fireTemplate(tmpl, Object.assign({ reason: 'manual' }, tgt));
    return { fired: ok, template: this.tName(tmpl), target: this.targetOf(tmpl) || 'journal:today', mode: tgt.mode };
  }
  async describeTriggers() {
    const out = []; const now = Date.now();
    try {
      const idx = await this.getTriggerIndex();
      for (const { tmpl, spec } of idx.schedules) out.push({ template: this.tName(tmpl), schedule: spec.raw, kind: spec.kind, nextFire: new Date(this.nextDue(spec, now)).toString().slice(0, 24), lastFired: this.readLastFired(tmpl) ? new Date(this.readLastFired(tmpl)).toString().slice(0, 24) : '—', condition: this.conditionOf(tmpl) || '—', target: this.targetOf(tmpl) || 'journal:today' });
      const evs = idx.byEvent;
      for (const t of ['record.created', 'record.updated']) for (const coll in evs[t]) for (const tmpl of evs[t][coll]) out.push({ template: this.tName(tmpl), event: t + ':' + coll, condition: this.conditionOf(tmpl) || '—', target: '(trigger record)' });
      for (const tmpl of evs['journal.open']) out.push({ template: this.tName(tmpl), event: 'journal.open', condition: this.conditionOf(tmpl) || '—', target: 'opened day page' });
      for (const tmpl of evs['app.open']) out.push({ template: this.tName(tmpl), event: 'app.open', condition: this.conditionOf(tmpl) || '—', target: this.targetOf(tmpl) || 'journal:today' });
    } catch (e) {}
    return out;
  }
  async openTriggersPanel() {
    try {
      const rows = await this.describeTriggers();
      const ov = document.createElement('div');
      ov.setAttribute('style', 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;');
      const box = document.createElement('div');
      box.setAttribute('style', 'background:var(--cards-bg,#1c2127);color:var(--color-text-400,#ddd);border:1px solid var(--cards-border-color,#333);border-radius:10px;max-width:760px;width:90%;max-height:80vh;overflow:auto;padding:18px 20px;font:13px/1.5 var(--font-family,system-ui);');
      let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><b style="font-size:15px;">Templater Triggers</b><span style="opacity:.6;cursor:pointer;font-size:18px;" data-x>&times;</span></div>';
      if (!rows.length) html += '<div style="opacity:.6;">No triggers configured. Set a Schedule (e.g. "05:00 daily") or Trigger On (e.g. "record.created:Meetings") on a template.</div>';
      for (const r of rows) {
        html += '<div style="border-top:1px solid var(--cards-border-color,#333);padding:8px 0;">'
          + '<div style="display:flex;justify-content:space-between;gap:10px;"><b>' + this.escape(r.template) + '</b>'
          + '<button data-run="' + this.escape(r.template) + '" style="background:var(--button-primary-bg-color,#3b82f6);color:#fff;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;">Run now</button></div>'
          + '<div style="opacity:.8;">' + (r.schedule ? ('⏰ ' + this.escape(r.schedule) + ' &middot; next ' + this.escape(r.nextFire || '?')) : ('⚡ ' + this.escape(r.event || ''))) + '</div>'
          + '<div style="opacity:.6;font-size:12px;">target: ' + this.escape(r.target) + ' &middot; condition: ' + this.escape(r.condition) + (r.lastFired ? (' &middot; last: ' + this.escape(r.lastFired)) : '') + '</div></div>';
      }
      box.innerHTML = html; ov.appendChild(box); document.body.appendChild(ov);
      const close = () => { try { document.body.removeChild(ov); } catch (e) {} };
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
      box.querySelector('[data-x]').addEventListener('click', close);
      box.querySelectorAll('[data-run]').forEach(btn => btn.addEventListener('click', async () => { btn.textContent = '…'; const res = await this.runTriggerByName(btn.getAttribute('data-run')); this.toast('Templater', res && res.fired ? ('Ran "' + btn.getAttribute('data-run') + '"') : ('Failed: ' + (res && res.error || '?'))); btn.textContent = 'Run now'; }));
    } catch (e) { this.toast('Templater', 'Triggers panel error: ' + (e && e.message || e)); }
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  // Thymer's global key handler swallows Space (and some keys) from plugin-modal inputs.
  // Intercept Space on the input itself and insert it manually so it survives whether the
  // host blocks it in the capture phase (we still insert) or the bubble phase (we stop it).
  attachInputGuards(el) {
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
        e.stopPropagation();
        e.preventDefault();
        const s = (el.selectionStart == null) ? el.value.length : el.selectionStart;
        const en = (el.selectionEnd == null) ? el.value.length : el.selectionEnd;
        el.value = el.value.slice(0, s) + ' ' + el.value.slice(en);
        el.selectionStart = el.selectionEnd = s + 1;
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
      }
    });
  }

  toast(title, message) {
    try { this.ui.addToaster({ title, message, dismissible: true, autoDestroyTime: 4000 }); } catch (e) {}
  }

  escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}
