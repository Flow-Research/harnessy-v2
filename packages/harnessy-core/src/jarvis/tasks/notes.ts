/**
 * Optional narrative note for close-out. The portal page never calls this.
 * The CLI may append a follow-up note in the same shape as `jarvis note -c followup`.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const closeoutNotePath = (contextRoot: string, user: string, date: Date): string => {
	const year = String(date.getFullYear());
	const month = MONTHS[date.getMonth()]!;
	const day = String(date.getDate()).padStart(2, "0");
	return join(contextRoot, "private", user, "notes", year, month, `${day}.md`);
};

/** Append one follow-up note. Creates today's file with a heading when it does not exist. */
export const appendCloseoutNote = (contextRoot: string, user: string, text: string, now: Date = new Date()): string => {
	const body = text.trim();
	if (body.length === 0) throw new Error("empty_note");
	if (body.length > 4000 || /[\p{Cc}\p{Cf}]/u.test(body)) throw new Error("invalid_note");
	const file = closeoutNotePath(contextRoot, user, now);
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	if (!existsSync(file)) {
		const heading = `# Notes — ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n\n`;
		writeFileSync(file, heading, { mode: 0o600, flag: "wx" });
	}
	const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	appendFileSync(file, `- ${stamp} — [followup] ${body}\n`, { encoding: "utf8" });
	return file;
};
