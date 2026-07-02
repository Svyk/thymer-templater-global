# Templater — Gap Analysis: Obsidian Templater vs Thymer Templater v2

**Original**: SilentVoid13/Templater (Obsidian) — `~/Templater/`
**Ours**: `thymer-templater-global/plugin.js` v2.38.0 — a Thymer **global AppPlugin** (~3420 lines)
**Date**: 2026-07-01

Two different substrates. Obsidian = filesystem + markdown files + full Obsidian API + a real editor cursor. Thymer = collections of records + line items with typed properties/relations, a plugin fleet spine (`window.__quickadd / __plexusDatacore / __taskEngine`), a live Datacore query engine, an LLM proxy, WHOOP data, and a triggers engine. So parity is not the goal for large parts of the original surface — several original features are **N/A by substrate** and we already have analogs that are strictly more powerful (typed relations vs text refs, live Datacore vs cached Dataview, collection auto-apply vs folder templates).

The syntax also intentionally diverged: original uses `<% tp.x %>` interpolation + `<%* js %>` execution. Ours uses **`{{token}}` interpolation** (prompt/date/record/var/ref/tag/include/ai/task/relate/banner/attr/cursor/firstline) + **`<%* tp.* %>` execution only** (no `<% %>` interpolation form, no `tR`).

---

## 1. Feature Matrix

Legend: **HAVE** (cite mechanism) · **PARTIAL** · **MISSING** · **N/A** (why, in Thymer).

### Command syntax & engine

| Original capability | Status | Ours (mechanism / line) |
|---|---|---|
| `<% expr %>` interpolation command | PARTIAL | We use `{{token}}` for interpolation; `<% %>` (non-star) is **not** a handler — only `<%* %>` runs (plugin.js:859). A `<% tp.date.now() %>` in a template body is left literal. |
| `<%* js %>` execution command | HAVE | `runJsBlock` (1038) — async, `tp` + `ctx` injected, blocklist gate. |
| `tR` output variable / `tR = ""` reset | MISSING | JS block returns a value (`return`/expression), no accumulating `tR`. No way to overwrite generated content mid-template. |
| Whitespace control `<%_ / _%> / <%- / -%>` | MISSING | No trim directives. We author bodies as native outline lines, so leading/trailing-newline noise is less common — but multi-line JS emitting blank lines has no trim. |
| Dynamic commands `<%+ … %>` (re-render on preview) | N/A | Thymer has no "preview mode cache" concept; **`{{attr:}}` + `tp.datacore.*` are our live-at-apply analog**, and Datacore embeds are live-forever. Original docs themselves deprecate `<%+`. |
| Recursion / includes | HAVE | `{{include:Template}}` with `RECURSION_LIMIT = 3` (656–659). |

### `tp.date`

| Original | Status | Ours |
|---|---|---|
| `tp.date.now(format, offset, ref, refFmt)` | PARTIAL | `_tp.date.now(f)` (1109) + `{{date:FMT}}` token with full strftime + relative offset `{{date:+7}}`/`{{date:+7@Start Date}}` (dateStringForSegment 917). **Missing**: `offset`/`reference`/`reference_format` positional args on `tp.date.now()`. |
| `tp.date.tomorrow / yesterday / weekday` | HAVE | 1111–1118. `weekday(offset, f)`. |
| moment.js object exposed | MISSING | No `moment` global; `formatDate` covers common tokens. Rare in Svyat's use. |
| Relative-date natural language | HAVE (better) | `{{date:next monday}}` / `+2 weeks` become **real Thymer datetime segments** that schedule (822, 917) — Obsidian only emits text. |

### `tp.file` (the biggest N/A cluster — no filesystem)

