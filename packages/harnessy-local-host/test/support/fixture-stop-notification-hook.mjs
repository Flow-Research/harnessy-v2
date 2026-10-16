// Test-only preload: exercise the real CLI failure/finalizer path without sending
// desktop content. Only the fixed stop-alert OS invocation is substituted; all
// other subprocesses retain their real behavior and the external-network guard.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const original = childProcess.execFile;
childProcess.execFile = function (file, ...args) {
	if (file !== "/usr/bin/osascript") return original.call(this, file, ...args);
	const [argv, options, completed] = args;
	assert.deepEqual(argv, [
		"-e",
		'display notification "Meeting review and dispatch stopped. Do not retry uncertain deliveries. Check the session log and reconcile before restarting." with title "Harnessy meeting runtime stopped"',
	]);
	assert.equal(options.shell, false);
	assert.equal(options.timeout, 2_000);
	assert.equal(options.killSignal, "SIGKILL");
	process.stderr.write("FIXTURE_STOP_NOTIFICATION\n");
	completed(null);
};
syncBuiltinESMExports();
