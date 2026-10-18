"""Private stdio adapter for V2-owned briefing preparation, never publication.

The parent owns AI authorization, deadlines, credentials and notifications. Each
JSON-line request is answered once; EOF or malformed output fails without retry.
Run with the bootstrap-installed Jarvis Python, not an ambient source checkout.
"""

import json
import hashlib
import os
import queue
import re
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from jarvis.community_briefing.ai import AIResponse
from jarvis.community_briefing.collector import iter_content_files
from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.config.schema import CommunityBriefingConfig
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_briefing_review_server


_EMIT_LOCK = threading.Lock()


def emit(value):
    # Review threads and scheduled generation share stdout; keep lines whole.
    line = json.dumps(value, ensure_ascii=False) + "\n"
    with _EMIT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def parse_line(line, limit):
    if not line.endswith(b"\n") or len(line) > limit:
        raise ValueError("invalid bounded protocol input")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("protocol requires an object")
    return value


def receive(limit):
    return parse_line(sys.stdin.buffer.readline(limit + 1), limit)


class NativeDraftBusy(ValueError):
    """The single native draft slot is taken; a scheduled request retries later."""


class ParentChannel:
    """The review's only stdin reader.

    Replies to an active native run go to that run. A ``generate_week`` request
    from the parent starts one scheduled generation. Malformed lines fail only
    the run waiting for a reply, as direct reads did; EOF closes the channel.
    """

    _CLOSED = object()

    def __init__(self, on_request):
        self.replies = queue.Queue()
        self.on_request = on_request
        self.closed = threading.Event()

    def read(self):
        while True:
            line = sys.stdin.buffer.readline(1048576 + 1)
            if not line:
                self.closed.set()
                self.replies.put(self._CLOSED)
                return
            try:
                message = parse_line(line, 1048576)
            except Exception as error:
                self.replies.put(error)
                continue
            if message.get("type") == "generate_week":
                self.on_request(message)
            else:
                self.replies.put(message)

    def reply(self):
        message = self.replies.get()
        if message is self._CLOSED:
            self.replies.put(message)
            raise ValueError("parent channel closed")
        if isinstance(message, Exception):
            raise ValueError("invalid bounded protocol input")
        return message


def deny_external(event, _args):
    if event in {"socket.connect", "socket.bind", "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn"}:
        raise RuntimeError("draft adapter cannot invoke providers or subprocesses")


def validate_paths(settings, week_start=None):
    roots = {}
    for name in ("source_path", "draft_path", "state_path"):
        value = settings.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError("explicit absolute paths required")
        path = Path(value)
        if path.is_symlink():
            raise ValueError("linked root refused")
        roots[name] = path.resolve()
    source, draft, state = (roots[name] for name in ("source_path", "draft_path", "state_path"))
    if not source.is_dir():
        raise ValueError("source directory missing")
    if source == draft or source.is_relative_to(draft):
        raise ValueError("draft root overlaps source")
    # Preserve the existing nested output convention: the collector explicitly
    # excludes community-briefings directories, preventing generated feedback.
    if draft.is_relative_to(source) and "community-briefings" not in {
        part.lower() for part in draft.relative_to(source).parts
    }:
        raise ValueError("nested draft root must be excluded from collection")
    if any(state.is_relative_to(path) or path.is_relative_to(state) for path in (source, draft)):
        raise ValueError("state root overlaps content")
    for root in roots.values():
        if root.exists() and not root.is_dir():
            raise ValueError("root is not a directory")
    # The shared state directory can contain unrelated meeting/Executor state.
    # Inspect only this workflow's database and SQLite sidecars there.
    for name in ("weekly-briefings.sqlite3", "weekly-briefings.sqlite3-wal", "weekly-briefings.sqlite3-shm", "weekly-briefings.sqlite3-journal"):
        path = state / name
        if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)):
            raise ValueError("unsafe queue file")
    # Dated source folders accumulate without bound, so never walk the whole
    # source tree. Validate the requested week as the collector will read it,
    # or only the undated structure when no week is known yet; the collector
    # applies the same bounds to each week's dated folders before reading them.
    scope = {"undated_only": True} if week_start is None else {
        "window": (week_start, week_start + timedelta(days=6))}
    for _ in iter_content_files(source, **scope):
        pass
    for _ in iter_content_files(draft, source=False):
        pass
    return {**settings, **{name: str(path) for name, path in roots.items()}}


