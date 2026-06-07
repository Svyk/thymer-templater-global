# Templater v2 — Status

**Plugin**: global AppPlugin "Templater" (`1PYD1SFQB74D8DXJJ1P6QY8TNM`, svy workspace)
**Data**: `Templates` collection (`1DEGAQTQARK8MKNAFZ9D1MY16W`) — 5 seed templates
**Audit**: reuses `Template Applications` (`14QZGY1XMNSQDQCTRW2MVS3H2W`); plugin tries `Template Log` then this
**Repo**: `github.com/Svyk/thymer-templater-global` (private)

## v2.0.0 — shipped (built ground-up via multi-agent workflow, 2026-06-07)

Feature-complete in a single AppPlugin file. Phases 1–5 of the plan collapsed into one build:

- [x] Global AppPlugin loads (banner `[Templater] v2.0.0 loaded`)
- [x] Picker — Cmd+K "Apply Template..." + sidebar + status-bar quick-apply
- [x] `/tmpl <name>` slash emulation (lineitem.updated, sentinel + 500ms cooldown)
- [x] Prompts modal + preview modal (port of v1)
- [x] **Fills record TITLE** (first body line)
- [x] **Fills record PROPERTIES** via `---` frontmatter (text / choice / datetime / number)
- [x] **Fills BODY** as native nested line items (segment-aware: datetime / ref / hashtag segments)
- [x] Token language: prompt / date (FMT + natural-language) / record.Prop / var.NAME / ref / tag / include (recursion limit 3)
- [x] `<%* async js %>` with `tp.*` namespace (date / system.suggester+prompt / thymer.query+setProperty) + forbidden-identifier blocklist
- [x] Inheritance via `Extends`
- [x] Triggers: Append / Update current record / `<Collection>` / `auto:<Collection>` (loop guard: Set + 30s)
- [x] Audit row per apply; `lastUsed` updated; picker sorts by lastUsed
- [x] Hot-reload disposal guard on `window.__templater`

## Not yet / deferred
- v1 stack deletion (Recurring Templates `191R6K0MMXFMRB4PSE4DNPP286` + its CollectionPlugin) — left intact; user deletes when ready.
