import { createHash } from "node:crypto";

import {
	definePlugin,
	IntegrationSlug,
	type ToolDef,
	type ToolInvocationCredential,
	ToolName,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import type { Layer } from "effect/Layer";
import type { HttpClient } from "effect/unstable/http";

import { googleMeetingBatchRequests, renderMeetingMarkdown } from "../meeting-publication/markdown.ts";
import { revalidateMeetingPublicationMutation } from "../meeting-publication/mutation-guard.ts";
import {
	authorizationFailure,
	checkpointFailure,
	configFailure,
	credentialFailure,
	duplicateFailure,
	executeMeetingJson,
	identityFailure,
	inputFailure,
	type MeetingProviderTransportConfig,
	type ResolvedMeetingProviderTransport,
	resolveMeetingProviderTransport,
	safeToolResult,
	scopeFailure,
} from "../meeting-publication/transport.ts";

export const GOOGLE_MEETING_INTEGRATION = "google-meeting-publication";
export const GOOGLE_MEETING_AUTH_TEMPLATE = "google-drive-file";
export const GOOGLE_MEETING_TEST_AUTH_TEMPLATE = "google-drive-file-test-token";
export const GOOGLE_MEETING_PREFLIGHT_TOOL = "preflight";
export const GOOGLE_MEETING_UPSERT_TOOL = "upsert";
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const integration = IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION);
const EmptyObject = Schema.Struct({});
const GooglePreflightInput = Schema.Struct({ expectedOwnerEmail: Schema.String });
const GoogleUpsertInput = Schema.Struct({
	itemId: Schema.String,
	sourceHash: Schema.String,
	title: Schema.String,
	meetingDate: Schema.String,
	markdown: Schema.String,
	existingDocId: Schema.NullOr(Schema.String),
	expectedOwnerEmail: Schema.String,
	folderPath: Schema.String,
});

const AboutResponse = Schema.Struct({ user: Schema.Struct({ emailAddress: Schema.String }) });
const DriveFile = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	mimeType: Schema.String,
	parents: Schema.Array(Schema.String),
	appProperties: Schema.Record(Schema.String, Schema.String),
	trashed: Schema.Boolean,
});
const DriveFilesResponse = Schema.Struct({ files: Schema.Array(DriveFile) });
const IdResponse = Schema.Struct({ id: Schema.String });
const DocumentResponse = Schema.Struct({
	body: Schema.Struct({ content: Schema.Array(Schema.Struct({ endIndex: Schema.optional(Schema.Number) })) }),
});
const Permission = Schema.Struct({
	id: Schema.optional(Schema.String),
	type: Schema.String,
	role: Schema.String,
});
const PermissionsResponse = Schema.Struct({ permissions: Schema.Array(Permission) });

const toJsonSchema = <S extends Schema.Top>(schema: S): unknown => Schema.toJsonSchemaDocument(schema).schema;

const tools: ReadonlyArray<ToolDef> = [
	{
		name: ToolName.make(GOOGLE_MEETING_PREFLIGHT_TOOL),
		description: "Verify the connected Google identity for meeting publication without mutating Drive.",
		inputSchema: toJsonSchema(GooglePreflightInput),
	},
	{
		name: ToolName.make(GOOGLE_MEETING_UPSERT_TOOL),
		description: "Create or replace one approved meeting note in its stable Google document.",
		inputSchema: toJsonSchema(GoogleUpsertInput),
		annotations: {
			requiresApproval: true,
			approvalDescription: "Approve publishing this already-reviewed meeting note to Google Docs?",
		},
	},
];

const safeId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/u.test(value);
const safeEmail = (value: string) =>
	value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const safeFolderPath = (value: string) => {
	const parts = value.split("/").map((part) => part.trim());
	return (
		parts.length > 0 &&
		parts.length <= 16 &&
		parts.every(
			(part) =>
				part.length > 0 &&
				part.length <= 128 &&
				part !== "." &&
				part !== ".." &&
				!/[\u0000-\u001f\u007f]/u.test(part),
		)
	);
};

const validPreflightInput = (input: typeof GooglePreflightInput.Type) => safeEmail(input.expectedOwnerEmail.trim());
const validUpsertInput = (input: typeof GoogleUpsertInput.Type, maxMarkdownBytes: number) =>
	safeId(input.itemId) &&
	/^[0-9a-f]{64}$/u.test(input.sourceHash) &&
	/^\d{4}-\d{2}-\d{2}$/u.test(input.meetingDate) &&
	input.title.trim().length > 0 &&
	Buffer.byteLength(input.title, "utf8") <= 512 &&
	!/[\u0000-\u001f\u007f]/u.test(input.title) &&
	Buffer.byteLength(input.markdown, "utf8") <= maxMarkdownBytes &&
	(input.existingDocId === null || safeId(input.existingDocId)) &&
	validPreflightInput(input) &&
	safeFolderPath(input.folderPath);

