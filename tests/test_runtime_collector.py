import datetime as dt
import importlib.util
import pathlib
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("collector", pathlib.Path(__file__).parents[1] / "agent" / "luigi_runtime_collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_budgets_are_visible_and_units_rotate(self):
        now = dt.datetime.now(dt.timezone.utc)
        containers = [{"id": str(i), "key": f"container:{i:03}", "label": f"service-{i:03}", "running": True,
                       "restartCount": 0, "startedAt": now} for i in range(80)]
        events = [{"type": "restart", "unitKey": "container:000", "unitLabel": "shop", "occurredAt": collector.iso(now), "count": 1} for _ in range(55)]
        state = {"bootId": "boot", "containers": {}, "events": events, "eventsSince": collector.iso(now - dt.timedelta(hours=25))}
        with patch.object(collector, "load_state", return_value=state) as load, \
                patch.object(collector, "BOOT_ID", Mock(read_text=lambda **_: "boot")), \
                patch.object(collector, "docker_containers", return_value=containers), \
                patch.object(collector, "systemd_services", return_value=[]), \
                patch.object(collector, "boot_time", return_value=now), \
                patch.object(collector, "kernel_oom_kills", return_value=([], "cursor")), \
                patch.object(collector, "container_cgroup", return_value=None), \
                patch.dict(collector.os.environ, {"LUIGI_SERVICES": "", "LUIGI_RUNTIME_UNITS": ""}):
            first, next_state = collector.collect()
            self.assertEqual(len(first["units"]), 40)
            self.assertEqual(first["completeness"]["omittedUnits"], 40)
            self.assertEqual(first["completeness"]["omittedEvents"], 5)
            self.assertEqual(first["completeness"]["events"], "partial")
            self.assertEqual(len(next_state["events"]), 55)
            load.return_value = next_state
            second, _ = collector.collect()
            self.assertFalse({u["key"] for u in first["units"]} & {u["key"] for u in second["units"]})

    def test_lost_journal_cursor_is_reported(self):
        collector.COLLECTION_ERRORS.clear()
        with patch.object(collector, "command", side_effect=[(1, ""), (0, "")]):
            collector.kernel_oom_kills("lost-cursor")
        self.assertIn("journal_cursor_lost", collector.COLLECTION_ERRORS)

    def test_kernel_budget_is_never_claimed_complete(self):
        collector.COLLECTION_ERRORS.clear()
        with patch.object(collector, "MAX_KERNEL_LINES", 2), patch.object(collector, "command", return_value=(0, "{}\n{}\n")):
            collector.kernel_oom_kills("cursor")
        self.assertIn("journal_budget_exceeded", collector.COLLECTION_ERRORS)


if __name__ == "__main__":
    unittest.main()
