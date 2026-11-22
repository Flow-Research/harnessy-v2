import { createHash } from "node:crypto";

const modules = {
	"local-status": [
		"engineering/command-workload",
		"engineering/store",
		"engineering/contracts",
		"engineering/host-contract",
	],
	"preparation-plan": [
		"engineering/command-workload",
		"cli/work",
		"errors",
		"hsy-runtime-env",
		"notifications/config",
		"notifications/desktop",
		"notifications/notifier",
		"notifications/remote",
		"notifications/sanitize",
		"work/deps",
		"work/execution-policy",
		"work/github-app",
		"work/logic",
		"work/notifications",
		"work/run",
		"work/task-content",
		"work/zip",
	],
} as const;

// Reviewed semantic sources and fixed emitted forms. Changes require a reviewed profile revision.
// No runtime compilation or caller-supplied manifest is supported.
const reviewed: {
	readonly revision: string;
	readonly node: string;
	readonly sqlite: string;
	readonly generator: Readonly<Record<string, string>>;
	readonly files: Readonly<Record<string, { readonly ts: string; readonly js: string }>>;
} = /* REVIEWED_ORACLE_START */ {
	revision: "harnessy.engineering.command-oracle.v1.r6",
	node: "22.22.2",
	sqlite: "3.51.2",
	generator: {
		compilerVersion: "Version 7.0.0-dev.20260120.1",
		nativeCompilerSha256: "be895ec2d5f4836aceb530f3be5b675ac1fcb1637f4cc8975c27e4e19b820ebc",
		coreConfigSha256: "5d1d8e87055b879ea8525af3d2061952705dac28f2a79450cc86b138828eff3f",
		baseConfigSha256: "2db314b2e40a37a94e7b1da0af3883b7dd0ef2a8abc4b22138ae1ceb7cc2375f",
		lockSha256: "d6959c4695563298261dd2d2451d0ea6f42690f9290820ad4f486a6d9b7fc221",
	},
	files: {
		"cli/work": {
			ts: "785a4a8ff4ac00b21033f25646d3435934a5a6e22afbf8a94197ffe806eb0caa",
			js: "3f40a145cfd67086fcb86e35eb9c9a5e968ad645cb33bd9e4ba9578ea91d3055",
		},
		"engineering/command-workload": {
			ts: "5767b54e0d9b37cfd549f3a9d156cb262508336fc74e3db608075c0c1455af58",
			js: "80a3e60e505583ca193e521f17777af37ac2769edcdbdec89a948f677562d0fc",
		},
		"engineering/contracts": {
			ts: "73ca4dcda1145320e5af32e0e1a2bede69c7a78d8a9c4d63d0483b07b13c8523",
			js: "a541b08909aba984d2886db802eb3dd5dfd4209eb81a542db44f1385ce735334",
		},
		"engineering/host-contract": {
			ts: "0206c29fa6cd4e85aa9267a566bee60915b804068dfb5a35676d9eea4271d38f",
			js: "858e0146c84b1e0efd3bca53c4c7ba83d5a838448ddedeef1b06625f83e84f6c",
		},
		"engineering/store": {
			ts: "0285f1f3cf4851111300f939157cfb7d32cb0bb9423c98be7124f2751002136d",
			js: "616ac93e0551d81a24d8a2a2b809d8cc6408fb4a61d0c279cf5917b063a3caa9",
		},
		errors: {
			ts: "e063578d3934955a6a3107dffca7b66f22e2a3dd6a70cf01721c32291d26d96c",
			js: "4072a06ee87eb3359724f4860acc1ca58cbc502d6bb16964d69bc471286908b8",
		},
		"hsy-runtime-env": {
			ts: "1bb1fe2ba3bb4b1191c08a43e0611833b52fd03afc40208b4ccdd0a8ab8b32e1",
			js: "029b762f1ab996f17f791fd0999211643818f1fd8e4a2bcc187b2cd91d4006fe",
		},
		"notifications/config": {
			ts: "c288db8948e7873490e3a5bcdbf6ab9dd03d4240d1bf16f95a231bbb7e01b031",
			js: "596282475b37b8e766ace14a777c4748fcc318ffe7ad5c380900f66024b68904",
		},
		"notifications/desktop": {
			ts: "8d924e8452c9723127288cd14efa936acd06b31de2f94cad57116092320ba386",
			js: "440bf8e76481dc6bfdd9e64c7605730aae88ab576072d1946113c4cf4a0ee95d",
		},
		"notifications/notifier": {
			ts: "33b656c80cb4e802c7f4f43de064309c82d2fd3b02864821ad31e5381c5b6211",
			js: "326d2f5fcfbb381016bbb1474ba5e3d1c470e058d5ce5e645ef5226094e78db9",
		},
		"notifications/remote": {
			ts: "278845f8b7181adf2025235d5c524d88502c1df5046d8e69a6496cd388b09138",
			js: "5ba458670719ce2aba4a5192e93b52d84a57bf26b37595fb3e9f0948e94a9f37",
		},
		"notifications/sanitize": {
			ts: "584fbe9c611fb8b8cab81b797396367cd2ea1a518974a369aa51b7c2fa027f19",
			js: "30c9e4099a29c6e51db71f43e2c6a094d5b50f4109ba253748fd387888d51a8c",
		},
		"work/deps": {
			ts: "b29dac87f7495f79a71c5960c0b6f7087d4568d9cc8dde3d82f09872949ec4dd",
			js: "9e0534c9f6fee43b8c2095e18ec3bc2f0a24e9a965990ec7f2df725d908dc878",
		},
		"work/execution-policy": {
			ts: "1e29e5cab3acf139b7d5b2536bff9455ca2504f5f5a9c3831d326e12b4112685",
			js: "78c357c006c054ad3b78e69a8b100c065b0d1440a3d465581be49815b30bc9eb",
		},
		"work/github-app": {
			ts: "d0174a61b360f756ef8e7502b56d461431b85cfb362bcb24ac93f5ee8941a846",
			js: "fca5ef7bc555829f870f576518215388c9123689676e7c5e6740a2bad211c984",
		},
		"work/logic": {
			ts: "34f267acdc90df94ace0534d10af21abd2a346ad7c47821057657737124bc2d8",
			js: "546c260682e630542342db439cd1b0b9bb90aa124e66b182f41140a81b69d044",
		},
		"work/notifications": {
			ts: "02cfaa74e77c6c178bc079db91380548747b8eb81baab37f0b8e692380bb13bf",
			js: "d2c08f98e56b34926265084fce70144398b0eaf75eaf9f7ed5569d84f7e13f75",
		},
		"work/run": {
			ts: "25b7e1043f4290e13f0b0a4c6a47ff16913e139f08f8c7251f0d762e819059f2",
			js: "43eea215d71c8b7fe379944ddd148d3b6acb47b3768f9470f89bcc67e9795191",
		},
		"work/task-content": {
			ts: "cf72399760f50f76f1363b086042283b573bd53e8e7181fd90d68f154bf270f5",
			js: "ec89fcab0328d93295fddffba4577107baccb7cf7a61d3928eeb352729f0f8bb",
		},
		"work/zip": {
			ts: "e05e7deea4effbe00125530f8f56027c63d601554c99f434182b963bed9cd781",
			js: "6808bd19a5f7b5cca51673dc950bc63d40ed2f180423da21fc329337e4854ee8",
		},
	},
} /* REVIEWED_ORACLE_END */;

