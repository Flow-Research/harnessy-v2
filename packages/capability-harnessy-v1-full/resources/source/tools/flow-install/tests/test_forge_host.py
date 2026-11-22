"""harness-forge (skill forge-host): the command is tested with a fake `ssh` and a fake `docker`.

No server and no network are used. The fake `ssh` records each script that harness-forge sends
and answers from canned text, selected by the marker line `# harness-forge:<step>`.
"""
from __future__ import annotations

import http.server
import json
import os
import stat
import subprocess
import sys
import threading
import time
import types
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
hook = home / f"hook-{step}"
if hook.exists():  # something that happens while this step runs on the server
    import subprocess
    subprocess.run([sys.executable, str(hook)], check=True, stdout=subprocess.DEVNULL)
answer = home / f"answer-{step}"
sys.stdout.write(answer.read_text() if answer.exists() else "")
"""


DEFAULT_RUNNER_CONFIG = """runner:
  capacity: 1
  # Extra environment variables to run jobs.
  envs:
    A_TEST_ENV_NAME_1: a_test_env_value_1
    A_TEST_ENV_NAME_2: a_test_env_value_2
  env_file: .env
cache:
  # the cache server
  enabled: true
container:
  docker_host: "-"
host:
  enabled: true
"""

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
home = Path(os.environ["FAKE_SSH_DIR"])
args = sys.argv[1:]
count = len(list(home.glob("docker-*.argv")))
(home / f"docker-{count:02d}.argv").write_text("\n".join(args))
if "generate-config" in args:
    print(os.environ["FAKE_RUNNER_CONFIG"], end="")
elif any("create-runner-file" in a for a in args):
    folder = args[args.index("-v") + 1].rsplit(":/data", 1)[0]
    Path(folder, ".runner").write_text(json.dumps({"id": 0, "name": args[-1], "address": args[-2],
                                                   "token": os.environ.get("FORGE_RUNNER_SECRET", ""), "labels": []}))
elif args[:1] == ["logs"]:
    if os.environ.get("FAKE_DOCKER_LOGS_HANG"):
        time.sleep(int(os.environ["FAKE_DOCKER_LOGS_HANG"]))
    else:
        print("runner: declared successfully")
"""


def make_env(tmp_path: Path, server: str = GOOD_SERVER) -> dict:
    fake = tmp_path / "fake"
    bin_dir = tmp_path / "bin"
    fake.mkdir(); bin_dir.mkdir()
    ssh = bin_dir / "ssh"
    ssh.write_text(FAKE_SSH)
    ssh.chmod(ssh.stat().st_mode | stat.S_IEXEC)
    fake_docker = bin_dir / "docker"
    fake_docker.write_text(FAKE_DOCKER)
    fake_docker.chmod(fake_docker.stat().st_mode | stat.S_IEXEC)
    (fake / "answer-inspect").write_text(server)
    (fake / "answer-install-version").write_text("15.0.12+gitea-1.22.0\n")
    (fake / "answer-token").write_text("a" * 40 + "\n")
    (fake / "answer-service-account").write_text("b" * 40 + "\n")
    (fake / "answer-runner-config").write_text(DEFAULT_RUNNER_CONFIG)
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
        "FAKE_RUNNER_CONFIG": DEFAULT_RUNNER_CONFIG,
    }


def run(env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HARNESS_FORGE), *args], env=env, text=True, capture_output=True)


def secret_path(env: dict, name: str) -> Path:
    """The secret folder has the id and the uid of the install: `acme.<uid>`."""
    uid = register(env)["installs"]["acme"]["uid"]
    return Path(env["XDG_CONFIG_HOME"]) / f"harnessy/forge/acme.{uid}" / name


def secret_of(env: dict, runner: str) -> str:
    return secret_path(env, f"runner-{runner}.secret").read_text().strip()


