# 10x Features — implementation plan (v2.40+)

Target: `~/thymer-templater-global/plugin.js` (v2.39.0, ~3500 lines). Deploy: bump plugin.json +
banner → push → PM reinstall. Existing machinery to reuse: `renderTemplate` token pipeline
(~line 700-880), `_attrValue` ({{attr:}}), `runJsBlock`/`buildTp`, `applyTemplate` tail
(hooks drain ~2230), `{{relate}}` parse + wiring (PLEXUS-RELATE markers), `writeAuditRow`,
`openPromptsModal`/form path, `asyncSuggester`/`asyncMultiSuggester`/`asyncPrompt`,
`_state.applyTemplateByName`, `{{ai:}}` LLM helper, editor `_attachAutocomplete`,
`getTemplatesCollection`/`tName`/`tContent`, Version prop (F_VERSION?), Variables JSON (F_VARS).

## Phase A — conditionals + versioning (S)
- **#7/#2 Conditional sections**: `{{if:<cond>}} … {{endif}}` (+ optional `{{else}}`) in the render
  pipeline BEFORE prompt resolution. Cond forms: `Field=Value` / `Field!=Value` (reads ctx.record
  prop or a prompts value), and `attr:Key>N` / `attr:Key<N` / `attr:Key=V` via `_attrValue`
  (numeric compare when both numeric). Non-matching section text is dropped. WHOOP daily-note use:
  `{{if:attr:Recovery>66}}## Deep work…{{else}}## Admin…{{endif}}`.
- **#9 Versioning + migration**: templates already have a Version text prop. On apply, audit row
  already records template+target. Add command "Templater: Re-scaffold outdated records" →
  pick template → read audit rows (or scan target collection) for records born from it with an
  older recorded version → re-apply in MERGE mode (#8) → update recorded version. Store born-from
  info: add `tmpl_born` marker via audit only (no record mutation) OR Variables JSON opt-in.
  Minimal v1: use audit rows (writeAuditRow already stores template name + target guid + ts);
  extend audit row with template Version; migration command re-applies merge-mode to those guids.

## Phase B — apply modes (M)
- **#8 Idempotent merge re-apply**: `applyTemplate(..., {mode:'merge'})` — when target has body
  content: compare rendered TOP-LEVEL headings vs existing record headings; write only sections
  (heading + its children) whose heading text is absent; never duplicate; props: only fill EMPTY
  props (never overwrite user values). Reuse writeBody for the missing-section subset.
- **#5 Trigger chains**: template Variables JSON `{"then": "Other Template"}` or body directive
  `{{then:Other Template}}` (strip to marker like TMPL-TASK). At applyTemplate tail (after hooks
  drain): if chain present, `_state.applyTemplateByName(nextName, { record: newGuid? })` —
  guard: max chain depth 3 (pass depth via opts), no self-chain.

## Phase C — creation powers (M)
- **#4 Relate cascade**: extend `{{relate:Field :: Target}}` syntax with optional
  `:: create=<Collection>` and `:: apply=<Template>`: if Target record not found → create it in
  <Collection> (createRecord + poll — reuse the resolve pattern), optionally apply <Template> to
  it (depth-guarded), then wire the relation as today.
- **#1 Schema-aware prompt form**: in the prompts-collection step, when the template has a target
  collection, render ONE form modal: all {{prompt:}} fields as inputs PLUS typed inputs for
  frontmatter rows (choice → <select> from schema choices, date → <input type=date>,
  record → text with autocomplete). Extend the existing openPromptsModal (already one modal?) —
  verify what it does; upgrade typed rendering.
- **#3 LLM capture router**: command "Templater: Smart capture…" → asyncPrompt big text →
  LLM (reuse {{ai:}} helper's call path, llm proxy) with template list + each template's prompt
  labels → returns JSON {template, prompts:{label:value}} → applyTemplateByName(name,{prompts}).
  Fallback on LLM failure: suggester.

## Phase D — polish (S)
- **#6 Datacore insert menu**: editor body autocomplete already handles `dc: @`; add an
  "Insert ▸ Datacore block" helper in the edit dialog (snippet menu with table/list/group-by
  starters + {{attr:}} snippets), reusing _templateTokens/autocomplete machinery.
- **#10 AI template synthesis**: command "Templater: New template from example…" → pick a record
  (searchStickyTargets-style picker or suggester over recent records) → serialize (props via
  get_record-equivalent reads + body via serializeBody pattern on that record) → LLM → template
  content (frontmatter + body with {{prompt:}} where values look instance-specific) → create
  Templates record (createRecord + set Template Name/Content/Purpose) → open editor on it.

## Verify per phase
node -c; grep call sites; bump version (2.40.0 A, 2.41.0 B, 2.42.0 C, 2.43.0 D — or single 2.40.0
if done in one push per phase); commit+push each phase; final adversarial review agent over the
full diff v2.39.0→HEAD; fix findings; final push. Update README token docs + banner.
