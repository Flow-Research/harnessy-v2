/** Interpreter options that may precede a script or module without supplying inline code. */
const LAUNCH_OPTIONS = new Set(["-u", "-B", "-E", "-s", "-S", "-I", "-O", "-OO", "-b", "-bb", "-d", "-q", "-v", "-x"]);
/** Interpreter options whose value is the next token and is never code to run. */
const LAUNCH_OPTIONS_WITH_VALUE = new Set([
	"-W",
	"-X",
	"--check-hash-based-pycs",
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"--conditions",
	"-C",
	"--env-file",
	"--title",
]);
/** Options that supply the program as inline text; nothing after them is a launched program. */
const INLINE_CODE_OPTION = /^(?:-[ceip]|--(?:eval|print|command)(?:=.*)?)$/u;
const INTERPRETER = /^(?:node|python[\d.]*|bun|deno)$/iu;
const SCRIPT_EXTENSION = /\.(?:[cm]?js|py)$/u;
/** Launched scripts known to dispatch a subcommand: the Harnessy CLI entry points. */
const DISPATCHING_SCRIPT = /(?:^|\/)(?:harnessy|hsy)$|(?:@harnessy\/core|harnessy-core)\/dist\/cli\.js$/u;

const commandName = (token: string) => (token.split("/").at(-1) ?? "").replace(SCRIPT_EXTENSION, "");

interface Launched {
	/** Token position in the command line. */
	readonly position: number;
	readonly token: string;
	readonly name: string;
	readonly module: boolean;
}

/**
 * The executable, then the one script path or `-m` module an interpreter starts.
 * Interpreter options before it are skipped, including options with a separate
 * value (`-W ignore`, `-r ./hook.js`). `-c`/`-e` inline code, a non-path token or
 * anything after the launched script ends the prefix: later text is an argument,
 * not a launched program.
 */
const launchPrefix = (tokens: ReadonlyArray<string>): ReadonlyArray<Launched> => {
	const executable = tokens[0];
	if (executable === undefined) return [];
	const prefix: Launched[] = [{ position: 0, token: executable, name: commandName(executable), module: false }];
	if (!INTERPRETER.test(commandName(executable))) return prefix;
	for (let position = 1; position < tokens.length; position++) {
		const token = tokens[position] ?? "";
		if (INLINE_CODE_OPTION.test(token)) break;
		if (LAUNCH_OPTIONS.has(token)) continue;
		if (LAUNCH_OPTIONS_WITH_VALUE.has(token)) {
			position++;
			continue;
		}
		if (token === "-m") {
			const module = tokens[position + 1];
			if (module !== undefined) prefix.push({ position: position + 1, token: module, name: module, module: true });
			break;
		}
		// Attached values (`-Wignore`, `-Xdev`) and `--option=value` forms carry no inline code.
		if (/^-[WX]./u.test(token) || /^--[\w-]+=/u.test(token)) continue;
		if (token.includes("/") && !token.startsWith("-"))
			prefix.push({ position, token, name: commandName(token), module: false });
		break;
	}
	return prefix;
};

/**
 * Whether an observed process command line runs `words` as its own command,
 * rather than mentioning them inside another command's arguments.
 *
 * Accepted shapes: `/path/jarvis …`, `<interpreter> /path/jarvis …`,
 * `<interpreter> -m jarvis …` and a Harnessy CLI entry point dispatching the
 * command (`<interpreter> /path/@harnessy/core/dist/cli.js jarvis …`), with
 * interpreter options that cannot carry inline code. Shells, search tools,
 * agents, other scripts and `-c`/`-e` programs that merely contain the words
 * are not invocations. Bounded known-process evidence, not protection from
 * arbitrary same-UID code.
 */
export const invokesCommand = (commandLine: string, words: ReadonlyArray<string>): boolean => {
	const [program, ...rest] = words;
	if (program === undefined) return false;
	const tokens = commandLine.trim().split(/\s+/u);
	const followedBy = (position: number) => rest.every((word, offset) => tokens[position + 1 + offset] === word);
	const prefix = launchPrefix(tokens);
	for (const { position, name, module } of prefix) {
		const named = module ? name === program || name.startsWith(`${program}.`) : name === program;
		if (named && followedBy(position)) return true;
	}
	// A Harnessy CLI script dispatching a subcommand: `node /path/@harnessy/core/dist/cli.js jarvis …`.
	const last = prefix.at(-1);
	if (prefix.length < 2 || last === undefined || last.module || !DISPATCHING_SCRIPT.test(last.token)) return false;
	return tokens[last.position + 1] === program && followedBy(last.position + 1);
};

/** The executable and the script path or module it launched, as observed. */
export const launchedPrograms = (commandLine: string): ReadonlyArray<string> =>
	launchPrefix(commandLine.trim().split(/\s+/u)).map(({ token }) => token);
