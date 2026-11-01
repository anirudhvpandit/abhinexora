#!/usr/bin/env python3
"""Local-first AbhiNexora process intelligence application."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import math
import os
import sqlite3
import statistics
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = Path(os.environ.get("ABHINEXORA_DATA_DIR", ROOT / "data"))
DATABASE = DATA_DIR / "abhinexora.sqlite3"
TENANT_ID = "local-demo"
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
SLA_HOURS = 72.0
_db_lock = threading.Lock()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATABASE, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


def initialize() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                tenant_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS imports (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                status TEXT NOT NULL,
                rows_seen INTEGER NOT NULL,
                rows_imported INTEGER NOT NULL,
                rows_rejected INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                case_id TEXT NOT NULL,
                activity TEXT NOT NULL,
                event_time TEXT NOT NULL,
                resource TEXT,
                source_import_id TEXT,
                PRIMARY KEY (tenant_id, event_id),
                FOREIGN KEY (tenant_id) REFERENCES workspaces (tenant_id),
                FOREIGN KEY (source_import_id) REFERENCES imports (id)
            );
            CREATE INDEX IF NOT EXISTS idx_events_case_time
                ON events (tenant_id, case_id, event_time);
            CREATE INDEX IF NOT EXISTS idx_events_activity_time
                ON events (tenant_id, activity, event_time);
            CREATE TABLE IF NOT EXISTS scenarios (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                assumptions TEXT NOT NULL,
                results TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES workspaces (tenant_id)
            );
            CREATE TABLE IF NOT EXISTS initiatives (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                owner TEXT NOT NULL,
                status TEXT NOT NULL,
                evidence TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES workspaces (tenant_id)
            );
            """
        )
        db.execute(
            "INSERT OR IGNORE INTO workspaces (tenant_id, name, created_at) VALUES (?, ?, ?)",
            (TENANT_ID, "AbhiNexora Demonstration", now_iso()),
        )
        has_events = db.execute(
            "SELECT 1 FROM events WHERE tenant_id = ? LIMIT 1", (TENANT_ID,)
        ).fetchone()
        if not has_events:
            seed_events(db)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def event_key(case_id: str, activity: str, event_time: str, resource: str | None) -> str:
    raw = "\x1f".join((case_id, activity, event_time, resource or ""))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def seed_events(db: sqlite3.Connection) -> None:
    """Create reproducible synthetic event data through the same event table."""
    origin = datetime(2026, 8, 1, 8, tzinfo=timezone.utc)
    rows: list[tuple[str, str, str, str, str, str | None, str | None]] = []
    for number in range(1, 181):
        case_id = f"INV-{number:04d}"
        started = origin + timedelta(hours=(number * 11) % (24 * 75))
        pattern = number % 12
        if pattern in (0, 1):
            activities = [
                ("Invoice received", 0),
                ("Invoice validated", 2),
                ("Approval requested", 3),
                ("Approval requested", 45 + number % 22),
                ("Payment scheduled", 75 + number % 18),
                ("Payment completed", 80 + number % 20),
            ]
        elif pattern == 2:
            activities = [
                ("Invoice received", 0),
                ("Invoice validated", 3),
                ("Correction requested", 5),
                ("Invoice resubmitted", 28),
                ("Invoice validated", 31),
                ("Approval requested", 33),
                ("Payment scheduled", 54),
                ("Payment completed", 58),
            ]
        elif pattern == 3:
            activities = [
                ("Invoice received", 0),
                ("Invoice validated", 2),
                ("Approval requested", 4),
            ]
        elif pattern == 4:
            activities = [
                ("Invoice received", 0),
                ("Invoice validated", 2),
                ("Auto-approved", 3),
                ("Payment scheduled", 16),
                ("Payment completed", 20),
            ]
        else:
            activities = [
                ("Invoice received", 0),
                ("Invoice validated", 2 + number % 6),
                ("Approval requested", 4 + number % 8),
                ("Payment scheduled", 16 + number % 24),
                ("Payment completed", 20 + number % 28),
            ]
        for index, (activity, offset_hours) in enumerate(activities):
            timestamp = (started + timedelta(hours=offset_hours)).isoformat(timespec="seconds")
            resource = f"AP-{1 + number % 8:02d}" if index else None
            rows.append(
                (
                    event_key(case_id, activity, timestamp, resource),
                    TENANT_ID,
                    case_id,
                    activity,
                    timestamp,
                    resource,
                    None,
                )
            )
    db.executemany(
        """INSERT OR IGNORE INTO events
           (event_id, tenant_id, case_id, activity, event_time, resource, source_import_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )


def parse_timestamp(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def analyze_events(rows: list[sqlite3.Row]) -> dict:
    cases: dict[str, list[sqlite3.Row]] = {}
    activity_cases: dict[str, set[str]] = {}
    for row in rows:
        cases.setdefault(row["case_id"], []).append(row)
        activity_cases.setdefault(row["activity"], set()).add(row["case_id"])

    cycle_hours: list[float] = []
    durations: dict[tuple[str, str], list[float]] = {}
    edge_cases: dict[tuple[str, str], set[str]] = {}
    variant_cases: dict[tuple[str, ...], list[str]] = {}
    complete_cases = 0
    rework_cases = 0
    for case_id, events in cases.items():
        events.sort(key=lambda item: (item["event_time"], item["event_id"]))
        sequence = tuple(item["activity"] for item in events)
        variant_cases.setdefault(sequence, []).append(case_id)
        parsed_times = [parse_timestamp(item["event_time"]) for item in events]
        if len(events) >= 2:
            complete_cases += 1
            cycle_hours.append((parsed_times[-1] - parsed_times[0]).total_seconds() / 3600)
        if len(set(sequence)) < len(sequence):
            rework_cases += 1
        for index in range(len(events) - 1):
            left, right = events[index], events[index + 1]
            edge = (left["activity"], right["activity"])
            elapsed = max(
                0.0, (parsed_times[index + 1] - parsed_times[index]).total_seconds() / 3600
            )
            durations.setdefault(edge, []).append(elapsed)
            edge_cases.setdefault(edge, set()).add(case_id)

    case_total = len(cases)
    transitions_total = sum(len(items) for items in durations.values())
    variants = []
    for sequence, case_ids in variant_cases.items():
        variants.append(
            {
                "sequence": list(sequence),
                "cases": len(case_ids),
                "share": len(case_ids) / case_total if case_total else 0,
                "median_hours": case_median_cycle(cases, case_ids),
            }
        )
    variants.sort(key=lambda item: (-item["cases"], item["sequence"]))

    edges = []
    for (source, target), observed_durations in durations.items():
        edges.append(
            {
                "source": source,
                "target": target,
                "count": len(observed_durations),
                "case_count": len(edge_cases[(source, target)]),
                "transition_share": len(observed_durations) / transitions_total
                if transitions_total
                else 0,
                "median_hours": statistics.median(observed_durations),
                "mean_hours": statistics.fmean(observed_durations),
            }
        )
    edges.sort(key=lambda item: (-item["count"], item["source"], item["target"]))

    activities = [
        {"name": name, "cases": len(case_ids), "events": sum(1 for row in rows if row["activity"] == name)}
        for name, case_ids in activity_cases.items()
    ]
    activities.sort(key=lambda item: (-item["events"], item["name"]))
    breached = sum(value > SLA_HOURS for value in cycle_hours)
    quality = round(100 * (len(rows) / max(len(rows), 1)))
    bottlenecks = [
        edge
        for edge in edges
        if edge["case_count"] >= max(5, math.ceil(case_total * 0.04))
        and edge["median_hours"] >= 8
    ]
    bottlenecks.sort(key=lambda item: (-item["median_hours"], -item["case_count"]))

    return {
        "event_count": len(rows),
        "case_count": case_total,
        "completed_cases": complete_cases,
        "active_cases": case_total - complete_cases,
        "cycle_time": {
            "median_hours": statistics.median(cycle_hours) if cycle_hours else None,
            "mean_hours": statistics.fmean(cycle_hours) if cycle_hours else None,
            "p90_hours": percentile(cycle_hours, 0.9),
            "observed_cases": len(cycle_hours),
        },
        "sla": {
            "threshold_hours": SLA_HOURS,
            "breached_cases": breached,
            "compliance": (complete_cases - breached) / complete_cases if complete_cases else None,
        },
        "rework_rate": rework_cases / case_total if case_total else 0,
        "variant_count": len(variants),
        "quality_score": quality,
        "activities": activities,
        "edges": edges,
        "variants": variants,
        "bottlenecks": bottlenecks,
    }


def case_median_cycle(
    cases: dict[str, list[sqlite3.Row]], case_ids: list[str]
) -> float | None:
    values = []
    for case_id in case_ids:
        events = cases[case_id]
        if len(events) > 1:
            first = parse_timestamp(events[0]["event_time"])
            last = parse_timestamp(events[-1]["event_time"])
            values.append((last - first).total_seconds() / 3600)
    return statistics.median(values) if values else None


def load_analysis(db: sqlite3.Connection, days: int | None = None) -> dict:
    if days not in (None, 30, 90, 365):
        raise ValueError("Date window must be 30, 90, or 365 days")
    if days is None:
        rows = db.execute(
            """SELECT event_id, case_id, activity, event_time, resource
               FROM events WHERE tenant_id = ? ORDER BY case_id, event_time, event_id""",
            (TENANT_ID,),
        ).fetchall()
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        rows = db.execute(
            """SELECT event_id, case_id, activity, event_time, resource
               FROM events WHERE tenant_id = ? AND event_time >= ?
               ORDER BY case_id, event_time, event_id""",
            (TENANT_ID, since),
        ).fetchall()
    return analyze_events(rows)


def import_quality_score(db: sqlite3.Connection) -> int:
    totals = db.execute(
        """SELECT COALESCE(SUM(rows_seen), 0) AS seen,
                  COALESCE(SUM(rows_imported), 0) AS accepted
           FROM imports WHERE tenant_id = ?""",
        (TENANT_ID,),
    ).fetchone()
    return round(totals["accepted"] / totals["seen"] * 100) if totals["seen"] else 100


def financial_results(assumptions: dict) -> dict:
    required = {
        "annual_volume": (1, 100_000_000),
        "manual_minutes": (0, 10_000),
        "hourly_cost": (0, 1_000_000),
        "eligible_share": (0, 1),
        "time_reduction": (0, 1),
        "realization": (0, 1),
        "implementation_cost": (0, 1_000_000_000),
        "annual_recurring_cost": (0, 1_000_000_000),
        "ramp_months": (0, 36),
    }
    clean: dict[str, float] = {}
    for key, (minimum, maximum) in required.items():
        try:
            value = float(assumptions[key])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"{key} must be a number") from None
        if not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"{key} must be between {minimum} and {maximum}")
        if key in {"annual_volume", "ramp_months"} and not value.is_integer():
            raise ValueError(f"{key} must be a whole number")
        clean[key] = value
    addressable = clean["annual_volume"] * clean["manual_minutes"] / 60 * clean["hourly_cost"]
    gross = addressable * clean["eligible_share"] * clean["time_reduction"] * clean["realization"]
    net = gross - clean["annual_recurring_cost"]
    ramp_factor = max(0.0, min(1.0, (12 - clean["ramp_months"] / 2) / 12))
    first_year = gross * ramp_factor - clean["annual_recurring_cost"] - clean["implementation_cost"]
    three_year_gross = gross * (3 - clean["ramp_months"] / 24)
    three_year_net = three_year_gross - clean["implementation_cost"] - 3 * clean["annual_recurring_cost"]
    investment = clean["implementation_cost"] + 3 * clean["annual_recurring_cost"]
    payback = None
    monthly_net = net / 12
    if monthly_net > 0:
        payback = clean["implementation_cost"] / monthly_net + clean["ramp_months"] / 2
    return {
        "assumptions": clean,
        "annual_addressable_labor_cost": round(addressable, 2),
        "annual_gross_savings": round(gross, 2),
        "annual_net_benefit": round(net, 2),
        "first_year_net_impact": round(first_year, 2),
        "three_year_net_benefit": round(three_year_net, 2),
        "three_year_roi_percent": round(three_year_net / investment * 100, 1)
        if investment
        else None,
        "payback_months": round(payback, 1) if payback is not None else None,
        "ramp_factor": round(ramp_factor, 3),
        "label": "Estimate — validate assumptions before investment decisions",
    }


def json_bytes(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "AbhiNexoraLocal/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        logging.info("request method=%s path=%s", self.command, urlparse(self.path).path)

    def respond(self, status: int, data: object, content_type: str = "application/json") -> None:
        payload = json_bytes(data) if content_type == "application/json" else data
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request length") from None
        if length <= 0 or length > MAX_UPLOAD_BYTES + 32_000:
            raise ValueError("Request body must be between 1 byte and 8 MB")
        try:
            body = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Request body must be valid JSON") from None
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object")
        return body

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            with _db_lock, connect() as db:
                if path == "/api/v1/health":
                    self.respond(200, {"status": "ok", "storage": "sqlite"})
                elif path == "/api/v1/analysis":
                    days = int(parse_qs(parsed.query).get("days", ["90"])[0])
                    analysis = load_analysis(db, days)
                    analysis["quality_score"] = import_quality_score(db)
                    self.respond(200, analysis)
                elif path == "/api/v1/dashboard":
                    days = int(parse_qs(parsed.query).get("days", ["90"])[0])
                    analysis = load_analysis(db, days)
                    imports = db.execute(
                        """SELECT COUNT(*) AS count
                           FROM imports WHERE tenant_id = ?""",
                        (TENANT_ID,),
                    ).fetchone()
                    analysis["quality_score"] = import_quality_score(db)
                    self.respond(
                        200,
                        {
                            "workspace": "AbhiNexora Demonstration",
                            "dataset_label": "Synthetic demonstration data"
                            if imports["count"] == 0
                            else "Imported event log",
                            "import_count": imports["count"],
                            "analysis": analysis,
                            "calculation_notes": {
                                "cycle_time": "Elapsed time from first to last event in cases with at least two events.",
                                "sla": f"Completed cases exceeding {SLA_HOURS:g} elapsed hours are breaches.",
                                "rework": "A case is counted when any activity repeats in its observed sequence.",
                                "edge_share": "Transition event count divided by all directly-follows transitions.",
                            },
                        },
                    )
                elif path == "/api/v1/events":
                    query = parse_qs(parsed.query)
                    limit = min(200, max(1, int(query.get("limit", ["50"])[0])))
                    offset = max(0, int(query.get("offset", ["0"])[0]))
                    days = int(query.get("days", ["90"])[0])
                    if days not in (30, 90, 365):
                        raise ValueError("Date window must be 30, 90, or 365 days")
                    search = query.get("q", [""])[0].strip()
                    if len(search) > 100:
                        raise ValueError("Search text must be 100 characters or fewer")
                    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
                    where = "tenant_id = ? AND event_time >= ?"
                    params: list[object] = [TENANT_ID, since]
                    if search:
                        where += " AND (case_id LIKE ? OR activity LIKE ? OR resource LIKE ?)"
                        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                        params.extend([f"%{escaped}%"] * 3)
                    result = db.execute(
                        f"""SELECT case_id, activity, event_time, resource FROM events
                            WHERE {where} ORDER BY event_time DESC, event_id LIMIT ? OFFSET ?""",
                        (*params, limit, offset),
                    ).fetchall()
                    total = db.execute(
                        f"SELECT COUNT(*) AS count FROM events WHERE {where}", params
                    ).fetchone()["count"]
                    self.respond(
                        200,
                        {"items": [dict(row) for row in result], "total": total, "limit": limit, "offset": offset},
                    )
                elif path == "/api/v1/imports":
                    rows = db.execute(
                        """SELECT id, filename, status, rows_seen, rows_imported, rows_rejected, created_at
                           FROM imports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50""",
                        (TENANT_ID,),
                    ).fetchall()
                    self.respond(200, {"items": [dict(row) for row in rows]})
                elif path == "/api/v1/scenario":
                    row = db.execute(
                        """SELECT assumptions, results FROM scenarios
                           WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 1""",
                        (TENANT_ID,),
                    ).fetchone()
                    if row:
                        self.respond(200, json.loads(row["results"]))
                    else:
                        self.respond(200, financial_results(default_assumptions(db)))
                elif path == "/api/v1/initiatives":
                    rows = db.execute(
                        """SELECT id, title, description, owner, status, evidence, created_at
                           FROM initiatives WHERE tenant_id = ? ORDER BY created_at DESC""",
                        (TENANT_ID,),
                    ).fetchall()
                    self.respond(
                        200,
                        {"items": [{**dict(row), "evidence": json.loads(row["evidence"])} for row in rows]},
                    )
                elif path == "/api/v1/report.csv":
                    query = parse_qs(parsed.query)
                    days = int(query.get("days", ["90"])[0])
                    if days not in (30, 90, 365):
                        raise ValueError("Date window must be 30, 90, or 365 days")
                    report_type = query.get("type", ["executive"])[0]
                    if report_type not in {"executive", "current-state", "bottlenecks", "variants", "quality", "financial"}:
                        raise ValueError("Unsupported report type")
                    self.send_report(db, days, report_type)
                elif path == "/" or path.startswith("/static/"):
                    self.serve_static(path)
                else:
                    self.respond(404, {"error": "Not found"})
        except (ValueError, IndexError) as error:
            self.respond(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            logging.exception("request failed")
            self.respond(500, {"error": "The request could not be completed. Check local server logs."})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            with _db_lock, connect() as db:
                if path == "/api/v1/imports":
                    self.import_csv(db, body)
                elif path == "/api/v1/scenario":
                    results = financial_results(body.get("assumptions", body))
                    db.execute(
                        """INSERT INTO scenarios (id, tenant_id, assumptions, results, updated_at)
                           VALUES (?, ?, ?, ?, ?)""",
                        (
                            str(uuid.uuid4()),
                            TENANT_ID,
                            json.dumps(results["assumptions"]),
                            json.dumps(results),
                            now_iso(),
                        ),
                    )
                    self.respond(201, results)
                elif path == "/api/v1/initiatives":
                    title = str(body.get("title", "")).strip()
                    description = str(body.get("description", "")).strip()
                    owner = str(body.get("owner", "Unassigned")).strip()
                    if not title or len(title) > 160 or len(description) > 3000 or len(owner) > 120:
                        raise ValueError("Provide a title (1–160 characters); other fields are limited to 3,000 characters.")
                    evidence = body.get("evidence", {})
                    if not isinstance(evidence, dict):
                        raise ValueError("Evidence must be an object")
                    initiative_id = str(uuid.uuid4())
                    db.execute(
                        """INSERT INTO initiatives
                           (id, tenant_id, title, description, owner, status, evidence, created_at)
                           VALUES (?, ?, ?, ?, ?, 'Proposed', ?, ?)""",
                        (initiative_id, TENANT_ID, title, description, owner, json.dumps(evidence), now_iso()),
                    )
                    self.respond(
                        201,
                        {
                            "id": initiative_id,
                            "title": title,
                            "description": description,
                            "owner": owner,
                            "status": "Proposed",
                            "evidence": evidence,
                        },
                    )
                else:
                    self.respond(404, {"error": "Not found"})
        except ValueError as error:
            self.respond(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            logging.exception("request failed")
            self.respond(500, {"error": "The request could not be completed. Check local server logs."})

    def import_csv(self, db: sqlite3.Connection, body: dict) -> None:
        filename = str(body.get("filename", "")).replace("\\", "/").split("/")[-1][:160]
        content = body.get("content")
        mapping = body.get("mapping")
        if not filename.lower().endswith(".csv"):
            raise ValueError("Only CSV files are supported in this release")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("CSV content is required")
        if len(content.encode("utf-8")) > MAX_UPLOAD_BYTES:
            raise ValueError("CSV file exceeds the 8 MB upload limit")
        if not isinstance(mapping, dict) or not all(mapping.get(key) for key in ("case_id", "activity", "timestamp")):
            raise ValueError("Map case ID, activity, and timestamp columns before importing")
        try:
            reader = csv.DictReader(io.StringIO(content, newline=""))
            headers = reader.fieldnames or []
            if not headers:
                raise ValueError("CSV must include a header row")
            for key, column in mapping.items():
                if column and column not in headers:
                    raise ValueError(f"Mapped column for {key} was not found in the CSV")
            import_id = str(uuid.uuid4())
            created_at = now_iso()
            db.execute(
                """INSERT INTO imports
                   (id, tenant_id, filename, status, rows_seen, rows_imported, rows_rejected, created_at)
                   VALUES (?, ?, ?, 'processing', 0, 0, 0, ?)""",
                (import_id, TENANT_ID, filename, created_at),
            )
            seen = set()
            rejected: list[dict] = []
            rejected_count = 0
            to_insert: list[tuple] = []
            rows_seen = 0
            existing = {
                row["event_id"]
                for row in db.execute(
                    "SELECT event_id FROM events WHERE tenant_id = ?", (TENANT_ID,)
                ).fetchall()
            }
            for row_number, record in enumerate(reader, start=2):
                rows_seen += 1
                try:
                    case_id = (record.get(mapping["case_id"]) or "").strip()
                    activity = (record.get(mapping["activity"]) or "").strip()
                    timestamp_value = (record.get(mapping["timestamp"]) or "").strip()
                    if not case_id or not activity or not timestamp_value:
                        raise ValueError("case ID, activity, and timestamp are required")
                    if len(case_id) > 200 or len(activity) > 200:
                        raise ValueError("case ID and activity must be 200 characters or fewer")
                    timestamp = parse_timestamp(timestamp_value).isoformat(timespec="seconds")
                    resource_column = mapping.get("resource")
                    resource = (record.get(resource_column) or "").strip() if resource_column else ""
                    resource = resource[:200] or None
                    identity = event_key(case_id, activity, timestamp, resource)
                    if identity in seen or identity in existing:
                        raise ValueError("duplicate event")
                    seen.add(identity)
                    to_insert.append((identity, TENANT_ID, case_id, activity, timestamp, resource, import_id))
                except (ValueError, TypeError) as error:
                    rejected_count += 1
                    if len(rejected) < 100:
                        rejected.append({"row": row_number, "reason": str(error)})
            db.executemany(
                """INSERT INTO events
                   (event_id, tenant_id, case_id, activity, event_time, resource, source_import_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                to_insert,
            )
            status = "completed" if not rejected_count else ("completed_with_errors" if to_insert else "failed")
            db.execute(
                """UPDATE imports SET status = ?, rows_seen = ?, rows_imported = ?, rows_rejected = ?
                   WHERE id = ? AND tenant_id = ?""",
                (status, rows_seen, len(to_insert), rejected_count, import_id, TENANT_ID),
            )
            self.respond(
                201,
                {
                    "id": import_id,
                    "filename": filename,
                    "status": status,
                    "rows_seen": rows_seen,
                    "rows_imported": len(to_insert),
                    "rows_rejected": rejected_count,
                    "errors": rejected,
                    "message": f"Imported {len(to_insert)} events; {len(rejected)} rows were rejected.",
                },
            )
        except csv.Error as error:
            raise ValueError(f"Could not parse CSV: {error}") from None

    def send_report(self, db: sqlite3.Connection, days: int, report_type: str) -> None:
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["AbhiNexora — Process analysis"])
        writer.writerow(["Report type", report_type])
        writer.writerow(["Generated at (UTC)", now_iso()])
        writer.writerow(["Selected window (days)", days])
        import_count = db.execute(
            "SELECT COUNT(*) AS count FROM imports WHERE tenant_id = ?", (TENANT_ID,)
        ).fetchone()["count"]
        writer.writerow([
            "Dataset",
            "Imported event log" if import_count else "Synthetic demonstration data",
        ])
        writer.writerow(["Methodology", "Observed-event analysis; elapsed intervals do not establish causal waiting time."])
        if report_type == "quality":
            imports = db.execute(
                """SELECT filename, status, rows_seen, rows_imported, rows_rejected, created_at
                   FROM imports WHERE tenant_id = ? ORDER BY created_at DESC""",
                (TENANT_ID,),
            ).fetchall()
            seen = sum(item["rows_seen"] for item in imports)
            accepted = sum(item["rows_imported"] for item in imports)
            writer.writerow(["Current stored events", db.execute(
                "SELECT COUNT(*) AS count FROM events WHERE tenant_id = ?", (TENANT_ID,)
            ).fetchone()["count"]])
            writer.writerow(["Import validity formula", "accepted imported rows / submitted rows"])
            writer.writerow(["Import validity", round(accepted / seen, 4) if seen else 1])
            writer.writerow([])
            writer.writerow(["Filename", "Status", "Rows seen", "Rows accepted", "Rows rejected", "Created at (UTC)"])
            for item in imports:
                writer.writerow([
                    self.safe_spreadsheet(item["filename"]),
                    item["status"],
                    item["rows_seen"],
                    item["rows_imported"],
                    item["rows_rejected"],
                    item["created_at"],
                ])
        elif report_type == "financial":
            row = db.execute(
                """SELECT assumptions, results FROM scenarios WHERE tenant_id = ?
                   ORDER BY updated_at DESC LIMIT 1""",
                (TENANT_ID,),
            ).fetchone()
            result = json.loads(row["results"]) if row else financial_results(default_assumptions(db))
            writer.writerow(["Label", result["label"]])
            writer.writerow([
                "Annual gross savings formula",
                "Annual volume × manual minutes ÷ 60 × hourly cost × eligible share × time reduction × realization",
            ])
            writer.writerow([
                "Ramp-up limitation",
                "Linear half-ramp-year approximation; three-year cash flows are undiscounted.",
            ])
            writer.writerow(["Output", "Value"])
            for label, key in (
                ("Annual addressable labor cost (USD)", "annual_addressable_labor_cost"),
                ("Annual gross savings estimate (USD)", "annual_gross_savings"),
                ("Annual net benefit estimate (USD)", "annual_net_benefit"),
                ("First-year net impact estimate (USD)", "first_year_net_impact"),
                ("Three-year net benefit estimate (USD)", "three_year_net_benefit"),
                ("Three-year ROI estimate (%)", "three_year_roi_percent"),
                ("Payback estimate (months)", "payback_months"),
            ):
                writer.writerow([label, result[key] if result[key] is not None else ""])
            writer.writerow([])
            writer.writerow(["Assumption", "Value"])
            for key, value in result["assumptions"].items():
                writer.writerow([key, value])
        else:
            analysis = load_analysis(db, days)
            if report_type in {"executive", "current-state"}:
                writer.writerow(["Cycle-time definition", "First-to-last observed event, cases with at least two events"])
                writer.writerow(["P90 method", "Linear interpolation at (n - 1) × 0.9"])
                writer.writerow(["SLA definition", f"Completed cases with cycle time <= {SLA_HOURS:g} elapsed hours"])
                writer.writerow(["Rework definition", "Cases with at least one repeated activity name"])
                writer.writerow(["Cases", analysis["case_count"]])
                writer.writerow(["Events", analysis["event_count"]])
                writer.writerow(["Median cycle time (hours)", analysis["cycle_time"]["median_hours"] or ""])
                writer.writerow(["P90 cycle time (hours)", analysis["cycle_time"]["p90_hours"] or ""])
                writer.writerow(["SLA threshold (hours)", analysis["sla"]["threshold_hours"]])
                writer.writerow(["SLA compliance", analysis["sla"]["compliance"] or ""])
                writer.writerow(["Rework rate", analysis["rework_rate"]])
            if report_type in {"executive", "current-state", "bottlenecks"}:
                writer.writerow([])
                writer.writerow([
                    "Bottleneck rule",
                    "Median adjacent-event elapsed time >= 8 hours and distinct cases >= max(5, ceil(4% of cases))",
                ])
                writer.writerow(["Bottleneck transition", "Affected cases", "Median elapsed hours", "Events"])
                for item in analysis["bottlenecks"]:
                    writer.writerow([
                        self.safe_spreadsheet(f'{item["source"]} → {item["target"]}'),
                        item["case_count"],
                        round(item["median_hours"], 2),
                        item["count"],
                    ])
            if report_type in {"executive", "current-state", "variants"}:
                writer.writerow([])
                writer.writerow(["Variant definition", "Exact ordered activity-name sequence per case; incomplete traces retained"])
                writer.writerow(["Variant", "Cases", "Share", "Median cycle hours"])
                for index, variant in enumerate(analysis["variants"], start=1):
                    writer.writerow([
                        self.safe_spreadsheet(f"Variant {index}: " + " → ".join(variant["sequence"])),
                        variant["cases"],
                        round(variant["share"], 4),
                        round(variant["median_hours"], 2) if variant["median_hours"] is not None else "",
                    ])
        self.respond(
            200,
            output.getvalue().encode("utf-8"),
            "text/csv",
        )

    @staticmethod
    def safe_spreadsheet(value: str) -> str:
        return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value

    def serve_static(self, path: str) -> None:
        relative = "index.html" if path == "/" else path.removeprefix("/static/")
        target = (STATIC / relative).resolve()
        if STATIC.resolve() not in target.parents and target != STATIC.resolve():
            self.respond(404, {"error": "Not found"})
            return
        if not target.is_file():
            self.respond(404, {"error": "Not found"})
            return
        content_type = {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "text/javascript",
            ".svg": "image/svg+xml",
        }.get(target.suffix, "application/octet-stream")
        self.respond(200, target.read_bytes(), content_type)


def default_assumptions(db: sqlite3.Connection) -> dict:
    analysis = load_analysis(db)
    observed_days = 75
    annual_volume = round(analysis["case_count"] * 365 / observed_days)
    return {
        "annual_volume": max(1, annual_volume),
        "manual_minutes": 35,
        "hourly_cost": 42,
        "eligible_share": 0.55,
        "time_reduction": 0.3,
        "realization": 0.7,
        "implementation_cost": 18000,
        "annual_recurring_cost": 4800,
        "ramp_months": 6,
    }


def main() -> None:
    initialize()
    host = os.environ.get("ABHINEXORA_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8019"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"AbhiNexora listening at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping AbhiNexora.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