| Original | Status | Ours |
|---|---|---|
| `tp.file.title` | HAVE | `_tp.file.title` (1106). |
| `tp.file.content` | MISSING | No `tp.file.content`. Reachable via `ctx.record.getLineItems()`; not surfaced as a string. |
| `tp.file.selection()` | N/A | No editor text-selection API in Thymer plugin SDK. |
| `tp.file.cursor()` / cursor_append | PARTIAL | `{{cursor}}` → navigates+highlights the carrying line after apply (824). **Cannot place the caret** (GUARDRAIL: editor cursor not programmatically placeable). Approximation only. |
| `tp.file.create_new` | PARTIAL | `_tp.thymer.create_record(coll, title)` (1159) creates a record; not a full "create + apply template + open" like the original. |
| `tp.file.move / rename` | PARTIAL | Rename: "Rename from properties" + auto-title + AI title (2548). Move: `move_record_to_collection` exists in Thymer but not surfaced as `tp.file.move`. |
| `tp.file.exists / find_tfile / path / folder` | N/A | No paths/folders. `tp.thymer.query(collName)` is the record-world analog. |
| `tp.file.tags` | PARTIAL | `{{tag:…}}` writes tags; reading a record's existing tags not surfaced on `tp`. |
| `tp.file.creation_date / last_modified_date` | MISSING | Rich Tasks tracks Last Touched, but not surfaced on `tp.file`. Trivial to add from `ctx.record`. |
| `tp.file.include` | HAVE | `{{include:}}` (656). |

### `tp.system`

| Original | Status | Ours |
|---|---|---|
| `tp.system.prompt(prompt, default, throw, multiline)` | HAVE | `asyncPrompt` modal (1122, 1202). **Missing**: multiline flag, throw-on-cancel. |
| `tp.system.suggester(textItems, items, throw, placeholder)` | HAVE | `asyncSuggester` keyboard-nav modal (1123, 1244). |
| `tp.system.multi_suggester` | PARTIAL | `_tp.system.multi_suggester` (1130) is **single-select under the hood**, returns a 1-element array. Real multi-select missing (but the `{{prompt.records:}}` form-modal path IS multi-select — 1326). |
| `tp.system.clipboard()` | HAVE | `navigator.clipboard.readText()` (1135). |

### `tp.web`

| Original | Status | Ours |
|---|---|---|
| `tp.web.request(url, path)` | MISSING | `fetch` is blocklisted inside `<%* %>` (1039). Plugin-side fetch works (used for banner/LLM), just not surfaced on `tp.web`. **Feasible** — fetch is allowed in Thymer. |
| `tp.web.daily_quote()` | MISSING | Not implemented. Trivial via plugin-side fetch. |
| `tp.web.random_picture()` | PARTIAL | Not on `tp.web`, but `{{banner:URL}}` fetches + sets a banner image (827, 2146). |

### `tp.frontmatter / tp.config / tp.hooks / tp.app / tp.obsidian`

| Original | Status | Ours |
|---|---|---|
| `tp.frontmatter.<var>` | PARTIAL | Frontmatter → **typed properties** on the record (our whole model). Reading another record's props: `ctx.record.text(name)` etc., not a `tp.frontmatter` accessor. |
| `tp.config.*` (run_mode, active_file, target_file, template_file) | PARTIAL | `_tp.config` has run_mode/templateName/activeRecord/activeCollection (1099). No target/template *file* (no files). |
| `tp.hooks.on_all_templates_executed()` | MISSING | No post-apply hook surfaced to template authors. We DO run post-apply logic internally (task spawn, banner, relate, cursor nav) — just not exposed as `tp.hooks`. |
| `tp.app` (Obsidian App) | N/A | No Obsidian App. `plugin.data.*` (Thymer SDK) is the analog, reachable in trusted user-fns. |
| `tp.obsidian` (TFolder, requestUrl, htmlToMarkdown, normalizePath) | N/A | Obsidian-only API. |

### User functions

| Original | Status | Ours |
|---|---|---|
| Script user functions (`tp.user.<fn>` from `.js` files) | HAVE (better substrate) | `tp.user.*` loaded from a **`Template Functions` collection** (record name = fn name, body = code), cached w/ TTL (1062–1082). No filesystem needed. |
| System command user functions (shell) | N/A | No shell from a browser/Electron-renderer plugin. |
| TSDoc intellisense for user scripts | MISSING | Autocomplete exists for tokens/fields/collections, not for user-fn signatures. |

