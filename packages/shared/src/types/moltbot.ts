// Moltbot status matches Fly.io machine states
export type MoltbotStatus =
  | "created"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "destroying"
  | "destroyed"
  | "error";

export type MoltbotSize = "1gb" | "2gb" | "4gb" | "5gb";

// ACP (Agent Client Protocol) agent identifiers supported by acpx
export type AcpAgent = "claude" | "codex" | "gemini" | "opencode" | "pi";

// ACP configuration for a moltbot's openclaw.json
export interface AcpConfig {
  enabled: boolean;
  defaultAgent: AcpAgent;
  allowedAgents: AcpAgent[];
  maxConcurrentSessions: number;
}

export interface Moltbot {
  id: string;
  name: string;
  status: MoltbotStatus;
  hostname: string;
  region: string;
  size: MoltbotSize;
  createdAt: string;
  /** Gateway token for accessing OpenClaw dashboard (only returned on creation) */
  gatewayToken?: string;
  /** ACP subagent configuration */
  acpConfig?: AcpConfig;
}

export interface CreateMoltbotInput {
  name: string;
  size?: MoltbotSize;
  acpConfig?: AcpConfig;
}

export interface VolumeSnapshot {
  id: string;
  moltbotName: string;  // Source moltbot
  volumeId: string;
  createdAt: string;
  sizeGb: number;
  label: string;  // "{moltbotName} - {date}"
}
