# Templater (Global) for Thymer

A Thymer **global AppPlugin** that turns saved template records into fully-formed Thymer records — title, typed properties, and native nested body — in one keystroke. Pick a template, answer any prompts, and Templater renders the tokens and applies the result to a new or existing record. Templates can also **auto-apply** when you create a record, run on a **schedule**, and be edited through a **form dialog** with autocomplete.

**v2.49.2:** After child dispatch, reconciliation may delete an empty marker-less losing heading only when a fresh page snapshot proves it has no children, its normalized text exactly matches the smallest-GUID winner, and it is one of that duplicate group's larger-GUID losers. Real moves are recorded as `{guid, text}` entries in `window.__TEMPLATER_LAST_RECONCILE.movedLines`; lines already under the winner are not moved or counted again. The v2.49.1 fresh-handle move retries and guarded `window.__TEMPLATER_MOVE_PROBE({lineGuid, targetHeadingGuid})` remain available.

The v2.49.0 exactly-once protocol remains unchanged: same-browser opens use a page-day Web Lock plus a lease written before the first await. Every generated Journal line is marked immediately through `setMetaProperties`, and `window.__templater.RECONCILE()` converges old, marker-less, stale, and CLI-created duplicate sections by keeping the smallest heading GUID, preserving user lines through GUID-stable moves, and deleting only proven template twins. Reconciliation runs before apply, after navigation convergence, on synthetic Journal line creation/restoration, and once for today at boot.

The v2.48.6 `;;` insertion path remains unchanged: selection keeps only record/line GUID identity; commit re-reads current anchor segments, replaces the last live `;;query`, and performs exactly one anchor `setSegments`. Multi-line snippets re-resolve record, parent, and previous-sibling handles before every create.

Inline inserts do not emit highlighted navigation by default, so the Navigation plugin does not pulse/center the inserted line; enable **Navigate to and pulse the first `{{cursor}}` after `;;` insert** in Templater settings to restore the old behavior.

Templates live in the **Templates** collection — one record per template. The body can be authored as the template record's own nested outline (WYSIWYG) or as a markdown block in the `Template Content` text property; the short `---` frontmatter (which sets the new record's properties) lives in `Template Content`.

## Entry points

- **Cmd+K → "Apply Template…"** — pick a template, answer prompts, confirm. Creates/updates the target record and navigates to it.
- **Inline `/tmpl`** — in any line, type `/tmpl` to open the picker or `/tmpl <name>` to jump to one; applied in place per its Triggers.
- **Inline `;;`** — type `;;query` anywhere in a line to open a live, fuzzy-filtered caret popup and insert at that exact position. `;;;` escapes to literal `;;`; change, disable, or switch to settled fallback mode in **Templater: Settings…**.
- **Cmd+K → "Templater: Edit template…"** — the form editor (below). Edits the active Templates record, else prompts you to pick one.
- **Auto-apply** — make a new record in a collection that has a template with `Trigger On: record.created:<Collection>` and the body/props are scaffolded automatically (silent, no prompts).
- **Schedule** — a template with a `Schedule` (e.g. `06:00 daily`) + `Target` (e.g. `journal:today`) fires on its own.

The picker renders a side-by-side, scrollable preview of the highlighted template (up to about 30 lines). Preview is a strict dry render: prompts become placeholders, JavaScript becomes `⟨js⟩`, dates resolve normally, and apply-time directives cannot run.

## The Template Editor (form)

`Templater: Edit template…` opens a dialog so you never hand-edit the cramped text field:

