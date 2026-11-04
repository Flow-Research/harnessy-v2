import { createHash } from "node:crypto";

/** V2 installation correction; never write into the provenance-verified oracle. */
export const correctJarvisPlanningSource = (source: string): string => {
	if (
		createHash("sha256").update(source).digest("hex") !==
		"a99d4c0fc588e6801e45dbad3d54d44b279f42824779481117d71597fba3327f"
	)
		throw new Error("Unknown Jarvis planning source; refusing installation correction");
	return source
		.replace(
			"busy_today = [b for b in busy if b.start.date() == current]",
			"busy_today = [b for b in busy if b.start < day_end and b.end > day_start]",
		)
		.replace(
			"free_slots.append((block_end, slot_end))",
			"free_slots.append((block_end, slot_end))\n            free_slots.sort(key=lambda slot: slot[0])",
		);
};
