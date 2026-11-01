# AbhiNexora

AbhiNexora is a local-first process-intelligence demonstration built around one end-to-end workflow: import or inspect invoice events, discover observed process behavior, investigate elapsed-time signals, model savings assumptions, create roadmap proposals, and export an evidence-backed CSV report.

This repository was empty and the environment did not provide Node.js or FastAPI. The application therefore uses the Python standard library, a small responsive HTML/CSS/JavaScript client, and SQLite. It is runnable without installing dependencies. This is a verified local vertical slice, **not an enterprise production release**.

## Run locally

Requires Python 3.9 or later.

```sh
python3 server.py
```

Open [http://127.0.0.1:8019](http://127.0.0.1:8019). The server binds to loopback by default. Stop it with Ctrl+C.

The SQLite database is created at `data/abhinexora.sqlite3` and seeded on first run with reproducible synthetic invoice events. Set `ABHINEXORA_DATA_DIR` to use another local data directory, or set `PORT` to change the port:

```sh
ABHINEXORA_DATA_DIR=/path/to/local/data PORT=8020 python3 server.py
```

Keep the server bound to `127.0.0.1`. Changing `ABHINEXORA_HOST` exposes the app to other interfaces; this build has no authentication and must not be exposed to a network.

## Implemented workflow

- Deterministic sample invoices are seeded into SQLite and analyzed like imported records.
- CSV import supports UTF-8 data with a header row, configurable case/activity/timestamp/resource mappings, ISO timestamps, duplicate detection, required-field checks, an 8 MB limit, and row-level rejection summaries.
- A searchable, paginated event explorer displays persisted events and import history.
- Discovery computes exact activity-sequence variants, directly-follows edge counts/shares, distinct case counts, median/mean adjacent-event elapsed time, case cycle time, P90, repeated-activity rate, and the demonstration SLA rate.
- The process map and detail panel use the analysis API response; edge filters affect the view without changing source events.
- Explainable bottleneck signals use a visible rule: at least 8 hours median elapsed time and a minimum volume of five cases or 4% of cases, whichever is greater.
- Opportunity cards present event-log evidence and control caveats; users can save a proposal to SQLite.
- Financial assumptions are validated and saved. The UI shows formula inputs and labels outputs as estimates.
- Roadmap proposals persist across restarts.
- Analysis CSV is generated from current stored events, including method notes, variants, and bottlenecks. Spreadsheet-leading characters are escaped.
- The 30/90/365-day selector filters the current analytical views.

## API

The versioned JSON API is served by the same-origin local server:

| Route | Behavior |
|---|---|
| `GET /api/v1/health` | Local server readiness |
| `GET /api/v1/dashboard?days=90` | Workspace label, calculations, and method notes |
| `GET /api/v1/analysis?days=90` | Process discovery and performance calculations |
| `GET /api/v1/events?days=90&limit=12&offset=0&q=` | Searchable event page |
| `GET /api/v1/imports` | Import summaries |
| `POST /api/v1/imports` | Validate and persist mapped CSV events |
| `GET /api/v1/scenario` / `POST /api/v1/scenario` | Read or calculate and persist a scenario |
| `GET /api/v1/initiatives` / `POST /api/v1/initiatives` | Read or create roadmap proposals |
| `GET /api/v1/report.csv?days=90&type=executive` | Generate `executive`, `current-state`, `bottlenecks`, `variants`, `quality`, or `financial` CSV |

JSON errors use an `error` field and standard HTTP status codes. The API has no public cross-origin access configured. A fixed local workspace identifier scopes SQLite queries; it is **not authentication or a tenant-security boundary**.

## Test

```sh
python3 -m unittest discover -s tests -v
```

Tests use only the Python standard library and temporary SQLite databases. They cover known-answer process calculations, scenario arithmetic and input validation, CSV import/error handling, persistent roadmap creation, and report output.

## Method and definitions

See [METHODOLOGY.md](./METHODOLOGY.md) for calculation definitions, limitations, and the sample-data recipe.

## Not implemented / production blockers

- No authentication, invitation flow, role-based access control, or verified tenant isolation.
- SQLite is used instead of PostgreSQL; no migrations or separate database service.
- No asynchronous jobs, Redis, worker process, cancellation, or large-log streaming.
- CSV only; XLSX and JSON import are not included.
- No formal Petri-net/inductive discovery, lifecycle processing-time semantics, target-state editor, or formal conformance engine.
- No audit trail, comments, notification provider, SSO, integrations, admin console, or retention workflows.
- No PDF/XLSX report, CI pipeline, container build, production reverse proxy, backup/restore test, or security/dependency scan.
- The application has not been load-tested, penetration-tested, deployed, or assessed for regulatory requirements.
- The implementation reads selected event records into application memory for calculations; do not use it as an enterprise-scale process-mining engine.

Before any real operational evaluation, implement and independently verify authentication, tenant/resource authorization, a production database and migrations, background processing, secure deployment, retention, backups, audit logging, and the outstanding security and reliability controls. Do not expose this unauthenticated local server to the network.
# abhinexora
