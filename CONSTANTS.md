# Templater v2.0.0 — Constants

GUIDs and identifiers the v2 global plugin depends on. The plugin encodes collection **names** as constants and resolves GUIDs at runtime — these are recorded here for reference and ops, not hardcoded in `plugin.js`.

## Plugin

| Constant | Value | Notes |
|---|---|---|
| `GLOBAL_PLUGIN_GUID` | `1PYD1SFQB74D8DXJJ1P6QY8TNM` | The v2 global AppPlugin "Templater" |

## Collections

| Constant | Value | Notes |
|---|---|---|
| `TEMPLATES_GUID` | `1DEGAQTQARK8MKNAFZ9D1MY16W` | The **Templates** collection — source of template records (read by label: `Template Name`, `Template Content`, `Variables (JSON)`, `Triggers`, `Version`, `Extends`, `lastUsed`) |
| `AUDIT_GUID` | `14QZGY1XMNSQDQCTRW2MVS3H2W` | **Template Applications** — reused as the audit/apply log. Fields: `Template`, `Target Record`, `Target Collection`, `Applied At`, `Rendered Output`. Looked up by name "Template Log" first, then "Template Applications". Audit is best-effort — never throws if absent. |

## Workspace

| Constant | Value | Notes |
|---|---|---|
| `WORKSPACE_SVY` | `WEJ9EZW6ADT58SJC3EQMNETSW6` | The `svy` workspace where Templates + Template Applications live |

## Name constants (used in plugin.js instead of GUIDs)

- `TEMPLATES_COLL = "Templates"`
- `AUDIT_COLL_CANDIDATES = ["Template Log", "Template Applications"]`

GUIDs above are **not** hardcoded in the plugin — collections are resolved by name via `this.data.getAllCollections()` so the plugin survives id changes.

## v1 stack (kept until the user deletes it)

The v1 CollectionPlugin stack remains live and is intentionally **not** removed by the v2 build:

| Item | GUID |
|---|---|
| `Recurring Templates` collection | `191R6K0MMXFMRB4PSE4DNPP286` |
| Its CollectionPlugin | (attached to the `Recurring Templates` collection) |

v1 stays operational alongside v2 until the user explicitly deletes it. Do not migrate or trash the `Recurring Templates` collection or its CollectionPlugin as part of the v2 work.
