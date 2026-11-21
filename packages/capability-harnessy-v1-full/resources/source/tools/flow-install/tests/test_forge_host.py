"""harness-forge (skill forge-host): the command is tested with a fake `ssh` and a fake `docker`.

No server and no network are used. The fake `ssh` records each script that harness-forge sends
and answers from canned text, selected by the marker line `# harness-forge:<step>`.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
HARNESS_FORGE = REPO_ROOT / "tools" / "flow-install" / "skills" / "forge-host" / "scripts" / "harness-forge"

GOOD_SERVER = """os=Debian GNU/Linux 13 (trixie)
arch=x86_64
cpus=2
memory_available_mb=5554
disk_free_gb=78
docker=29.4.3
compose=5.1.3
public_ip=203.0.113.7
port80=1
port443=1
proxy_container=edge-proxy
proxy_network=edge
proxy_resolver=letsencrypt
proxy_entrypoint_http=http
proxy_entrypoint_https=https
existing_forge_dirs=
"""

FAKE_SSH = r"""#!/usr/bin/env python3
import os, re, sys
from pathlib import Path
home = Path(os.environ["FAKE_SSH_DIR"])
script = sys.stdin.read()
step = re.search(r"^# harness-forge:(\S+)", script, re.M).group(1)
count = len(list(home.glob("call-*.sh")))
(home / f"call-{count:02d}-{step}.sh").write_text(script)
(home / f"call-{count:02d}-{step}.argv").write_text("\n".join(sys.argv[1:]))
fail = home / f"fail-{step}"
if fail.exists():
    sys.stderr.write(fail.read_text()); sys.exit(1)
