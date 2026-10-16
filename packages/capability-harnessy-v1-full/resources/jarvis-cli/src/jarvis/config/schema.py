"""Configuration schema models using Pydantic Settings."""

from datetime import date
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class NotionConfig(BaseModel):
    """Notion-specific configuration.

    Requires API token via JARVIS_NOTION_TOKEN environment variable.
    """

    workspace_id: str = Field(description="Notion workspace ID")
    task_database_id: str = Field(description="Tasks database ID")
    journal_database_id: str = Field(description="Journal database ID")
    property_mappings: dict[str, str] = Field(
        default_factory=lambda: {
            "priority": "Priority",
            "due_date": "Due Date",
            "tags": "Tags",
            "done": "Done",
            "title": "Name",
            "date": "Date",
        },
        description="Mapping of Jarvis fields to Notion property names",
    )


class AnyTypeConfig(BaseModel):
    """AnyType-specific configuration.

    AnyType uses local gRPC connection (localhost:31009), so minimal config needed.
    """

    default_space_id: str | None = Field(
        default=None,
        description="Optional: Pre-select space ID to skip space selection",
    )


class BackendsConfig(BaseModel):
    """Container for all backend configurations."""

    anytype: AnyTypeConfig = Field(default_factory=AnyTypeConfig)
    notion: NotionConfig | None = Field(
        default=None,
        description="Notion configuration (required if using Notion backend)",
    )


class ContentConfig(BaseModel):
    """Configuration for the content publishing pipeline.

    Values here replace previously-hardcoded identifiers so the CLI is not
    tied to any particular workspace layout or AnyType space/collection name.
    """

    root_path: str | None = Field(
        default=None,
        description=(
            "Local path to the content root directory. May be absolute or "
            "relative to the current working directory / git root. When unset, "
            "the CLI searches `.jarvis/context/private/<user>/content` and "
            "then `<user>/flow-content` as a backwards-compat fallback."
        ),
    )
    anytype_space_name: str | None = Field(
        default=None,
        description=(
            "Case-insensitive name of the AnyType space to target for content "
            "publishing. When unset, the standard space-selection prompt runs."
        ),
    )
    anytype_root_collection: str = Field(
        default="Content",
        description=(
            "Name of the top-level AnyType collection under which the "
            "year/month/piece hierarchy is created."
        ),
    )


class AnalyticsConfig(BaseModel):
    """Analytics configuration (opt-in only)."""

    enabled: bool = Field(default=False)
    metrics_file: str = Field(default="~/.jarvis/metrics.json")


class FathomAccountConfig(BaseModel):
    """Configuration for a single Fathom account."""

    email: str | None = Field(default=None, description="Google/Fathom account email")
    api_key_env_var: str = Field(
        default="FATHOM_API_KEY",
        description="Environment variable holding the API key for this account",
    )
    webhook_secret_env_var: str = Field(
        default="FATHOM_WEBHOOK_SECRET",
        description="Environment variable holding the webhook signing secret for this account",
    )
    webhook_id: str | None = Field(
        default=None,
        description="Last Fathom webhook ID registered for this account",
    )
    webhook_destination_url: str | None = Field(
        default=None,
        description="Last Fathom webhook destination URL registered for this account",
    )


class FathomConfig(BaseModel):
    """Configuration for one or more Fathom accounts."""

    default_account: str | None = Field(
        default=None,
        description="Default named Fathom account to use when none is specified",
    )
    accounts: dict[str, FathomAccountConfig] = Field(default_factory=dict)


