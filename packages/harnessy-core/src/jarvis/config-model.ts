import { Schema, SchemaTransformation } from "effect";
import * as Effect from "effect/Effect";

const LegacyIntegerFromString = Schema.Trim.pipe(
	Schema.check(Schema.isPattern(/^[+-]?\d(?:_?\d)*(?:\.0+)?$/)),
	Schema.decodeTo(
		Schema.String,
		SchemaTransformation.transform({ decode: (value) => value.replaceAll("_", ""), encode: (value) => value }),
	),
	Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
);
const LegacyInteger = Schema.Union([Schema.Int, LegacyIntegerFromString, Schema.flip(Schema.BooleanFromBit)]);
const LegacyTrueString = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^(?:1|true|t|on|yes|y)$/i)),
	Schema.decodeTo(
		Schema.Literal(true),
		SchemaTransformation.transform({ decode: () => true as const, encode: () => "true" }),
	),
);
const LegacyFalseString = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^(?:0|false|f|off|no|n)$/i)),
	Schema.decodeTo(
		Schema.Literal(false),
		SchemaTransformation.transform({ decode: () => false as const, encode: () => "false" }),
	),
);
const LegacyBoolean = Schema.Union([Schema.Boolean, Schema.BooleanFromBit, LegacyTrueString, LegacyFalseString]);
const NullableString = Schema.NullOr(Schema.String);
const boundedInt = (minimum: number, maximum: number) =>
	Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum)));

export const JarvisBackend = Schema.Literals(["anytype", "notion"]);
export type JarvisBackend = typeof JarvisBackend.Type;

export class JarvisNotionConfig extends Schema.Class<JarvisNotionConfig>("JarvisNotionConfig")({
	workspaceId: Schema.String,
	taskDatabaseId: Schema.String,
	journalDatabaseId: Schema.String,
	propertyMappings: Schema.Record(Schema.String, Schema.String),
}) {}

export class JarvisAnytypeConfig extends Schema.Class<JarvisAnytypeConfig>("JarvisAnytypeConfig")({
	defaultSpaceId: Schema.NullOr(Schema.String),
}) {}

export class JarvisContentConfig extends Schema.Class<JarvisContentConfig>("JarvisContentConfig")({
	rootPath: Schema.NullOr(Schema.String),
	anytypeSpaceName: Schema.NullOr(Schema.String),
	anytypeRootCollection: Schema.String,
}) {}

export class JarvisAnalyticsConfig extends Schema.Class<JarvisAnalyticsConfig>("JarvisAnalyticsConfig")({
	enabled: Schema.Boolean,
	metricsFile: Schema.String,
}) {}

export class JarvisFathomAccountConfig extends Schema.Class<JarvisFathomAccountConfig>("JarvisFathomAccountConfig")({
	email: Schema.NullOr(Schema.String),
	apiKeyEnvVar: Schema.String,
	webhookSecretEnvVar: Schema.String,
	webhookId: Schema.NullOr(Schema.String),
	webhookDestinationUrl: Schema.NullOr(Schema.String),
}) {}

export class JarvisFathomConfig extends Schema.Class<JarvisFathomConfig>("JarvisFathomConfig")({
	defaultAccount: Schema.NullOr(Schema.String),
	accounts: Schema.Record(Schema.String, JarvisFathomAccountConfig),
}) {}

export class JarvisWhatsAppAccountConfig extends Schema.Class<JarvisWhatsAppAccountConfig>(
	"JarvisWhatsAppAccountConfig",
)({
	provider: Schema.Literal("meta"),
	phoneNumberId: Schema.NullOr(Schema.String),
	businessAccountId: Schema.NullOr(Schema.String),
	accessTokenEnvVar: Schema.String,
	appSecretEnvVar: Schema.String,
	verifyTokenEnvVar: Schema.String,
	apiVersion: Schema.String,
	webhookDestinationUrl: Schema.NullOr(Schema.String),
}) {}

export class JarvisWhatsAppConfig extends Schema.Class<JarvisWhatsAppConfig>("JarvisWhatsAppConfig")({
	defaultAccount: Schema.NullOr(Schema.String),
	accounts: Schema.Record(Schema.String, JarvisWhatsAppAccountConfig),
}) {}

const IsoDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)));
export const JarvisMeetingPublicationReviewHost = Schema.Literals(["127.0.0.1", "::1"]);
export type JarvisMeetingPublicationReviewHost = typeof JarvisMeetingPublicationReviewHost.Type;
/** Admits a worst-case URL-encoded 50,000-code-point note plus bounded review fields. */
export const JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES = 1_000_000;