- **Fills a new record in** — the target collection.
- **Properties set on create** — one row per frontmatter property: pick a property from the target collection's schema, choose how it fills (**Prompt / Choice / Date / Record (one) / Records (many) / Static**), set the value. `+ add property` to add more. Composite/odd values load as **Static** (verbatim, lossless).
- **Auto-title rules** — open `Templater: Auto-title rules…`, choose a collection, then compose a real title from property chips. Rules live in Templater's own `custom.autoTitleRules` config and run after frontmatter is applied on create/fill.
- **Body** — a markdown textarea (full control) with a **storage toggle**: *Native outline* (the body is the template record's own line items — editable here **and** in the normal doc) or *Text* (stored in `Template Content`). The body is only rebuilt when you change it.
- **Auto-apply** checkbox → sets `Trigger On: record.created:<collection>`.
- **Auto Title** (Off/On) + **Title Pattern**.
- **Advanced — Variables (JSON)** — edit the raw Variables JSON (validated on save).
- **Template language reference** — the full token list, in-dialog.

**Autocomplete** (in every value field + the body): type `{{` for the token menu (with hints), `{{record.` for the target collection's fields, `dc: @` for collections, and `:: ` inside a record token for collections. ↑/↓ to move, Enter/Tab to accept, Esc to dismiss.

## Template language

Tokens are written in `Template Content` (the `---` frontmatter and the body) or in the body line items. Tokens with a native Thymer representation emit **segments** (datetime, ref, hashtag), not plain text.

### Prompts (ask at apply time)

| Token | Resolves to |
|---|---|
| `{{prompt:LABEL}}` | Text input; value substituted |
| `{{prompt:LABEL ?? default}}` | Text input with a default (`?? ` with nothing = optional/empty) |
| `{{prompt.choice:LABEL :: A, B, C}}` | Pick one of the listed options |
| `{{suggester:LABEL|A,B,C}}` | Alias of `prompt.choice` (Roam-style spelling) |
| `{{prompt.date:LABEL ?? 2026-07-16}}` | Date input; emits a native datetime segment when it is the line's only text run, otherwise ISO text |
| `{{prompt.record:LABEL :: Collection}}` | Pick one record from `Collection` → a `ref` segment / relation |
| `{{prompt.records:LABEL :: Collection}}` | Pick multiple records (multi-relation) |

The same `LABEL` is asked once even if reused (e.g. a Title composed of `{{prompt.choice:Type …}} · {{prompt:Title}}`).

### Dates

| Token | Resolves to |
|---|---|
| `{{date}}` | Today — a `datetime` segment on its own body line, or text in frontmatter |
| `{{date:FMT}}` | Formatted; `FMT` uses `YYYY MM DD HH mm ss dddd MMMM` etc. |
| `{{date:tomorrow}}` / `{{date:next monday}}` / `{{date:+3 days}}` / `{{date:-1 week}}` | Natural language (via `DateTime.parseDateTimeString`) |
| `{{date:+7}}` / `{{date:+7@Start Date}}` | Relative-offset / milestone (offset from another date field) |
| `{{schedule:…}}` / `{{datetime:…}}` | Aliases of `{{date:…}}` — a real scheduling segment |
| `{{time}}` | Current local time as 24-hour `HH:mm` plain text |

### References, tags, record & vars

| Token | Resolves to |
|---|---|
| `{{ref:Name or GUID}}` | Inline **ref** segment to that record |
| `{{tag:foo}}` or inline `#foo` | **hashtag** segment |
| `{{record.PropName}}` | A property value of the active/target record |
| `{{var.NAME}}` | A default from the template's `Variables (JSON)` → `defaults` |

### Journal chains and carry-forward

| Token | Resolves to |
|---|---|
| `{{journal:yesterday}}` / `{{journal:tomorrow}}` | Real ref segment to the adjacent Journal day |
| `{{journal:+N}}` / `{{journal:-N}}` | Real ref segment to the target Journal day plus/minus `N` local calendar days |
| `{{carry:unfinished}}` | Live Datacore line: `dc: @task and @todo and date=<yesterday> \| list` |
| `{{carry:refs}}` | Frozen refs to up to 20 unfinished task lines from yesterday |

Journal math uses the page being filled (`record.getJournalDetails().date`), falling back to today outside Journal. `carry:unfinished` stays live and reflects later task changes without copying tasks. `carry:refs` is a static snapshot of the matching task GUIDs at apply time. Neither form duplicates a task; scheduling remains one-GUID/in-place.

### Directives (do something after apply)

| Token | Effect |
|---|---|
| `{{cursor}}` | Cursor stop 1; navigate here after apply |
| `{{cursor:2}}` … `{{cursor:9}}` | Additional ordered stops for **Templater: Next cursor stop** |
| `{{banner:https://…}}` | Fetch the image and set it as the new record's banner |
| `{{relate:Field=Name}}` | Set a typed **relation** property `Field` → the resolved record |
| `{{task: Title \| status=To Do \| priority=High \| context=Computer \| due=+3 days}}` | Spawn a linked **Rich Task** record (not a body line) |
| `{{include:Template Name}}` | Inline another template's content (recursion limit 3) |
| `<!--PLEXUS-PROMOTE-->` | After apply, promote the body's native `- [ ]` tasks → linked Rich Tasks |
| `{{ai:: instruction}}` | Inline text generated by the local `/llm` proxy (best-effort; empty if down) |

After stop 1, run **Templater: Next cursor stop** to move through the remaining lines; the transient stop list clears after the final stop or when you leave the record. For a one-key workflow, bind this command through the Keyboard Shortcuts plugin.

### JavaScript blocks `<%* … %>`

Sandboxed async JS with a `tp.*` namespace (a forbidden-identifier blocklist gates `eval`/`Function`/`window`/`fetch(`/`require(`…):

- `tp.date.now/today/tomorrow/yesterday/weekday/parse(fmt)`
- `tp.system.prompt(label, default)` · `suggester(items, labels)` · `clipboard()`
- `tp.thymer.query(collection)` · `ref(nameOrGuid)` · `setProperty(name, val)` · `create_record(collection, title)`
- `tp.file.title` — the active record's name
- `tp.user.<fn>(…)` — reusable functions from the **Template Functions** collection
- `tp.datacore.query(q)` · `count(q)` · `names(q)` · `evaluate(expr)` — live Plexus Datacore at apply time
- `tp.brain.neighbours()` · `openTasks()` — the record's graph context
- `tp.set(name, value)` / `tp.config` — scratch vars / plugin config

Example: `<%* tp.set('n', await tp.datacore.count('@task and not $done')) %>You have <%* tp.get('n') %> open tasks.`

### Embedded Datacore queries

A body line starting with `dc:` (or `dc.js:`) is a live **Plexus Datacore** query. Use `| list` for a compact list (name + Type pill + snippet) or `| table: col, col` for columns; `| sort Field desc`, `| limit N`, `| grouped: Field`, `| card:`, `references(this.title)` for backlinks. Full DSL: see the Datacore plugin.

```
dc: @Captures and `Captured At` >= date(today) | list | sort `Captured At` desc
dc: @"Rich Tasks" and `Task Status` != "Done" | table: $name, Priority, Due | sort Priority
dc: references(this.title)
```

## Frontmatter → properties

If `Template Content` starts with a `---` line, the block up to the next `---` is parsed as `Key: Value` and applied to the target record's typed properties: choice props use `setChoice`; datetime keys/values are parsed via `DateTime`; record values become relations; everything else is text. A frontmatter `Title:` sets the record title (dangling separators from empty optional tokens are trimmed). The block is stripped from the body.

```
---
Title: {{prompt.choice:Type :: Reference, Idea, Procedure, Summary}} · {{prompt:Title}}
Type: {{prompt.choice:Type :: Reference, Idea, Procedure, Summary}}
Topics: {{prompt.records:Topics :: Topics}}
Source: {{prompt:Source ?? }}
---
## Summary
{{prompt:One-line summary}}
## Notes
- Key point
## 🔗 Backlinks
dc: references(this.title)
```

## Body authoring & nesting

The body can live two ways (toggle in the editor):

- **Native outline** — the template record's own nested line items. Edit it in the normal Thymer outliner (drag to indent) **or** in the editor's Body textarea. Used as the body source whenever `Template Content` has no body text.
- **Text** — a markdown block after the `---` in `Template Content`.

Either way, **a heading parents the lines beneath it**: `## Notes` then `- Key point` makes Key point a child of Notes. Opt out per template with `Variables (JSON)` `{"nest":"flat"}`.

## Variables (JSON)

A small JSON object on each template:

| Key | Meaning |
|---|---|
| `collection` | Target collection the template fills |
| `nest: "flat"` | Disable heading-nesting (legacy flat body) |
| `empty: "skip" \| "keep"` | How empty values are handled (default `skip` — empty props/lines dropped) |
| `preview: true` | Show a schema-validating preview before create |
| `defaults: { Name: value }` | Values for `{{var.Name}}` |

## Title Pattern & Auto Title

`Auto Title: On` + a `Title Pattern` titles records of the template's collection automatically (set-once-until-manual — it stops the moment you type your own title). Pattern tokens: `{{firstline}}` (first body line), `{{body}}` (whole body), `{{summary}}` (AI summary, needs `/llm`), or property tokens like `{{Type}} · {{Lead}}`. Commands: `Templater: Rename from properties`, `Templater: AI title this note`.

## Triggers engine

| Field | Behavior |
|---|---|
| `Trigger On: record.created:<Collection>` | **Auto-apply** when a new record is created in `<Collection>` (silent). Local UI creates fire automatically; remote/MCP creates need a `#auto` tag on the new record. |
| `Trigger On: record.updated:<Collection>` | Re-apply on update |
| `Trigger On: journal.open` / `app.open` | Fire when the journal opens / on app load |
| `Schedule: 06:00 daily` (+ `Target`) | Time-based fire; `Target` = `journal:today`, a collection, append/update, etc. |
| `Condition` | A predicate gate (Datacore expr / weekday / `Prop=val`); empty = always |
| legacy `Triggers: auto:<Collection>` | Same as `Trigger On: record.created:<Collection>` |

## Per-collection defaults

Open **Templater: Settings…** and map a collection to a template. A local, newly-created record receives that template headlessly only when it has no body content and no `record.created` trigger claims the collection. Records created by Templater are transiently guarded so a default cannot recursively fire. Settings are stored in `custom.collectionDefaults`; the same panel controls `custom.inlineTrigger` (`;;` by default, `false` when disabled), `custom.inlineLive` (default `true`), and `custom.inlineNavFlash` (default `false`).

## Snippets & the `;;` popup

Type `;;` anywhere in an editor line. A RefX-style popup opens at Thymer's real model caret immediately; keep typing in the editor to fuzzy-filter from the live line, use Up/Down, then Enter or Tab to insert. Ctrl+O or Cmd+O toggles a dry-render preview of the highlighted result (20 lines maximum), positioned to the right when space permits and below otherwise. Escape or clicking elsewhere dismisses the popup and leaves `;;query` untouched. Ordinary typing, deletion, and caret movement remain native editor input; only Up/Down, Enter/Tab, Escape, and Ctrl/Cmd+O are consumed while the popup is open. If live mode is disabled or its listener cannot initialize, the prior settled-line picker remains the fallback. `custom.inlineScope` is `snippets` by default (only **Type=Snippet** records); set it to `all` in **Templater: Settings…** for the v2.48.0 list. The same preview key toggles the already-present preview in `/tmpl` and **Apply Template…**.

Templates whose **Type** choice is **Snippet** appear first with a `✂` marker. Snippets are collection-free and body-only: they never enter record create/fill flows, ask for a target collection, apply frontmatter/properties, or run banner/relation directives. Prompt tokens still open their normal modal before insertion. Use **Templater: New snippet from selection** to capture the current text selection, or the active line when nothing is selected.

A single rendered body line is spliced into the trigger line as native segments, preserving both prefix and suffix text. Multi-line bodies retain anchor mode: the trigger text is removed, the surrounding line is kept, and blocks are inserted immediately after it (an otherwise-empty trigger line may be reused for the first block). The anchor is re-resolved after the replacement before new sibling lines are created, so the edit guard applies only to the trigger span—not to new body lines. `{{cursor}}` stops are retained in both forms. By default an inline stop does not call `panel.navigateTo`, avoiding `panel.navigated.highlightLines` and the Navigation-plugin flash; the editor stays focused on the anchor and later stops remain available through **Templater: Next cursor stop**. Set `custom.inlineNavFlash` to `true` in **Templater: Settings…** to navigate/pulse stop 1 as before.

The global Templater plugin does not own the Templates collection's `plugin.json`, so it must not declare collection fields in this repository. On the first snippet save it preserves the full Templates schema and adds a stored choice field `Type` with choice `Snippet` through `PluginCollectionAPI.saveConfiguration()` when absent. If the Templates collection is source-managed, mirror that same field in its owning `plugin.json`; a later Plugins Manager reinstall otherwise replaces runtime-added schema fields.

## Spine (`window.__templater`)

For cross-plugin use (e.g. Quick Add): `render(content, prompts)`, `renderTemplateByName(name, prompts)`, `applyTemplateByName(name, {prompts, mode, collection})`, `runTrigger`, `checkSchedulesNow`, `composeTitle`, `autoTitleByGuid(guid, collName)`, `_instance` (debug). MCP `update_plugin_code` does NOT reach the web client — deploy via the Plugins Manager.

### Auto-title rule syntax and live mode

Auto-title rules use `{name}` for the current stored title and `{field:FIELD_ID}` for a collection property. Wrap separators and fields in `?{ ... }` when the whole group should disappear if its property is empty; escape literal braces with `\{` and `\}`.

The optional live mode installs a clearly marked `Templater Auto-title: managed collection hook` block that wraps the collection plugin's existing `Plugin.prototype.onLoad`, calls it first, then registers `customizeRecordTitle()`. `Remove title hook` deletes only Templater's marked block (and its exact managed stub when Templater added one); unmarked collection code is never rewritten. Templater refuses installation when it cannot read the collection's existing code/config or when the generated result fails validation.

The managed-hook mechanism, token grammar, and property-chip settings approach were adapted from [akaready/thymer-build-title-from-properties](https://github.com/akaready/thymer-build-title-from-properties). Templater keeps its own real-title apply path; rich display formatting and telemetry from the reference plugin were intentionally not adopted.

## Data model

Reads the **Templates** collection; writes audit rows to a template-log collection if present. Creates no collections. The first snippet save may add the `Type → Snippet` choice to the existing Templates schema as described above. See `CONSTANTS.md` for GUIDs.

## 10x features (v2.40–v2.43)

**Conditional sections** — `{{if:<cond>}} … {{else}} … {{endif}}` (non-nested). Conditions:
`Field=Value` / `Field!=Value` (target record's typed property) or `attr:Key>N|<|>=|<=|=|!=`
(live Attributes value). WHOOP-aware daily note:
`{{if:attr:Recovery>66}}## Deep work…{{else}}## Admin…{{endif}}`.
Keep `{{prompt:}}` tokens outside branches (prompts are collected before render).

**Idempotent merge re-apply** — apply with mode `merge` (or headless
`__templater.applyTemplateByName(name, {mode:'merge', recordGuid})`) adds ONLY sections whose
top-level heading is missing and fills ONLY empty properties; task/relate/banner directives
re-collect from the filtered body so a re-apply never duplicates or respawns.

**Trigger chains** — Variables JSON `{"then": "Next Template"}` merge-applies the next template
onto the same record after this one completes (depth-capped at 3; self-chains ignored).

**Version migration** — command `Templater: Re-scaffold outdated records…` reads the audit log
("Template Log") for records born from an older template Version and merge-applies the current
one (cap 25 per run, confirm-first; prompts render empty — structural migration).

**Relate cascade** — `{{relate:Field=Name :: create=Collection :: apply=Template}}` creates the
relation target when missing and merge-applies a template onto it: one apply scaffolds a whole
linked subgraph.

**Smart capture** — command `Templater: Smart capture…` (spine: `__templater.smartCapture(text)`):
raw text in, the LLM picks the best template AND pre-fills its prompts; manual picker fallback
when the /llm proxy is down.

**Typed schema form** — the TP-19 one-form apply (date pickers / choice dropdowns / record
pickers / number inputs + AI-fill) is now a checkbox in the Edit dialog (was Variables JSON
`{"form": true}`).

**Insert snippets** — the Edit dialog body has an `Insert:` row of one-click starters
(dc: table/list, `{{attr}}`, `{{if}}`, `{{task}}`, cascade `{{relate+}}`).

**AI template synthesis** — command `Templater: New template from example…`: pick any record;
the LLM turns its props/body into a reusable template (instance values →
`{{prompt:}}`/`{{prompt.choice::}}`/`{{date:}}`; structure and `dc:`/`{{attr:}}` lines kept
verbatim); a draft Templates record is created and the editor opens on it.

**Original-Templater parity (v2.39)** — `<% expr %>` interpolation (Obsidian templates paste in
portably), `tp.web.request/daily_quote/random_picture`, real multi-select
`tp.system.multi_suggester`, `tp.hooks.on_all_templates_executed`, and a palette command per
template. Full gap matrix: GAP_ANALYSIS.md.
