// Thymer Templater v2 — global AppPlugin
// Full template language: prompt / date / record.Prop / var.NAME / ref / tag /
// include (recursion limit 3) / <%* async js %> with tp.* namespace + blocklist.
// Frontmatter -> properties, title-setting, segment-aware nested body writer, all
// Trigger modes (append/update/collection/auto with loop guard), audit log,
// status-bar quick-template, slash /tmpl, command palette, hot-reload disposal guard.

console.log('%c[Templater] v2.27.0 loaded — RENAME FROM PROPERTIES: command "Templater: Rename from properties" titles the open note from its collection template\'s Title Pattern (e.g. "{{Type}} · {{Lead}}" → "1:1 · Lori Boyd"; {{Prop}} reads the record\'s property, relations resolve to the linked name). Auto-rename: a template with Trigger On record.updated:<Coll> + Target "rename" + a Title Pattern re-titles on every edit (loop-safe, idempotent). ——— TRIGGERS ENGINE: templates now run on a SCHEDULE, an EVENT, or a CONDITION. Template props: Schedule ("05:00 daily" / "09:00 weekdays" / "Mon,Wed 07:30" / "every 30m"), Trigger On ("record.created:Meetings", "record.updated:Tasks", "journal.open", "app.open"), Condition (Datacore expr / weekday / day / Prop="x" — gate), Target ("journal:today" | "collection:<Name>"). The schedule engine ticks every 60s and CATCHES UP on app-open if a time passed while closed (per-occurrence Last Fired dedup). e.g. Daily Note → Schedule "05:00 daily" + Target "journal:today" appends the rendered template to today\'s journal. Command "Templater: Triggers" lists + test-fires. Spine: __templater.runTrigger/checkSchedulesNow/listTriggers. Plus legacy auto:<Coll>, <%* tp.* %>, {{ai:}}, render/renderTemplateByName.', 'color:#10b981;font-weight:bold');

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
const SCHED_TICK_MS = 60000;       // schedule engine tick
const TRIGGER_TTL_MS = 30000;      // trigger-index cache TTL
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

class Plugin extends AppPlugin {
  onLoad() {
    const plugin = this;

    // --- hot-reload disposal guard (GUARDRAIL #1) ---
    try {
      if (window.__templater) {
        (window.__templater.eventIds || []).forEach(id => { try { this.events.off(id); } catch (e) {} });
        (window.__templater.disposers || []).forEach(fn => { try { fn(); } catch (e) {} });
        if (window.__templater.schedTimer) { try { clearInterval(window.__templater.schedTimer); } catch (e) {} } // GUARDRAIL #21: clear leaked interval
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
      appOpenFired: false,
      collCache: null,
      autoIndex: null,
      triggerIndex: null,
    };
    this._state = window.__templater;

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
        const content = plugin.tField(tpl, 'Template Content') || '';
        return await plugin.renderTemplate(String(content), { record: null, collection: null, prompts: prompts || {}, vars: {}, empty: 'skip', templateName: name });
      } catch (e) { return { error: String(e && e.message || e) }; }
    };

