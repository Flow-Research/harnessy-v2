"""Exercise week-scoped source traversal in the installed, corrected community collector.

Run with the Python of a real isolated Jarvis install (CI fixture or release
acceptance). Every case builds a real temporary tree; nothing is mocked.
"""

import os
from datetime import date, timedelta
from pathlib import Path
import tempfile
import unittest

from jarvis.community_briefing.collector import collect_sources, iter_content_files
from jarvis.config.schema import CommunityBriefingConfig


# Lagos week Monday 2026-10-12 to Sunday 2026-10-18. With the seven-day margin,
# dated folders from 2026-10-05 to 2026-10-25 can still hold this week's evidence.
WEEK = (date(2026, 10, 12), date(2026, 10, 18))
OVER_LIMIT = 10050


def write_source(path: Path, title: str, day: date) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# {title}\n\n- Date: {day.isoformat()}\n\n## Key takeaways\n\n"
        "Flow Research reviewed the community programme and agreed the next public steps.\n",
        encoding="utf-8",
    )


def fill(directory: Path, count: int = OVER_LIMIT) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        (directory / f"{index}.txt").touch()


def plant_fifo(directory: Path) -> None:
    """A special file the collector refuses, proving whether a folder was traversed."""
    directory.mkdir(parents=True, exist_ok=True)
    os.mkfifo(directory / "refused.md")


class CollectorPruningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="community-collector-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        self.root.mkdir()

    def collect(self, week=WEEK):
        config = CommunityBriefingConfig(source_path=str(self.root), timezone="Africa/Lagos")
        return collect_sources(config, week_start=week[0], week_end=week[1])

    def titles(self, week=WEEK):
        return sorted(source.title for source in self.collect(week).sources)

    def test_large_out_of_window_history_is_not_traversed(self):
        # The live failure: generated experiment output in an old dated folder
        # pushed a whole-tree walk past the entry limit.
        fill(self.root / "flow/strategy/2026/Sep/13-research/experiments")
        write_source(self.root / "flow/meetings/2026/Oct/14-community-sync.md", "Community Sync", date(2026, 10, 14))
        result = self.collect()
        self.assertEqual([source.title for source in result.sources], ["Community Sync"])
        self.assertEqual(result.files_seen, 1)
        self.assertEqual(result.skipped["outside_week"], 1)

    def test_year_and_month_levels_outside_the_window_are_pruned_before_descent(self):
        plant_fifo(self.root / "notes/2025")
        plant_fifo(self.root / "flow/strategy/2026/Aug/future-mail")
        plant_fifo(self.root / "flow/strategy/2026/Nov/30-planning")
        fill(self.root / "flow/strategy/2026/Sep/03-paper/build", 6000)
        fill(self.root / "garden/docs/2027/Jan/04-plan", 6000)
        write_source(self.root / "flow/strategy/2026/Oct/15-update.md", "October Update", date(2026, 10, 15))
        write_source(self.root / "flow/strategy/2026/flow-overview.md", "Year Level Overview", date(2026, 10, 13))
        result = self.collect()
        self.assertEqual(sorted(source.title for source in result.sources), ["October Update", "Year Level Overview"])
        # 2025, Aug, Nov/30, Sep, 2027: each pruned folder counts once.
        self.assertEqual(result.skipped["outside_week"], 5)

    def test_window_margin_is_inclusive_at_each_boundary(self):
        in_week = date(2026, 10, 14)
        for name in ("04-before", "05-low-edge", "12-monday", "18-sunday", "25-high-edge", "26-after"):
            write_source(self.root / f"flow/docs/2026/Oct/{name}/note.md", name, in_week)
        self.assertEqual(self.titles(), ["05-low-edge", "12-monday", "18-sunday", "25-high-edge"])

    def test_window_margin_crosses_month_and_year_boundaries(self):
        week = (date(2026, 12, 28), date(2027, 1, 3))  # low 2026-12-21, high 2027-01-10
        in_week = date(2026, 12, 30)
        for folder in ("2026/Nov/30-a", "2026/Dec/20-b", "2026/Dec/21-c", "2027/Jan/10-d", "2027/Jan/11-e", "2027/Feb/01-f"):
            write_source(self.root / "flow/docs" / folder / "note.md", folder, in_week)
        self.assertEqual(self.titles(week), ["2026/Dec/21-c", "2027/Jan/10-d"])
        week = (date(2026, 10, 5), date(2026, 10, 11))  # low 2026-09-28: September still overlaps
        for folder in ("2026/Sep/27-g", "2026/Sep/28-h"):
            write_source(self.root / "flow/docs" / folder / "note.md", folder, date(2026, 10, 7))
        self.assertEqual(self.titles(week), ["2026/Sep/28-h"])

    def test_undated_and_unconventional_folders_are_always_traversed(self):
        in_week = date(2026, 10, 14)
        for folder in (
            "meeting-inbox/pending",  # undated
            "flow/2026/Sept/03-not-an-abbreviation",  # month not in the YYYY/Mmm convention
            "flow/2026/Oct/32-impossible-date",  # invalid day: treated as undated
            "flow/2026/Oct/01-valid-date",  # valid day before the margin: pruned
            "flow/Sep/03-no-year-parent",  # month without a year parent
            "flow/1999/Jan/03-implausible-year",  # outside the year range
            "flow/2026/Sep/x03-prefixed",  # month child without a day prefix is pruned with Sep
        ):
            write_source(self.root / folder / "note.md", folder, in_week)
        self.assertEqual(
            self.titles(),
            [
                "flow/1999/Jan/03-implausible-year",
                "flow/2026/Oct/32-impossible-date",
                "flow/2026/Sept/03-not-an-abbreviation",
                "flow/Sep/03-no-year-parent",
                "meeting-inbox/pending",
            ],
        )
        # A day-named folder only counts as dated beneath YYYY/Mmm.
        write_source(self.root / "projects/04-old-looking/note.md", "projects/04-old-looking", in_week)
        self.assertIn("projects/04-old-looking", self.titles())

    def test_excluded_and_generated_folders_are_pruned_before_descent(self):
        fill(self.root / "Archive/old", 6000)
        plant_fifo(self.root / "flow/meetings/2026/Oct/14-sync/transcripts")
        fill(self.root / "flow/hiring", 6000)
        fill(self.root / "tools/node_modules/pkg", 6000)
        plant_fifo(self.root / "flow/.venv")
        write_source(self.root / "flow/meetings/2026/Oct/14-sync/notes.md", "Synced Notes", date(2026, 10, 14))
        result = self.collect()
        self.assertEqual([source.title for source in result.sources], ["Synced Notes"])
        self.assertEqual(result.skipped["private_category"], 3)

    def test_safety_bounds_still_apply_to_traversed_folders(self):
        week_folder = self.root / "flow/docs/2026/Oct/14-work"
        undated = self.root / "notes"

        def expect(message):
            with self.assertRaisesRegex(ValueError, message):
                self.collect()

        for folder in (week_folder, undated):
            with self.subTest(folder=folder.name):
                folder.mkdir(parents=True, exist_ok=True)
                link = folder / "linked.md"
                link.symlink_to(self.root / "absent")
                expect("linked or special content refused")
                link.unlink()
                target = Path(self.temp.name) / "outside.md"
                target.write_text("PRIVATE")
                os.link(target, link)
                expect("linked or special content refused")
                link.unlink()
                target.unlink()
                os.mkfifo(link)
                expect("linked or special content refused")
                link.unlink()
                with link.open("wb") as stream:
                    stream.truncate(1048577)
                expect("source byte limit exceeded")
                link.unlink()

    def test_symlinked_folders_are_refused_even_when_named_as_pruned(self):
        target = Path(self.temp.name) / "elsewhere"
        target.mkdir()
        for name in ("flow/2026/Oct/01-linked", "flow/archive", "flow/2025"):
            with self.subTest(name=name):
                link = self.root / name
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(target, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "linked or special content refused"):
                    self.collect()
                link.unlink()

    def test_total_bytes_remain_bounded_across_the_week(self):
        for index in range(33):
            folder = self.root / f"flow/docs/2026/Oct/{12 + index % 7}-part"
            folder.mkdir(parents=True, exist_ok=True)
            with (folder / f"{index}.md").open("wb") as stream:
                stream.truncate(1048576)
        with self.assertRaisesRegex(ValueError, "source byte limit exceeded"):
            self.collect()

    def test_entry_limit_still_applies_to_what_is_traversed(self):
        fill(self.root / "flow/docs/2026/Oct/14-generated-output")
        with self.assertRaisesRegex(ValueError, "directory entry limit exceeded"):
            self.collect()

    def test_entry_limit_still_applies_to_undated_folders(self):
        fill(self.root / "scratch")
        with self.assertRaisesRegex(ValueError, "directory entry limit exceeded"):
            self.collect()

    def test_depth_limit_still_applies_inside_the_week(self):
        directory = self.root / "flow/docs/2026/Oct/14-deep"
        for _ in range(64):
            directory = directory / "nested"
        directory.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "directory depth limit exceeded"):
            self.collect()

    def test_undated_only_traversal_skips_every_dated_folder(self):
        fill(self.root / "flow/docs/2026/Oct/14-current", 6000)
        fill(self.root / "flow/docs/2026/Sep/13-old", 6000)
        (self.root / "flow/docs/2026/top-level.md").write_text("# Year file\n")
        (self.root / "notes").mkdir()
        (self.root / "notes/undated.md").write_text("# Undated\n")
        files = sorted(path.relative_to(self.root).as_posix() for path in iter_content_files(self.root, undated_only=True))
        self.assertEqual(files, ["notes/undated.md"])

    def test_output_traversal_is_never_pruned(self):
        draft = self.root / "community-briefings"
        old = draft / "2025/Jan/05-week"
        old.mkdir(parents=True)
        (old / "briefing.md").symlink_to(self.root / "absent")
        with self.assertRaisesRegex(ValueError, "linked or special content refused"):
            list(iter_content_files(draft, source=False, window=WEEK))

    def test_week_window_matches_the_configured_week_only(self):
        for offset in range(-21, 22, 7):
            day = date(2026, 10, 14) + timedelta(days=offset)
            write_source(
                self.root / f"flow/docs/{day.year}/{day.strftime('%b')}/{day.day:02d}-work/note.md",
                f"Work offset {offset + 21}",
                day,
            )
        self.assertEqual(self.titles(), ["Work offset 21"])


if __name__ == "__main__":
    unittest.main()
