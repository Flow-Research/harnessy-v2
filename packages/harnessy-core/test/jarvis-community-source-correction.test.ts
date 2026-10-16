import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctJarvisCommunitySource } from "../src/runtime/jarvis-community-source-correction.ts";

const resource = (root: "jarvis-cli" | "source/jarvis-cli") =>
	readFileSync(
		new URL(
			`../../capability-harnessy-v1-full/resources/${root}/src/jarvis/community_briefing/collector.py`,
			import.meta.url,
		),
		"utf8",
	);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGINAL_DIGEST = "2f69c284c3ac5bd47ccc657e76c2f344c1186c1b11fb33fa56e09e37a2ed3935";
const PREVIOUS_DIGEST = "d8c93d4290f4a449aaff22f1aec95149ec3ae99688b7d7f72f98ab747631801d";

const correctedLoop = `    for path in sorted(
        path
        for path in iter_content_files(root, window=(week_start, week_end), pruned=result.skipped)
        if path.suffix == ".md"
    ):
`;

/** Rebuild the preserved V1 source from the canonical corrected resource. */
const preservedFrom = (corrected: string): string =>
	corrected
		.slice(0, corrected.indexOf("\n\n# Dated folders follow"))
		.replace(correctedLoop, '    for path in sorted(root.rglob("*.md")):\n')
		.replace("import stat\n", "")
		.replace("from datetime import UTC, date, datetime, timedelta\n", "from datetime import UTC, date, datetime\n");

/** The first V2 correction, exactly as it was shipped before week pruning. */
const previousFrom = (preserved: string): string =>
	`${preserved
		.replace("import re\n", "import re\nimport stat\n")
		.replace(
			'sorted(root.rglob("*.md"))',
			'sorted(path for path in iter_content_files(root) if path.suffix == ".md")',
		)}

def iter_content_files(root: Path, *, source: bool = True):
    """Bound source traversal before descent; never inspect generated environments."""
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
    pending = [root] if root.exists() else []
    seen = total = 0
    while pending:
        directory = pending.pop()
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
                    pending.append(Path(entry.path))
                elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("linked or special content refused")
                else:
                    if source and entry.name.endswith(".md"):
                        total += info.st_size
                        if info.st_size > 1048576 or total > 33554432:
                            raise ValueError("source byte limit exceeded")
                    yield Path(entry.path)
`;

describe("V2 community collector installation correction", () => {
	const canonical = resource("jarvis-cli");
	const preserved = preservedFrom(canonical);

	it("ships the same canonical corrected collector in the source tree and its projection", () => {
		expect(resource("source/jarvis-cli")).toBe(canonical);
		expect(sha256(preserved)).toBe(ORIGINAL_DIGEST);
	});

	it("corrects the exact preserved source and accepts the canonical corrected source idempotently", () => {
		const corrected = correctJarvisCommunitySource(preserved);
		expect(corrected).toBe(canonical);
		expect(corrected).not.toContain('root.rglob("*.md")');
		expect(corrected).toContain("iter_content_files(root, window=(week_start, week_end), pruned=result.skipped)");
		expect(corrected).toContain("_DATED_MARGIN = timedelta(days=7)");
		expect(correctJarvisCommunitySource(corrected)).toBe(corrected);
	});

	it("upgrades the first V2 correction from its verified original", () => {
		const previous = previousFrom(preserved);
		expect(sha256(previous)).toBe(PREVIOUS_DIGEST);
		expect(correctJarvisCommunitySource(previous)).toBe(canonical);
	});

	it("refuses unknown, tampered or partially corrected sources", () => {
		const previous = previousFrom(preserved);
		for (const unknown of [
			`${canonical}\n`,
			`${preserved}\n`,
			previous.replace("seen > 10000", "seen > 99999"),
			preserved.replace('sorted(root.rglob("*.md"))', "sorted([])"),
			"",
		])
			expect(() => correctJarvisCommunitySource(unknown)).toThrow("Unknown Jarvis community collector");
	});

	it("produces Python that compiles", () => {
		const python = process.env.HARNESSY_TEST_JARVIS_PYTHON ?? "python3";
		execFileSync(python, ["-I", "-c", "import sys; compile(sys.stdin.read(), 'collector.py', 'exec')"], {
			input: correctJarvisCommunitySource(preserved),
		});
	});
});