    // Triggers test/diagnostic spine — fire a template's trigger now, or run the schedule check immediately.
    this._state.runTrigger = async (name) => { try { return await plugin.runTriggerByName(name); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.checkSchedulesNow = async () => { try { return await plugin.checkSchedules('manual'); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.listTriggers = async () => { try { return await plugin.describeTriggers(); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.renameActive = async () => { try { return await plugin.renameFromActive(); } catch (e) { return { error: String(e && e.message || e) }; } };
    this._state.composeTitle = async (guid, pattern) => { try { const r = plugin.data.getRecord(guid); return r ? await plugin.composeTitleFromRecord(r, pattern, null) : null; } catch (e) { return { error: String(e && e.message || e) }; } };

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
    const records = await coll.getAllRecords();
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
    let content = this.tContent(template);
    if (!content) { this.toast("Templater", "Template has no content."); return; }

    // Inheritance: Extends -> prepend parent content (one level).
    try {
      const extendsRef = (this.tField(template, F_EXTENDS) || "").trim();
      if (extendsRef) {
        const parent = await this.findTemplate(extendsRef);
        if (parent) {
          const parentContent = this.tContent(parent);
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

    // TP-19: SCHEMA FORM mode — a pinned template with Variables JSON {"form": true} shows ONE
    // typed form rendered from the collection schema (date pickers / choice dropdowns / record
    // pickers / number) instead of chained {{prompt}} dialogs. (Create-new only; opt-in per template.)
    if (vars.form && pinned) { try { await this.applySchemaForm(template, pinned, content, vars); } catch (e) { console.warn('[Templater] schema form failed', e); this.toast('Templater', 'Schema form error: ' + (e && e.message || e)); } return; }

    // TP-13: runtime "fill the OPEN record vs create new" chooser. If a real (non-Journal)
    // record is open, offer to fill it in place; otherwise go straight to create as before.
    let journalish = false;
    try { journalish = !!(activeRecord && activeRecord.getJournalDetails && activeRecord.getJournalDetails()); } catch (e) {}
    if (activeRecord && !journalish) {
      const activeName = (activeRecord.getName && activeRecord.getName()) || 'current record';
      const pinName = pinned && pinned.getName && pinned.getName();
      const activeCollName = activeCollection && activeCollection.getName && activeCollection.getName();
      const mismatch = !!(pinName && activeCollName && pinName !== activeCollName);
      const mode = await this.chooseApplyTarget(this.tName(template), activeName, pinName, mismatch);
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
  async chooseApplyTarget(templateName, recordName, pinnedCollName, mismatch) {
    const fill   = { k: 'update', l: 'Fill this record — set properties, replace title (' + recordName + ')' };
    const append = { k: 'append', l: 'Append to this record — keep title, add below' };
    const create = { k: 'create', l: mismatch
      ? ('Create a NEW record in "' + pinnedCollName + '" instead')
      : (pinnedCollName ? ('Create a NEW record in "' + pinnedCollName + '"') : 'Create a NEW record') };
    const opts = mismatch ? [create, fill, append] : [fill, append, create];
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

  async renderTemplate(content, ctx) {
    let out = content;

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
        if (p.text) { const t = p.text(); if (t != null && t !== "") return String(t); }
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
    out = await this.replaceAsync(out, /\{\{relate:([^=}]+)=([^}]+)\}\}/g, async (_, field, nameOrGuid) => {
      const guid = await this.resolveRefGuid(nameOrGuid.trim());
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

    // <%* js %> sandbox (async tp.* namespace)
    out = await this.replaceAsync(out, /<%\*([\s\S]*?)%>/g, async (_, code) => {
      return await this.runJsBlock(code, ctx);
    });

    return out;
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
    if (this._userFnsLoaded) return;
    this._userFnsLoaded = true; this._userFns = {};
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
        // Single-select under the hood; returns an array for tp.* API compatibility.
        // (Real multi-select not implemented — documented limitation.)
        multi_suggester: async (items, labels) => {
          const opts = (labels || items) || [];
          const idx = await plugin.asyncSuggester("Choose (one)", opts.map(String));
          return idx >= 0 ? [items ? items[idx] : opts[idx]] : [];
        },
        clipboard: async () => { try { return await navigator.clipboard.readText(); } catch (e) { return ""; } },
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
      // Write the BODY (already rendered above; frontmatter + directive markers stripped).
      const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(parsedSF.body || '');
      try {
        const body = (parsedSF.body || '').replace(/<!--TMPL-TASK:[^>]*?-->/g, '').replace(/<!--PLEXUS-[^>]*?-->/g, '');
        if (body.trim()) await this.writeBody(rec, body);
      } catch (e) { console.warn('[Templater] schema-form body write failed', e); }
      if (wantPromote) this._promoteAfterApply(rec);
      try { const p = template.prop && template.prop(F_LASTUSED); if (p && p.setFromDate) p.setFromDate(new Date()); } catch (_) {}
      this.writeAuditRow(template, rec.guid, collection, title, '(schema form)').catch(() => {});
      this.toast('Applied: ' + this.tName(template), 'Created "' + title + '" in ' + (collection.getName ? collection.getName() : ''));
      try { const np = this.ui.getActivePanel && this.ui.getActivePanel(); if (np && np.navigateTo) await np.navigateTo({ itemGuid: guid, highlight: true }); } catch (_) {}
    });
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

  async applyTemplate(template, rendered, opts) {
    const triggers = this.tTriggers(template);
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

    if (appendMode || updateMode) {
      if (!activeRecord) { this.toast("Templater", "No active record — open a record first."); return; }
      targetRecord = activeRecord;
      targetCollection = activeCollection;
      // Update-mode rename: PluginRecord has no setName. Only a Name/Title text PROPERTY
      // can be written; if none exists, update-mode cannot rename — we skip silently.
      // When update-mode sets the title, drop the title line from the body too (it now lives
      // as the record name). Append-mode keeps it (the record's own name is left untouched).
      if (updateMode) {
        await this.trySetRecordTitle(targetRecord, title);
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
      // Drop the title line from the body only when the title CAME from the first body line.
      if (dropTitleLine) bodyForWrite = this.stripTitleLine(bodyAll, titleLineRaw);
    }

    // Frontmatter -> properties (CORE).
    if (frontmatter && Object.keys(frontmatter).length) {
      await this.applyFrontmatter(targetRecord, frontmatter);
    }

    // Body -> native nested line items (segment-aware). Strip the directive markers first (not content).
    if (relates.length) bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-RELATE:[^>]+?-->/g, '');
    if (bannerUrl) bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-BANNER:[^>]+?-->/g, '');
    if (taskDirectives.length) bodyForWrite = bodyForWrite.replace(/<!--TMPL-TASK:[^>]*?-->/g, '');
    const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(bodyForWrite);
    bodyForWrite = bodyForWrite.replace(/<!--PLEXUS-PROMOTE-->/gi, '');
    let cursorGuid = null;
    if (bodyForWrite.trim()) {
      cursorGuid = await this.writeBody(targetRecord, bodyForWrite); // TP-3: {{cursor}} target line
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
        if (coll) { for (const r of await coll.getAllRecords()) { const pat = this.titlePatternOf(r); if (!pat) continue; const tc = this._templatePinnedCollection(r); if (tc && !map[tc]) map[tc] = pat; } }
      } catch (e) {}
      st.titlePatIndex = { ts: Date.now(), map };
    }
    return st.titlePatIndex.map[collName] || null;
  }

  // Pre-expand {{Bare}} → {{record.Bare}} (skip reserved tokens), render against the record, clean to a title.
  async composeTitleFromRecord(record, pattern, collection) {
    if (!record || !pattern) return null;
    const RESERVED = /^(date[:}]|prompt|var\.|ref:|tag:|ai::|include:|cursor|banner:|relate:|task:|record\.|schedule:|datetime:)/i;
    const pat = String(pattern).replace(/\{\{\s*([^}|]+?)\s*\}\}/g, (m, inner) => RESERVED.test(inner.trim()) ? m : ('{{record.' + inner.trim() + '}}'));
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

  async writeBody(record, body) {
    const lines = body.split('\n');
    // Track parents per indent LEVEL so nested bullets nest correctly. Indent is normalized
    // to a level (2 spaces or 1 tab = one level) before the stack comparison, so 2-space and
    // 4-space markdown both nest to the author's intent. createLineItem(parent, null, ...)
    // PREPENDS at the parent's start, so each new sibling lands ABOVE the previous one and the
    // whole body renders REVERSED. To append in author order, pass the previous sibling under
    // the same parent as afterItem. lastChildOf maps a parent (or ROOT) -> its last inserted child.
    const stack = []; // [{level, item}]
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
      if (nestable) {
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        parentItem = stack.length ? stack[stack.length - 1].item : null;
      } else {
        // headings / text / quote reset list nesting
        stack.length = 0;
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
        if (nestable) stack.push({ level, item: created });
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
      const text = segs.map(s => (s && typeof s.text === 'string' ? s.text : '')).join('').trim();
      const m = text.match(SLASH_RE);
      if (!m) return;

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
  async onRecordCreated(ev) {
    try {
      if (!ev) return;
      // Only react to LOCAL creations by default — a '*' listener fires on every connected client. TS-7: a
      // REMOTE creation (MCP agent / cron) auto-applies only when the new record carries an explicit #auto tag.
      const remote = ev.source && ev.source.isLocal === false;
      const recGuid = ev.recordGuid, collGuid = ev.collectionGuid;
      if (!recGuid || !collGuid) return;
      if (this._state.applying.has(recGuid)) return;      // the engine's own create (create-mode) → don't re-fire
      if (this._state.autoFired.has(recGuid)) return;

      const collName = await this.collectionNameByGuid(collGuid);
      if (!collName) return;
      if (collName === TEMPLATES_COLL || AUDIT_COLL_CANDIDATES.includes(collName)) return;

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
        const records = await coll.getAllRecords();
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
      let content = this.tContent(tmpl); if (!content) return false;
      try { const ext = (this.tField(tmpl, F_EXTENDS) || '').trim(); if (ext) { const p = await this.findTemplate(ext); if (p) { const pc = this.tContent(p); if (pc) content = pc + "\n" + content; } } } catch (e) {}
      try { content = await this.resolveIncludes(content, 0, new Set()); } catch (e) {}
      let vars = { defaults: {} };
      try { const raw = this.tField(tmpl, F_VARS) || this.tField(tmpl, 'Variables'); if (raw && raw.trim()) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') vars = Object.assign({ defaults: {} }, parsed); } } catch (e) {}
      if (!vars.defaults) vars.defaults = {};
      const rendered = await this.renderTemplate(content, { record, collection: targetCollection, prompts: {}, vars: vars.defaults, empty: vars.empty || 'skip', templateName: this.tName(tmpl) });
      const parsed = this.parseFrontmatter(rendered);
      const wantPromote = /<!--PLEXUS-PROMOTE-->/i.test(parsed.body || '');
      const body = (parsed.body || '').replace(/<!--PLEXUS-PROMOTE-->/gi, '');
      if (mode !== 'append' && parsed.frontmatter && Object.keys(parsed.frontmatter).length) { try { await this.applyFrontmatter(record, parsed.frontmatter); } catch (e) {} }
      if (body.trim()) { try { await this.writeBody(record, body); } catch (e) {} }
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
          if (this.readLastFired(tmpl) >= due) continue;                 // already fired this occurrence
          if (!(await this.evalCondition(this.conditionOf(tmpl)))) continue;
          const tgt = await this.resolveTarget(tmpl); if (!tgt) { console.warn('[Templater] schedule: no target for "' + this.tName(tmpl) + '"'); continue; }
          if (tgt.mode === 'append' && await this._journalAlreadyHas(tgt.record, tmpl)) { this.stampLastFired(tmpl); continue; } // idempotent on the day page
          if (await this.fireTemplate(tmpl, Object.assign({ reason: 'schedule:' + (reason || '') }, tgt))) fired++;
        } catch (e) { console.warn('[Templater] schedule fire error', e); }
      }
    } catch (e) { console.warn('[Templater] checkSchedules error', e); }
    return { fired };
  }
  // append-mode idempotence: skip if the day page already contains the template's first real heading text
  // (belt-and-suspenders behind the per-occurrence Last Fired dedup — so a lost stamp can't double-append).
  async _journalAlreadyHas(record, tmpl) {
    try {
      const probe = this._templateProbe(tmpl); if (!probe) return false;
      const items = await record.getLineItems(false);
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
      if (!ev) return; const recGuid = ev.recordGuid, collGuid = ev.collectionGuid; if (!recGuid || !collGuid) return;
      if (this._state.applying.has(recGuid)) return;                    // our own write → ignore
      const collName = await this.collectionNameByGuid(collGuid); if (!collName) return;
      if (collName === TEMPLATES_COLL || AUDIT_COLL_CANDIDATES.includes(collName)) return;
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
      if (this._state.journalSeen.has(dayKey)) return; this._state.journalSeen.add(dayKey);
      const cols = await this.getCollectionsCached(); const jcol = cols.find(c => { try { return c.isJournalPlugin && c.isJournalPlugin(); } catch (e) { return false; } }) || null;
      for (const tmpl of tmpls) { try { if (!(await this.evalCondition(this.conditionOf(tmpl), recGuid))) continue; if (await this._journalAlreadyHas(rec, tmpl)) continue; await this.fireTemplate(tmpl, { record: rec, recGuid, targetCollection: jcol, mode: 'append', reason: 'journal.open' }); } catch (e) { console.warn('[Templater] journal-open trigger error', e); } }
    } catch (e) { console.warn('[Templater] onPanelNavigated error', e); }
  }
  async fireAppOpen() {
    try {
      if (this._state.appOpenFired) return; this._state.appOpenFired = true;
      const idx = await this.getTriggerIndex(); const tmpls = idx.byEvent['app.open']; if (!tmpls || !tmpls.length) return;
      for (const tmpl of tmpls) { try { if (!(await this.evalCondition(this.conditionOf(tmpl)))) continue; const tgt = await this.resolveTarget(tmpl); if (!tgt) continue; if (tgt.mode === 'append' && await this._journalAlreadyHas(tgt.record, tmpl)) continue; await this.fireTemplate(tmpl, Object.assign({ reason: 'app.open' }, tgt)); } catch (e) { console.warn('[Templater] app.open trigger error', e); } }
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