### Settings / triggers / lifecycle

| Original | Status | Ours |
|---|---|---|
| Folder templates (auto-apply by folder) | HAVE (analog) | **Per-collection auto-apply**: `Trigger On: record.created:<Coll>` scaffolds new records (2932). Deepest-folder-wins → per-collection. |
| File-regex templates | MISSING | No path-regex matching (no paths). Could match on record name / property regex. |
| Startup templates | HAVE | `Trigger On: app.open` fires once per load (139). |
| Per-template hotkeys | MISSING | No per-template command/hotkey registration; single "Apply Template…" palette entry + `/tmpl`. |
| "Trigger on new file creation" master toggle | HAVE | Auto-apply is per-template opt-in via Trigger On. |
| Excluded folders | N/A | No folders. Per-collection opt-in is inherently scoped. |
| Automatic jump to cursor setting | PARTIAL | `{{cursor}}` always navigates; no global toggle. |
| Syntax highlighting in editor | N/A | Templates authored as native outline / a textarea; no CM6 mode. |

### Beyond-original features WE ALREADY HAVE (no Obsidian equivalent)

- **Triggers engine**: schedule (`06:00 daily` / `weekdays` / `Mon,Wed 07:30` / `every 30m`), event (`record.created/updated:<Coll>`, `journal.open`, `app.open`), condition gate, `Last Fired` dedup (28–37, 134). Obsidian has none of this — closest is a separate Calendar/Periodic-Notes plugin.
- **AI**: `{{ai:: instruction}}` inline generation, AI-fill of a whole prompt form from one brief, AI-title (4–6 word summary) — all via the local `/llm` proxy (837, 1468, 151).
- **Auto-title**: `{{firstline}}`, property-pattern titles, set-once-until-manual lock (banner). No Obsidian analog.
- **Typed relations**: `{{relate:Field=Name}}` drops the new record into the Plexus Brain graph as a real relation (830); `{{prompt.record(s):}}` picks live records as typed relations.
- **Live Datacore at apply time**: `tp.datacore.query/count/names/evaluate` (1175) — computes from real workspace data. Obsidian's Dataview is preview-cached and read-only.
- **Attributes**: `{{attr:Key:avg7|trend|…}}` embeds live metric summaries (851).
- **Rich Task spawn**: `{{task: Title | status | priority | context | due=+3 days}}` creates a linked **Rich Tasks record** wired to the Task Engine (845, 2192).
- **Spine**: `__templater.applyTemplateByName(name,{prompts,mode,collection})` runs the full pipeline headless for the Quick Add plugin (194).
- **Heading nesting**: `## Notes` PARENTS the lines beneath it into a real outline (banner) — Obsidian markdown stays flat.
- **`tp.brain.neighbours() / openTasks()`**: a note born summarizing its own graph context (1182).

---

## 2. Fillable Gaps — Ranked by value for Svyat's workflows

Svyat's real templates: **daily notes** (journal @ 06:00), **tasks / Rich Tasks**, **Captures**, **WHOOP** metric embeds, **Datacore** rollups, meetings/projects/people/decisions scaffolds.

Ranked (value × feasibility):

