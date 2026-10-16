import { createHash } from "node:crypto";

/** The preserved V1 collector, as recorded in the V1 provenance (SOURCE.json). */
const ORIGINAL_DIGEST = "2f69c284c3ac5bd47ccc657e76c2f344c1186c1b11fb33fa56e09e37a2ed3935";
/** The first V2 correction: bounded traversal without week pruning. Upgraded in place. */
const PREVIOUS_CORRECTED_DIGEST = "d8c93d4290f4a449aaff22f1aec95149ec3ae99688b7d7f72f98ab747631801d";
/** The canonical corrected collector shipped in the V1 capability resources. */
const CORRECTED_DIGEST = "f6146baa6efbfb5a7a85328168f6e8ce8fa842b205f45325e6d3dd15b0cbfcd5";

const PREVIOUS_HELPER_MARKER = "\n\ndef iter_content_files(";
const PREVIOUS_LOOP = 'sorted(path for path in iter_content_files(root) if path.suffix == ".md")';
const ORIGINAL_LOOP = '    for path in sorted(root.rglob("*.md")):\n';
const CORRECTED_LOOP = `    for path in sorted(
        path
        for path in iter_content_files(root, window=(week_start, week_end), pruned=result.skipped)
        if path.suffix == ".md"
    ):
`;

const HELPER = String.raw`

# Dated folders follow YYYY/Mmm/DD-slug. A dated folder is pruned only when its
# whole date range lies more than this margin outside the target week, which
# covers time zones and work that continues after the folder's date.
_DATED_MARGIN = timedelta(days=7)
_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_YEAR_DIR = re.compile(r"^(\d{4})$")
_DAY_DIR = re.compile(r"^(\d{2})(?:$|\s*-)")


def _dated_span(name: str, parent: tuple[int, int] | None):
    """Return (first, last, child context) for a YYYY, YYYY/Mmm or YYYY/Mmm/DD folder."""
    year = _YEAR_DIR.match(name)
    if year and 2000 <= int(year.group(1)) <= 2999:
        value = int(year.group(1))
        return date(value, 1, 1), date(value, 12, 31), (value, 0)
    if parent is None:
        return None
    parent_year, parent_month = parent
    if parent_month == 0 and name.lower() in _MONTHS:
        month = _MONTHS.index(name.lower()) + 1
        following = date(parent_year + month // 12, month % 12 + 1, 1)
        return date(parent_year, month, 1), following - timedelta(days=1), (parent_year, month)
    day = _DAY_DIR.match(name)
    if parent_month and day:
        try:
            value = date(parent_year, parent_month, int(day.group(1)))
        except ValueError:
            return None
        return value, value, None
    return None


def iter_content_files(
    root: Path,
    *,
    source: bool = True,
    window: tuple[date, date] | None = None,
    undated_only: bool = False,
    pruned: Counter[str] | None = None,
):
    """Bound source traversal before descent; never inspect generated environments.

    For source trees, private-category folders are pruned before descent. With an
    inclusive (first, last) week window, dated folders that cannot hold that week
    are pruned too; undated_only prunes every dated folder. Undated folders are
    always traversed, and every traversed entry counts toward the entry limit.
    """
    generated = {
        ".git",
        ".goal-agent",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".turbo",
        "coverage",
    }
    if window is not None:
        low, high = window[0] - _DATED_MARGIN, window[1] + _DATED_MARGIN
    pending = [(root, None)] if root.exists() else []
    seen = total = 0
    while pending:
        directory, context = pending.pop()
        if len(directory.relative_to(root).parts) > 64:
            raise ValueError("directory depth limit exceeded")
        with os.scandir(directory) as entries:
            for entry in entries:
                seen += 1
                if seen > 10000:
                    raise ValueError("directory entry limit exceeded")
                if source and entry.name.lower() in generated:
                    continue
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = None
                    if source:
                        if entry.name.lower() in _EXCLUDED_PARTS:
                            if pruned is not None:
                                pruned["private_category"] += 1
                            continue
                        span = _dated_span(entry.name, context)
                        if span is not None:
                            first, last, child = span
                            if undated_only or (window is not None and (last < low or first > high)):
                                if pruned is not None:
                                    pruned["outside_week"] += 1
                                continue
                    pending.append((Path(entry.path), child))
                elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("linked or special content refused")
                else:
                    if source and entry.name.endswith(".md"):
                        total += info.st_size
                        if info.st_size > 1048576 or total > 33554432:
                            raise ValueError("source byte limit exceeded")
                    yield Path(entry.path)
`;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Undo the first V2 correction so an older corrected copy is upgraded from the verified original. */
const restorePreviousCorrection = (source: string): string =>
	source
		.slice(0, source.indexOf(PREVIOUS_HELPER_MARKER))
		.replace("import stat\n", "")
		.replace(PREVIOUS_LOOP, 'sorted(root.rglob("*.md"))');

/**
 * Share bounded, week-scoped traversal with the native adapter. Only the exact
 * preserved source (or the first V2 correction of it) is corrected, and the
 * result must match the pinned canonical digest; anything else fails closed.
 */
export const correctJarvisCommunitySource = (source: string): string => {
	const digest = sha256(source);
	if (digest === CORRECTED_DIGEST) return source;
	const original = digest === PREVIOUS_CORRECTED_DIGEST ? restorePreviousCorrection(source) : source;
	if (sha256(original) !== ORIGINAL_DIGEST)
		throw new Error("Unknown Jarvis community collector; refusing installation correction");
	// Both input and output are digest-pinned, so plain first-match replacement is exact.
	const corrected = `${original
		.replace("import re\n", "import re\nimport stat\n")
		.replace("from datetime import UTC, date, datetime\n", "from datetime import UTC, date, datetime, timedelta\n")
		.replace(ORIGINAL_LOOP, CORRECTED_LOOP)}${HELPER}`;
	if (sha256(corrected) !== CORRECTED_DIGEST)
		throw new Error("Jarvis community collector correction does not match its pinned result");
	return corrected;
};
