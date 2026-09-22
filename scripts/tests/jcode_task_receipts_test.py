#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
from pathlib import Path


script = Path(__file__).parents[2] / "ops/jcode-operator/jcode-task-receipts"
policy = Path(__file__).parents[2] / "ops/jcode-operator/jcode-tool-policy"
with tempfile.TemporaryDirectory() as raw:
    root = Path(raw)
    home = root / "jcode"
    state = root / "state"
    (home / "sessions").mkdir(parents=True)
    (home / "todos").mkdir()
    sid = "session_test"
    session = {
        "id": sid,
        "parent_id": None,
        "created_at": "2099-01-01T00:00:00Z",
        "updated_at": "2099-01-01T00:01:00Z",
        "working_dir": "/tmp/example",
        "model": "gpt-5.6-sol",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "Ship it"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "Shipped and verified"}]},
        ],
    }
    (home / "sessions" / f"{sid}.json").write_text(json.dumps(session))
    (home / "todos" / f"{sid}.json").write_text(json.dumps([
        {"status": "completed", "completion_confidence": "verified"}
    ]))
    (home / "todos" / f"{sid}-goals.json").write_text(json.dumps([
        {"delivery_state": "outcome_delivered", "closed_feedback_loop": "closed", "stopping_evidence": "live check passed"}
    ]))
    env = os.environ | {"JCODE_HOME": str(home), "JCODE_STATE_DIR": str(state)}
    output = subprocess.check_output([str(script), "--session", sid, "--write", "--json"], env=env, text=True)
    receipt = json.loads(output)[0]
    assert receipt["status"] == "verified", receipt
    assert json.loads((state / "receipts" / f"{sid}.json").read_text())["status"] == "verified"
    summary = json.loads((state / "receipt-summary.json").read_text())
    assert summary["status"]["verified"] == 1
    assert summary["root_sessions"] == 1
    assert summary["task_like_sessions"] == 1
    assert summary["receipt_coverage"] == 1

    policy_home = root / "policy-home"
    (policy_home / ".jcode/todos").mkdir(parents=True)
    policy_env = os.environ | {
        "HOME": str(policy_home),
        "JCODE_HOOK_SESSION_ID": sid,
        "JCODE_HOOK_TOOL_NAME": "edit",
    }
    blocked = subprocess.run([str(policy)], input="{}", env=policy_env, text=True, capture_output=True)
    assert blocked.returncode == 2
    assert "create a todo plan" in blocked.stderr
    (policy_home / ".jcode/todos" / f"{sid}.json").write_text('[{"status":"pending"}]')
    allowed = subprocess.run([str(policy)], input="{}", env=policy_env, text=True, capture_output=True)
    assert allowed.returncode == 0
    link_env = policy_env | {"JCODE_HOOK_TOOL_NAME": "mcp__nova__add_link"}
    blocked_link = subprocess.run([str(policy)], input="{}", env=link_env, text=True, capture_output=True)
    assert blocked_link.returncode == 2
    assert "managed Nova" in blocked_link.stderr
