import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).parents[1] / "scripts/audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.run_git("init", "-q")
        self.run_git("config", "user.email", "fixture@example.invalid")
        self.run_git("config", "user.name", "Fixture")
        (self.repo / "removed.md").write_text("old\n")
        self.run_git("add", "--all")
        self.run_git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base")
        self.base = audit.commit(self.repo, "HEAD")
        (self.repo / "removed.md").unlink()
        for name in ["space name.ts", "tab\tname.ts", "line\nname.ts", "Yorùbá.ts"]:
            (self.repo / name).write_text("line one\nline two\n")
        (self.repo / "binary.dat").write_bytes(b"\0\1\2")
        self.run_git("add", "--all")
        self.run_git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "head")
        self.output = self.root / "audit"
        audit.create(self.repo, self.base, "HEAD", self.output)

    def run_git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    def edit(self, name, change):
        path = self.output / name
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def test_unusual_paths_binary_and_deletion_are_complete(self):
        data = json.loads((self.output / "inventory.json").read_text())
        self.assertEqual(data["summary"]["files"], 6)
        self.assertEqual(data["summary"]["binary_files"], 1)
        self.assertIn("line\nname.ts", [f["path"] for f in data["files"]])
        self.assertEqual(audit.verify(self.output)["audit_status"], "incomplete")

    def test_dirty_worktree_does_not_change_pinned_inventory(self):
        (self.repo / "space name.ts").write_text("not committed")
        (self.repo / "private.txt").write_text("must not read")
        self.assertTrue(audit.verify(self.output)["record_valid"])

    def test_no_overwrite_or_repo_output(self):
        with self.assertRaises(FileExistsError):
            audit.create(self.repo, self.base, "HEAD", self.output)
        with self.assertRaises(ValueError):
            audit.create(self.repo, self.base, "HEAD", self.repo / "report")

    def test_invalid_ref_is_not_a_command(self):
        with self.assertRaises(ValueError):
            audit.inventory(self.repo, "--help", "HEAD")

    def test_inventory_tamper_is_rejected(self):
        self.edit("inventory.json", lambda data: data["files"].pop())
        with self.assertRaises(ValueError):
            audit.verify(self.output)

    def test_missing_and_duplicate_coverage_rejected(self):
        self.edit("coverage.json", lambda data: data["files"].__setitem__(0, data["files"][1]))
        with self.assertRaises(ValueError):
            audit.verify(self.output)

    def test_wrong_revision_rejected(self):
        self.edit("coverage.json", lambda data: data.update(head=self.base))
        with self.assertRaises(ValueError):
            audit.verify(self.output)

    def test_review_claim_needs_notes(self):
        self.edit("coverage.json", lambda data: data["files"][0].update(status="reviewed"))
        with self.assertRaises(ValueError):
            audit.verify(self.output)

    def test_sampling_cannot_claim_complete(self):
        self.edit("coverage.json", lambda data: [r.update(status="sampled", notes="search only") for r in data["files"]])
        self.assertFalse(audit.verify(self.output)["coverage_complete"])

    def test_findings_require_real_lines_and_inspection(self):
        finding = {"id": "CR-001", "severity": "major", "category": "standards",
                   "file": "removed.md", "line": 1, "title": "Fixture",
                   "evidence": "Fixture evidence", "risk": "Fixture risk", "recommended_fix": "Fixture fix"}
        self.edit("findings.json", lambda data: data.append(finding))
        with self.assertRaises(ValueError):
            audit.verify(self.output)
        self.edit("coverage.json", lambda data: [r.update(status="sampled", notes="read deletion") for r in data["files"] if r["path"] == "removed.md"])
        self.assertEqual(audit.verify(self.output)["audit_status"], "request_changes")
        self.edit("findings.json", lambda data: data[0].update(line=100))
        with self.assertRaises(ValueError):
            audit.verify(self.output)


if __name__ == "__main__":
    unittest.main()