def start_run(store, run_id, request):
    # Reuse the queue database, not another authority store or signing key.
    with store.connect() as connection:
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("""CREATE TABLE IF NOT EXISTS community_draft_runs (
            run_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
            status TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
            receipts_json TEXT NOT NULL DEFAULT '[]'
        )""")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(community_draft_runs)")}
        if "receipts_json" not in columns:
            connection.execute("ALTER TABLE community_draft_runs ADD COLUMN receipts_json TEXT NOT NULL DEFAULT '[]'")
        connection.execute(
            "INSERT INTO community_draft_runs(run_id,request_hash,status) VALUES (?,?,'running')",
            (run_id, hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()),
        )


class ParentAI:
    def __init__(self, store, run_id, exchange=None):
        self.calls = 0
        self.store = store
        self.run_id = run_id
        self.exchange = exchange

    def generate_json(self, prompt):
        if self.calls >= 3 or len(prompt.encode("utf8")) > 262144:
            raise ValueError("draft request bound exceeded")
        with self.store.connect() as connection:
            changed = connection.execute(
                "UPDATE community_draft_runs SET calls=calls+1 WHERE run_id=? AND status='running' AND calls=?",
                (self.run_id, self.calls),
            ).rowcount
            if changed != 1:
                raise ValueError("draft run changed")
        self.calls += 1
        event = {"type": "generate", "sequence": self.calls, "prompt": prompt}
        if self.exchange is None:
            emit(event)
            response = receive(1048576)
        else:
            response = self.exchange(event)
        if type(response.get("sequence")) is not int or response["sequence"] != self.calls or response.get("provider") != "codex":
            raise ValueError("draft response binding mismatch")
        text = response.get("text")
        if not isinstance(text, str) or any(
            not isinstance(response.get(key), str) or not response[key].strip() or len(response[key]) > 200
            for key in ("receiptId", "model")
        ):
            raise ValueError("draft response receipt required")
        receipt = {
            "sequence": self.calls, "provider": "codex",
            "receiptId": response["receiptId"], "model": response["model"],
            "promptHash": hashlib.sha256(prompt.encode("utf8")).hexdigest(),
            "outputHash": hashlib.sha256(text.encode("utf8")).hexdigest(),
        }
        # Record the returned response before parsing it: invalid output still
        # consumed a provider call. Never store its raw content in the run ledger.
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT receipts_json FROM community_draft_runs WHERE run_id=? AND status='running' AND calls=?",
                (self.run_id, self.calls),
            ).fetchone()
            if row is None:
                raise ValueError("draft run changed")
            receipts = json.loads(row[0])
            if len(receipts) != self.calls - 1:
                raise ValueError("draft receipt sequence changed")
            receipts.append(receipt)
            connection.execute(
                "UPDATE community_draft_runs SET receipts_json=? WHERE run_id=?",
                (json.dumps(receipts), self.run_id),
            )
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("strict JSON object required")
        if "decisions" in data:
            decisions = data["decisions"]
            if not isinstance(decisions, list) or any(
                not isinstance(item, dict)
                or not isinstance(item.get("source_id"), str)
                or type(item.get("include")) is not bool
                or item.get("sensitivity") not in {"public", "private", "confidential", "unknown"}
                or not isinstance(item.get("facts"), list)
                or any(not isinstance(fact, str) for fact in item["facts"])
                for item in decisions
            ):
                raise ValueError("invalid source decisions")
        return AIResponse(data, "codex")


class PendingNotifications:
    def __init__(self, enabled=False):
        self.pending = False
        self.error = False
        self.enabled = enabled

    def send(self, kind, count):
        if not self.enabled:
            return False
        emit({"type": "notification", "kind": kind, "count": count})
        response = receive(4096)
        if response.get("type") != "notification-result" or response.get("kind") != kind or type(response.get("delivered")) is not bool:
            raise ValueError("invalid notification acknowledgement")
        return response["delivered"]

    def briefing_pending(self, count):
        self.pending = True
        delivered = self.send("pending", count)
        self.pending = not delivered
        return delivered

    def briefing_error(self):
        self.error = True
        delivered = self.send("error", 0)
        self.error = not delivered
        return delivered


