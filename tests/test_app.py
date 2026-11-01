import json
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class AnalysisTests(unittest.TestCase):
    def test_variants_edges_cycle_time_and_rework(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute(
            """CREATE TABLE events (
                event_id TEXT, case_id TEXT, activity TEXT, event_time TEXT, resource TEXT
            )"""
        )
        db.executemany(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
            [
                ("1", "C1", "Start", "2026-10-01T00:00:00+00:00", None),
                ("2", "C1", "Review", "2026-10-01T02:00:00+00:00", "R1"),
                ("3", "C1", "Review", "2026-10-01T03:00:00+00:00", "R1"),
                ("4", "C1", "End", "2026-10-01T05:00:00+00:00", "R2"),
                ("5", "C2", "Start", "2026-10-02T00:00:00+00:00", None),
            ],
        )
        result = server.analyze_events(
            db.execute("SELECT event_id, case_id, activity, event_time, resource FROM events").fetchall()
        )
        self.assertEqual(result["event_count"], 5)
        self.assertEqual(result["case_count"], 2)
        self.assertEqual(result["completed_cases"], 1)
        self.assertEqual(result["active_cases"], 1)
        self.assertEqual(result["variant_count"], 2)
        self.assertEqual(result["cycle_time"]["median_hours"], 5)
        self.assertEqual(result["cycle_time"]["p90_hours"], 5)
        self.assertEqual(result["rework_rate"], 0.5)
        self.assertEqual(result["edges"][0]["count"], 1)
        self.assertEqual(
            next(edge for edge in result["edges"] if edge["source"] == "Review" and edge["target"] == "Review")["median_hours"],
            1,
        )

    def test_percentile_interpolates(self):
        self.assertEqual(server.percentile([0, 10], 0.9), 9)
        self.assertIsNone(server.percentile([], 0.9))


class FinancialTests(unittest.TestCase):
    def test_calculates_transparent_savings_and_payback(self):
        result = server.financial_results(
            {
                "annual_volume": 1200,
                "manual_minutes": 30,
                "hourly_cost": 60,
                "eligible_share": 0.5,
                "time_reduction": 0.4,
                "realization": 0.75,
                "implementation_cost": 3000,
                "annual_recurring_cost": 1200,
                "ramp_months": 6,
            }
        )
        self.assertEqual(result["annual_addressable_labor_cost"], 36000)
        self.assertEqual(result["annual_gross_savings"], 5400)
        self.assertEqual(result["annual_net_benefit"], 4200)
        self.assertEqual(result["first_year_net_impact"], -150)
        self.assertEqual(result["three_year_net_benefit"], 8250)
        self.assertEqual(result["three_year_roi_percent"], 125)
        self.assertEqual(result["payback_months"], 11.6)

    def test_rejects_non_finite_or_out_of_range_inputs(self):
        assumptions = {
            "annual_volume": 1,
            "manual_minutes": 1,
            "hourly_cost": 1,
            "eligible_share": 0.5,
            "time_reduction": 0.5,
            "realization": 0.5,
            "implementation_cost": 1,
            "annual_recurring_cost": 1,
            "ramp_months": 1,
        }
        assumptions["eligible_share"] = 1.5
        with self.assertRaisesRegex(ValueError, "eligible_share"):
            server.financial_results(assumptions)
        assumptions["eligible_share"] = 0.5
        assumptions["annual_volume"] = 1.5
        with self.assertRaisesRegex(ValueError, "whole number"):
            server.financial_results(assumptions)


class ApiWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base_url = f"http://127.0.0.1:{cls.httpd.server_port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_data_dir, self.old_database = server.DATA_DIR, server.DATABASE
        server.DATA_DIR = server.Path(self.tempdir.name)
        server.DATABASE = server.DATA_DIR / "test.sqlite3"
        server.initialize()

    def tearDown(self):
        server.DATA_DIR, server.DATABASE = self.old_data_dir, self.old_database
        self.tempdir.cleanup()

    def request_json(self, path, body=None, expected_status=200):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            self.base_url + path,
            data=data,
            headers={"Content-Type": "application/json"},
            method="GET" if body is None else "POST",
        )
        try:
            response = urlopen(request, timeout=4)
        except HTTPError as error:
            self.assertEqual(error.code, expected_status)
            return json.loads(error.read())
        self.assertEqual(response.status, expected_status)
        return json.loads(response.read())

    def test_csv_import_validation_analysis_and_report(self):
        timestamp = datetime.now(timezone.utc).isoformat()
        content = (
            "invoice,step,when,owner\n"
            f"CASE-900,Received,{timestamp},Analyst\n"
            f"CASE-900,Approved,{timestamp},Manager\n"
            "CASE-901,Missing date,not-a-time,Manager\n"
        )
        imported = self.request_json(
            "/api/v1/imports",
            {
                "filename": "../invoices.csv",
                "content": content,
                "mapping": {
                    "case_id": "invoice",
                    "activity": "step",
                    "timestamp": "when",
                    "resource": "owner",
                },
            },
            201,
        )
        self.assertEqual(imported["filename"], "invoices.csv")
        self.assertEqual(imported["rows_seen"], 3)
        self.assertEqual(imported["rows_imported"], 2)
        self.assertEqual(imported["rows_rejected"], 1)
        self.assertEqual(imported["errors"][0]["row"], 4)
        duplicate = self.request_json(
            "/api/v1/imports",
            {
                "filename": "invoices.csv",
                "content": content,
                "mapping": {
                    "case_id": "invoice",
                    "activity": "step",
                    "timestamp": "when",
                    "resource": "owner",
                },
            },
            201,
        )
        self.assertEqual(duplicate["rows_imported"], 0)
        self.assertEqual(duplicate["rows_rejected"], 3)
        dashboard = self.request_json("/api/v1/dashboard?days=365")
        self.assertEqual(dashboard["analysis"]["quality_score"], 33)

        analysis = self.request_json("/api/v1/analysis?days=30")
        self.assertGreaterEqual(analysis["event_count"], 2)
        self.assertGreaterEqual(analysis["case_count"], 1)

        report_response = urlopen(self.base_url + "/api/v1/report.csv?days=30", timeout=4)
        report = report_response.read().decode("utf-8")
        self.assertIn("Median cycle time (hours)", report)
        self.assertIn("Variant", report)
        quality_report = urlopen(
            self.base_url + "/api/v1/report.csv?type=quality&days=90", timeout=4
        ).read().decode("utf-8")
        self.assertIn("0.3333", quality_report)

    def test_rejects_unsupported_date_range(self):
        result = self.request_json("/api/v1/dashboard?days=17", expected_status=400)
        self.assertIn("Date window", result["error"])

    def test_scenario_and_roadmap_persist(self):
        scenario = self.request_json(
            "/api/v1/scenario",
            {
                "assumptions": {
                    "annual_volume": 100,
                    "manual_minutes": 30,
                    "hourly_cost": 40,
                    "eligible_share": 0.5,
                    "time_reduction": 0.5,
                    "realization": 0.8,
                    "implementation_cost": 2000,
                    "annual_recurring_cost": 100,
                    "ramp_months": 4,
                }
            },
            201,
        )
        self.assertEqual(scenario["annual_gross_savings"], 400)
        initiative = self.request_json(
            "/api/v1/initiatives",
            {
                "title": "Review repeated approvals",
                "description": "Validate observed approval loops with process owners.",
                "owner": "Operations",
                "evidence": {"affected_cases": 9},
            },
            201,
        )
        stored = self.request_json("/api/v1/initiatives")
        self.assertEqual(stored["items"][0]["id"], initiative["id"])
        self.assertEqual(stored["items"][0]["evidence"]["affected_cases"], 9)
        financial_report = urlopen(
            self.base_url + "/api/v1/report.csv?type=financial&days=90", timeout=4
        ).read().decode("utf-8")
        self.assertIn("Three-year ROI estimate (%)", financial_report)

    def test_rejects_unknown_report_type(self):
        result = self.request_json("/api/v1/report.csv?type=unknown", expected_status=400)
        self.assertIn("Unsupported report type", result["error"])

    def test_upload_requires_mapping_and_size_bounds(self):
        result = self.request_json(
            "/api/v1/imports",
            {"filename": "events.csv", "content": "a,b,c\n1,2,3", "mapping": {"case_id": "a"}},
            400,
        )
        self.assertIn("Map case ID", result["error"])


if __name__ == "__main__":
    unittest.main()
