"""Build only this audit's normalized review artifacts; never modifies runtime."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
findings = [
    {
        "id": "CR-001", "severity": "minor", "category": "recovery-usability",
        "file": "packages/harnessy-core/src/jarvis/calendar/apply.ts", "line": 185,
        "title": "Complete the operator recovery journey for unattempted calendar blocks",
        "evidence": "Reconciliation returns false when a block has no receipt; apply rejects any noncomplete prior plan at lines 71-72. The passing calendar-apply test explicitly leaves unattempted events blocked. Legacy reports are rejected at lines 147-148. This is an intentional safety limitation, not a duplicate-write regression.",
        "risk": "A partially attempted plan has no ordinary supported completion or explicit retirement path. This prevents full calendar migration closure despite correct fail-closed behavior.",
        "recommended_fix": "Add a reviewed residual-plan or retirement workflow and legacy receipt reconciliation without relaxing uncertain-write or single-writer safeguards; accept it through the installed CLI. See G05."
    },
    {
        "id": "CR-002", "severity": "minor", "category": "acceptance-coverage",
        "file": "scripts/test-harnessy-release.mjs", "line": 145,
        "title": "Run installed Life and skill acceptance in a hosted lane that executes them",
        "evidence": "The release consumer runner executes these suites only on Darwin and prints not assessed elsewhere. The main CI aggregate release job is Linux; the macOS and Windows matrix covers Executor packaging rather than this whole-product runner.",
        "risk": "Green aggregate CI cannot establish installed Life and skill acceptance for the expanded migration. Prior local Darwin evidence does not provide a recurring hosted gate.",
        "recommended_fix": "Add the relevant macOS consumer job or equivalent isolated runner, and bind explicit family-level outcomes to the reviewed candidate. See G06."
    }
]
review = {
    "schema_version": 1, "mode": "ai_review", "review_status": "completed",
    "verdict": "comment",
    "summary": "Bounded migration source review with two nonblocking observations. Expanded migration closure remains unready because of the separately documented nine operational, reproducibility and acceptance gaps. Historical ref discovery excludes dirty changes, which are captured in workspace inventories; not every historical diff line was reviewed.",
    "findings": findings,
    "tests_reviewed": ["121 selected core workflow/runtime tests passed", "89 meeting/compatibility tests passed", "47 local-host tests passed", "46 Node script tests passed", "npm run check passed", "Compatibility verification failed due to projection cache drift"],
    "missing_tests": ["Fresh packed release acceptance on reviewed clean source", "Hosted installed Life and skill acceptance that is not skipped", "Supported installed calendar partial/legacy recovery", "Complete retained-feature consumer matrix and appropriate authorized operational acceptance"],
    "verification": {"schema_valid": True, "citations_valid": True, "blocking_findings_verified": True, "verifier_notes": "Same-agent verifier pass checked source citations and counterevidence. No critical/major code finding asserted. Operational gaps do not pretend to be newly introduced PR defects. Passing schema validation is not migration approval."}
}
(root / "feedback.json").write_text(json.dumps(review, indent=2) + "\n")
sarif = {
    "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
    "runs": [{"tool": {"driver": {"name": "Harnessy migration audit", "rules": [{"id": f["id"], "shortDescription": {"text": f["title"]}} for f in findings]}},
              "results": [{"ruleId": f["id"], "level": "warning", "message": {"text": f["evidence"] + " " + f["recommended_fix"]}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": f["file"]}, "region": {"startLine": f["line"]}}}]} for f in findings]}]
}
(root / "review.sarif").write_text(json.dumps(sarif, indent=2) + "\n")
(root / "skill-feedback.json").write_text(json.dumps({"captured": True, "traces": ["tr_20260923T100042Z_code-review_ad_hoc", "tr_20260923T100043Z_life-orchestrator_ad_hoc"]}, indent=2) + "\n")
print("Wrote review, SARIF and feedback trace receipts")
