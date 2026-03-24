// Fixed gateway token for all moltbots
// This is intentionally simple - users don't need to manage tokens
export const GATEWAY_TOKEN = "clawnboard";

// VM size specs for Fly.io machines (shared CPU)
// 1 shared CPU keeps deploys working when regional CPU capacity is tight
// OpenClaw recommends 2GB RAM minimum
// See: https://docs.openclaw.ai/platforms/fly
// Pricing based on: https://fly.io/docs/about/pricing/ (iad region)
// Prices include 20GB persistent volume storage ($3/mo)
export const VM_SPECS = {
  "1gb": {
    cpus: 1,
    memoryMb: 1024,
    label: "1GB RAM",
    description: "1 CPU, 1GB RAM, 20GB storage",
    pricePerMonth: "~$9/mo",
  },
  "2gb": {
    cpus: 1,
    memoryMb: 2048,
    label: "2GB RAM",
    description: "1 CPU, 2GB RAM, 20GB storage",
    pricePerMonth: "~$14/mo",
  },
  "4gb": {
    cpus: 1,
    memoryMb: 4096,
    label: "4GB RAM",
    description: "1 CPU, 4GB RAM, 20GB storage",
    pricePerMonth: "~$23/mo",
  },
} as const;

// Default persistent volume size in GB
export const DEFAULT_VOLUME_SIZE_GB = 20;

// Available AI models for moltbots
// Model IDs follow OpenClaw's provider/model format
export const AI_MODELS = {
  // Anthropic Claude 4.5 models
  "anthropic/claude-haiku-4-5": {
    provider: "anthropic",
    label: "Claude 4.5 Haiku",
  },
  "anthropic/claude-sonnet-4-5": {
    provider: "anthropic",
    label: "Claude 4.5 Sonnet",
  },
  "anthropic/claude-opus-4-6": {
    provider: "anthropic",
    label: "Claude 4.6 Opus",
  },
  "anthropic/claude-opus-4-5": {
    provider: "anthropic",
    label: "Claude 4.5 Opus",
  },
  // OpenAI GPT models
  "openai/gpt-4o-mini": {
    provider: "openai",
    label: "GPT-4o mini",
  },
  "openai/gpt-4o": {
    provider: "openai",
    label: "GPT-4o",
  },
  // OpenRouter models
  "openrouter/moonshotai/kimi-k2.5": {
    provider: "openrouter",
    label: "Kimi K2.5 (via OpenRouter)",
  },
} as const;

export type AIModelId = keyof typeof AI_MODELS;
export const DEFAULT_MODEL: AIModelId = "anthropic/claude-opus-4-6";
