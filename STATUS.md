# Templater v2 — Status

**Plugin**: global AppPlugin "Templater" (`1PYD1SFQB74D8DXJJ1P6QY8TNM`, svy)
**Data**: `Templates` (`1DEGAQTQARK8MKNAFZ9D1MY16W`) — 8 system templates
**Audit**: `Template Applications` (`14QZGY1XMNSQDQCTRW2MVS3H2W`)
**Repo**: `github.com/Svyk/thymer-templater-global`

## v2.1.0 — system release (2026-06-07)
Per-collection template/property/title system designed via multi-agent research workflow.

Plugin capabilities:
- Frontmatter `Title:` key → record title composed from properties
- `{{date:FMT}}` rich tokens: YYYY/YY/MMMM/MMM/MM/M/DD/D/dddd/ddd/HH/mm/ss
- `{{prompt.choice:LABEL :: a, b, c}}` → dropdown picker (choice props never free-text)
- Empty-optional title-separator cleanup ("1:1 · " → "1:1")
- (v2.0.x) collection picker create-flow, space-key fix, reversed-body fix, inline **bold**/*italic*/`code`, frontmatter→properties, segment-aware body, hot-reload guard

System (8 collections, 8 templates):
- Meetings, Projects, People, Goals(+Domain,+Horizon), Areas, Reflections, Notes(+Type) — extended
- Decisions (`110K19NGXFBVYX8TFMFE6DPHNY`) — NEW (Decided On / Status / Type / Project)
- Templates: Meeting, Project, Person, Goal, Area, Reflection, Note, Decision (each title from props)
- Old generic seeds (Daily Note, Meeting Notes, Research Entry, Project Starter, Deviation Report) retired.

## TODO
- v1 `Recurring Templates` collection trashed by user.
- Test one datetime round-trip (Meetings.Date) end-to-end after reload.
