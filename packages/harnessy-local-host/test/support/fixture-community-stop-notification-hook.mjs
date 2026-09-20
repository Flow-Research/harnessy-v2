// Test-only interception: never invoke the actual desktop notifier.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const original = childProcess.execFile;
childProcess.execFile = function (file, ...args) {
	if (file !== "/usr/bin/osascript") return original.call(this, file, ...args);
	const [argv, options, completed] = args;
	assert.deepEqual(argv, ["-e", 'display notification "Community publication stopped. Do not retry uncertain deliveries. Check the session log and reconcile before restarting." with title "Harnessy community publication stopped"']);
	assert.equal(options.shell, false);
	assert.equal(options.timeout, 2_000);
	assert.equal(options.killSignal, "SIGKILL");
	process.stderr.write("FIXTURE_COMMUNITY_STOP_NOTIFICATION\n");
	completed(new Error("PRIVATE_NOTIFICATION_FAILURE"));
};
syncBuiltinESMExports();