export const REVIEWED_COMMAND_ORACLE_DIGEST = createHash("sha256")
	.update(JSON.stringify({ modules, reviewed }))
	.digest("hex");

/** Only the checked-in reviewed identities can authorize these fixed fixture oracles. */
export function reviewedCommandOracle(profile: "local-status" | "preparation-plan", form: "ts" | "js") {
	if (process.versions.node !== reviewed.node || process.versions.sqlite !== reviewed.sqlite)
		throw new Error(
			`Unsupported command oracle runtime: requires Node ${reviewed.node} with SQLite ${reviewed.sqlite}`,
		);
	for (const key of ["nativeCompilerSha256", "coreConfigSha256", "baseConfigSha256", "lockSha256"])
		if (!/^[a-f0-9]{64}$/.test(reviewed.generator[key] ?? ""))
			throw new Error("Reviewed oracle build identity is missing");
	if (typeof reviewed.generator.compilerVersion !== "string" || reviewed.generator.compilerVersion.length < 1)
		throw new Error("Reviewed oracle compiler version is missing");
	if (!Object.hasOwn(modules, profile)) throw new Error("Unsupported reviewed oracle profile");
	const files = modules[profile].map((name) => {
		const digest = reviewed.files[name]?.[form];
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
			throw new Error("Reviewed command oracle identity is missing");
		return Object.freeze({ name, form, digest });
	});
	return Object.freeze({
		revision: reviewed.revision,
		digest: REVIEWED_COMMAND_ORACLE_DIGEST,
		files: Object.freeze(files),
	});
}
