/** Interpreter options that may precede a script or module without supplying inline code. */
const LAUNCH_OPTIONS = new Set(["-u", "-B", "-E", "-s", "-S", "-I", "-O", "-OO"]);
const INTERPRETER = /^(?:node|python[\d.]*|bun|deno)$/iu;
const SCRIPT_EXTENSION = /\.(?:[cm]?js|py)$/u;

const commandName = (token: string) => (token.split("/").at(-1) ?? "").replace(SCRIPT_EXTENSION, "");

interface Launched {
	/** Token position in the command line. */
	readonly position: number;
	readonly token: string;
	readonly name: string;
	readonly module: boolean;
}

/**
 * The executable, then any script paths or `-m` module an interpreter starts.
 * Anything else, such as `-c`/`-e` inline code or a subcommand, ends the prefix:
 * text after it is an argument, not a launched program.
 */
const launchPrefix = (tokens: ReadonlyArray<string>): ReadonlyArray<Launched> => {
	const executable = tokens[0];
	if (executable === undefined) return [];
	const prefix: Launched[] = [{ position: 0, token: executable, name: commandName(executable), module: false }];
	if (!INTERPRETER.test(commandName(executable))) return prefix;
	for (let position = 1; position < tokens.length; position++) {
		const token = tokens[position] ?? "";
		if (LAUNCH_OPTIONS.has(token)) continue;
		if (token === "-m") {
			const module = tokens[position + 1];
			if (module !== undefined) prefix.push({ position: position + 1, token: module, name: module, module: true });
			break;
		}
		if (!token.includes("/") || token.startsWith("-")) break;
		prefix.push({ position, token, name: commandName(token), module: false });
	}
	return prefix;
};

/**
 * Whether an observed process command line runs `words` as its own command,
 * rather than mentioning them inside another command's arguments.
 *
 * Accepted shapes: `/path/jarvis …`, `<interpreter> /path/jarvis …`,
 * `<interpreter> -m jarvis …` and `<interpreter> /path/cli.js jarvis …`, with
 * interpreter options that cannot carry inline code. Shells, search tools,
 * agents and `-c`/`-e` programs that merely contain the words are not
 * invocations. Bounded known-process evidence, not protection from arbitrary
 * same-UID code.
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
	// A launched script dispatching a subcommand: `node /path/cli.js jarvis …`.
	const last = prefix.at(-1);
	if (prefix.length < 2 || last === undefined || last.module) return false;
	return tokens[last.position + 1] === program && followedBy(last.position + 1);
};

/** The executable and the script paths or module it launched, as observed. */
export const launchedPrograms = (commandLine: string): ReadonlyArray<string> =>
	launchPrefix(commandLine.trim().split(/\s+/u)).map(({ token }) => token);
