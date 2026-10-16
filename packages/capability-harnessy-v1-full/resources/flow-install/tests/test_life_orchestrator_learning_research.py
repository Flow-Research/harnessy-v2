from __future__ import annotations

import datetime
import email.utils
import importlib.util
import json
import uuid
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = (
    REPO_ROOT
    / "tools"
    / "flow-install"
    / "skills"
    / "life-orchestrator"
    / "scripts"
    / "learning-research"
)


def load_script(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLOW_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("FLOW_USER", "tester")
    monkeypatch.setenv("AGENTS_LIFE_DIR", str(tmp_path / ".agents" / "life"))
    loader = SourceFileLoader(f"learning_research_{uuid.uuid4().hex}", str(SCRIPT_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_topic_rotation_is_deterministic(tmp_path, monkeypatch) -> None:
    module = load_script(tmp_path, monkeypatch)
    topics = ["inference", "institutions", "cognition"]
    date = datetime.date(2026, 8, 19)

    assert module.choose_topic(topics, date) == module.choose_topic(topics, date)
    assert module.choose_topic(topics, date) in topics


def test_topic_rotation_advances_each_day(tmp_path, monkeypatch) -> None:
    module = load_script(tmp_path, monkeypatch)
    topics = ["inference", "institutions", "cognition"]
    date = datetime.date(2026, 8, 19)

    assert module.choose_topic(topics, date) != module.choose_topic(
        topics, date + datetime.timedelta(days=1)
    )


def test_topic_parser_reads_only_current_topics(tmp_path, monkeypatch) -> None:
    module = load_script(tmp_path, monkeypatch)
    steering = tmp_path / "learning-research.md"
    steering.write_text(
        """# Learning Research

## Current Topics

- inference engineering
- political economy

## Avoid

- hype
""",
        encoding="utf-8",
    )

    assert module.read_topics(steering) == ["inference engineering", "political economy"]


def test_research_disables_expensive_wiki_compilation() -> None:
    script = SCRIPT_PATH.read_text(encoding="utf-8")

    assert '"--no-auto-compile"' in script


def test_default_cutoff_fits_brief_schedule_and_wait(tmp_path, monkeypatch) -> None:
    module = load_script(tmp_path, monkeypatch)

    monkeypatch.setenv("LIFE_RESEARCH_START", "04:15")
    monkeypatch.setenv("LIFE_DAILY_BRIEF_START", "05:30")
    monkeypatch.setenv("LIFE_READING_WAIT_SECONDS", "1800")
    monkeypatch.setenv("LIFE_RESEARCH_SAFETY_MARGIN_SECONDS", "300")

    assert module.maximum_research_cutoff_seconds() == 6000
    assert 5400 <= module.maximum_research_cutoff_seconds()


def test_cutoff_budget_tracks_configured_brief_wait(tmp_path, monkeypatch) -> None:
    module = load_script(tmp_path, monkeypatch)
    monkeypatch.setenv("LIFE_RESEARCH_START", "04:15")
    monkeypatch.setenv("LIFE_DAILY_BRIEF_START", "05:30")
    monkeypatch.setenv("LIFE_RESEARCH_SAFETY_MARGIN_SECONDS", "300")

    monkeypatch.setenv("LIFE_READING_WAIT_SECONDS", "1800")
    with_wait = module.maximum_research_cutoff_seconds()
    monkeypatch.setenv("LIFE_READING_WAIT_SECONDS", "0")
    without_wait = module.maximum_research_cutoff_seconds()

    assert with_wait - without_wait == 1800


def test_watched_feed_ingestion_is_recent_canonical_and_rss_only(
    tmp_path,
    monkeypatch,
) -> None:
    life_dir = tmp_path / ".agents" / "life"
    life_dir.mkdir(parents=True)
    (life_dir / "config.json").write_text(
        json.dumps(
            {
                "reading": {
                    "lookback_days": 21,
                    "sources": [
                        {
                            "name": "REKT",
                            "url": "https://rekt.news/rss/feed.xml",
                            "tier": "secondary",
                            "topic": "automated knowledge economies",
                            "max_per_brief": 1,
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    module = load_script(tmp_path, monkeypatch)
    now = datetime.datetime.now(datetime.timezone.utc)
    recent = email.utils.format_datetime(now - datetime.timedelta(days=1))
    old = email.utils.format_datetime(now - datetime.timedelta(days=40))
    feed = f"""<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Validator Trust Boundaries</title>
    <link>https://www.rekt.news/validator-case/?utm_source=rss</link>
    <pubDate>{recent}</pubDate>
    <description><![CDATA[<p>A feed-supplied case study.</p>]]></description>
  </item>
  <item>
    <title>Old Incident</title>
    <link>https://rekt.news/old-incident</link>
    <pubDate>{old}</pubDate>
    <description>Too old.</description>
  </item>
</channel></rss>""".encode()
    fetched = []

    def fetcher(url):
        fetched.append(url)
        return feed

    raw_dir = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    created, errors = module.ingest_watched_feeds(
        raw_dir,
        datetime.date.today(),
        fetcher=fetcher,
    )

    assert created == 1
    assert errors == []
    assert fetched == ["https://rekt.news/rss/feed.xml"]
    files = list(raw_dir.glob("*.md"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    assert "source_url: https://rekt.news/validator-case" in content
    assert "source_tier: secondary" in content
    assert "content_mode: rss" in content
    assert "A feed-supplied case study." in content
    assert "Old Incident" not in content


def test_watched_feed_ingestion_deduplicates_www_and_tracking_variants(
    tmp_path,
    monkeypatch,
) -> None:
    life_dir = tmp_path / ".agents" / "life"
    life_dir.mkdir(parents=True)
    (life_dir / "config.json").write_text(
        json.dumps(
            {
                "reading": {
                    "sources": [
                        {
                            "name": "REKT",
                            "url": "https://rekt.news/rss/feed.xml",
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    module = load_script(tmp_path, monkeypatch)
    raw_dir = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    raw_dir.mkdir(parents=True)
    (raw_dir / "existing.md").write_text(
        "---\nsource_url: https://rekt.news/same-article\n---\n",
        encoding="utf-8",
    )
    recent = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
    feed = f"""<rss version="2.0"><channel><item>
      <title>Same Article</title>
      <link>https://www.rekt.news/same-article/?utm_medium=rss</link>
      <pubDate>{recent}</pubDate>
      <description>Duplicate.</description>
    </item></channel></rss>""".encode()

    created, errors = module.ingest_watched_feeds(
        raw_dir,
        datetime.date.today(),
        fetcher=lambda _url: feed,
    )

    assert created == 0
    assert errors == []


def test_evergreen_feed_backfill_ranks_and_admits_one_old_item_per_poll(
    tmp_path,
    monkeypatch,
) -> None:
    life_dir = tmp_path / ".agents" / "life"
    life_dir.mkdir(parents=True)
    (life_dir / "config.json").write_text(
        json.dumps(
            {
                "reading": {
                    "lookback_days": 21,
                    "sources": [
                        {
                            "name": "REKT",
                            "url": "https://rekt.news/rss/feed.xml",
                            "tier": "secondary",
                            "topic": "automated knowledge economies",
                            "max_per_brief": 1,
                            "evergreen_enabled": True,
                            "max_evergreen_per_poll": 1,
                            "evergreen_min_score": 1,
                            "evergreen_keywords": ["governance", "validator", "trust"],
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    module = load_script(tmp_path, monkeypatch)
    old = email.utils.format_datetime(
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=90)
    )
    feed = f"""<rss version="2.0"><channel>
      <item><title>Governance and Validator Trust</title>
        <link>https://rekt.news/high-score</link><pubDate>{old}</pubDate>
        <description>Governance case.</description></item>
      <item><title>Validator Failure</title>
        <link>https://rekt.news/second-score</link><pubDate>{old}</pubDate>
        <description>Operational case.</description></item>
      <item><title>Unrelated Market Story</title>
        <link>https://rekt.news/no-score</link><pubDate>{old}</pubDate>
        <description>Price coverage.</description></item>
    </channel></rss>""".encode()
    raw_dir = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"

    first_created, first_errors = module.ingest_watched_feeds(
        raw_dir,
        datetime.date.today(),
        fetcher=lambda _url: feed,
    )
    first = next(raw_dir.glob("*.md")).read_text(encoding="utf-8")

    assert first_created == 1
    assert first_errors == []
    assert "source_url: https://rekt.news/high-score" in first
    assert "selection_lane: evergreen" in first
    assert "evergreen_score: 9" in first
    assert "selected_at:" in first

    second_created, second_errors = module.ingest_watched_feeds(
        raw_dir,
        datetime.date.today(),
        fetcher=lambda _url: feed,
    )

    assert second_created == 1
    assert second_errors == []
    contents = "\n".join(path.read_text(encoding="utf-8") for path in raw_dir.glob("*.md"))
    assert "source_url: https://rekt.news/second-score" in contents
    assert "source_url: https://rekt.news/no-score" not in contents
