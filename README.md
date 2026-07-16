# Templater (Global) for Thymer

A Thymer **global AppPlugin** that turns saved template records into fully-formed Thymer records — title, typed properties, and native nested body — in one keystroke. Pick a template, answer any prompts, and Templater renders the tokens and applies the result to a new or existing record. Templates can also **auto-apply** when you create a record, run on a **schedule**, and be edited through a **form dialog** with autocomplete.

**v2.46.0:** applying a template while a Journal day is open now defaults to **Fill this journal page** instead of creating a record in the template's pinned collection. Journal date titles remain host-owned; template properties are applied when compatible and the body is inserted at the page top. This release also adds per-collection **Auto-title rules** with real apply-time titles and an optional removable display-only live hook.

Templates live in the **Templates** collection — one record per template. The body can be authored as the template record's own nested outline (WYSIWYG) or as a markdown block in the `Template Content` text property; the short `---` frontmatter (which sets the new record's properties) lives in `Template Content`.

## Entry points

- **Cmd+K → "Apply Template…"** — pick a template, answer prompts, confirm. Creates/updates the target record and navigates to it.
- **Inline `/tmpl`** — in any line, type `/tmpl` to open the picker or `/tmpl <name>` to jump to one; applied in place per its Triggers.
- **Cmd+K → "Templater: Edit template…"** — the form editor (below). Edits the active Templates record, else prompts you to pick one.
- **Auto-apply** — make a new record in a collection that has a template with `Trigger On: record.created:<Collection>` and the body/props are scaffolded automatically (silent, no prompts).
- **Schedule** — a template with a `Schedule` (e.g. `06:00 daily`) + `Target` (e.g. `journal:today`) fires on its own.

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

### References, tags, record & vars

| Token | Resolves to |
|---|---|
| `{{ref:Name or GUID}}` | Inline **ref** segment to that record |
| `{{tag:foo}}` or inline `#foo` | **hashtag** segment |
| `{{record.PropName}}` | A property value of the active/target record |
| `{{var.NAME}}` | A default from the template's `Variables (JSON)` → `defaults` |

### Directives (do something after apply)

| Token | Effect |
|---|---|
| `{{cursor}}` | Put the cursor on this line after apply (and highlight it) |
| `{{banner:https://…}}` | Fetch the image and set it as the new record's banner |
| `{{relate:Field=Name}}` | Set a typed **relation** property `Field` → the resolved record |
| `{{task: Title \| status=To Do \| priority=High \| context=Computer \| due=+3 days}}` | Spawn a linked **Rich Task** record (not a body line) |
| `{{include:Template Name}}` | Inline another template's content (recursion limit 3) |
| `<!--PLEXUS-PROMOTE-->` | After apply, promote the body's native `- [ ]` tasks → linked Rich Tasks |
| `{{ai:: instruction}}` | Inline text generated by the local `/llm` proxy (best-effort; empty if down) |

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

## Spine (`window.__templater`)

For cross-plugin use (e.g. Quick Add): `render(content, prompts)`, `renderTemplateByName(name, prompts)`, `applyTemplateByName(name, {prompts, mode, collection})`, `runTrigger`, `checkSchedulesNow`, `composeTitle`, `autoTitleByGuid(guid, collName)`, `_instance` (debug). MCP `update_plugin_code` does NOT reach the web client — deploy via the Plugins Manager.

### Auto-title rule syntax and live mode

Auto-title rules use `{name}` for the current stored title and `{field:FIELD_ID}` for a collection property. Wrap separators and fields in `?{ ... }` when the whole group should disappear if its property is empty; escape literal braces with `\{` and `\}`.

The optional live mode installs a clearly marked `Templater Auto-title: managed collection hook` block that wraps the collection plugin's existing `Plugin.prototype.onLoad`, calls it first, then registers `customizeRecordTitle()`. `Remove title hook` deletes only Templater's marked block (and its exact managed stub when Templater added one); unmarked collection code is never rewritten. Templater refuses installation when it cannot read the collection's existing code/config or when the generated result fails validation.

The managed-hook mechanism, token grammar, and property-chip settings approach were adapted from [akaready/thymer-build-title-from-properties](https://github.com/akaready/thymer-build-title-from-properties). Templater keeps its own real-title apply path; rich display formatting and telemetry from the reference plugin were intentionally not adopted.

## Data model

Reads the **Templates** collection; writes audit rows to a template-log collection if present. Creates no collections. See `CONSTANTS.md` for GUIDs.

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
