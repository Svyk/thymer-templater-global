# Templater (Global) v2.0.0

A Thymer **global AppPlugin** that turns saved template records into fully-formed Thymer records — title, typed properties, and native body line items — in one keystroke. Pick a template, fill any prompts, and Templater renders the tokens and applies the result to a new or existing record, then writes an audit row.

This is the v2 successor to the v1 `Recurring Templates` CollectionPlugin. The architecture changed (AppPlugin + a `Templates` collection as the data store); the proven v1 algorithms (picker, prompts modal, preview, render, apply, segment parsing, audit, toast) were ported as-is.

## What's different from v1

- **Global** — invokable from any panel/collection, not bound to one collection.
- **Sets properties + title, not just body.** A template can populate a new record's typed properties (text / choice / datetime) and its title via a frontmatter block — this is a core feature, not optional.
- **Two entry points** — Cmd+K command palette and an inline `/tmpl` slash command.
- **Triggers** — control where a template lands (new record, append, update, or auto-apply on record creation).

## How to use

### 1. Cmd+K → "Apply Template..."

Open the command palette (**Cmd+K** / Ctrl+K), run **Apply Template...**, choose a template from the dropdown (sorted by most-recently-used), answer any `{{prompt:...}}` modals, and confirm in the preview. Templater creates/updates the target record and navigates to it.

### 2. Inline `/tmpl`

In any line item, type `/tmpl` to open the picker, or `/tmpl <name>` to jump straight to a named template. The slash line is cleared and the template is applied in place per its Triggers.

## Token / template language

Tokens are written in the template's `Template Content`. Tokens with a native Thymer representation emit **segments** (datetime, ref, hashtag), not plain text.

| Token | Resolves to |
|---|---|
| `{{prompt:LABEL}}` | Modal text input; value substituted |
| `{{prompt:LABEL ?? default}}` | Modal input with a default |
| `{{date}}` | Today — text, or a `datetime` segment on its own line |
| `{{date:FMT}}` | Formatted date; `FMT` uses `YYYY MM DD HH mm ss` |
| `{{date:tomorrow}}` / `{{date:next monday}}` / `{{date:+3 days}}` / `{{date:-1 week}}` | Natural-language date via `DateTime.parseDateTimeString` |
| `{{record.PropName}}` | A property of the currently-active record |
| `{{var.NAME}}` | A default from the template's `Variables (JSON)` |
| `{{ref:Name or GUID}}` | Inline **ref** segment to that record |
| `{{tag:foo}}` or inline `#foo` | **hashtag** segment |
| `{{include:Template Name}}` | Inlines another template's content (recursion limit 3) |
| `<%* js %>` | Sandboxed JS block (forbidden-identifier blocklist enforced) |

Sandboxed JS exposes a `tp.*` namespace (`tp.date.*`, `tp.system.prompt/suggester/clipboard`, `tp.thymer.query/ref/setProperty/create_record`, `tp.file.title`, `tp.config`). Blocked identifiers (`eval`, `Function`, `window`, `fetch(`, `require(`, etc.) output `[js blocked: forbidden identifier]`; runtime errors output `[js error: ...]`.

## Frontmatter → properties

If `Template Content` starts with a literal `---` line, the block up to the next `---` is parsed as `Key: Value` pairs and applied to the target record's typed properties. Choice properties use `setChoice`; datetime keys (matching `/date|due|at|when/i` or parseable values) are set via `DateTime`; everything else is plain text. The frontmatter block is stripped from the body, and the first non-empty body line (markers stripped, ~200 char cap) becomes the record **title**.

Example template content:

```
---
Status: In Progress
Due: next friday
Owner: Svyat
---
# Deviation {{prompt:Event ID}}
- [ ] Draft investigation by {{date:+2 days}}
- See {{ref:Deviation SOP}}  #qa
```

Result: a new record titled `Deviation <Event ID>`, with `Status` set to the choice "In Progress", `Due` set to next Friday's date, `Owner` set to "Svyat", and a body containing a heading, a task line with a datetime segment, and a bullet with a ref + hashtag segment.

## Triggers

The template's `Triggers` (choice, many) decide where output lands:

| Trigger | Behavior |
|---|---|
| _none_ / `<Collection Name>` | Create a new record in that collection (default: active collection) |
| `Append to current record` | Write body line items into the active record (no new record) |
| `Update current record` | Apply frontmatter properties to the active record (and append any body) |
| `auto:<Collection Name>` | On `record.created` in that collection, auto-apply (loop-guarded) |

## Data model

Templater reads from the live **Templates** collection and writes audit rows to **Template Applications** (looked up as "Template Log" first, then "Template Applications"). It creates no collections. See `CONSTANTS.md` for GUIDs.
