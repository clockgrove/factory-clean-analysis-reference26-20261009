# Incident explorer frontend

Serve this directory from the local app's same origin. `index.html` loads `app.js`, with `state.js`, `triage.js`, and `styles.css`; requests use `/api/incidents`, `/api/overview`, `/api/incidents/:id`, and `/api/export.csv`. No dataset or server is embedded in the frontend.

Search is submitted with Search or Enter. Facet, date, sorting, and page-size changes apply immediately and return to page one. Dates and displayed timestamps use UTC. The overview and daily counts describe the full matching result. While updating, the previous completed rows and summaries remain explicitly marked, and page controls are disabled. CSV exports the current applied selections and sort, across all pages; tags follow the API's JSON-array CSV representation.

The service overview uses the complete filtered scope, including later pages. Its incident count includes every match; unresolved means open or in progress; critical-or-high counts both severities in any status. Average resolution hours uses only resolved matches and is unavailable when none exist, rather than zero. Services sort by unresolved count descending and name ascending. Page, page-size and sort changes leave these measures unchanged. An empty scope has an empty state. Selection labels identify which filters the displayed measures represent, and previous measures stay marked during loading or failure. Retry uses current filters. Independent overview ownership prevents obsolete successes, errors or cleanup from overwriting a newer selection.

Copy or bookmark the browser address to share the applied query, including sorting, page size and later pages. Reload and fresh tabs restore the results view. Back and Forward restore controls (discarding unsent drafts), rows and whole-result summaries; pending requests retain the previous snapshot as stale. Details and export activity do not create history entries. Invalid address values fall back to defaults; invalid dates clear and reversed date ranges clear both bounds. Unknown parameters are removed.

Named views persist the applied search, facets, dates, sorting, and page size in browser localStorage. Opening a view applies its selections together and returns to page one. Storage failures are visible and exploration remains available.

Personal triage is separate from named views and the address. Add from complete details; repeat addition is disabled for an existing member. Entries retain addition order and incident recognition snapshots. Edit a plain-text note of up to 1,000 characters directly in the list; input saves immediately. Markup-looking punctuation remains text. Open an entry to revisit full details without changing the search or page. Removing it also deletes its note, so re-adding starts blank. The native dialog, labeled buttons and note fields support keyboard use and focus restoration; the overview measures and triage actions are reachable on a narrow screen.

The `incident-explorer.triage.v1` localStorage value holds membership, snapshots and notes for this origin. Reload restores saved entries; changing hostname, port, browser or profile uses separate storage. Clearing storage removes the list, and there is no cross-tab synchronization. Triage never changes canonical incidents or goes to an external service. Unavailable reads or malformed stored values produce a visible warning while keeping this visit usable. Write failures preserve the current in-memory list and notes, but reload may recover an older stored value or lose unsaved edits. Successful later writes clear the write warning; read and malformed-data warnings remain for the visit.

The native details dialog supports keyboard dismissal, exposes every incident field as text, and restores focus to the incident on return. Results, detail sessions, and exports have separate ownership tokens. Each completion, error, and cleanup is gated; changed selections invalidate details and export downloads. Cancellation helps save work but tokens provide correctness. Download object URLs are released.

Run the repository's exact verification command from the checkout:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

Run these commands in order. Discoverable tests under `tests/frontend/` exercise the actual DOM-free modules with direct events. These establish component behavior, including overlapping intents, retries and storage limitations; they do not establish real HTTP or browser integration. The integration suites run real sandbox-enabled Chromium against the existing backend and compare with an independent canonical-data oracle, covering the overview and triage alongside existing regression journeys. Their waits are bounded and cleanup closes owned servers, contexts, browsers and startup subprocesses. See the root README for preparation, browser qualification and the actual loopback startup/shutdown procedure.

Component review: `state.js` separates the requested intent from the last displayed snapshot and publishes rows and whole-result summaries atomically. Pending or stale queries lock pagination, and synchronous page transitions are clamped before dispatch. The UI retains the native modal and return target while detail ownership changes; it renders dataset values through text nodes. Independent operation tokens gate success, failure, and cleanup, and export gates download side effects after reading the response. This review establishes frontend structure and state behavior only.
