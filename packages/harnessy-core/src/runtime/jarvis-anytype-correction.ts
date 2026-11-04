import { createHash } from "node:crypto";

/** Apply only to the V2 build copy; preserve the provenance-verified source. */
export const correctJarvisAnytypeSource = (source: string): string => {
	if (
		createHash("sha256").update(source).digest("hex") !==
		"4a1ae815fa66a443606afc977739f73d5d27272b802a19c6f1f58d3a5eaff6e4"
	)
		throw new Error("Unknown Jarvis AnyType source; refusing installation correction");
	return source.replaceAll(
		"                self._add_to_collection(space_id, parent_id, created.id)",
		"                if not self._add_to_collection(space_id, parent_id, created.id):\n" +
			'                    raise RuntimeError(f"Attachment unconfirmed for object {created.id} in collection {parent_id}; reconcile before retrying")',
	);
};
