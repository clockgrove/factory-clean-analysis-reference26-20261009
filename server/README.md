# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Startup does not seed the data automatically. Press Ctrl+C (SIGINT), or send
SIGTERM, to stop accepting connections and close idle connections gracefully;
active requests finish before exit. From this checkout, verify in order:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

The first two commands prepare the pinned data/tooling and qualify the supplied
sandbox-enabled browser. The test suite includes a finite `npm run start`
harness and closes its owned process group; do not use a bare foreground start
as a verification command.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`/api/overview` accepts and validates the same query parameters as the list.
It applies the same search, facet and inclusive UTC date meanings, but measures
the complete filtered result independently of page, page size and sorting.
It returns `{total,services}`; each service entry contains `service`,
`incidentCount`, `unresolvedCount`, `highSeverityCount` and
`averageResolutionHours`. Unresolved counts open and in-progress incidents;
high severity counts critical and high incidents, regardless of status.
Average resolution hours is the arithmetic mean of elapsed hours from
`openedAt` to `resolvedAt` for matching resolved incidents only. It is `null`
when a service has no resolved matches. Entries sort by unresolved count
descending, then service name ascending. No matches return total zero and an
empty services array. Triage membership and notes remain in browser storage;
this read-only API does not store or modify personal triage metadata.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.
