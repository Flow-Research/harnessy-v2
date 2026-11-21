"""Run the pinned networkless checker against synthetic contract input."""

import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("pinned_workstream_checker", Path(__file__).with_name("checker.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
value = json.load(sys.stdin)
findings = checker.evaluate_proof(
    json.dumps(value["proof"]).encode("utf-8"),
    configuration=value["configuration"],
    input_value={"forge_facts": value["facts"]},
)
sys.stdout.write(json.dumps(findings))
