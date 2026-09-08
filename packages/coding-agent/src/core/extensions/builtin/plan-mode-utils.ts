/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Composition, redirection, and expansion make a command allowlist
// ambiguous. Reject them instead of trying to validate a shell program.
const UNSAFE_SHELL_SYNTAX_PATTERN = /[\r\n;&|`<>$]/;

const ALWAYS_READ_ONLY_COMMANDS = new Set([
	"cal",
	"cat",
	"df",
	"du",
	"echo",
	"eza",
	"free",
	"grep",
	"head",
	"id",
	"jq",
	"ls",
	"printenv",
	"printf",
	"ps",
	"pwd",
	"stat",
	"tail",
	"type",
	"uname",
	"uptime",
	"wc",
	"whereis",
	"whoami",
]);

const FIND_WRITE_ACTIONS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-ok",
	"-okdir",
]);

function splitShellWords(command: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const character of command.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"') {
			if (quote === character) quote = undefined;
			else if (quote === undefined) quote = character;
			else current += character;
			continue;
		}
		if (/\s/.test(character) && quote === undefined) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		// Unquoted glob and brace expansion can turn a validated operand into
		// an option such as `-oFILE` after the shell expands it.
		if (quote === undefined && /[*?[{~]/.test(character)) return undefined;
		current += character;
	}

	if (escaped || quote !== undefined) return undefined;
	if (current) words.push(current);
	return words;
}

function hasOption(words: string[], longOption: string, shortOption?: string): boolean {
	return words.some((word) => {
		if (word === longOption || word.startsWith(`${longOption}=`)) return true;
		if (shortOption === undefined || !word.startsWith("-") || word.startsWith("--")) return false;
		return word.slice(1).includes(shortOption.slice(1));
	});
}

function isSafeGitCommand(words: string[]): boolean {
	const subcommand = words[1]?.toLowerCase();
	const args = words.slice(2);

	if (subcommand === "status") return true;
	if (subcommand === "log" || subcommand === "diff" || subcommand === "show") {
		return !hasOption(args, "--output", "-o") && !args.includes("--ext-diff") && !args.includes("--textconv");
	}
	if (subcommand === "branch") {
		const safeOptions = new Set([
			"--all",
			"--list",
			"--remotes",
			"--show-current",
			"--verbose",
			"-a",
			"-r",
			"-v",
			"-vv",
		]);
		return args.every((arg) => safeOptions.has(arg));
	}
	if (subcommand === "remote") return args.length === 0 || (args.length === 1 && args[0] === "-v");
	if (subcommand === "config") return args.length >= 2 && args[0] === "--get";
	return subcommand === "ls-files" || subcommand === "ls-tree";
}

export function isSafeCommand(command: string): boolean {
	if (UNSAFE_SHELL_SYNTAX_PATTERN.test(command)) return false;
	const words = splitShellWords(command);
	if (!words || words.length === 0) return false;

	const executable = words[0].toLowerCase();
	const args = words.slice(1);
	if (ALWAYS_READ_ONLY_COMMANDS.has(executable)) return true;
	if (executable === "git") return isSafeGitCommand(words);
	if (executable === "find") return !args.some((arg) => FIND_WRITE_ACTIONS.has(arg.toLowerCase()));
	if (executable === "date") return !hasOption(args, "--set", "-s");
	if (executable === "tree") return !hasOption(args, "--output", "-o");
	if (executable === "rg") {
		return !hasOption(args, "--pre") && !hasOption(args, "--hostname-bin");
	}
	if (executable === "fd") {
		return !hasOption(args, "--exec", "-x") && !hasOption(args, "--exec-batch", "-X");
	}
	if (executable === "node") return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
	if (executable === "python" || executable === "python3") {
		return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
	}
	return false;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