const decodeInput = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, args: unknown) =>
	Schema.decodeUnknownEffect(schema)(args).pipe(Effect.mapError(() => inputFailure()));

const tokenFrom = (credential: ToolInvocationCredential) => {
	const token = credential.value;
	return token === null || token.length === 0 || token.length > 16_384
		? Effect.fail(credentialFailure())
		: Effect.succeed(token);
};

const ensureScope = (credential: ToolInvocationCredential) =>
	credential.grantedScopes !== undefined && !credential.grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)
		? Effect.fail(scopeFailure())
		: Effect.void;

const url = (base: string, path: string, params: Readonly<Record<string, string>> = {}) => {
	const value = new URL(`${base}${path}`);
	for (const [key, entry] of Object.entries(params)) value.searchParams.set(key, entry);
	return value.toString();
};

interface GoogleRequestContext {
	readonly token: string;
	readonly transport: ResolvedMeetingProviderTransport;
	readonly httpClientLayer: Layer<HttpClient.HttpClient>;
}

const googleRequest = <S extends Schema.Top & { readonly DecodingServices: never }>(
	context: GoogleRequestContext,
	method: "GET" | "POST" | "PATCH",
	base: "drive" | "docs",
	path: string,
	schema: S,
	options: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
) =>
	(method === "GET"
		? Effect.void
		: revalidateMeetingPublicationMutation.pipe(Effect.mapError(() => authorizationFailure()))
	).pipe(
		Effect.flatMap(() =>
			executeMeetingJson({
				method,
				url: url(
					base === "drive" ? context.transport.googleDriveBaseUrl : context.transport.googleDocsBaseUrl,
					path,
					options.params,
				),
				token: context.token,
				...(options.body === undefined ? {} : { body: options.body }),
				schema,
				transport: context.transport,
				httpClientLayer: context.httpClientLayer,
			}),
		),
	);

const verifyOwner = Effect.fn("GoogleMeetingPublication.verifyOwner")(function* (
	context: GoogleRequestContext,
	expectedOwnerEmail: string,
) {
	const response = yield* googleRequest(context, "GET", "drive", "/about", AboutResponse, {
		params: { fields: "user(emailAddress)" },
	});
	if (response.user.emailAddress !== expectedOwnerEmail.trim()) {
		return yield* identityFailure();
	}
	return true;
});

const escapeDriveQuery = (value: string) => value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");

const validateFolder = (file: typeof DriveFile.Type, parent: string, key: string) =>
	file.mimeType === "application/vnd.google-apps.folder" &&
	file.trashed === false &&
	file.parents.length === 1 &&
	file.parents[0] === parent &&
	file.appProperties.harnessyMeetingFolderKey === key;

const findFolder = Effect.fn("GoogleMeetingPublication.findFolder")(function* (
	context: GoogleRequestContext,
	parent: string,
	key: string,
) {
	const q = [
		`appProperties has { key='harnessyMeetingFolderKey' and value='${escapeDriveQuery(key)}' }`,
		`'${escapeDriveQuery(parent)}' in parents`,
		"mimeType='application/vnd.google-apps.folder'",
		"trashed=false",
	].join(" and ");
	const response = yield* googleRequest(context, "GET", "drive", "/files", DriveFilesResponse, {
		params: { q, fields: "files(id,name,mimeType,parents,appProperties,trashed)", pageSize: "2" },
	});
	if (response.files.length > 1) return yield* duplicateFailure();
	const found = response.files[0];
	if (found === undefined) return null;
	if (!validateFolder(found, parent, key)) return yield* checkpointFailure();
	return found.id;
});

const ensureFolderPath = Effect.fn("GoogleMeetingPublication.ensureFolderPath")(function* (
	context: GoogleRequestContext,
	parts: ReadonlyArray<string>,
) {
	let parent = "root";
	let logicalPath = "";
	for (const rawName of parts) {
		const name = rawName.trim();
		logicalPath = `${logicalPath}/${name}`;
		const key = `sha256:${createHash("sha256").update(logicalPath).digest("hex")}`;
		let folderId = yield* findFolder(context, parent, key);
		if (folderId === null) {
			const created = yield* googleRequest(context, "POST", "drive", "/files", IdResponse, {
				params: { fields: "id" },
				body: {
					name,
					mimeType: "application/vnd.google-apps.folder",
					parents: [parent],
					appProperties: { harnessyMeetingFolderKey: key },
				},
			});
			if (!safeId(created.id)) return yield* checkpointFailure();
			folderId = created.id;
		}
		parent = folderId;
	}
	return parent;
});

