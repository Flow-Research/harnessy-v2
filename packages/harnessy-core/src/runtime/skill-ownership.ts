import fs from "node:fs/promises";
import path from "node:path";

// Ownership is explicit. Existing names, versions and --force do not prove it.
/** Install or replace only an explicitly owned skill, staging the copy before replacement. */
export const installOwnedSkill = async (
	source: string,
	target: string,
	sourceId: string,
	{ dryRun = false }: { dryRun?: boolean } = {},
): Promise<void> => {
	const markerName = ".harnessy-install.json";
	const owner = { version: 1, owner: "harnessy", sourceId };
	const existing = await fs.lstat(target).catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (existing) {
		const markerPath = path.join(target, markerName);
		const markerInfo = await fs.lstat(markerPath).catch(() => null);
		let marker: { version?: number; owner?: string; sourceId?: string } | null = null;
		if (
			existing.isDirectory() &&
			!existing.isSymbolicLink() &&
			markerInfo?.isFile() &&
			!markerInfo.isSymbolicLink()
		) {
			marker = await fs
				.readFile(markerPath, "utf8")
				.then((raw) => JSON.parse(raw))
				.catch(() => null);
		}
		if (marker?.version !== owner.version || marker?.owner !== owner.owner || marker?.sourceId !== sourceId) {
			throw new Error(
				`Skill install conflict at ${target}; ownership is unverified. Existing entry preserved. Move or rename it explicitly, then retry.`,
			);
		}
	}
	if (dryRun) return;
	await fs.mkdir(path.dirname(target), { recursive: true });
	const staging = await fs.mkdtemp(path.join(path.dirname(target), ".harnessy-stage-"));
	const next = path.join(staging, "next");
	const previous = path.join(staging, "previous");
	let moved = false;
	let completed = false;
	try {
		await fs.cp(source, next, { recursive: true, dereference: false });
		const copiedMarker = path.join(next, markerName);
		await fs.rm(copiedMarker, { force: true });
		await fs.writeFile(copiedMarker, `${JSON.stringify(owner)}\n`, { flag: "wx" });
		if (existing) {
			await fs.rename(target, previous);
			moved = true;
		} else await fs.mkdir(target); // Claim only an absent target; never replace a racing install.
		await fs.rename(next, target).catch(async (error) => {
			if (moved) {
				await fs.rename(previous, target);
				moved = false;
			} else await fs.rmdir(target);
			throw error;
		});
		completed = true;
	} finally {
		// If rollback itself fails, keep the previous directory for recovery.
		if (!moved || completed) await fs.rm(staging, { recursive: true, force: true });
	}
};
