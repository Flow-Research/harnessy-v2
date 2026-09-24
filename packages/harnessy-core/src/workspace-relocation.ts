import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { resolveWorkspacePath, workspaceRelativePath } from "./workspace.ts";

export interface RelocationMove {
	readonly from: string;
	readonly to: string;
	readonly digest: string;
	readonly device: number;
	readonly inode: number;
}
export interface RelocationPlan {
	readonly version: 1;
	readonly id: string;
	readonly root: string;
	readonly moves: ReadonlyArray<RelocationMove>;
}
export interface RelocationBackup {
	readonly from: string;
	readonly backupPath: string;
}
interface RelocationJournal {
	readonly version: 1;
	readonly planHash: string;
	readonly backups: ReadonlyArray<RelocationBackup>;
	readonly completed: number;
	readonly state: "applying" | "applied" | "rolling_back" | "rolled_back";
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Content and permission digest, including untracked/ignored files and link text; never follows links. */
export const relocationTreeDigest = (root: string): string => {
	const digest = createHash("sha256");
	const visit = (path: string, relative: string): void => {
		const before = lstatSync(path);
		const kind = before.isSymbolicLink()
			? "link"
			: before.isDirectory()
				? "directory"
				: before.isFile()
					? "file"
					: "unsupported";
		if (kind === "unsupported") throw new Error(`Unsupported migration entry: ${relative}`);
		digest.update(JSON.stringify([relative, kind, before.mode & 0o7777]));
		if (kind === "link") digest.update(JSON.stringify(readlinkSync(path)));
		if (kind === "directory") {
			for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
		}
		if (kind === "file") {
			const fileHash = createHash("sha256");
			const file = openSync(path, "r");
			try {
				const buffer = Buffer.allocUnsafe(65536);
				let bytes = readSync(file, buffer);
				while (bytes > 0) {
					fileHash.update(buffer.subarray(0, bytes));
					bytes = readSync(file, buffer);
				}
			} finally {
				closeSync(file);
			}
			digest.update(fileHash.digest());
		}
		const after = lstatSync(path);
		if (
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error(`Entry changed during migration inventory: ${relative}`);
	};
	visit(root, "");
	return digest.digest("hex");
};

const assertIndependentBackup = (source: string, backup: string): void => {
	const sourceFiles = new Set<string>();
	const visit = (path: string, inspect: (device: number, inode: number) => void): void => {
		const stat = lstatSync(path);
		if (stat.isFile()) inspect(stat.dev, stat.ino);
		if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name), inspect);
	};
	visit(source, (device, inode) => sourceFiles.add(`${device}:${inode}`));
	visit(backup, (device, inode) => {
		if (sourceFiles.has(`${device}:${inode}`))
			throw new Error("Backup shares file inodes with source; hardlinks are not independent backups");
	});
};

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** One phase contains disjoint moves. Plan nested layout normalization as a later phase. */
export const planWorkspaceRelocation = (
	root: string,
	requests: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): RelocationPlan => {
	const base = realpathSync(root);
	if (!requests.length || requests.length > 1000) throw new Error("Expected 1–1000 relocation moves");
	const paths = requests.flatMap(({ from, to }) => [workspaceRelativePath(from), workspaceRelativePath(to)]);
	for (let i = 0; i < paths.length; i++) {
		const path = paths[i]!;
		if (overlaps(path, ".harnessy")) throw new Error("Migration control files cannot be relocated");
		for (let j = i + 1; j < paths.length; j++)
			if (overlaps(path.toLowerCase(), paths[j]!.toLowerCase())) throw new Error("Overlapping relocation paths");
	}
	const device = lstatSync(base).dev;
	const moves = requests.map(({ from, to }): RelocationMove => {
		const source = resolveWorkspacePath(base, from);
		const target = resolveWorkspacePath(base, to);
		const stat = lstatSync(source);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device)
			throw new Error("Relocation requires an actual directory on the workspace filesystem");
		if (realpathSync(source) !== source) throw new Error("Relocation source cannot traverse directory links");
		if (present(target)) throw new Error(`Relocation destination exists: ${to}`);
		let parent = dirname(target);
		while (!existsSync(parent)) parent = dirname(parent);
		if (realpathSync(parent) !== parent || lstatSync(parent).dev !== device)
			throw new Error("Relocation target cannot traverse links or filesystems");
		return { from, to, digest: relocationTreeDigest(source), device: stat.dev, inode: stat.ino };
	});
	return { version: 1, id: randomUUID(), root: base, moves };
};