const validateDocument = (file: typeof DriveFile.Type, folderId: string, itemId: string) =>
	file.mimeType === "application/vnd.google-apps.document" &&
	file.trashed === false &&
	file.parents.length === 1 &&
	file.parents[0] === folderId &&
	file.appProperties.harnessyMeetingItemId === itemId;

const getDocumentCheckpoint = Effect.fn("GoogleMeetingPublication.getDocumentCheckpoint")(function* (
	context: GoogleRequestContext,
	docId: string,
	folderId: string,
	itemId: string,
) {
	const file = yield* googleRequest(context, "GET", "drive", `/files/${encodeURIComponent(docId)}`, DriveFile, {
		params: { fields: "id,name,mimeType,parents,appProperties,trashed" },
	});
	if (!validateDocument(file, folderId, itemId) || file.id !== docId) return yield* checkpointFailure();
	return file.id;
});

const findDocument = Effect.fn("GoogleMeetingPublication.findDocument")(function* (
	context: GoogleRequestContext,
	folderId: string,
	itemId: string,
) {
	const q = [
		`appProperties has { key='harnessyMeetingItemId' and value='${escapeDriveQuery(itemId)}' }`,
		`'${escapeDriveQuery(folderId)}' in parents`,
		"mimeType='application/vnd.google-apps.document'",
		"trashed=false",
	].join(" and ");
	const response = yield* googleRequest(context, "GET", "drive", "/files", DriveFilesResponse, {
		params: { q, fields: "files(id,name,mimeType,parents,appProperties,trashed)", pageSize: "2" },
	});
	if (response.files.length > 1) return yield* duplicateFailure();
	const found = response.files[0];
	if (found === undefined) return null;
	if (!validateDocument(found, folderId, itemId)) return yield* checkpointFailure();
	return found.id;
});

const documentEndIndex = (document: typeof DocumentResponse.Type): number => {
	const final = document.body.content.at(-1)?.endIndex;
	return final === undefined || !Number.isSafeInteger(final) || final < 1 ? 1 : final;
};

const publish = Effect.fn("GoogleMeetingPublication.publish")(function* (
	input: typeof GoogleUpsertInput.Type,
	credential: ToolInvocationCredential,
	transport: ResolvedMeetingProviderTransport,
	httpClientLayer: Layer<HttpClient.HttpClient>,
) {
	if (!validUpsertInput(input, transport.maxMarkdownBytes)) return yield* inputFailure();
	yield* ensureScope(credential);
	const token = yield* tokenFrom(credential);
	const context = { token, transport, httpClientLayer } satisfies GoogleRequestContext;
	// Identity is deliberately rechecked inside every mutation, before the first write.
	yield* verifyOwner(context, input.expectedOwnerEmail);
	const [year, month] = input.meetingDate.split("-");
	if (year === undefined || month === undefined) return yield* inputFailure();
	const folderId = yield* ensureFolderPath(context, [...input.folderPath.split("/"), year, month]);
	let docId =
		input.existingDocId === null
			? yield* findDocument(context, folderId, input.itemId)
			: yield* getDocumentCheckpoint(context, input.existingDocId, folderId, input.itemId);
	const appProperties = {
		harnessyMeetingItemId: input.itemId,
		harnessyMeetingSourceHash: input.sourceHash,
	};
	if (docId === null) {
		const created = yield* googleRequest(context, "POST", "drive", "/files", IdResponse, {
			params: { fields: "id" },
			body: {
				name: input.title.trim(),
				mimeType: "application/vnd.google-apps.document",
				parents: [folderId],
				appProperties,
			},
		});
		if (!safeId(created.id)) return yield* checkpointFailure();
		docId = created.id;
	} else {
		const updated = yield* googleRequest(
			context,
			"PATCH",
			"drive",
			`/files/${encodeURIComponent(docId)}`,
			IdResponse,
			{
				params: { fields: "id" },
				body: { name: input.title.trim(), appProperties },
			},
		);
		if (updated.id !== docId) return yield* checkpointFailure();
	}
	const document = yield* googleRequest(
		context,
		"GET",
		"docs",
		`/documents/${encodeURIComponent(docId)}`,
		DocumentResponse,
	);
	const rendered = renderMeetingMarkdown(input.markdown);
	yield* googleRequest(context, "POST", "docs", `/documents/${encodeURIComponent(docId)}:batchUpdate`, EmptyObject, {
		body: { requests: googleMeetingBatchRequests(rendered, documentEndIndex(document)) },
	});
	const permissions = yield* googleRequest(
		context,
		"GET",
		"drive",
		`/files/${encodeURIComponent(docId)}/permissions`,
		PermissionsResponse,
		{ params: { fields: "permissions(id,type,role)" } },
	);
	if (!permissions.permissions.some((permission) => permission.type === "anyone" && permission.role === "reader")) {
		const createdPermission = yield* googleRequest(
			context,
			"POST",
			"drive",
			`/files/${encodeURIComponent(docId)}/permissions`,
			Permission,
			{
				params: { sendNotificationEmail: "false", fields: "id,type,role" },
				body: { type: "anyone", role: "reader", allowFileDiscovery: false },
			},
		);
		if (createdPermission.type !== "anyone" || createdPermission.role !== "reader") {
			return yield* checkpointFailure();
		}
	}
	return { docId, docUrl: `https://docs.google.com/document/d/${docId}/view` };
});

