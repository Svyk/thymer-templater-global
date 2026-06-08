// Thymer Templater v2 — global AppPlugin
// Full template language: prompt / date / record.Prop / var.NAME / ref / tag /
// include (recursion limit 3) / <%* async js %> with tp.* namespace + blocklist.
// Frontmatter -> properties, title-setting, segment-aware nested body writer, all
// Trigger modes (append/update/collection/auto with loop guard), audit log,
// status-bar quick-template, slash /tmpl, command palette, hot-reload disposal guard.

console.log('%c[Templater] v2.3.0 loaded — global AppPlugin', 'color:#10b981;font-weight:bold');

const TEMPLATES_COLL = "Templates";
const AUDIT_COLL_CANDIDATES = ["Template Log", "Template Applications"];
const RECURSION_LIMIT = 3;
const SLASH_RE = /^\/tmpl(?:\s+(.+))?$/;
const SLASH_COOLDOWN_MS = 500;
const AUTO_COOLDOWN_MS = 30000;
const GUID_RE = /^[A-Z0-9]{26}$/;

// Field labels (read robustly by label, never by id).
const F_NAME = "Template Name";
const F_CONTENT = "Template Content";
const F_VARS = "Variables (JSON)";
const F_TRIGGERS = "Triggers";
const F_VERSION = "Version";
const F_EXTENDS = "Extends";
const F_LASTUSED = "lastUsed";

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
      }
    } catch (e) { /* ignore */ }
    window.__templater = {
      eventIds: [],
      disposers: [],
      autoFired: (window.__templater && window.__templater.autoFired) || new Set(),
      autoCooldown: (window.__templater && window.__templater.autoCooldown) || new Map(),
      slashCooldown: new Map(),
      clearing: new Set(),
    };
    this._state = window.__templater;

    // --- CSS (drop prior style, re-inject — don't stack) ---
    try {
      const prior = document.getElementById('templater-css');
      if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
    } catch (e) {}
    try {
      this.ui.injectCSS(`
        #templater-css{display:none}
        .tmpl-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 100000; display: flex; align-items: center; justify-content: center; }
        .tmpl-modal { background: var(--cards-bg, var(--color-bg-900, #fff)); color: var(--color-text-400, #111); border: 1px solid var(--cards-border-color, rgba(0,0,0,0.1)); border-radius: 12px; padding: 20px 22px; min-width: 460px; max-width: 760px; max-height: 80vh; overflow-y: auto; box-shadow: 0 12px 48px rgba(0,0,0,0.35); font-family: var(--font-family, -apple-system, sans-serif); }
        .tmpl-modal h2 { margin: 0 0 6px; font-size: 16px; font-weight: 600; color: var(--color-text-100, inherit); }
        .tmpl-modal .tmpl-sub { color: var(--color-text-600, #6b7280); font-size: 12px; margin-bottom: 16px; }
        .tmpl-field { display: flex; flex-direction: column; margin-bottom: 14px; }
        .tmpl-field label { font-size: 12px; font-weight: 500; margin-bottom: 4px; color: var(--color-text-600, #6b7280); }
        .tmpl-field input, .tmpl-field textarea, .tmpl-field select { background: var(--input-bg-color, rgba(0,0,0,0.04)); color: var(--color-text-400, inherit); border: 1px solid var(--cards-border-color, rgba(0,0,0,0.1)); border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
        .tmpl-field textarea { min-height: 60px; resize: vertical; }
        .tmpl-field input:focus, .tmpl-field textarea:focus, .tmpl-field select:focus { outline: none; border-color: #3b82f6; }
        .tmpl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
        .tmpl-btn { padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid var(--cards-border-color, rgba(0,0,0,0.1)); background: var(--button-bg-color, rgba(0,0,0,0.04)); color: var(--color-text-400, inherit); }
        .tmpl-btn.primary { background: #10b981; color: #fff; border-color: #10b981; }
        .tmpl-btn:hover { filter: brightness(1.05); }
        .tmpl-btn:disabled { opacity: 0.6; cursor: default; }
        .tmpl-preview { background: var(--input-bg-color, rgba(0,0,0,0.04)); border: 1px solid var(--cards-border-color, rgba(0,0,0,0.1)); border-radius: 6px; padding: 12px 14px; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 12px; white-space: pre-wrap; max-height: 50vh; overflow-y: auto; margin-bottom: 12px; color: var(--color-text-400, inherit); }
        .tmpl-sugg-list { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; }
        .tmpl-sugg-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .tmpl-sugg-item:hover, .tmpl-sugg-item.active { background: var(--sidebar-bg-hover, rgba(0,0,0,0.06)); }
      `);
    } catch (e) { console.warn('[Templater] injectCSS failed:', e); }

    // --- command palette + sidebar + status bar (GUARDRAIL #6 icons; capture remove()) ---
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
        label: "Apply Template...",
        icon: "ti-files",
        tooltip: "Render and apply a template",
        onClick: () => plugin.openPicker()
      });
      if (side && side.remove) this._state.disposers.push(() => { try { side.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] sidebar add failed:', e); }

    try {
      const sbar = this.ui.addStatusBarItem({
        label: "Templates",
        icon: "ti-copy",
        tooltip: "Quick-apply a template",
        onClick: () => plugin.openPicker()
      });
      if (sbar && sbar.remove) this._state.disposers.push(() => { try { sbar.remove(); } catch (e) {} });
    } catch (e) { console.warn('[Templater] statusbar add failed:', e); }

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

    console.log('[Templater] commands + slash + auto-apply registered, CSS injected.');
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
    const proceed = async (chosenCollection) => {
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
          await this.applyTemplate(template, rendered, { collection: chosenCollection });
        } catch (e) {
          console.error('[Templater] apply failed:', e);
          this.toast("Apply failed", String(e && e.message || e));
        }
      };
      if (!prompts.length) finalize({});
      else this.openPromptsModal(template, prompts, finalize);
    };

    // Append/Update operate on the active record — no collection choice.
    if (appendMode || updateMode) { proceed(null); return; }
    // Create mode: pin the collection from a Trigger or Variables JSON {"collection":"X"};
    // only fall back to the picker when the template doesn't say where it belongs.
    let pinned = await this.resolveTargetCollection(triggers, null);
    if (!pinned && vars.collection) { try { pinned = await this.collectionByName(String(vars.collection)); } catch (e) {} }
    if (pinned) { proceed(pinned); return; }
    this.openCollectionPicker((col) => proceed(col));
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
    // Record-reference prompts: {{prompt.record:LABEL :: Collection}} -> dropdown of that
    // collection's records; resolves to a clickable ref (and a plain name in properties).
    const recordRe = /\{\{prompt\.record:([^}]+?)\}\}/g;
    while ((m = recordRe.exec(stripped)) !== null) {
      const dd = m[1].trim().split(/\s*::\s*/);
      const label = dd[0].trim();
      const recordCollection = dd[1] ? dd[1].trim() : "";
      if (!seen.has(label)) seen.set(label, { defaultValue: "", choices: [], recordCollection });
      else if (recordCollection && !seen.get(label).recordCollection) seen.get(label).recordCollection = recordCollection;
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
    return Array.from(seen, ([label, v]) => ({ label, defaultValue: v.defaultValue, choices: v.choices || [], recordCollection: v.recordCollection || "" }));
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

    // {{prompt:LABEL ?? def}}
    out = out.replace(/\{\{prompt:([^}]+?)\}\}/g, (_, body) => {
      const [labelPart, defPart] = body.split(/\s*\?\?\s*/);
      const label = labelPart.trim();
      const v = ctx.prompts && ctx.prompts[label];
      if (v != null && v !== "") return v;
      return (defPart !== undefined) ? defPart.trim() : "";
    });

    // {{prompt.record:LABEL :: Collection}} -> ref marker to the picked record (clickable in
    // body; collapses to the plain name in a frontmatter property value).
    out = await this.replaceAsync(out, /\{\{prompt\.record:([^}]+?)\}\}/g, async (_, body) => {
      const label = body.split(/\s*::\s*/)[0].trim();
      const name = ctx.prompts && ctx.prompts[label];
      if (name == null || name === "") return "";
      const guid = await this.resolveRefGuid(String(name).trim());
      if (guid) return M_OPEN + "REF" + M_SEP + guid + M_SEP + String(name).trim() + M_CLOSE;
      return String(name);
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
    out = out.replace(/\{\{date(?::([^}]+))?\}\}/g, (_, fmt) => {
      const ds = this.dateStringForSegment(fmt);
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

    // <%* js %> sandbox (async tp.* namespace)
    out = await this.replaceAsync(out, /<%\*([\s\S]*?)%>/g, async (_, code) => {
      return await this.runJsBlock(code, ctx);
    });

    return out;
  }

  // Resolve a {{date:...}} payload into a Thymer-parseable date STRING.
  // Bare {{date}} -> "today"; natural language passes through verbatim ("tomorrow",
  // "next monday", "+3 days"); only an explicit strftime-style FMT is pre-resolved to ISO.
  dateStringForSegment(fmt) {
    if (!fmt) return "today";
    const f = String(fmt).trim();
    if (!f) return "today";
    // strftime-ish format string -> resolve now to a concrete date. (Single M/D omitted from
    // detection to avoid catching natural language; they still RESOLVE in formatDate.)
    if (/(YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|HH|mm|ss)/.test(f)) {
      return this.formatDate(new Date(), f);
    }
    // Natural-language / relative: hand the raw string to Thymer's parser.
    return f;
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

    return {
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

      let teardownIdx = -1;
      const close = (idx) => {
        if (done) return;
        done = true;
        try { document.removeEventListener('keydown', onKey, true); } catch (e) {}
        try {
          if (teardownIdx >= 0 && this._state && this._state.disposers) this._state.disposers.splice(teardownIdx, 1);
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
          teardownIdx = this._state.disposers.push(() => close(-1)) - 1;
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
    prompts.forEach(({ label, defaultValue, choices }) => {
      const wrap = document.createElement('div');
      wrap.className = 'tmpl-field';
      const labelEl = document.createElement('label');
      labelEl.textContent = label;
      wrap.appendChild(labelEl);
      let input;
      if (choices && choices.length) {
        // Choice / record property -> dropdown (value always matches a real choice or record).
        input = document.createElement('select');
        choices.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (opt === defaultValue) o.selected = true;
          input.appendChild(o);
        });
      } else {
        const low = label.toLowerCase();
        const isLong = low.includes('description') || low.includes('details') || low.includes('notes') || label.length > 30;
        input = document.createElement(isLong ? 'textarea' : 'input');
        if (!isLong) input.type = 'text';
        if (defaultValue) input.value = defaultValue;
        this.attachInputGuards(input);
      }
      wrap.appendChild(input);
      fields.push({ label, input });
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
    cancel.onclick = () => { if (done) return; done = true; close(); onSubmit({}); };
    overlay.onclick = (e) => { if (e.target === overlay) { if (done) return; done = true; close(); onSubmit({}); } };
    submit.onclick = () => {
      if (done) return; done = true;
      const values = {};
      for (const { label, input } of fields) values[label] = input.value;
      close();
      onSubmit(values);
    };
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
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

    const appendMode = triggers.some(t => /^append to current record$/i.test(t));
    const updateMode = triggers.some(t => /^update current record$/i.test(t));

    // Parse frontmatter + strip from body.
    const parsed = this.parseFrontmatter(rendered);
    const frontmatter = parsed.frontmatter;
    const bodyAll = parsed.body;

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

    // Body -> native nested line items (segment-aware).
    if (bodyForWrite.trim()) {
      await this.writeBody(targetRecord, bodyForWrite);
    }

    // Update lastUsed on the template.
    try {
      const p = template.prop && template.prop(F_LASTUSED);
      if (p && p.setFromDate) p.setFromDate(new Date());
    } catch (e) { /* best-effort */ }

    // Audit (best-effort).
    try {
      await this.writeAuditRow(template, targetRecord.guid, targetCollection, title, this.previewText(rendered));
    } catch (e) { console.warn('[Templater] audit write failed:', e); }

    this.toast(
      "Applied: " + this.tName(template),
      (createdNewGuid ? ("Created \"" + title + "\"") : (updateMode ? ("Updated \"" + (targetRecord.getName ? targetRecord.getName() : title) + "\"") : "Appended to current record")) +
      (targetCollection && targetCollection.getName ? (" in " + targetCollection.getName()) : "")
    );

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
    await new Promise(r => setTimeout(r, 400));
    for (let i = 0; i < 12; i++) {
      let rec = null;
      try { rec = this.data.getRecord(guid); } catch (e) {}
      if (rec) return rec;
      await new Promise(r => setTimeout(r, 200));
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
      const refOnly = val.match(new RegExp('^' + M_OPEN + 'REF' + M_SEP + '([^' + M_SEP + M_CLOSE + ']+)(?:' + M_SEP + '[^' + M_CLOSE + ']*)?' + M_CLOSE + '$'));
      if (refOnly) { if (key) fm[key] = { __relation: refOnly[1] }; continue; }
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
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const indentMatch = raw.match(/^([\t ]*)/);
      const indentStr = indentMatch ? indentMatch[1] : "";
      const spaces = indentStr.replace(/\t/g, '  ').length;
      const level = Math.floor(spaces / 2);
      const line = raw.trim();

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
      } else if (/^[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        type = 'task';
        content = line.replace(/^[-*+]\s+\[[ xX]\]\s+/, '');
      } else if (/^[-*+]\s+/.test(line)) {
        type = 'ulist';
        content = line.replace(/^[-*+]\s+/, '');
      } else if (/^\d+\.\s+/.test(line)) {
        type = 'olist';
        content = line.replace(/^\d+\.\s+/, '');
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        // Markdown horizontal rule (`---`, `***`, `___`). The SDK's PluginLineItemType
        // enum has NO 'hr' member, so createLineItem(type='hr') is rejected and the
        // separator is silently dropped. Render the divider as a plain `text` line (a
        // supported type) so the rule survives in the written output.
        type = 'text';
        content = '———';
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

      const segments = this.parseInlineSegments(content);
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
      }
    }
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
        // datetime segment — text is a Thymer-parseable date string ("today","tomorrow",ISO).
        segments.push({ type: 'datetime', text: m[2] });
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
        setTimeout(() => { try { this._state.clearing.delete(guid); } catch (e) {} }, SLASH_COOLDOWN_MS + 50);
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

  async onRecordCreated(ev) {
    try {
      if (!ev) return;
      // Only react to LOCAL creations — a '*' listener fires on every connected client, so
      // without this guard each client would auto-apply against the same new record.
      if (ev.source && ev.source.isLocal === false) return;

      const recGuid = ev.recordGuid;
      const collGuid = ev.collectionGuid;
      if (!recGuid || !collGuid) return;

      // Per-record loop guard (consulted before any await to close the re-entrancy window).
      if (this._state.autoFired.has(recGuid)) return;

      // Self-collection skip FIRST — never auto-apply onto a Templates or audit record,
      // and don't even look up a template for them.
      const collName = await this.collectionNameByGuid(collGuid);
      if (!collName) return;
      if (collName === TEMPLATES_COLL || AUDIT_COLL_CANDIDATES.includes(collName)) return;

      // Find an auto template for this collection.
      const tmpl = await this.findAutoTemplateFor(collName);
      if (!tmpl) return;

      // Loop prevention: per-RECORD sentinel + per-record cooldown (NOT per-collection, so
      // rapid legitimate creation in the same collection is not throttled).
      const lastRec = this._state.autoCooldown.get(recGuid) || 0;
      if (Date.now() - lastRec < AUTO_COOLDOWN_MS) return;
      this._state.autoFired.add(recGuid);
      this._state.autoCooldown.set(recGuid, Date.now());
      setTimeout(() => { try { this._state.autoFired.delete(recGuid); this._state.autoCooldown.delete(recGuid); } catch (e) {} }, AUTO_COOLDOWN_MS);

      const record = await this.pollRecord(recGuid);
      if (!record) return;

      // Resolve content (inheritance + includes), render with NO prompts (auto can't prompt).
      let content = this.tContent(tmpl);
      if (!content) return;
      try {
        const extendsRef = (this.tField(tmpl, F_EXTENDS) || "").trim();
        if (extendsRef) {
          const parent = await this.findTemplate(extendsRef);
          if (parent) { const pc = this.tContent(parent); if (pc) content = pc + "\n" + content; }
        }
      } catch (e) {}
      try { content = await this.resolveIncludes(content, 0, new Set()); } catch (e) {}

      let vars = { defaults: {} };
      try {
        const raw = this.tField(tmpl, F_VARS) || this.tField(tmpl, "Variables");
        if (raw && raw.trim()) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') vars = Object.assign({ defaults: {} }, parsed); }
      } catch (e) {}
      if (!vars.defaults) vars.defaults = {};

      const cols = await this.data.getAllCollections();
      const targetCollection = cols.find(c => { try { return c.getGuid && c.getGuid() === collGuid; } catch (e) { return false; } }) || null;

      const rendered = await this.renderTemplate(content, {
        record, collection: targetCollection,
        prompts: {}, vars: vars.defaults, empty: vars.empty || "skip",
        templateName: this.tName(tmpl),
      });

      // Apply UPDATE-style into the just-created record (props + body), no new record.
      const parsed = this.parseFrontmatter(rendered);
      if (parsed.frontmatter && Object.keys(parsed.frontmatter).length) {
        await this.applyFrontmatter(record, parsed.frontmatter);
      }
      if (parsed.body.trim()) {
        // Don't drop the title line — the record already exists with its own name.
        await this.writeBody(record, parsed.body);
      }
      try {
        const p = tmpl.prop && tmpl.prop(F_LASTUSED);
        if (p && p.setFromDate) p.setFromDate(new Date());
      } catch (e) {}
      try {
        await this.writeAuditRow(tmpl, recGuid, targetCollection, record.getName ? record.getName() : "(auto)", this.previewText(rendered));
      } catch (e) {}
      console.log('[Templater] auto-applied "' + this.tName(tmpl) + '" to new record in ' + collName);
    } catch (e) {
      console.warn('[Templater] auto-apply error:', e);
    }
  }

  async collectionNameByGuid(guid) {
    try {
      const cols = await this.data.getAllCollections();
      const c = cols.find(cc => { try { return cc.getGuid && cc.getGuid() === guid; } catch (e) { return false; } });
      return c ? c.getName() : null;
    } catch (e) { return null; }
  }

  async findAutoTemplateFor(collName) {
    try {
      const coll = await this.getTemplatesCollection();
      if (!coll) return null;
      const records = await coll.getAllRecords();
      for (const r of records) {
        const triggers = this.tTriggers(r);
        for (const t of triggers) {
          if (/^auto:/i.test(t) && t.replace(/^auto:/i, '').trim() === collName) return r;
        }
      }
    } catch (e) {}
    return null;
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
