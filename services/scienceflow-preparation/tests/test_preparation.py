"""Pure-helper tests for the preparation adapter; the engine is not imported."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import preparation  # noqa: E402


class RelativePathTests(unittest.TestCase):
    def test_rejects_escapes_and_absolute_paths(self) -> None:
        for value in ("", "/etc/passwd", "../solution.json", "a/../b.json"):
            with self.subTest(value=value):
                with self.assertRaises(preparation.AdapterRefusal):
                    preparation._clean_relative(value)

    def test_normalizes_backslashes_and_empty_segments(self) -> None:
        self.assertEqual(preparation._clean_relative("artifacts\\solution.json"), "artifacts/solution.json")
        self.assertEqual(preparation._clean_relative("a//./b.json"), "a/b.json")


class SampleWorkspaceTests(unittest.TestCase):
    def test_rejects_a_label_with_a_separator(self) -> None:
        for label in ("", ".", "..", "a/b", "a\\b"):
            with self.subTest(label=label):
                with self.assertRaises(preparation.AdapterRefusal):
                    preparation._sample_workspace(__import__("pathlib").Path("/tmp"), label)


class DispatchTests(unittest.TestCase):
    def test_unknown_actions_are_refused(self) -> None:
        with self.assertRaises(preparation.AdapterRefusal) as raised:
            preparation.run("launch-research", {})
        self.assertEqual(raised.exception.code, "invalid_arguments")

    def test_engine_refuses_a_missing_checkout(self) -> None:
        with self.assertRaises(preparation.AdapterRefusal) as raised:
            preparation.list_tasks({"engineCheckout": "/nonexistent/engine"})
        self.assertEqual(raised.exception.code, "engine_unavailable")


class DependencyGapTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self._directory = tempfile.TemporaryDirectory(prefix="prep-imports-")
        self.root = Path(self._directory.name)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def evaluator(self, source: str) -> Path:
        path = self.root / "evaluator.py"
        path.write_text(source, encoding="utf-8")
        return path

    def test_stdlib_and_package_modules_are_not_gaps(self) -> None:
        (self.root / "helper.py").write_text("VALUE = 1\n", encoding="utf-8")
        source = self.evaluator(
            "import json\nimport helper\nfrom pathlib import Path\n\nprint(json.dumps({}))\n"
        )
        self.assertEqual(preparation.missing_evaluator_modules(source, self.root), [])

    def test_a_missing_third_party_module_is_reported(self) -> None:
        source = self.evaluator("import sd_no_such_module_xyz\n")
        self.assertEqual(
            preparation.missing_evaluator_modules(source, self.root),
            ["sd_no_such_module_xyz"],
        )

    def test_relative_imports_are_not_dependency_gaps(self) -> None:
        source = self.evaluator("from . import helper\n")
        self.assertEqual(preparation.missing_evaluator_modules(source, self.root), [])

    def test_unparseable_or_absent_sources_report_nothing(self) -> None:
        broken = self.evaluator("import (\n")
        self.assertEqual(preparation.missing_evaluator_modules(broken, self.root), [])
        self.assertEqual(preparation.missing_evaluator_modules(self.root / "absent.py", self.root), [])
        self.assertEqual(preparation.missing_evaluator_modules(None, self.root), [])


if __name__ == "__main__":
    unittest.main()