export const googleMeetingPublicationPlugin = (
	options: { readonly transport?: MeetingProviderTransportConfig } = {},
) => {
	const transport = resolveMeetingProviderTransport(options.transport);
	const expectedTemplate =
		options.transport?.kind === "test-loopback" ? GOOGLE_MEETING_TEST_AUTH_TEMPLATE : GOOGLE_MEETING_AUTH_TEMPLATE;
	return definePlugin(() => ({
		id: "harnessy-google-meeting-publication" as const,
		storage: () => ({}),
		extension: (ctx) => ({
			register: Effect.fn("GoogleMeetingPublication.register")(function* () {
				yield* ctx.core.integrations.register({
					slug: integration,
					name: "Google meeting publication",
					description: "Least-privilege Google Drive and Docs publication for approved meeting notes.",
					config: {},
					canRemove: false,
					canRefresh: true,
				});
			}),
		}),
		resolveTools: () => Effect.succeed({ tools }),
		validateToolArgs: ({ args, toolRow }) =>
			Effect.gen(function* () {
				if (transport === null) return yield* configFailure();
				if (String(toolRow.name) === GOOGLE_MEETING_UPSERT_TOOL) {
					const input = yield* decodeInput(GoogleUpsertInput, args);
					if (!validUpsertInput(input, transport.maxMarkdownBytes)) return yield* inputFailure();
					return;
				}
				if (String(toolRow.name) === GOOGLE_MEETING_PREFLIGHT_TOOL) {
					const input = yield* decodeInput(GooglePreflightInput, args);
					if (!validPreflightInput(input)) return yield* inputFailure();
					return;
				}
				return yield* inputFailure();
			}),
		invokeTool: ({ args, credential, ctx, toolRow }) =>
			safeToolResult(
				Effect.gen(function* () {
					if (transport === null) return yield* configFailure();
					if (String(credential.template) !== expectedTemplate) return yield* credentialFailure();
					if (String(toolRow.name) === GOOGLE_MEETING_PREFLIGHT_TOOL) {
						const input = yield* decodeInput(GooglePreflightInput, args);
						if (!validPreflightInput(input)) return yield* inputFailure();
						yield* ensureScope(credential);
						const token = yield* tokenFrom(credential);
						return yield* verifyOwner(
							{ token, transport, httpClientLayer: ctx.httpClientLayer },
							input.expectedOwnerEmail,
						);
					}
					if (String(toolRow.name) === GOOGLE_MEETING_UPSERT_TOOL) {
						const input = yield* decodeInput(GoogleUpsertInput, args);
						return yield* publish(input, credential, transport, ctx.httpClientLayer);
					}
					return yield* inputFailure();
				}),
			),
		describeAuthMethods: () => {
			const oauth = {
				id: GOOGLE_MEETING_AUTH_TEMPLATE,
				label: "Google Drive file access",
				kind: "oauth" as const,
				template: GOOGLE_MEETING_AUTH_TEMPLATE,
				placements: [{ carrier: "header" as const, name: "Authorization", prefix: "Bearer " }],
				oauth: {
					authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
					tokenUrl: "https://oauth2.googleapis.com/token",
					scopes: [GOOGLE_DRIVE_FILE_SCOPE],
				},
			};
			if (options.transport?.kind !== "test-loopback") return [oauth];
			return [
				oauth,
				{
					id: GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
					label: "Google test access token",
					kind: "apikey" as const,
					template: GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
					placements: [
						{ carrier: "header" as const, name: "Authorization", prefix: "Bearer ", variable: "token" },
					],
				},
			];
		},
	}))();
};
