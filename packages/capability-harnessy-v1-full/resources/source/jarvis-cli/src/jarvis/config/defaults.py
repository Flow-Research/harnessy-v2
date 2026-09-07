"""Default configuration values for Jarvis."""

DEFAULT_CONFIG_YAML = """\
# Jarvis Configuration
# ====================
# This file configures the Jarvis CLI tool.
# Secrets (API tokens) should be set via environment variables, NOT in this file.

version: 1

# Which backend to use for all operations
# Options: anytype, notion
active_backend: anytype

# Backend-specific configuration
backends:
  anytype:
    # AnyType uses local gRPC connection (localhost:31009)
    # Optionally pre-select a space ID to skip interactive selection
    # default_space_id: "your-space-id"

  # Uncomment and configure to use Notion:
  # notion:
  #   workspace_id: "your-workspace-id"
  #   task_database_id: "your-tasks-db-id"
  #   journal_database_id: "your-journal-db-id"
  #   # Optional: Custom property name mappings
  #   property_mappings:
  #     priority: "Priority"
  #     due_date: "Due Date"
  #     tags: "Tags"
  #     done: "Done"

# Content publishing pipeline
# Leave any field unset to use built-in defaults / prompts.
content:
  # Local path to the content root (relative to repo or absolute).
  # Defaults to `.jarvis/context/private/<user>/content` if unset.
  # root_path: ".jarvis/context/private/me/content"

  # Name of the AnyType space to target. Case-insensitive.
  # If unset, the standard space-selection prompt runs.
  # anytype_space_name: "MySpace"

  # Top-level AnyType collection under which year/month/piece hierarchy lives.
  anytype_root_collection: "Content"

# Analytics (opt-in)
analytics:
  enabled: false
  metrics_file: "~/.jarvis/metrics.json"

# Fathom meeting ingestion
fathom:
  # Optional: choose a default named account for `jarvis meeting fathom ...`
  # default_account: work

  # Configure named accounts when you use multiple Google/Fathom identities.
  # Keep secrets in environment variables, not in this file.
  # accounts:
  #   work:
  #     email: "you@work.com"
  #     api_key_env_var: "FATHOM_API_KEY_WORK"
  #     webhook_secret_env_var: "FATHOM_WEBHOOK_SECRET_WORK"
  #   personal:
  #     email: "you@gmail.com"
  #     api_key_env_var: "FATHOM_API_KEY_PERSONAL"
  #     webhook_secret_env_var: "FATHOM_WEBHOOK_SECRET_PERSONAL"

# WhatsApp channel integration
whatsapp:
  # Optional: choose a default named account for `jarvis whatsapp ...`
  # default_account: personal

  # Meta WhatsApp Cloud API is the canonical provider. Keep secrets in
  # environment variables, not in this file.
  # accounts:
  #   personal:
  #     provider: meta
  #     phone_number_id: "1234567890"
  #     business_account_id: "9876543210"
  #     access_token_env_var: "JARVIS_WHATSAPP_META_TOKEN_PERSONAL"
  #     app_secret_env_var: "JARVIS_WHATSAPP_META_APP_SECRET_PERSONAL"
  #     verify_token_env_var: "JARVIS_WHATSAPP_VERIFY_TOKEN_PERSONAL"
  #     api_version: "v24.0"

# Approval-gated Flow meeting publication
meeting_publication:
  enabled: false
  project: flow
  backfill_days: 30
  # Optional hard floor for a controlled launch/backfill.
  # cutover_date: 2026-08-28
  review_host: 127.0.0.1
  review_port: 8770
  reminder_hours: 4
  google_owner_email: "julian.duru@flowresearch.tech"
  google_drive_folder: "Flow Research/Meeting Notes"
  # Numeric Discord text-channel ID; configurable per installation.
  # discord_channel_id: "123456789012345678"
  discord_bot_token_env_var: "JARVIS_DISCORD_BOT_TOKEN"

# Approval-gated Sunday community briefing. It remains disabled until a
# dedicated Discord channel ID is configured explicitly.
community_briefing:
  enabled: false
  timezone: "Africa/Lagos"
  review_host: 127.0.0.1
  review_port: 8770
  reminder_hours: 4
  google_owner_email: "julian.duru@flowresearch.tech"
  google_drive_folder: "Flow Research/Weekly Briefings"
  # discord_channel_id: "123456789012345678"
  discord_bot_token_env_var: "JARVIS_DISCORD_BOT_TOKEN"
  ai_provider: auto
  max_sources: 60
"""

# Valid backend names
VALID_BACKENDS = {"anytype", "notion"}

# Environment variable names for tokens
ENV_NOTION_TOKEN = "JARVIS_NOTION_TOKEN"
ENV_NOTION_TOKEN_FALLBACK = "NOTION_TOKEN"
