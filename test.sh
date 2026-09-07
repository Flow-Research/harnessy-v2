#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
temporary_base=${TMPDIR:-/tmp}
test_home=$(mktemp -d "${temporary_base%/}/harnessy-test-home.XXXXXX")

cleanup() {
    rm -rf -- "$test_home"
}
trap cleanup EXIT

required_build_artifacts=(
    "packages/tui/dist/index.js"
    "packages/ai/dist/index.js"
    "packages/agent/dist/index.js"
    "packages/coding-agent/dist/index.js"
    "packages/orchestrator/dist/index.js"
    "packages/harnessy-core/dist/index.js"
    "packages/harnessy-engine/dist/index.js"
)

for artifact in "${required_build_artifacts[@]}"; do
    if [[ ! -f "$repository_root/$artifact" ]]; then
        echo "Build artifact $artifact is missing; building the workspace first."
        npm --prefix "$repository_root" run build
        break
    fi
done

# Tests must not discover credentials or user-global Harnessy state.
export HOME="$test_home"
export XDG_CONFIG_HOME="$test_home/.config"
export XDG_DATA_HOME="$test_home/.local/share"
export XDG_STATE_HOME="$test_home/.local/state"
export PI_NO_LOCAL_LLM=1

# See packages/ai/src/stream.ts getEnvApiKey.
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset ANT_LING_API_KEY
unset NVIDIA_API_KEY
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_CN_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST

echo "Running workspace tests in an isolated home without API keys."
npm --prefix "$repository_root" run test --workspaces --if-present
