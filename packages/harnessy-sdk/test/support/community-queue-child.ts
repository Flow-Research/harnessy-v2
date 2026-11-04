import { CommunityBriefingQueue } from "../../src/community-briefing/queue.ts";

const [path, briefingId] = process.argv.slice(2);
if (!path || !briefingId || !process.send) throw new Error("Queue child requires database, item and IPC");
const queue = new CommunityBriefingQueue(path);
let item: ReturnType<CommunityBriefingQueue["claim"]> = null;
const report = (type: string): void => {
	process.send!({ type, pid: process.pid, briefingId: item?.briefingId ?? null });
};
process.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("type" in message))
		throw new Error("Invalid queue child command");
	if (message.type === "claim" || message.type === "claim-expired") {
		report("attempting");
		item = queue.claim(message.type === "claim" ? "2026-09-19T01:00:00.000Z" : "2026-09-19T02:00:00.000Z", 1, {
			briefingId,
			sourceHash: "a".repeat(64),
		});
		report("claimed");
	} else if (message.type === "finish") {
		if (item === null) throw new Error("Cannot finish without an owned claim");
		queue.markPublished(item, "fixture-channel", "fixture-message", "2026-09-19T02:00:01.000Z");
		report("finished");
	} else if (message.type === "stop") {
		queue.close();
		process.disconnect();
	} else {
		throw new Error("Unknown queue child command");
	}
});
report("ready");