class WhatsAppAccountConfig(BaseModel):
    """Configuration for a single WhatsApp channel account."""

    provider: Literal["meta"] = Field(
        default="meta",
        description="WhatsApp provider adapter. Meta Cloud API is the canonical provider.",
    )
    phone_number_id: str | None = Field(
        default=None,
        description="Meta WhatsApp Cloud API phone number ID used for outbound sends",
    )
    business_account_id: str | None = Field(
        default=None,
        description="Meta WhatsApp Business Account ID for this channel",
    )
    access_token_env_var: str = Field(
        default="JARVIS_WHATSAPP_META_TOKEN",
        description="Environment variable holding the Meta Cloud API access token",
    )
    app_secret_env_var: str = Field(
        default="JARVIS_WHATSAPP_META_APP_SECRET",
        description="Environment variable holding the Meta app secret for webhook signatures",
    )
    verify_token_env_var: str = Field(
        default="JARVIS_WHATSAPP_VERIFY_TOKEN",
        description="Environment variable holding the Meta webhook verification token",
    )
    api_version: str = Field(
        default="v24.0",
        description="Meta Graph API version segment used for outbound sends",
    )
    webhook_destination_url: str | None = Field(
        default=None,
        description="Last public HTTPS webhook URL registered in Meta",
    )


class WhatsAppConfig(BaseModel):
    """Configuration for one or more WhatsApp channel accounts."""

    default_account: str | None = Field(
        default=None,
        description="Default named WhatsApp account to use when none is specified",
    )
    accounts: dict[str, WhatsAppAccountConfig] = Field(default_factory=dict)


class MeetingPublicationConfig(BaseModel):
    """Local-first meeting review and publication settings.

    Secrets intentionally do not live in this model. Discord credentials are
    resolved from ``discord_bot_token_env_var`` and Google authentication is
    delegated to the local Google Workspace CLI credential store.
    """

    enabled: bool = Field(
        default=False,
        description="Enable scanning and publication worker commands",
    )
    project: str = Field(default="flow", description="Only publish this canonical project")
    source_path: str | None = Field(
        default=None,
        description="Optional canonical meeting-note directory override",
    )
    state_path: str = Field(
        default="~/.jarvis/state/meeting-publication",
        description="Owner-only queue, review token, and service log directory",
    )
    backfill_days: int = Field(
        default=30,
        ge=1,
        le=365,
        description="Rolling local note window scanned by the worker",
    )
    cutover_date: date | None = Field(
        default=None,
        description="Hard publication floor; meetings before this date stay archived",
    )
    review_host: str = Field(default="127.0.0.1")
    review_port: int = Field(default=8770, ge=1024, le=65535)
    reminder_hours: int = Field(default=4, ge=1, le=168)
    google_owner_email: str = Field(default="julian.duru@flowresearch.tech")
    google_drive_folder: str = Field(default="Flow Research/Meeting Notes")
    discord_channel_id: str | None = Field(
        default=None,
        description="Configurable Discord text-channel ID for new meeting posts",
    )
    discord_bot_token_env_var: str = Field(default="JARVIS_DISCORD_BOT_TOKEN")
    discord_api_base: str = Field(default="https://discord.com/api/v10")

    @field_validator("review_host")
    @classmethod
    def validate_review_host(cls, value: str) -> str:
        """Keep the approval surface strictly local."""

        if value not in {"127.0.0.1", "localhost"}:
            raise ValueError("meeting publication review_host must be localhost")
        return value

    @field_validator("discord_channel_id")
    @classmethod
    def validate_discord_channel_id(cls, value: str | None) -> str | None:
        """Accept Discord snowflakes without silently accepting channel names."""

        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned.isdigit() or len(cleaned) < 15:
            raise ValueError("discord_channel_id must be a Discord numeric channel ID")
        return cleaned