def load_tool() -> types.ModuleType:
    """The tool as a module, for the parts that a test cannot reach through the command line.
    No cache file is written beside the tool."""
    module = types.ModuleType("harness_forge")
    exec(compile(HARNESS_FORGE.read_text(), str(HARNESS_FORGE), "exec"), module.__dict__)
    return module


class FakeForge:
    """A forge API on this machine. Like Forgejo, it gives at most 50 items for each call."""

    def __init__(self, branches: int = 0) -> None:
        self.requests: list[dict] = []
        forge = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def answer(self) -> None:
                size = int(self.headers.get("Content-Length") or 0)
                forge.requests.append({"method": self.command, "path": self.path,
                                       "authorization": self.headers.get("Authorization"),
                                       "body": json.loads(self.rfile.read(size)) if size else None})
                result: object = {"full_name": "acme-org/app"}
                if "/branches" in self.path:
                    query = dict(pair.split("=") for pair in self.path.split("?", 1)[1].split("&"))
                    limit = min(int(query.get("limit", 50)), 50)
                    start = (int(query.get("page", 1)) - 1) * limit
                    result = [{"name": f"branch-{n:03d}", "commit": {"id": f"{n:040x}"}}
                              for n in range(start, min(start + limit, branches))]
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = answer

            def log_message(self, *args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def serve(self, env: dict) -> None:
        """Make the install `acme` of this workspace use this forge for API calls."""
        file = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/register.json"
        data = json.loads(file.read_text())
        data["installs"]["acme"]["url"] = f"http://127.0.0.1:{self.server.server_address[1]}"
        file.write_text(json.dumps(data))
        env.update({"FORGE_SOURCE_TOKEN": "source-token", "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"})

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


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
    secret_file = secret_path(env, "admin-initial-password.txt")
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
    token_file = secret_path(env, "admin-token")
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
    done = run(env, "token", "--id", "acme", "--user", "forge-admin", "--name", "harness", "--as-admin-token",
               "--confirm", "acme")
    assert done.returncode == 0, done.stderr
    token_file = secret_path(env, "admin-token")
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
    run_id = register(env)["installs"]["acme"]["runs"][-1]
    config = (Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/runs" / run_id / "runner-config.yml").read_text()
    assert 'docker_host: "automount"' in config and "  capacity: 2" in config
    assert "cache:\n  # the cache server\n  enabled: false" in config, "the cache server must be off"
    assert "  envs: {}" in config and "A_TEST_ENV_NAME" not in config, "the example job environment must go"
    import base64
    assert base64.b64encode(config.encode()).decode() in start, "the server gets exactly this config"
    assert secret_of(env, "vps-1") not in Path(env["FAKE_SSH_DIR"], next(
        p.name for p in Path(env["FAKE_SSH_DIR"]).glob("call-*-runner-start.argv"))).read_text()
    assert "/opt/forge-acme/runner-vps-1" in start and "--restart unless-stopped" in start
    secret = secret_of(env, "vps-1")
    assert len(secret) == 40 and secret not in json.dumps(register(env)) and secret not in done.stdout


def test_a_local_runner_uses_only_docker_and_keeps_the_secret_out_of_command_lines(tmp_path):
    """The local path has no shell script, so it is the same on macOS, Linux and Windows."""
    env = make_env(tmp_path)
    install(env)
    done = run(env, "runner", "add", "--id", "acme", "--name", "laptop-1", "--where", "local",
               "--capacity", "2", "--confirm", "acme")
    assert done.returncode == 0, done.stderr
    runner = register(env)["installs"]["acme"]["runners"]["laptop-1"]
    folder = Path(runner["folder"])
    assert runner["where"] == "local" and folder == Path(env["XDG_DATA_HOME"]) / "harnessy/forge-runners/acme-laptop-1"
    config = (folder / "config.yml").read_text()
    assert 'docker_host: "automount"' in config and "  capacity: 2" in config
    assert "cache:\n  # the cache server\n  enabled: false" in config, "the cache server must be off"
    assert "host:\n  enabled: true" in config, "only the cache section may change"
    assert "  envs: {}" in config and "A_TEST_ENV_NAME" not in config
    runner_file = json.loads((folder / ".runner").read_text())
    secret = secret_of(env, "laptop-1")
    assert runner_file["token"] == secret, "the secret reaches the container through the environment"
    assert runner_file["labels"] == ["ubuntu-24.04:docker://ghcr.io/catthehacker/ubuntu:act-24.04"]
    docker_calls = [p.read_text() for p in sorted(Path(env["FAKE_SSH_DIR"]).glob("docker-*.argv"))]
    assert all(secret not in call for call in docker_calls), "the secret is in a docker command line"
    assert any("--restart\nunless-stopped" in call and "daemon" in call for call in docker_calls)
    assert not any(c.endswith("runner-start.sh") for c in calls(env)), "a local runner starts nothing on the server"
    if hasattr(os, "getuid"):
        # With Docker Engine on Linux, a container that runs as root makes a root-owned `.runner`
        # in the folder of this user; the tool could then not write the labels in it.
        create = next(call for call in docker_calls if "create-runner-file" in call)
        assert f"--user\n{os.getuid()}:{os.getgid()}\n" in create, "the runner file must belong to this user"
    assert secret not in done.stdout + json.dumps(register(env))


def test_a_runner_can_give_each_job_a_machine_setting_and_refuses_a_bad_one(tmp_path):
    """Found on an Apple M4 with an old Docker Desktop: ARM containers crashed in OpenSSL until
    OPENSSL_armcap was set. Such a value belongs to the machine, so the runner carries it."""
    env = make_env(tmp_path)
    install(env)
    base = ("runner", "add", "--id", "acme", "--where", "local", "--confirm", "acme")
    done = run(env, *base, "--name", "laptop-1", "--env", "OPENSSL_armcap=0x3D", "--env", "TZ=UTC")
    assert done.returncode == 0, done.stderr
    runner = register(env)["installs"]["acme"]["runners"]["laptop-1"]
    config = (Path(runner["folder"]) / "config.yml").read_text()
    assert '  envs:\n    OPENSSL_armcap: "0x3D"\n    TZ: "UTC"\n' in config and "A_TEST_ENV_NAME" not in config
    assert runner["job_env_names"] == ["OPENSSL_armcap", "TZ"]
    for bad in ("NOEQUALS", "A=b c", "A=$(id)", "1A=x", 'A=x"y'):
        refused = run(env, *base, "--name", "laptop-2", "--env", bad)
        assert refused.returncode == 3 and "is not valid" in refused.stderr, bad


def test_a_local_runner_on_an_arm_machine_may_not_take_the_label_amd64(tmp_path):
    import platform

    if platform.machine().lower() in ("x86_64", "amd64"):
        return  # the refusal applies to machines that are not x86_64
    env = make_env(tmp_path)
    install(env)
    done = run(env, "runner", "add", "--id", "acme", "--name", "laptop-1", "--where", "local",
               "--label", "amd64:docker://ghcr.io/catthehacker/ubuntu:act-24.04", "--confirm", "acme")
    assert done.returncode == 3 and "may not take the label amd64" in done.stderr
    assert not list(Path(env["FAKE_SSH_DIR"]).glob("docker-*.argv"))


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
    done = run(env, "backup", "--id", "acme", "--keep", "7", "--confirm", "acme")
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


# ---------------------------------------------------------------- findings of the review of pull request 192

def test_two_workspaces_with_the_same_install_id_keep_their_own_secrets(tmp_path):
    """The install id is unique in one workspace only. The secret folder is for the whole user."""
    (tmp_path / "one").mkdir(); (tmp_path / "two").mkdir()
    one, two = make_env(tmp_path / "one"), make_env(tmp_path / "two")
    two["XDG_CONFIG_HOME"] = one["XDG_CONFIG_HOME"]
    Path(two["FAKE_SSH_DIR"], "answer-service-account").write_text("c" * 40 + "\n")
    assert install(one).returncode == 2
    first = register(one)["installs"]["acme"]["secret_files"]
    password = Path(first["admin_initial_password"]).read_text()
    assert install(two).returncode == 2
    second = register(two)["installs"]["acme"]["secret_files"]
    assert Path(first["admin-token"]) != Path(second["admin-token"])
    assert Path(first["admin-token"]).read_text().strip() == "b" * 40, "the second install took the first token"
    assert Path(second["admin-token"]).read_text().strip() == "c" * 40
    assert Path(first["admin_initial_password"]).read_text() == password
    assert Path(second["admin_initial_password"]).read_text() != password


def test_an_install_made_before_the_uid_keeps_its_secret_folder(tmp_path):
    """Version 0.1.0 kept secrets in `forge/<id>/` and its register entry has no uid. Such an
    install must work as before: its secrets are read and written there, and nothing is moved."""
    env = make_env(tmp_path)
    install(env)
    forge_dir = Path(env["XDG_CONFIG_HOME"]) / "harnessy/forge"
    file = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts/register.json"
    data = json.loads(file.read_text())
    uid = data["installs"]["acme"].pop("uid")
    (forge_dir / f"acme.{uid}").rename(forge_dir / "acme")  # the state that version 0.1.0 left
    file.write_text(json.dumps(data))
    password = (forge_dir / "acme/admin-initial-password.txt").read_text()

    forge = FakeForge()
    try:
        forge.serve(env)
        mirror = run(env, "repo", "mirror", "--id", "acme", "--owner", "acme-org", "--name", "app",
                     "--to", "https://github.com/acme-org/app", "--remote-user", "bot", "--confirm", "acme")
        assert mirror.returncode == 0, mirror.stderr
        assert forge.requests[-1]["authorization"] == "token " + "b" * 40, "the old folder was not read"
    finally:
        forge.close()
    done = run(env, "token", "--id", "acme", "--user", "forge-admin", "--name", "harness", "--as-admin-token",
               "--confirm", "acme")
    assert done.returncode == 0, done.stderr
    assert (forge_dir / "acme/admin-token").read_text().strip() == "a" * 40
    assert [p.name for p in forge_dir.iterdir()] == ["acme"], "no second secret folder for an old install"
    assert (forge_dir / "acme/admin-initial-password.txt").read_text() == password


def test_a_command_keeps_the_records_that_another_command_wrote_while_it_ran(tmp_path):
    """`runner add` reads the register, works on the server, then saves. A backup that ends in
    that time must stay in the register."""
    env = make_env(tmp_path)
    install(env)
    Path(env["FAKE_SSH_DIR"], "answer-backup-now").write_text("/opt/forge-acme/backups/forge-1.zip\n12M\n")
    Path(env["FAKE_SSH_DIR"], "hook-runner-register").write_text(
        "import subprocess, sys\n"
        f"subprocess.run([sys.executable, {str(HARNESS_FORGE)!r}, 'backup', '--id', 'acme', '--confirm', 'acme'], check=True)\n")
    done = run(env, "runner", "add", "--id", "acme", "--name", "vps-1", "--where", "remote", "--confirm", "acme")
    assert done.returncode == 0, done.stderr
    record = register(env)["installs"]["acme"]
    assert "vps-1" in record["runners"]
    assert record["backup"].get("last_file") == "/opt/forge-acme/backups/forge-1.zip", "the backup record was lost"


def test_commands_at_the_same_time_all_reach_the_register(tmp_path):
    env = make_env(tmp_path)
    install(env)
    names = [f"token-{n}" for n in range(8)]
    running = [subprocess.Popen([sys.executable, str(HARNESS_FORGE), "token", "--id", "acme", "--user", "forge-admin",
                                 "--name", name, "--confirm", "acme"], env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True) for name in names]
    for process in running:
        _, stderr = process.communicate(timeout=120)
        assert process.returncode == 0, stderr
    files = register(env)["installs"]["acme"]["secret_files"]
    assert all(f"token-forge-admin-{name}" in files for name in names), sorted(files)
    records = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts"
    assert not list(records.glob("*.tmp")), "a temporary file of the register was left"


def test_install_with_json_prints_only_json(tmp_path):
    env = make_env(tmp_path)
    dry = run(env, *INSTALL, "--json", "--dry-run")
    assert dry.returncode == 0, dry.stderr
    plan = json.loads(dry.stdout)
    assert plan["dry_run"] is True and plan["changed"] is False
    assert plan["plan"]["remote_dir"] == "/opt/forge-acme" and plan["inspect"]["ok"] is True
    done = run(env, *INSTALL, "--json", "--confirm", "acme")
    assert done.returncode == 2, done.stderr
    result = json.loads(done.stdout)
    assert result["ok"] is False and result["record"] == register(env)["installs"]["acme"]
    assert Path(result["evidence"]).is_dir() and Path(result["register"]).is_file()
    assert secret_path(env, "admin-initial-password.txt").read_text().strip() not in done.stdout


def test_an_install_that_stopped_after_the_first_server_step_can_continue(tmp_path):
    env = make_env(tmp_path)
    fake = Path(env["FAKE_SSH_DIR"])
    records = Path(env["HARNESSY_WORKSPACE"]) / ".jarvis/context/forge-hosts"
    (fake / "fail-install-admin").write_text("connection lost\n")
    assert install(env).returncode == 3
    assert not (records / "register.json").exists(), "an install that did not finish is not in the register"
    pending = json.loads((records / "pending/acme.json").read_text())
    assert pending["completed"] == ["install-files"] and pending["ssh"]["host"] == "server.example"
    password_file = Path(env["XDG_CONFIG_HOME"]) / f"harnessy/forge/acme.{pending['uid']}/admin-initial-password.txt"
    password = password_file.read_text()
    assert password.strip() not in (records / "pending/acme.json").read_text()

    # The folder is now on the server. Only the workspace with the pending record may continue.
    (fake / "answer-inspect").write_text(GOOD_SERVER.replace("existing_forge_dirs=", "existing_forge_dirs=/opt/forge-acme "))
    (fake / "fail-install-admin").unlink()
    other = run(env, "install", "--id", "acme", "--host", "other.example", "--ssh-user", "deploy", "--wait", "0",
                "--confirm", "acme")
    assert other.returncode == 3 and "did not finish" in other.stderr
    assert sum("install-files" in c for c in calls(env)) == 1, "a refused install must not change the server"

    done = install(env)
    assert done.returncode == 2, done.stderr
    record = register(env)["installs"]["acme"]
    assert record["uid"] == pending["uid"] and len(record["runs"]) == 2
    assert password_file.read_text() == password, "the admin on the forge has the password of the first try"
    assert Path(record["secret_files"]["admin_initial_password"]) == password_file
    assert not (records / "pending/acme.json").exists()
    admin = sorted(fake.glob("call-*-install-admin.sh"))[-1].read_text()
    assert "forgejo admin user list" in admin, "a second try must not make the admin again"
    files = sorted(fake.glob("call-*-install-files.sh"))[-1].read_text()
    assert "/opt/forge-acme/.harness-forge-install" in files and pending["uid"] in files


def test_the_server_step_refuses_a_folder_of_another_install(tmp_path):
    """The shell that makes the folder on the server, run here on a folder of the test."""
    tool = load_tool()
    folder = tmp_path / "forge-acme"

    def step(uid: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "-c", "set -euo pipefail\n" + tool.owned_folder_guard(str(folder), uid)],
                              text=True, capture_output=True)

    folder.mkdir()  # an empty folder has nothing to damage
    assert step("aaaa1111").returncode == 0
    assert (folder / ".harness-forge-install").read_text() == "aaaa1111\n"
    assert step("aaaa1111").returncode == 0, "the same install may run the step again"
    other = step("bbbb2222")
    assert other.returncode == 1 and "does not belong to this install" in other.stderr
    assert (folder / ".harness-forge-install").read_text() == "aaaa1111\n"
    (folder / ".harness-forge-install").unlink()
    (folder / "docker-compose.yml").write_text("services: {}\n")
    assert step("aaaa1111").returncode == 1, "a folder with files and no mark is not ours"
    assert not (folder / ".harness-forge-install").exists()


def test_each_command_that_changes_the_server_or_the_forge_needs_the_confirmation(tmp_path):
    env = make_env(tmp_path)
    install(env)
    before = calls(env)
    forge = FakeForge(branches=3)
    try:
        forge.serve(env)
        commands = {
            "token": ("token", "--id", "acme", "--user", "forge-admin", "--name", "harness"),
            "backup": ("backup", "--id", "acme"),
            "migrate": ("repo", "migrate", "--id", "acme", "--source", "https://github.com/acme-org/app",
                        "--owner", "acme-org", "--name", "app"),
            "mirror": ("repo", "mirror", "--id", "acme", "--owner", "acme-org", "--name", "app",
                       "--to", "https://github.com/acme-org/app", "--remote-user", "bot"),
        }
        for name, command in commands.items():
            for confirm in ((), ("--confirm", "other")):
                refused = run(env, *command, *confirm)
                assert refused.returncode == 3 and "--confirm acme" in refused.stderr, (name, refused.stderr)
        assert calls(env) == before and forge.requests == [], "a refused command reached the server or the forge"
        for name, command in commands.items():
            done = run(env, *command, "--confirm", "acme")
            assert done.returncode == 0, (name, done.stderr)
        assert [r["path"] for r in forge.requests if r["method"] == "POST"] == [
            "/api/v1/repos/migrate", "/api/v1/repos/acme-org/app/push_mirrors"]
    finally:
        forge.close()


def test_a_migration_records_the_branches_of_every_page(tmp_path):
    env = make_env(tmp_path)
    install(env)
    forge = FakeForge(branches=120)
    try:
        forge.serve(env)
        done = run(env, "repo", "migrate", "--id", "acme", "--source", "https://github.com/acme-org/app",
                   "--owner", "acme-org", "--name", "app", "--confirm", "acme")
        assert done.returncode == 0, done.stderr
    finally:
        forge.close()
    heads = register(env)["installs"]["acme"]["repositories"]["acme-org/app"]["branch_heads_at_migration"]
    assert len(heads) == 120 and heads["branch-119"] == f"{119:040x}"
    assert "with 120 branches" in done.stdout


def test_a_docker_command_that_gives_no_answer_does_not_stop_the_tool(tmp_path, monkeypatch):
    env = make_env(tmp_path)
    for key in ("PATH", "FAKE_SSH_DIR", "FAKE_RUNNER_CONFIG"):
        monkeypatch.setenv(key, env[key])
    monkeypatch.setenv("FAKE_DOCKER_LOGS_HANG", "20")
    tool = load_tool()
    monkeypatch.setattr(tool, "RUNNER_DECLARE_SECONDS", 2, raising=False)
    started = time.monotonic()
    try:
        tool.start_local_runner(str(tmp_path / "runner"), "runner:1", "https://git.example.com", "laptop-1",
                                "s" * 40, ["ubuntu-24.04"], 1, "forge-runner-acme-laptop-1")
    except tool.Refused as refusal:
        assert "did not connect" in str(refusal)
    else:
        raise AssertionError("the runner never declared itself, so the command must refuse")
    assert time.monotonic() - started < 12, "`docker logs` ran past the time limit"