/** Generic, secret-free configuration for the native meeting-publication domain. */
export class JarvisMeetingPublicationConfig extends Schema.Class<JarvisMeetingPublicationConfig>(
	"JarvisMeetingPublicationConfig",
)({
	enabled: Schema.Boolean,
	project: Schema.NullOr(Schema.String),
	sourcePath: Schema.NullOr(Schema.String),
	statePath: Schema.NullOr(Schema.String),
	backfillDays: boundedInt(1, 365),
	cutoverDate: Schema.NullOr(IsoDate),
	maxFileBytes: boundedInt(1, 100 * 1024 * 1024),
	maxFiles: boundedInt(1, 100_000),
	leaseSeconds: boundedInt(1, 86_400),
	reminderSeconds: boundedInt(60 * 60, 168 * 60 * 60),
	reviewHost: JarvisMeetingPublicationReviewHost,
	reviewPort: boundedInt(0, 65_535),
	reviewSessionSeconds: boundedInt(60, 86_400),
	reviewMaxSessions: boundedInt(1, 1_024),
	reviewMaxBodyBytes: boundedInt(256, JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES),
	googleOwnerEmail: Schema.NullOr(Schema.String),
	googleDriveFolder: Schema.NullOr(Schema.String),
	discordChannelId: Schema.NullOr(Schema.String),
}) {}

export class JarvisResolvedConfig extends Schema.Class<JarvisResolvedConfig>("JarvisResolvedConfig")({
	version: Schema.Int,
	activeBackend: JarvisBackend,
	anytype: JarvisAnytypeConfig,
	notion: Schema.NullOr(JarvisNotionConfig),
	content: JarvisContentConfig,
	analytics: JarvisAnalyticsConfig,
	fathom: JarvisFathomConfig,
	whatsapp: JarvisWhatsAppConfig,
	meetingPublication: JarvisMeetingPublicationConfig,
}) {}

const LegacyNotionConfig = Schema.Struct({
	workspace_id: Schema.String,
	task_database_id: Schema.String,
	journal_database_id: Schema.String,
	property_mappings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const LegacyAnytypeConfig = Schema.Struct({ default_space_id: Schema.optional(NullableString) });
const LegacyFathomAccountConfig = Schema.Struct({
	email: Schema.optional(NullableString),
	api_key_env_var: Schema.optional(Schema.String),
	webhook_secret_env_var: Schema.optional(Schema.String),
	webhook_id: Schema.optional(NullableString),
	webhook_destination_url: Schema.optional(NullableString),
});
const LegacyWhatsAppAccountConfig = Schema.Struct({
	provider: Schema.optional(Schema.Literal("meta")),
	phone_number_id: Schema.optional(NullableString),
	business_account_id: Schema.optional(NullableString),
	access_token_env_var: Schema.optional(Schema.String),
	app_secret_env_var: Schema.optional(Schema.String),
	verify_token_env_var: Schema.optional(Schema.String),
	api_version: Schema.optional(Schema.String),
	webhook_destination_url: Schema.optional(NullableString),
});
const LegacyMeetingPublicationConfig = Schema.Struct({
	enabled: Schema.optional(LegacyBoolean),
	project: Schema.optional(NullableString),
	source_path: Schema.optional(NullableString),
	state_path: Schema.optional(NullableString),
	backfill_days: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365))),
	),
	cutover_date: Schema.optional(Schema.NullOr(IsoDate)),
	max_file_bytes: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100 * 1024 * 1024))),
	),
	max_files: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))),
	),
	lease_seconds: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(86_400))),
	),
	reminder_hours: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(168))),
	),
	review_host: Schema.optional(JarvisMeetingPublicationReviewHost),
	review_port: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
	),
	review_session_seconds: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(60), Schema.isLessThanOrEqualTo(86_400))),
	),
	review_max_sessions: Schema.optional(
		LegacyInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_024))),
	),
	review_max_body_bytes: Schema.optional(
		LegacyInteger.pipe(
			Schema.check(
				Schema.isGreaterThanOrEqualTo(256),
				Schema.isLessThanOrEqualTo(JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES),
			),
		),
	),
	google_owner_email: Schema.optional(NullableString),
	google_drive_folder: Schema.optional(NullableString),
	discord_channel_id: Schema.optional(NullableString),
});
export const JarvisLegacyConfig = Schema.Struct({
	version: Schema.optional(LegacyInteger),
	active_backend: Schema.optional(JarvisBackend),
	backends: Schema.optional(
		Schema.Struct({
			anytype: Schema.optional(LegacyAnytypeConfig),
			notion: Schema.optional(Schema.NullOr(LegacyNotionConfig)),
		}),
	),
	content: Schema.optional(
		Schema.Struct({
			root_path: Schema.optional(NullableString),
			anytype_space_name: Schema.optional(NullableString),
			anytype_root_collection: Schema.optional(Schema.String),
		}),
	),
	analytics: Schema.optional(
		Schema.Struct({ enabled: Schema.optional(LegacyBoolean), metrics_file: Schema.optional(Schema.String) }),
	),
	fathom: Schema.optional(
		Schema.Struct({
			default_account: Schema.optional(NullableString),
			accounts: Schema.optional(Schema.Record(Schema.String, LegacyFathomAccountConfig)),
		}),
	),
	whatsapp: Schema.optional(
		Schema.Struct({
			default_account: Schema.optional(NullableString),
			accounts: Schema.optional(Schema.Record(Schema.String, LegacyWhatsAppAccountConfig)),
		}),
	),
	meeting_publication: Schema.optional(LegacyMeetingPublicationConfig),
});
export type JarvisLegacyConfig = typeof JarvisLegacyConfig.Type;