class NativeCommunityService(CommunityBriefingService):
    """Retained publication ownership blocks drafts even with inconsistent status."""

    def _locked_item(self, connection, briefing_id):
        item = super()._locked_item(connection, briefing_id)
        lease = connection.execute(
            "SELECT lease_until FROM community_briefings WHERE briefing_id=?", (briefing_id,)
        ).fetchone()
        if lease[0] is not None:
            raise ValueError("Publication lease requires operator reconciliation before review.")
        return item


class NativeReviewService(NativeCommunityService):
    """Reuse the review jobs, artifacts and fences; only replace their AI owner."""

    def __init__(self, config, channel=None):
        super().__init__(config, notifier=PendingNotifications())
        self.native_lock = threading.Lock()
        self.native_context = threading.local()
        self.channel = channel

    @contextmanager
    def native_run(self, request):
        # There is one stdio conversation. Reject overlap rather than enqueueing
        # unbounded AI work or mixing replies between review threads.
        if not self.native_lock.acquire(blocking=False):
            raise NativeDraftBusy("Another native draft is running; retry after it finishes.")
        run_id = str(uuid.uuid4())
        try:
            validate_paths(self.config.model_dump())
            start_run(self.store, run_id, request)

            def exchange(event):
                emit({**event, "run_id": run_id})
                response = receive(1048576) if self.channel is None else self.channel.reply()
                if response.get("run_id") != run_id:
                    raise ValueError("Native draft response belongs to another run.")
                return response

            self.native_context.ai = ParentAI(self.store, run_id, exchange)
            emit({"type": "run_started", "run_id": run_id})
            status = "failed"
            try:
                yield
                status = "completed"
            finally:
                with self.store.connect() as connection:
                    connection.execute("UPDATE community_draft_runs SET status=? WHERE run_id=?", (status, run_id))
                emit({"type": "run_finished", "run_id": run_id, "status": status,
                      "provider_calls": self.native_context.ai.calls, "publication": False})
        finally:
            self.native_context.ai = None
            self.native_lock.release()

    def _ai_client(self, provider=None):
        if provider not in (None, "auto", "codex"):
            raise ValueError("This review uses the configured native Codex provider.")
        ai = getattr(self.native_context, "ai", None)
        if ai is None:
            raise ValueError("Native draft operation is not active.")
        return ai

    def start_revision(self, briefing_id, **kwargs):
        if kwargs.get("provider") not in (None, "auto", "codex"):
            raise ValueError("This review uses the configured native Codex provider.")
        return super().start_revision(briefing_id, **{**kwargs, "provider": "codex"})

    def _run_revision(self, briefing_id, job, markdown, summary):
        entered = False
        try:
            with self.native_run({"action": "revise", "briefing_id": briefing_id, "job": job}):
                entered = True
                return super()._run_revision(briefing_id, job, markdown, summary)
        except Exception:
            error = ValueError("Native revision failed; inspect the local run before retrying.")
            # The reused operation already records failures before the native
            # run finishes. Only bridge-entry failures need handling here.
            if not entered:
                self._fail_revision(briefing_id, job, error)
            raise error from None

    def _fail_revision(self, briefing_id, job, error):
        # Never expose protocol/provider diagnostics in the browser.
        return super()._fail_revision(briefing_id, job,
            ValueError("Native revision failed; inspect the local run before retrying."))

    def generate(self, **kwargs):
        if getattr(self.native_context, "ai", None) is not None:
            return super().generate(**kwargs)
        with self.native_run({"action": "regenerate", "week_start": str(kwargs.get("week_start"))}):
            return super().generate(**kwargs)


_REQUEST_ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")


def scheduled_generation(service, message):
    """Generate one scheduled week as a draft for review. Never approves or publishes.

    An existing draft for the week is reported without an AI run, so the
    parent's weekly trigger is idempotent even when its own record is lost.
    """
    request_id = message.get("request_id")
    week_text = message.get("week_start")
    ran = False

    def result(status, **fields):
        emit({"type": "generate_week_result", "request_id": request_id, "week_start": week_text,
              "status": status, "ran": ran, **fields, "publication": False})

    try:
        if (not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id)
                or not isinstance(week_text, str) or len(week_text) != 10
                or set(message) != {"type", "request_id", "week_start"}):
            raise ValueError("invalid scheduled request")
        week_start = date.fromisoformat(week_text)
        if week_start.weekday() != 0:
            raise ValueError("week_start must be a Monday")
    except Exception:
        if isinstance(request_id, str) and _REQUEST_ID.fullmatch(request_id):
            result("failed", code="invalid_request")
            return
        raise ValueError("invalid scheduled request") from None
    try:
        existing = service.store.for_week(week_start)
        if existing is not None:
            result("existing", briefing_id=existing.briefing_id)
            return
        # Validate the requested week as the one-shot generator does.
        validate_paths(service.config.model_dump(), week_start)
        with service.native_run({"action": "generate", "trigger": "schedule", "week_start": week_text}):
            ran = True
            generated = service.generate(week_start=week_start, regenerate=False)
        result("existing" if generated.existing else "created", briefing_id=generated.item.briefing_id)
    except NativeDraftBusy:
        result("busy")
    except Exception:
        # Never expose source excerpts, provider output or private paths.
        result("failed", code="generation_failed")


