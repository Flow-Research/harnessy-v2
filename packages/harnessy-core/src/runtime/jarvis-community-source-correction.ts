import { createHash } from "node:crypto";

/** Share bounded traversal with the native adapter without modifying the frozen oracle. */
export const correctJarvisCommunitySource = (source: string): string => {
	if (
		createHash("sha256").update(source).digest("hex") !==
		"2f69c284c3ac5bd47ccc657e76c2f344c1186c1b11fb33fa56e09e37a2ed3935"
	)
		throw new Error("Unknown Jarvis community collector; refusing installation correction");
	return `${source
		.replace("import re\n", "import re\nimport stat\n")
		.replace(
			'sorted(root.rglob("*.md"))',
			'sorted(path for path in iter_content_files(root) if path.suffix == ".md")',
		)}

def iter_content_files(root: Path, *, source: bool = True):
    """Bound source traversal before descent; never inspect generated environments."""
    generated = {".git", ".goal-agent", "node_modules", ".venv", "venv", "__pycache__", ".turbo", "coverage"}
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
};