const saveJournal = (path: string, journal: RelocationJournal): void => {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	renameSync(temporary, path);
	// Windows cannot open directory handles through this Node filesystem API.
	if (process.platform !== "win32") {
		const parent = openSync(dirname(path), "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	}
};

const validatePlan = (plan: RelocationPlan): void => {
	if (
		plan.version !== 1 ||
		!/^[a-f0-9-]{36}$/.test(plan.id) ||
		!plan.moves.length ||
		realpathSync(plan.root) !== plan.root
	)
		throw new Error("Invalid relocation plan");
	const paths: string[] = [];
	for (const move of plan.moves) {
		for (const path of [move.from, move.to]) {
			workspaceRelativePath(path);
			resolveWorkspacePath(plan.root, path);
			if (
				overlaps(path, ".harnessy") ||
				paths.some((existing) => overlaps(existing.toLowerCase(), path.toLowerCase()))
			)
				throw new Error("Invalid relocation paths");
			paths.push(path);
		}
		if (
			!/^[a-f0-9]{64}$/.test(move.digest) ||
			!Number.isSafeInteger(move.device) ||
			!Number.isSafeInteger(move.inode)
		)
			throw new Error("Invalid relocation identity");
	}
};

/** Caller must quiesce writers first. Every move requires a content-verified independent backup. */
export const executeWorkspaceRelocation = (
	plan: RelocationPlan,
	backups: ReadonlyArray<RelocationBackup>,
	rollback = false,
): string => {
	validatePlan(plan);
	const directory = resolveWorkspacePath(plan.root, ".harnessy/migrations");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const journalPath = join(directory, `${plan.id}.json`);
	const lockPath = join(directory, "relocation.lock");
	const lock = openSync(lockPath, "wx", 0o600);
	try {
		const planHash = hash(JSON.stringify(plan));
		let journal: RelocationJournal;
		if (present(journalPath)) {
			if (!lstatSync(journalPath).isFile() || lstatSync(journalPath).isSymbolicLink())
				throw new Error("Invalid migration journal");
			journal = JSON.parse(readFileSync(journalPath, "utf8")) as RelocationJournal;
			if (
				journal.version !== 1 ||
				journal.planHash !== planHash ||
				!Number.isSafeInteger(journal.completed) ||
				journal.completed < 0 ||
				journal.completed > plan.moves.length
			)
				throw new Error("Migration journal does not match plan");
			if (journal.state === "rolled_back" && !rollback) throw new Error("Create a new plan after rollback");
			if (journal.state === "rolling_back" && !rollback) throw new Error("Finish the interrupted rollback first");
		} else {
			if (rollback) throw new Error("No migration journal to roll back");

			journal = { version: 1, planHash, backups, completed: 0, state: "applying" };
		}
		for (const move of plan.moves) {
			const backup = journal.backups.find((candidate) => candidate.from === move.from);
			if (!backup) throw new Error(`Missing verified backup: ${move.from}`);
			const backupPath = realpathSync(backup.backupPath);
			for (const entry of plan.moves) {
				for (const path of [entry.from, entry.to]) {
					const active = resolveWorkspacePath(plan.root, path);
					if (
						backupPath === active ||
						backupPath.startsWith(`${active}${sep}`) ||
						active.startsWith(`${backupPath}${sep}`)
					)
						throw new Error("Backup must be independent of relocated directories");
				}
			}
			const sourcePath = resolveWorkspacePath(plan.root, move.from);
			const activePath = present(sourcePath) ? sourcePath : resolveWorkspacePath(plan.root, move.to);
			assertIndependentBackup(activePath, backupPath);
			if (relocationTreeDigest(backupPath) !== move.digest)
				throw new Error(`Backup verification failed: ${move.from}`);
		}
		// Infer a rename interrupted before journal commit from the original directory inode.
		let completed = 0;
		let encounteredSource = false;
		for (const move of plan.moves) {
			const source = resolveWorkspacePath(plan.root, move.from);
			const target = resolveWorkspacePath(plan.root, move.to);
			const atSource = present(source);
			if (atSource === present(target))
				throw new Error("Ambiguous migration state; neither overwrite nor deletion is allowed");
			const active = atSource ? source : target;
			const stat = lstatSync(active);
			if (stat.ino !== move.inode || stat.dev !== move.device || relocationTreeDigest(active) !== move.digest)
				throw new Error(`Migration source changed: ${move.from}`);
			if (atSource) encounteredSource = true;
			else {
				if (encounteredSource) throw new Error("Non-sequential migration state");
				completed++;
			}
		}
		journal = { ...journal, completed, state: rollback ? "rolling_back" : "applying" };
		saveJournal(journalPath, journal);
		while (rollback ? completed > 0 : completed < plan.moves.length) {
			const move = plan.moves[rollback ? completed - 1 : completed]!;
			const source = resolveWorkspacePath(plan.root, rollback ? move.to : move.from);
			const target = resolveWorkspacePath(plan.root, rollback ? move.from : move.to);
			if (present(target)) throw new Error("Relocation destination appeared; refusing overwrite");
			mkdirSync(dirname(target), { recursive: true });
			if (realpathSync(dirname(target)) !== dirname(target)) throw new Error("Destination parent changed to a link");
			renameSync(source, target);
			completed += rollback ? -1 : 1;
			journal = { ...journal, completed };
			saveJournal(journalPath, journal);
		}
		saveJournal(journalPath, { ...journal, state: rollback ? "rolled_back" : "applied" });
		return journalPath;
	} finally {
		closeSync(lock);
		unlinkSync(lockPath);
	}
};