def serve_native_review(request):
    def review_guard(event, args):
        if event == "socket.bind" and args[1][0] == "127.0.0.1":
            return
        deny_external(event, args)

    sys.addaudithook(review_guard)
    settings = validate_paths(request["config"])
    port = settings.pop("review_port", 8770)
    # Ephemeral ports are useful for an explicit foreground review and isolated
    # acceptance. All nonzero ports retain the existing schema validation.
    config = CommunityBriefingConfig(**{**settings, "review_host": "127.0.0.1",
        "review_port": port or 8770, "ai_provider": "codex", "enabled": False})
    if type(port) is not int or not 0 <= port <= 65535:
        raise ValueError("Invalid review port.")
    if port == 0:
        config = config.model_copy(update={"review_port": 0})
    def on_request(message):
        threading.Thread(target=scheduled_generation, args=(service, message), daemon=True).start()

    channel = ParentChannel(on_request)
    service = NativeReviewService(config, channel)
    server = create_briefing_review_server(service)
    parent = os.getppid()
    server.timeout = 0.5
    try:
        emit({"type": "ready", "url": f"http://127.0.0.1:{server.server_port}/?token={review_token(service.state_root)}",
              "publication": False})
        # Read the parent only after readiness, so requests cannot race startup.
        threading.Thread(target=channel.read, daemon=True).start()
        while os.getppid() == parent:
            server.handle_request()
    finally:
        server.server_close()
        service.close()


def main():
    request = receive(1048576)
    action = request.get("action")
    if action == "review":
        serve_native_review(request)
        return
    sys.addaudithook(deny_external)
    if action not in {"generate", "regenerate", "revise"}:
        raise ValueError("unsupported draft action")
    run_id = request.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip() or len(run_id) > 200:
        raise ValueError("explicit bounded run ID required")
    settings = request.get("config")
    if not isinstance(settings, dict):
        raise ValueError("explicit configuration required")
    week_start = None if action == "revise" else date.fromisoformat(request["week_start"])
    settings = validate_paths(settings, week_start)
    config = CommunityBriefingConfig(**{**settings, "ai_provider": "codex", "enabled": False})
    notices = PendingNotifications(request.get("notifications") is True)
    service = NativeCommunityService(config, notifier=notices)
    start_run(service.store, run_id, request)
    service._ai = ParentAI(service.store, run_id)
    ai = service._ai
    try:
        if action == "revise":
            item, _ = service.revise(
                request["briefing_id"], instruction=request["instruction"],
                markdown=request["markdown"], discord_summary=request["discord_summary"],
                provider="codex",
            )
            existing = False
        else:
            result = service.generate(
                week_start=week_start,
                regenerate=action == "regenerate",
            )
            item, existing = result.item, result.existing
        with service.store.connect() as connection:
            connection.execute("UPDATE community_draft_runs SET status='completed' WHERE run_id=?", (run_id,))
        emit({
            "type": "result", "briefing_id": item.briefing_id,
            "status": item.status.value, "draft_hash": item.draft_hash,
            "existing": existing, "provider_calls": ai.calls,
            "notification_pending": notices.pending, "notification_error": notices.error,
            "publication": False,
        })
    except Exception:
        with service.store.connect() as connection:
            connection.execute("UPDATE community_draft_runs SET status='failed' WHERE run_id=?", (run_id,))
        raise
    finally:
        service.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never expose source excerpts, provider output or private paths in errors.
        emit({"type": "error", "code": "community_draft_failed", "publication": False})
        sys.exit(1)