const LegacyNotionConfigOverride = Schema.Struct({
	workspace_id: Schema.optional(Schema.String),
	task_database_id: Schema.optional(Schema.String),
	journal_database_id: Schema.optional(Schema.String),
	property_mappings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const JarvisLegacyConfigOverride = Schema.Struct({
	...JarvisLegacyConfig.fields,
	backends: Schema.optional(
		Schema.Struct({
			anytype: Schema.optional(LegacyAnytypeConfig),
			notion: Schema.optional(Schema.NullOr(LegacyNotionConfigOverride)),
		}),
	),
});
export type JarvisLegacyConfigOverride = typeof JarvisLegacyConfigOverride.Type;

const defaultPropertyMappings = {
	priority: "Priority",
	due_date: "Due Date",
	tags: "Tags",
	done: "Done",
	title: "Name",
	date: "Date",
};

const mergeNamedRecords = <A extends object>(
	base: Readonly<Record<string, A>> | undefined,
	overrides: Readonly<Record<string, A>> | undefined,
): Record<string, A> =>
	Object.fromEntries(
		[...new Set([...Object.keys(base ?? {}), ...Object.keys(overrides ?? {})])].map((name) => [
			name,
			{ ...base?.[name], ...overrides?.[name] } as A,
		]),
	);

export const mergeJarvisLegacyConfig = Effect.fn("JarvisConfig.merge")(function* (
	base: JarvisLegacyConfig,
	overrides: JarvisLegacyConfigOverride,
) {
	const notionOverridePresent = overrides.backends !== undefined && "notion" in overrides.backends;
	const notion =
		notionOverridePresent && overrides.backends?.notion === null
			? null
			: base.backends?.notion === undefined && overrides.backends?.notion === undefined
				? undefined
				: {
						...base.backends?.notion,
						...overrides.backends?.notion,
						property_mappings:
							base.backends?.notion?.property_mappings === undefined &&
							overrides.backends?.notion?.property_mappings === undefined
								? undefined
								: {
										...base.backends?.notion?.property_mappings,
										...overrides.backends?.notion?.property_mappings,
									},
					};
	const merged = {
		...base,
		...overrides,
		backends:
			base.backends === undefined && overrides.backends === undefined
				? undefined
				: {
						...base.backends,
						...overrides.backends,
						anytype:
							base.backends?.anytype === undefined && overrides.backends?.anytype === undefined
								? undefined
								: { ...base.backends?.anytype, ...overrides.backends?.anytype },
						notion,
					},
		content: { ...base.content, ...overrides.content },
		analytics: { ...base.analytics, ...overrides.analytics },
		fathom: {
			...base.fathom,
			...overrides.fathom,
			accounts: mergeNamedRecords(base.fathom?.accounts, overrides.fathom?.accounts),
		},
		whatsapp: {
			...base.whatsapp,
			...overrides.whatsapp,
			accounts: mergeNamedRecords(base.whatsapp?.accounts, overrides.whatsapp?.accounts),
		},
		meeting_publication: { ...base.meeting_publication, ...overrides.meeting_publication },
	};
	return yield* Schema.decodeUnknownEffect(JarvisLegacyConfig)(merged);
});

export const resolveJarvisConfig = Effect.fn("JarvisConfig.resolve")((config: JarvisLegacyConfig) =>
	Effect.succeed(
		new JarvisResolvedConfig({
			version: config.version ?? 1,
			activeBackend: config.active_backend ?? "anytype",
			anytype: new JarvisAnytypeConfig({ defaultSpaceId: config.backends?.anytype?.default_space_id ?? null }),
			notion:
				config.backends?.notion === undefined || config.backends.notion === null
					? null
					: new JarvisNotionConfig({
							workspaceId: config.backends.notion.workspace_id,
							taskDatabaseId: config.backends.notion.task_database_id,
							journalDatabaseId: config.backends.notion.journal_database_id,
							propertyMappings: config.backends.notion.property_mappings ?? defaultPropertyMappings,
						}),
			content: new JarvisContentConfig({
				rootPath: config.content?.root_path ?? null,
				anytypeSpaceName: config.content?.anytype_space_name ?? null,
				anytypeRootCollection: config.content?.anytype_root_collection ?? "Content",
			}),
			analytics: new JarvisAnalyticsConfig({
				enabled: config.analytics?.enabled ?? false,
				metricsFile: config.analytics?.metrics_file ?? "~/.jarvis/metrics.json",
			}),
			fathom: new JarvisFathomConfig({
				defaultAccount: config.fathom?.default_account ?? null,
				accounts: Object.fromEntries(
					Object.entries(config.fathom?.accounts ?? {}).map(([name, account]) => [
						name,
						new JarvisFathomAccountConfig({
							email: account.email ?? null,
							apiKeyEnvVar: account.api_key_env_var ?? "FATHOM_API_KEY",
							webhookSecretEnvVar: account.webhook_secret_env_var ?? "FATHOM_WEBHOOK_SECRET",
							webhookId: account.webhook_id ?? null,
							webhookDestinationUrl: account.webhook_destination_url ?? null,
						}),
					]),
				),
			}),
			whatsapp: new JarvisWhatsAppConfig({
				defaultAccount: config.whatsapp?.default_account ?? null,
				accounts: Object.fromEntries(
					Object.entries(config.whatsapp?.accounts ?? {}).map(([name, account]) => [
						name,
						new JarvisWhatsAppAccountConfig({
							provider: account.provider ?? "meta",
							phoneNumberId: account.phone_number_id ?? null,
							businessAccountId: account.business_account_id ?? null,
							accessTokenEnvVar: account.access_token_env_var ?? "JARVIS_WHATSAPP_META_TOKEN",
							appSecretEnvVar: account.app_secret_env_var ?? "JARVIS_WHATSAPP_META_APP_SECRET",
							verifyTokenEnvVar: account.verify_token_env_var ?? "JARVIS_WHATSAPP_VERIFY_TOKEN",
							apiVersion: account.api_version ?? "v24.0",
							webhookDestinationUrl: account.webhook_destination_url ?? null,
						}),
					]),
				),
			}),
			meetingPublication: new JarvisMeetingPublicationConfig({
				enabled: config.meeting_publication?.enabled ?? false,
				project: config.meeting_publication?.project?.trim() || null,
				sourcePath: config.meeting_publication?.source_path?.trim() || null,
				statePath: config.meeting_publication?.state_path?.trim() || null,
				backfillDays: config.meeting_publication?.backfill_days ?? 30,
				cutoverDate: config.meeting_publication?.cutover_date ?? null,
				maxFileBytes: config.meeting_publication?.max_file_bytes ?? 1024 * 1024,
				maxFiles: config.meeting_publication?.max_files ?? 500,
				leaseSeconds: config.meeting_publication?.lease_seconds ?? 600,
				reminderSeconds: (config.meeting_publication?.reminder_hours ?? 4) * 60 * 60,
				reviewHost: config.meeting_publication?.review_host ?? "127.0.0.1",
				reviewPort: config.meeting_publication?.review_port ?? 8_770,
				reviewSessionSeconds: config.meeting_publication?.review_session_seconds ?? 900,
				reviewMaxSessions: config.meeting_publication?.review_max_sessions ?? 64,
				reviewMaxBodyBytes:
					config.meeting_publication?.review_max_body_bytes ?? JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES,
				googleOwnerEmail: config.meeting_publication?.google_owner_email?.trim() || null,
				googleDriveFolder: config.meeting_publication?.google_drive_folder?.trim() || null,
				discordChannelId: config.meeting_publication?.discord_channel_id?.trim() || null,
			}),
		}),
	),
);