1. **`<% expr %>` interpolation parity** — many portable Obsidian templates and muscle memory use `<% tp.date.now() %>`. Right now those render literally. HIGH value, LOW effort. **[SPEC below]**
2. **`tp.web.request` / `tp.web.daily_quote`** — surface the already-allowed plugin-side fetch to template authors (news-of-the-day, quote-of-the-day in daily note). MED value, LOW effort. **[SPEC below]**
3. **Real multi-select `tp.system.multi_suggester`** — daily-plan / meeting-attendees templates want true multi-pick in JS blocks (the form path already does it; the `tp.*` path doesn't). MED value, LOW effort. **[SPEC below]**
4. **`tp.hooks.on_all_templates_executed`** — lets a template run a finalizer (e.g. "after this Meeting record is built, schedule a follow-up task / re-title / set banner"). Unlocks composition. MED-HIGH value, MED effort. **[SPEC below]**
5. **Per-template palette command + hotkey** — one command per template ("Apply: Daily Note") so a hotkey / Quick-Add can fire a specific template directly instead of the picker. HIGH value for daily drivers, LOW-MED effort. **[SPEC below]**
6. Whitespace control (`-%>` / `_%>`) — LOW value in our outline model; author trims manually.
7. `tp.file.content` / `creation_date` / `last_modified_date` accessors — LOW-MED; easy adds from `ctx.record`.
8. File-regex templates → record-name/property-regex auto-apply — LOW value (per-collection already covers it).

### TOP-5 Implementation Specs (against our code)

#### SPEC 1 — `<% expr %>` interpolation command

**Why**: Portability + habit. `<% tp.date.now("YYYY-MM-DD") %>` should output, not sit literal.
**Where**: `render()` pipeline, immediately BEFORE the `<%* %>` handler at plugin.js:859. Order matters — resolve non-star `<%` after all `{{token}}` passes but before the star pass so the star regex (`/<%\*…%>/`) doesn't need changing (it already requires the `*`).
**Token syntax**: `<% <js-expr> %>` (no leading `*`). Evaluates the expression against the same `tp`/`ctx` from `buildTp`, returns its string value inline. Support `await` (some `tp.*` are async).
**Code** (~18 lines):
```js
// Non-star interpolation: <% expr %>  (must run BEFORE the <%* %> pass; negative-lookahead on *)
out = await this.replaceAsync(out, /<%(?!\*)([\s\S]+?)%>/g, async (_, expr) => {
  return await this.runJsBlock('return (' + expr.trim() + ')', ctx); // reuse the sandbox+blocklist
});
```
`runJsBlock` already wraps `return (expr)` and stringifies (1046–1054), so this is a one-liner reuse. Caveat: the blocklist (1039) still applies (good). Add the negative-lookahead so it never eats a `<%* … %>`. **~18 lines incl. a README row + an autocomplete hint entry (1846-block).**

#### SPEC 2 — `tp.web.*`

**Why**: daily-note quote/news; genuinely useful and fetch is allowed plugin-side.
**Where**: add a `web` block to `_tp` in `buildTp` (after the `system` block, ~1136). Runs plugin-side (NOT inside the sandboxed `new Function`, so it bypasses the fetch blocklist by living on the `tp` object the sandbox is handed — same pattern as `_tp.datacore`).
**Syntax**: `<%* tR? %>` → `await tp.web.request(url, jsonPath?)`, `await tp.web.daily_quote()`, `await tp.web.random_picture(size?, query?)`.
**Code** (~25 lines):
```js
_tp.web = {
  request: async (url, path) => {
    try {
      const r = await fetch(String(url)); const ct = r.headers.get('content-type') || '';
      if (/json/.test(ct) || path) { const j = await r.json(); return path ? String(path.split('.').reduce((o,k)=>o&&o[k], j) ?? '') : j; }
      return await r.text();
    } catch (e) { return ''; }
  },
  daily_quote: async () => {
    try { const j = await (await fetch('https://api.quotable.io/random')).json(); return '> ' + j.content + '\n> — ' + j.author; } catch (e) { return ''; }
  },
  random_picture: async (size, query) => {
    const s = size || '600x400'; return `https://source.unsplash.com/${s}/?${encodeURIComponent(query||'nature')}`;
  },
};
```
Note the `daily_quote` return is markdown; in our outline it lands as two body lines. **~25 lines.**

#### SPEC 3 — Real `tp.system.multi_suggester`

**Why**: JS-block templates (attendees, tags) want true multi-pick. The form path already does multi-select (`openPromptsModal`, `input.multiple`, 1326) — reuse that UI shape in a standalone modal.
**Where**: replace the stub `multi_suggester` (1130). Add a new `asyncMultiSuggester(title, labels)` modal modeled on `asyncSuggester` (1244) but with checkbox/`Cmd-click` multi-select and a "Done" button; resolve an array of indices.
**Syntax**: `<%* const who = await tp.system.multi_suggester(people, people) %>` → array.
**Code** (~40 lines): clone `asyncSuggester`; change `li.onclick` to toggle a `selected` Set instead of closing; add a Done button resolving `[...selected]`; keyboard: Space toggles, Enter = Done. Then:
```js
multi_suggester: async (items, labels) => {
  const opts = (labels || items) || [];
  const idxs = await plugin.asyncMultiSuggester('Choose (multiple)', opts.map(String));
  return idxs.map(i => (items ? items[i] : opts[i]));
},
```
**~45 lines incl. the new modal.**

#### SPEC 4 — `tp.hooks.on_all_templates_executed`

**Why**: post-apply composition. E.g. a Meeting template registers a finalizer that spawns a follow-up Rich Task or re-titles once properties settle.
**Where**: (a) add a per-apply hook registry on `ctx` in the apply pipeline (near where `taskDirectives` are collected, ~2061); (b) expose `_tp.hooks.on_all_templates_executed(fn)` in `buildTp` that pushes into `ctx.__hooks`; (c) after the body write + task-spawn + banner + relate steps complete (the post-apply block ~2127–2192), run `for (const h of ctx.__hooks) await h(ctx.record, tp)`.
**Syntax**: `<%* tp.hooks.on_all_templates_executed(async (rec, tp) => { /* rec is the finished record */ }) %>`.
**Code** (~20 lines): init `ctx.__hooks = []` at apply start; `_tp.hooks = { on_all_templates_executed: (fn) => { if (typeof fn === 'function') (ctx.__hooks ||= []).push(fn); } }`; drain after post-apply. Wrap each in try/catch + a 3s timeout guard so a bad hook can't wedge apply. **~20 lines.**

#### SPEC 5 — Per-template palette command (+ hotkey-able)

**Why**: Svyat's daily drivers (Daily Note, Capture) deserve a direct command, not a two-step picker. A registered command is hotkey-bindable in Thymer and callable by Quick Add.
**Where**: on load, after building the collections/templates cache, iterate templates with a new opt-in flag `Palette Command = On` (or reuse Auto Title's presence heuristic) and register one `addCommandPaletteCommand({ label: 'Apply: '+name })` per template (mirror the single registration at 92). Store each `.remove` in `_state.disposers` (already the pattern). Refresh on `record.created/updated:Templates` so new templates get commands without reload.
**Syntax / config**: a new template property `Palette Command` (choice Off/On). `onSelected` → `plugin.applyTemplateByName(name)` (spine at 194).
**Code** (~35 lines): a `registerTemplateCommands()` method: read templates, dispose old per-template commands (track in `_state.tmplCmds`), register new ones; call it on load + on Templates-collection change (debounced). **~35 lines + one property on the Templates collection.**

---

## 3. Ten "10x" Features — categorically better than Obsidian Templater

Each leverages something Thymer has that Obsidian lacks: typed properties/relations, collections, live Datacore, the plugin-fleet spine, the LLM proxy, the triggers engine, WHOOP.

1. **Schema-Aware Prompt Forms (auto-generated)** — *S, HIGH.* When a template targets a collection, read the collection schema and **auto-render a typed form**: choice props → dropdowns, relation props → record-pickers, datetime → date pickers, number → numeric inputs — with existing values pre-filled. Author writes zero prompt tokens; the form is inferred. (We already do choice/record dropdowns manually; this makes it automatic from the schema.) Obsidian has no schema to read.

2. **Live Datacore "Widgets" in the body** — *M, HIGH.* A `{{dc: @task and not $done | limit 5}}` token that renders a **live Datacore query block** into the record body (not a snapshot). A daily note is born with a live "Today's open tasks" and "This week's captures" that keep updating. Obsidian's Dataview is preview-only and re-queries on view; ours would embed a real reactive Plexus Datacore view.

3. **WHOOP-Aware Daily Note** — *S, HIGH.* `{{whoop:recovery}}`, `{{whoop:sleep}}`, `{{whoop:strain}}` tokens pull today's biometrics from the WHOOP data already in the workspace (`Health Metrics` collection). The 06:00-scheduled Daily Note template embeds recovery/sleep and even **energy-slots the plan** (high recovery → suggest a hard workout block). Uniquely ours — no Obsidian equivalent.

4. **AI Template Synthesis from an Example** — *M, MED.* Command "Templater: Learn a template from this record" → point at a well-formed record, an LLM (via `/llm`) infers the frontmatter + body skeleton + sensible prompt tokens and writes a new Templates record. Turns any good note into a reusable template. Leverages the LLM proxy + our editor.

5. **Relation-Graph Scaffolding (`{{relate}}` on steroids)** — *M, HIGH.* Extend `{{relate:Field=Name}}` to **create the target if missing AND back-link**: `{{relate:Project=Q3 Launch !create}}` makes the Project record (from its own template), links both directions, and can cascade (a Meeting auto-relates to Project → Project's Attendees). Obsidian text-refs can't do typed bidirectional relations.

6. **Conditional Template Sections via typed props** — *S, MED.* `{{if:Type=Meeting}} … {{/if}}` blocks gated on the record's typed properties (already resolvable via `ctx.record`). Cleaner than `<%* if(...) tR+= %>` and works with our token model. One template scaffolds different bodies per Type without a JS block.

7. **Trigger-Chained Templates (workflow spine)** — *M, HIGH.* A template's completion can **fire another template** via the triggers engine: finishing a "Deviation" record auto-schedules a "Follow-up CAPA" template 3 days out (`Trigger On: record.created:Deviations → schedule Template=CAPA target=+3d`). Composes our triggers + Rich Tasks + spine into multi-step workflows. Obsidian has nothing like this.

8. **Idempotent "Merge" Apply (re-apply without duplication)** — *M, MED.* Re-applying a template to an existing record **reconciles** rather than appends: fills only empty properties, adds missing heading sections, never duplicates. Uses typed props + heading-nesting to diff. Obsidian re-apply just dumps text again. Makes templates safe to re-run for evolving schemas.

9. **Template Versioning + Migration** — *S, MED.* The Templates collection already has `Version`/`Extends`. Add "apply migrations": when a template's Version bumps, offer to re-scaffold existing records of that collection to the new structure (add new props, new sections) idempotently (composes with #8). Collections make the target set queryable; Obsidian would have to grep files.

10. **Quick-Capture → Template Router** — *S, HIGH.* One capture bar (`/tmpl <text>`) where an LLM **routes the text to the right template + pre-fills prompts** from the text: "met Lori re: EMP swab schedule" → Meeting template, Attendees=Lori, Topic=EMP swab, spawns a follow-up task. Wires the LLM proxy + `applyTemplateByName` spine + Rich Tasks. Turns Templater into a Jarvis-style capture front-end — far beyond Obsidian's file-scaffold role.

---

## Honest assessment: where OURS already beats the original

- **Automation**: the triggers engine (schedule/event/condition/Last-Fired dedup) has no Obsidian equivalent; Templater relies on Periodic Notes/Calendar plugins.
- **Data model**: typed properties + **real bidirectional relations** (`{{relate}}`, `{{prompt.records}}`) vs Obsidian's plain-text `[[links]]`.
- **Live compute**: `tp.datacore.*` + `{{attr:}}` compute from real workspace data at apply time; Dataview is preview-cached, read-only.
- **AI**: inline `{{ai:}}`, AI-fill of forms, AI-title — the original has none.
- **Auto-title**: `{{firstline}}` / property-pattern / set-once-until-manual — none in Obsidian.
- **Task integration**: `{{task:}}` spawns a linked Rich Tasks record wired to the Task Engine.
- **Spine/composability**: `applyTemplateByName` headless pipeline for Quick Add.
- **Authoring**: WYSIWYG native-outline template bodies with drag-to-indent + heading nesting.

Where the original is still ahead: **`<% %>` interpolation parity** (Spec 1), **`tp.web`** (Spec 2), **true multi-suggester in JS** (Spec 3), **post-apply hooks** (Spec 4), **per-template hotkeys** (Spec 5), plus minor `tp.file.*` accessors and whitespace control. All five top gaps are LOW–MED effort against our existing pipeline.