class CommunityBriefingConfig(BaseModel):
    """Approval-gated weekly community briefing settings.

    Source material and generated drafts stay local. Secrets remain outside the
    YAML config and are resolved through the existing meeting-publication
    runtime environment.
    """

    enabled: bool = Field(default=False, description="Enable generation and publication workers")
    source_path: str | None = Field(
        default=None,
        description="Private contributor context root scanned for Flow-relevant weekly evidence",
    )
    draft_path: str | None = Field(
        default=None,
        description="Owner-only weekly briefing artifact directory",
    )
    state_path: str = Field(
        default="~/.jarvis/state/meeting-publication",
        description="Owner-only queue and shared review-token directory",
    )
    timezone: str = Field(default="Africa/Lagos")
    review_host: str = Field(default="127.0.0.1")
    review_port: int = Field(default=8770, ge=1024, le=65535)
    reminder_hours: int = Field(default=4, ge=1, le=168)
    google_owner_email: str = Field(default="julian.duru@flowresearch.tech")
    google_drive_folder: str = Field(default="Flow Research/Weekly Briefings")
    discord_channel_id: str | None = Field(
        default=None,
        description="Dedicated Discord text-channel ID for weekly community briefings",
    )
    discord_bot_token_env_var: str = Field(default="JARVIS_DISCORD_BOT_TOKEN")
    discord_api_base: str = Field(default="https://discord.com/api/v10")
    ai_provider: Literal["auto", "claude", "codex", "opencode"] = Field(default="auto")
    max_sources: int = Field(default=60, ge=1, le=200)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        """Keep the agreed weekly boundary stable across machines."""

        if value != "Africa/Lagos":
            raise ValueError("community briefing timezone must be Africa/Lagos")
        return value

    @field_validator("review_host")
    @classmethod
    def validate_review_host(cls, value: str) -> str:
        """Keep briefing approval on the existing loopback-only inbox."""

        if value not in {"127.0.0.1", "localhost"}:
            raise ValueError("community briefing review_host must be localhost")
        return value

    @field_validator("discord_channel_id")
    @classmethod
    def validate_discord_channel_id(cls, value: str | None) -> str | None:
        """Accept Discord snowflakes without accepting human channel names."""

        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned.isdigit() or len(cleaned) < 15:
            raise ValueError("discord_channel_id must be a Discord numeric channel ID")
        return cleaned


class JarvisConfig(BaseSettings):
    """Root configuration model for Jarvis.

    Configuration is loaded from:
    1. Config file: ~/.jarvis/config.yaml
    2. Environment variables: JARVIS_* prefix

    Environment variables take precedence over config file.
    """

    model_config = SettingsConfigDict(
        env_prefix="JARVIS_",
        env_nested_delimiter="__",
        extra="ignore",  # Ignore unknown fields
    )

    version: int = Field(default=1, description="Config file version")
    active_backend: Literal["anytype", "notion"] = Field(
        default="anytype",
        description="Which backend to use for all operations",
    )
    backends: BackendsConfig = Field(default_factory=BackendsConfig)
    content: ContentConfig = Field(default_factory=ContentConfig)
    analytics: AnalyticsConfig = Field(default_factory=AnalyticsConfig)
    fathom: FathomConfig = Field(default_factory=FathomConfig)
    whatsapp: WhatsAppConfig = Field(default_factory=WhatsAppConfig)
    meeting_publication: MeetingPublicationConfig = Field(default_factory=MeetingPublicationConfig)
    community_briefing: CommunityBriefingConfig = Field(default_factory=CommunityBriefingConfig)

    @field_validator("active_backend")
    @classmethod
    def validate_active_backend(cls, v: str) -> str:
        """Validate active_backend is a known backend type."""
        valid_backends = {"anytype", "notion"}
        if v not in valid_backends:
            raise ValueError(f"Invalid backend: {v}. Must be one of: {valid_backends}")
        return v

    def get_backend_config(self, backend: str | None = None) -> BaseModel:
        """Get the configuration for a specific backend.

        Args:
            backend: Backend name. Uses active_backend if None.

        Returns:
            Backend-specific configuration model.

        Raises:
            ValueError: If backend is not configured.
        """
        target = backend or self.active_backend
        if target == "anytype":
            return self.backends.anytype
        elif target == "notion":
            if self.backends.notion is None:
                raise ValueError(
                    "Notion backend is not configured. "
                    "Add a [backends.notion] section to ~/.jarvis/config.yaml"
                )
            return self.backends.notion
        else:
            raise ValueError(f"Unknown backend: {target}")


def get_config_dir() -> Path:
    """Get the Jarvis configuration directory, creating if needed.

    Returns:
        Path to ~/.jarvis/ directory
    """
    config_dir = Path.home() / ".jarvis"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def get_config_path() -> Path:
    """Get the path to the Jarvis config file.

    Returns:
        Path to ~/.jarvis/config.yaml
    """
    return get_config_dir() / "config.yaml"