answer = home / f"answer-{step}"
sys.stdout.write(answer.read_text() if answer.exists() else "")
"""


def make_env(tmp_path: Path, server: str = GOOD_SERVER) -> dict:
    fake = tmp_path / "fake"
    bin_dir = tmp_path / "bin"
    fake.mkdir(); bin_dir.mkdir()
    ssh = bin_dir / "ssh"
    ssh.write_text(FAKE_SSH)
    ssh.chmod(ssh.stat().st_mode | stat.S_IEXEC)
    (fake / "answer-inspect").write_text(server)
    (fake / "answer-install-version").write_text("15.0.12+gitea-1.22.0\n")
    (fake / "answer-token").write_text("a" * 40 + "\n")
    (fake / "answer-service-account").write_text("b" * 40 + "\n")
    workspace = tmp_path / "workspace"
    (workspace / ".harnessy").mkdir(parents=True)
    (workspace / ".harnessy" / "workspace.json").write_text("{}")
    return {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_SSH_DIR": str(fake),
        "HARNESSY_WORKSPACE": str(workspace),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
    }


def run(env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HARNESS_FORGE), *args], env=env, text=True, capture_output=True)


def calls(env: dict) -> list[str]:
    return sorted(p.name for p in Path(env["FAKE_SSH_DIR"]).glob("call-*.sh"))


def register(env: dict) -> dict:
    return json.loads((Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/register.json").read_text())


INSTALL = ("install", "--id", "acme", "--host", "server.example", "--ssh-user", "deploy", "--wait", "0")


def install(env: dict) -> subprocess.CompletedProcess:
    return run(env, *INSTALL, "--confirm", "acme")


# ---------------------------------------------------------------- inspect and plan

def test_inspect_reports_a_server_that_can_hold_a_forge(tmp_path):
    env = make_env(tmp_path)
    done = run(env, "inspect", "--host", "server.example", "--ssh-user", "deploy", "--json")
    assert done.returncode == 0, done.stderr
    facts = json.loads(done.stdout)
    assert facts["ok"] is True and facts["proxy"] == "traefik-docker"
    assert all(c["ok"] for c in facts["checks"])
    argv = Path(env["FAKE_SSH_DIR"], "call-00-inspect.argv").read_text().splitlines()
    assert "BatchMode=yes" in argv and argv[-2:] == ["deploy@server.example", "sudo -n bash -s"]


def test_inspect_fails_for_a_server_with_too_little_memory_and_no_proxy(tmp_path):
    weak = GOOD_SERVER.replace("memory_available_mb=5554", "memory_available_mb=900") \
                      .replace("proxy_container=edge-proxy", "proxy_container=")
    env = make_env(tmp_path, weak)
    done = run(env, "inspect", "--host", "server.example")
    assert done.returncode == 1
    assert "NO  at least 2048 MB of memory available: 900 MB" in done.stdout
    assert "CANNOT hold a forge" in done.stdout


def test_plan_needs_no_server(tmp_path):
    env = make_env(tmp_path)
    done = run(env, "plan", "--id", "acme", "--host", "server.example", "--json")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["remote_dir"] == "/opt/forge-acme"
    assert calls(env) == []


# ---------------------------------------------------------------- install

def test_install_writes_the_compose_file_the_register_and_the_evidence(tmp_path):
    env = make_env(tmp_path)
    done = install(env)
    assert done.returncode == 2, done.stdout + done.stderr  # --wait 0: HTTPS was not checked
    assert [c.split("-", 2)[2] for c in calls(env)] == [
        "inspect.sh", "install-files.sh", "install-admin.sh", "service-account.sh", "install-version.sh"]
    record = register(env)["installs"]["acme"]
    assert record["url"] == "https://git.203-0-113-7.sslip.io"
    assert record["version"].startswith("15.0.12") and record["state"] == "installed-not-reachable"
    assert record["proxy"] == {"kind": "traefik-docker", "network": "edge", "resolver": "letsencrypt",
                               "entrypoint_http": "http", "entrypoint_https": "https"}
    run_dir = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/runs" / record["runs"][0]
    compose = (run_dir / "docker-compose.yml").read_text()
    assert "Host(`git.203-0-113-7.sslip.io`)" in compose and "tls.certresolver=letsencrypt" in compose
    assert 'FORGEJO__service__DISABLE_REGISTRATION: "true"' in compose
    assert 'FORGEJO__service__REQUIRE_SIGNIN_VIEW: "true"' in compose
    assert "ports:" not in compose, "the forge must be reachable only through the proxy"
    assert [s["step"] for s in json.loads((run_dir / "steps.json").read_text())] == [
        "forge container started", "first admin created", "service account for the tool created",
        "web address answers over HTTPS"]


def test_the_admin_password_is_in_a_private_file_and_nowhere_else(tmp_path):
    env = make_env(tmp_path)
    done = install(env)
    secret_file = Path(env["XDG_CONFIG_HOME"]) / "harnessy/forge/acme/admin-initial-password.txt"
    password = secret_file.read_text().strip()
    assert len(password) >= 24
    assert stat.S_IMODE(secret_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(secret_file.parent.stat().st_mode) == 0o700
    assert password not in done.stdout + done.stderr
    records = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts"
    for path in records.rglob("*"):
        if path.is_file():
            assert password not in path.read_text(), f"the password is in the record {path}"
    for argv in Path(env["FAKE_SSH_DIR"]).glob("*.argv"):
        assert password not in argv.read_text(), "the password is in a command line"
    assert "--must-change-password=true" in Path(env["FAKE_SSH_DIR"], "call-02-install-admin.sh").read_text()


def test_install_without_the_typed_confirmation_changes_nothing(tmp_path):
    env = make_env(tmp_path)
    done = run(env, *INSTALL)
    assert done.returncode == 3 and "--confirm acme" in done.stderr
    assert [c.split("-", 2)[2] for c in calls(env)] == ["inspect.sh"]
    assert not (Path(env["HARNESSY_WORKSPACE"]) / ".jarvis").exists()


def test_install_with_a_wrong_confirmation_is_refused(tmp_path):
    env = make_env(tmp_path)
    done = run(env, *INSTALL, "--confirm", "other")
    assert done.returncode == 3 and len(calls(env)) == 1


def test_dry_run_only_inspects(tmp_path):
    env = make_env(tmp_path)
    done = run(env, *INSTALL, "--dry-run", "--confirm", "acme")
    assert done.returncode == 0 and "nothing was changed" in done.stdout
    assert len(calls(env)) == 1


def test_install_is_refused_on_a_server_that_does_not_meet_the_requirements(tmp_path):
    env = make_env(tmp_path, GOOD_SERVER.replace("docker=29.4.3", "docker="))
    done = install(env)
    assert done.returncode == 3 and "does not meet the requirements" in done.stderr
    assert len(calls(env)) == 1


def test_a_second_install_with_the_same_id_is_refused(tmp_path):
    env = make_env(tmp_path)
    install(env)
    before = len(calls(env))
    done = install(env)
    assert done.returncode == 3 and "already has an install" in done.stderr
    assert len(calls(env)) == before, "a refused install must not touch the server"


def test_a_folder_on_the_server_that_the_register_does_not_know_is_refused(tmp_path):
    env = make_env(tmp_path, GOOD_SERVER.replace("existing_forge_dirs=", "existing_forge_dirs=/opt/forge-acme "))
    done = install(env)
    assert done.returncode == 3 and "not in the register" in done.stderr


def test_a_failed_step_on_the_server_stops_the_install_and_records_nothing(tmp_path):
    env = make_env(tmp_path)
    Path(env["FAKE_SSH_DIR"], "fail-install-files").write_text("no space left on device\n")
    done = install(env)
    assert done.returncode == 3 and "no space left on device" in done.stderr
    assert not (Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/register.json").exists()


def test_values_that_could_carry_shell_text_are_refused(tmp_path):
    env = make_env(tmp_path)
    for flag, value in (("--id", "acme;rm"), ("--image", "img:1 && id"), ("--admin-user", "a b"),
                        ("--domain", "git.example.com`id`")):
        args = list(INSTALL) + ["--confirm", "acme"]
        if flag == "--id":
            args[args.index("acme")] = value
        else:
            args += [flag, value]
        done = run(env, *args)
        assert done.returncode == 3, (flag, done.stdout)
    assert all("install-files" not in c for c in calls(env))


# ---------------------------------------------------------------- token, runner, backup, list

def test_install_makes_a_service_account_whose_token_is_private(tmp_path):
    """The first admin must change its password before the API accepts it, so the tool has its
    own account. Its token is in a private file and in no record and no output."""
    env = make_env(tmp_path)
    done = install(env)
    token_file = Path(env["XDG_CONFIG_HOME"]) / "harnessy/forge/acme/admin-token"
    assert token_file.read_text().strip() == "b" * 40
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert "b" * 40 not in done.stdout + done.stderr + json.dumps(register(env))
    assert register(env)["installs"]["acme"]["service_account"] == "harness-forge"
    script = next(Path(env["FAKE_SSH_DIR"]).glob("call-*-service-account.sh")).read_text()
    assert "--random-password" in script and "--must-change-password=false" in script
    assert run(env, "service-account", "--id", "acme").returncode == 3, "renewal needs the confirmation"
    assert run(env, "service-account", "--id", "acme", "--confirm", "acme").returncode == 0


def test_a_token_goes_to_a_private_file_and_is_not_shown(tmp_path):
    env = make_env(tmp_path)
    install(env)
    done = run(env, "token", "--id", "acme", "--user", "forge-admin", "--name", "harness", "--as-admin-token")
    assert done.returncode == 0, done.stderr
    token_file = Path(env["XDG_CONFIG_HOME"]) / "harnessy/forge/acme/admin-token"
    assert token_file.read_text().strip() == "a" * 40
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert "a" * 40 not in done.stdout
    assert "a" * 40 not in json.dumps(register(env))


def test_a_remote_runner_is_registered_started_and_recorded(tmp_path):
    env = make_env(tmp_path)
    install(env)
    done = run(env, "runner", "add", "--id", "acme", "--name", "vps-1", "--where", "remote",
               "--scope", "acme-org", "--capacity", "2", "--confirm", "acme")
    assert done.returncode == 0, done.stderr
    runner = register(env)["installs"]["acme"]["runners"]["vps-1"]
    assert runner["where"] == "remote" and runner["machine"] == "server.example"
    assert runner["labels"] == ["ubuntu-24.04:docker://ghcr.io/catthehacker/ubuntu:act-24.04"]
    start = next(Path(env["FAKE_SSH_DIR"]).glob("call-*-runner-start.sh")).read_text()
    assert 'docker_host: "automount"' in start and "capacity: 2" in start
    assert "/^cache:/,/^[a-z]/ s|^  enabled: true|  enabled: false|" in start, "the cache server must be off"
    assert "/opt/forge-acme/runner-vps-1" in start and "--restart unless-stopped" in start
    secret = (Path(env["XDG_CONFIG_HOME"]) / "harnessy/forge/acme/runner-vps-1.secret").read_text().strip()
    assert len(secret) == 40 and secret not in json.dumps(register(env)) and secret not in done.stdout


def test_a_runner_needs_the_confirmation_and_a_free_name(tmp_path):
    env = make_env(tmp_path)
    install(env)
    base = ("runner", "add", "--id", "acme", "--name", "vps-1", "--where", "remote")
    assert run(env, *base).returncode == 3
    assert run(env, *base, "--confirm", "acme").returncode == 0
    again = run(env, *base, "--confirm", "acme")
    assert again.returncode == 3 and "already has a runner" in again.stderr


def test_a_command_for_an_unknown_install_is_refused(tmp_path):
    env = make_env(tmp_path)
    done = run(env, "backup", "--id", "nothing")
    assert done.returncode == 3 and "no install with the id" in done.stderr
    assert calls(env) == []


def test_backup_runs_a_script_on_the_server_and_records_the_file(tmp_path):
    env = make_env(tmp_path)
    install(env)
    Path(env["FAKE_SSH_DIR"], "answer-backup-now").write_text(
        "/opt/forge-acme/backups/forge-20261121T020000Z.zip\n12M\n")
    done = run(env, "backup", "--id", "acme", "--keep", "7")
    assert done.returncode == 0, done.stderr
    backup = register(env)["installs"]["acme"]["backup"]
    assert backup["last_file"].endswith("forge-20261121T020000Z.zip") and backup["keep"] == 7
    scheduled = run(env, "backup", "--id", "acme", "--schedule")
    assert scheduled.returncode == 3, "a nightly job on the server needs the confirmation"
    assert run(env, "backup", "--id", "acme", "--schedule", "--confirm", "acme").returncode == 0
    cron = next(Path(env["FAKE_SSH_DIR"]).glob("call-*-backup-schedule.sh")).read_text()
    assert "/etc/cron.d/forge-acme-backup" in cron


def test_list_shows_each_install_from_the_register(tmp_path):
    env = make_env(tmp_path)
    assert "No install in the register" in run(env, "list").stdout
    install(env)
    rows = json.loads(run(env, "list", "--json").stdout)
    assert [r["id"] for r in rows] == ["acme"]
    assert rows[0]["server"] == "server.example" and rows[0]["runners"] == []
    assert "acme: https://git.203-0-113-7.sslip.io" in run(env, "list").stdout
