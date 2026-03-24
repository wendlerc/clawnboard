/**
 * Fly.io Machines provisioner for OpenClaw instances.
 *
 * Each moltbot gets its own Fly.io app with a dedicated URL.
 * This ensures proper DNS and avoids the shared-app DNS issues.
 *
 * Security: Each moltbot gets a unique, randomly-generated gateway token
 * stored in Fly.io machine metadata. This prevents unauthorized access
 * to the OpenClaw dashboard - only users with access to the Fly.io API
 * (via their org token) can retrieve the gateway token.
 */

import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import type {
  ProvisionerConfig,
  MoltbotConfig,
  MoltbotInstance,
  MoltbotStatus,
  FlyMachine,
  FlyMachineCreateRequest,
  FlyMachineConfig,
  FlyVolume,
  FlyVolumeSnapshot,
} from "./types.js";
import { createLogger, type Logger } from "./logger.js";

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_API_GRAPHQL = "https://api.fly.io/graphql";

// OpenClaw VM sizes — shared CPUs; LLM work is external.
// Use 1 shared CPU so new machines fit when a region has tight CPU capacity (avoids 409 insufficient CPUs).
// See: https://docs.openclaw.ai/platforms/fly
const SIZE_SPECS = {
  "1gb": { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  "2gb": { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
  "4gb": { cpu_kind: "shared", cpus: 1, memory_mb: 4096 },
} as const;

// Prefix for moltbot app names to identify them
const MOLTBOT_APP_PREFIX = "moltbot-";

// Metadata key for storing gateway token
const GATEWAY_TOKEN_METADATA_KEY = "gateway_token";

// Metadata key for storing hidden snapshot IDs (comma-separated)
const HIDDEN_SNAPSHOTS_METADATA_KEY = "hidden_snapshots";

/**
 * First-boot: run OpenClaw non-interactive onboard with a Claude setup-token
 * (see https://docs.openclaw.ai/providers/anthropic — Option B).
 * Marker file prevents re-running on restarts.
 *
 * Onboard is wrapped in `timeout` and must never block the gateway: if Anthropic is slow or
 * onboard hangs, Fly would otherwise show no listener on :3000 forever (health never passes).
 */
function buildMoltbotGatewayCmd(configJson: string, machineEnv: Record<string, string>): string {
  const base =
    `mkdir -p /data && [ -f /data/openclaw.json ] || printf '%s' '${configJson}' > /data/openclaw.json`;
  const gateway = `exec node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan`;
  /** 20 minutes — long enough for slow networks; still bounded so machines cannot hang forever */
  const onboardTimeoutSec = 1200;

  if (machineEnv.ANTHROPIC_SETUP_TOKEN?.trim()) {
    const onboard =
      `if [ -n "$ANTHROPIC_SETUP_TOKEN" ] && [ ! -f /data/.clawnboard-setup-token-done ]; then ` +
      `if timeout ${onboardTimeoutSec} node dist/index.js onboard --non-interactive --accept-risk --auth-choice token --token-provider anthropic --token "$ANTHROPIC_SETUP_TOKEN" ` +
      `--skip-daemon --skip-channels --skip-skills --skip-health --gateway-port 3000 --gateway-bind lan --gateway-auth token --gateway-token "$OPENCLAW_GATEWAY_TOKEN"; then ` +
      `touch /data/.clawnboard-setup-token-done; ` +
      `else echo '[clawnboard] onboard failed or timed out; starting gateway anyway (fix auth in UI or SSH)' >&2; ` +
      `fi; ` +
      `fi`;
    return `${base} && ${onboard} && ${gateway}`;
  }

  return `${base} && ${gateway}`;
}

/**
 * Fly.io provisioner for OpenClaw moltbots.
 *
 * Each moltbot is deployed as its own Fly.io app, giving it a unique URL.
 */
export class FlyProvisioner {
  private config: ProvisionerConfig;
  private logger: Logger;

  constructor(config: ProvisionerConfig) {
    this.config = {
      region: "iad",
      ...config,
    };
    this.logger = config.logger || createLogger({ prefix: "fly-provisioner" });
  }

  /**
   * Make a request to the Fly.io Machines API for a specific app.
   */
  private async machinesRequest<T>(
    appName: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${FLY_API_BASE}/apps/${appName}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Fly.io API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a request to the Fly.io GraphQL API.
   */
  private async graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(FLY_API_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fly.io GraphQL error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { data: T; errors?: Array<{ message: string }> };
    if (result.errors?.length) {
      throw new Error(`Fly.io GraphQL error: ${result.errors[0].message}`);
    }

    return result.data;
  }

  /**
   * Creates a new Fly.io app for the moltbot.
   */
  private async createApp(name: string): Promise<void> {
    const query = `
      mutation($input: CreateAppInput!) {
        createApp(input: $input) {
          app { id name }
        }
      }
    `;

    await this.graphqlRequest(query, {
      input: {
        name,
        organizationId: await this.getOrgId(),
      },
    });
  }

  /**
   * Gets the user's organization ID.
   */
  private async getOrgId(): Promise<string> {
    const query = `
      query {
        viewer {
          organizations {
            nodes { id slug }
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      viewer: { organizations: { nodes: Array<{ id: string; slug: string }> } };
    }>(query);

    // Use personal org or first available
    const orgs = data.viewer.organizations.nodes;
    const personalOrg = orgs.find((o) => o.slug === "personal") || orgs[0];
    if (!personalOrg) {
      throw new Error("No Fly.io organization found");
    }
    return personalOrg.id;
  }

  /**
   * Allocates a shared IPv4 for an app.
   */
  private async allocateSharedIp(appName: string): Promise<void> {
    const query = `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress { id address type }
        }
      }
    `;

    await this.graphqlRequest(query, {
      input: {
        appId: appName,
        type: "shared_v4",
      },
    });
  }

  /**
   * Creates a volume for persistent storage.
   */
  private async createVolume(appName: string, volumeName: string, sizeGb: number = 1): Promise<string> {
    const response = await this.machinesRequest<{ id: string; name: string }>(
      appName,
      "POST",
      "/volumes",
      {
        name: volumeName,
        size_gb: sizeGb,
        region: this.config.region,
      }
    );
    return response.id;
  }

  /**
   * Deletes a Fly.io app and all its resources.
   */
  private async deleteApp(appName: string): Promise<void> {
    const query = `
      mutation($appId: ID!) {
        deleteApp(appId: $appId) {
          organization { id }
        }
      }
    `;

    await this.graphqlRequest(query, { appId: appName });
  }

  /**
   * Sets a metadata value on a machine.
   */
  private async setMachineMetadata(appName: string, machineId: string, key: string, value: string): Promise<void> {
    await this.machinesRequest<void>(appName, "POST", `/machines/${machineId}/metadata/${key}`, { value });
  }

  /**
   * Gets all metadata for a machine.
   * Returns empty object if metadata fetch fails (e.g., for older moltbots without tokens).
   */
  private async getMachineMetadata(appName: string, machineId: string): Promise<Record<string, string>> {
    try {
      return await this.machinesRequest<Record<string, string>>(appName, "GET", `/machines/${machineId}/metadata`);
    } catch {
      return {};
    }
  }

  /**
   * Lists all moltbot apps.
   */
  private async listMoltbotApps(): Promise<Array<{ name: string; status: string }>> {
    const query = `
      query {
        apps {
          nodes {
            name
            status
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      apps: { nodes: Array<{ name: string; status: string }> };
    }>(query);

    // Filter to only moltbot apps
    return data.apps.nodes.filter((app) => app.name.startsWith(MOLTBOT_APP_PREFIX));
  }

  /**
   * Creates a new OpenClaw moltbot.
   * This creates a new Fly.io app dedicated to this moltbot.
   */
  async createMoltbot(config: MoltbotConfig): Promise<MoltbotInstance> {
    const appName = `${MOLTBOT_APP_PREFIX}${config.name}`;
    const context = { moltbotName: config.name, appName, operation: "create" };

    this.logger.info(`Creating moltbot app: ${appName}`, context);

    // 1. Create the app
    await this.createApp(appName);
    this.logger.info(`App created: ${appName}`, context);

    // 2. Allocate shared IPv4
    await this.allocateSharedIp(appName);
    this.logger.info(`IP allocated for: ${appName}`, context);

    // 3. Create volume for persistent storage
    const volumeName = "openclaw_data";
    await this.createVolume(appName, volumeName, 20);
    this.logger.info(`Volume created: ${volumeName}`, context);

    // 4. Create the machine with a unique gateway token
    // Token is stored in Fly.io metadata for secure retrieval later
    const gatewayToken = crypto.randomUUID();
    const primaryModel = config.model || "anthropic/claude-sonnet-4-5";

    // Build OpenClaw config with selected model
    const openclawConfig = {
      agents: {
        defaults: {
          workspace: "/data/workspace",
          model: {
            primary: primaryModel,
            fallbacks: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
          },
          maxConcurrent: 4,
        },
        list: [{ id: "main", default: true }],
      },
      auth: {
        profiles: {
          "anthropic:default": { mode: "token", provider: "anthropic" },
          "openai:default": { mode: "token", provider: "openai" },
          "openrouter:default": { mode: "token", provider: "openrouter" },
        },
      },
      gateway: {
        mode: "local",
        bind: "lan",
        trustedProxies: ["172.16.0.0/12", "10.0.0.0/8"],
        controlUi: {
          allowInsecureAuth: true,
          // Skip browser device pairing for Control UI; gateway token is enough on Fly (no one to click "approve")
          dangerouslyDisableDeviceAuth: true,
          // Required since OpenClaw ~2026.2.26: browser origin must match when using the Fly HTTPS URL
          allowedOrigins: [`https://${appName}.fly.dev`, "http://localhost:3000", "http://127.0.0.1:3000"],
        },
      },
      meta: { lastTouchedVersion: "2026.1.29" },
    };

    // Escape single quotes in JSON for shell
    const configJson = JSON.stringify(openclawConfig).replace(/'/g, "'\\''");

    const machineEnv: Record<string, string> = {
      NODE_ENV: "production",
      OPENCLAW_STATE_DIR: "/data",
      OPENCLAW_PREFER_PNPM: "1",
      NODE_OPTIONS: "--max-old-space-size=1536",
      // Gateway authentication - unique token per moltbot
      // Token is also stored in Fly.io metadata for secure retrieval
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      ...config.env,
    };

    const machineConfig: FlyMachineConfig = {
      image: config.image || "ghcr.io/openclaw/openclaw:latest",
      env: machineEnv,
      guest: SIZE_SPECS[config.size || "2gb"],
      // Run as root so the agent can install packages (e.g., browser deps)
      init: {
        user: "root",
      },
      restart: {
        policy: "always",
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: 3000,
        },
      ],
      // Health check with grace period - OpenClaw can take several minutes to start
      checks: {
        httpget: {
          type: "http",
          port: 3000,
          path: "/",
          interval: "15s",
          timeout: "10s",
          grace_period: "300s",
        },
      },
      mounts: [
        {
          volume: volumeName,
          path: "/data",
        },
      ],
      processes: [
        {
          cmd: [
            "/bin/sh",
            "-c",
            // Create config file if it doesn't exist, then start gateway
            // Config structure matches: https://docs.openclaw.ai/platforms/fly
            buildMoltbotGatewayCmd(configJson, machineEnv),
          ],
        },
      ],
    };

    const createRequest: FlyMachineCreateRequest = {
      name: config.name,
      region: this.config.region,
      config: machineConfig,
      skip_launch: false,
    };

    try {
      const machine = await this.machinesRequest<FlyMachine>(
        appName,
        "POST",
        "/machines",
        createRequest
      );

      this.logger.info(`Moltbot created: ${machine.id}`, {
        ...context,
        machineId: machine.id,
        region: machine.region,
      });

      // Store the gateway token in machine metadata for later retrieval
      // This ensures the token persists and can be fetched when user returns
      await this.setMachineMetadata(appName, machine.id, GATEWAY_TOKEN_METADATA_KEY, gatewayToken);
      this.logger.info(`Gateway token stored in metadata`, { ...context, machineId: machine.id });

      // Wait for machine to be started, then install sudo access and repair pairing
      // SSH requires the machine to be running
      await this.waitForState(appName, machine.id, "started", 120000);
      await this.installSudoAccess(appName);
      await this.repairGatewayPairing(appName);

      const instance = this.mapMachineToInstance(machine, appName);
      instance.gatewayToken = gatewayToken;
      return instance;
    } catch (error) {
      // Clean up the app if machine creation fails
      this.logger.error(`Failed to create machine, cleaning up app: ${appName}`,
        error instanceof Error ? error : new Error(String(error)), context);
      try {
        await this.deleteApp(appName);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Gets a moltbot by its name.
   * Includes the gateway token fetched from machine metadata.
   */
  async getMoltbot(moltbotName: string): Promise<MoltbotInstance | null> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;

    try {
      const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
      if (machines.length === 0) {
        return null;
      }
      const machine = machines[0];
      const instance = this.mapMachineToInstance(machine, appName);

      // Fetch gateway token from metadata
      const metadata = await this.getMachineMetadata(appName, machine.id);
      instance.gatewayToken = metadata[GATEWAY_TOKEN_METADATA_KEY];

      return instance;
    } catch (error) {
      if (error instanceof Error && (error.message.includes("404") || error.message.includes("not found"))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Lists all moltbots.
   * Includes gateway tokens fetched from machine metadata.
   */
  async listMoltbots(): Promise<MoltbotInstance[]> {
    const apps = await this.listMoltbotApps();
    const moltbots: MoltbotInstance[] = [];

    for (const app of apps) {
      try {
        const machines = await this.machinesRequest<FlyMachine[]>(app.name, "GET", "/machines");
        if (machines.length > 0) {
          const machine = machines[0];
          const instance = this.mapMachineToInstance(machine, app.name);

          // Fetch gateway token from metadata
          const metadata = await this.getMachineMetadata(app.name, machine.id);
          instance.gatewayToken = metadata[GATEWAY_TOKEN_METADATA_KEY];

          moltbots.push(instance);
        }
      } catch {
        // Skip apps we can't access
      }
    }

    return moltbots;
  }

  /**
   * Starts a stopped moltbot.
   */
  async startMoltbot(moltbotName: string): Promise<MoltbotInstance> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, operation: "start" };

    this.logger.info(`Starting moltbot: ${moltbotName}`, context);

    const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
    if (machines.length === 0) {
      throw new Error(`No machine found for moltbot: ${moltbotName}`);
    }

    const machineId = machines[0].id;
    await this.machinesRequest<void>(appName, "POST", `/machines/${machineId}/start`);

    // Wait for start, then reinstall sudo and repair pairing (container resets to base image)
    const moltbot = await this.waitForState(appName, machineId, "started");
    await this.installSudoAccess(appName);
    await this.repairGatewayPairing(appName);
    this.logger.info(`Moltbot started: ${moltbotName}`, context);
    return moltbot;
  }

  /**
   * Stops a running moltbot.
   */
  async stopMoltbot(moltbotName: string): Promise<MoltbotInstance> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, operation: "stop" };

    this.logger.info(`Stopping moltbot: ${moltbotName}`, context);

    const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
    if (machines.length === 0) {
      throw new Error(`No machine found for moltbot: ${moltbotName}`);
    }

    const machineId = machines[0].id;
    await this.machinesRequest<void>(appName, "POST", `/machines/${machineId}/stop`);

    const moltbot = await this.waitForState(appName, machineId, "stopped");
    this.logger.info(`Moltbot stopped: ${moltbotName}`, context);
    return moltbot;
  }

  /**
   * Destroys a moltbot and its app permanently.
   */
  async destroyMoltbot(moltbotName: string): Promise<void> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, operation: "destroy" };

    this.logger.info(`Destroying moltbot: ${moltbotName}`, context);

    // Delete the entire app (this deletes machines, volumes, etc.)
    await this.deleteApp(appName);
    this.logger.info(`Moltbot destroyed: ${moltbotName}`, context);
  }

  /**
   * Updates a moltbot to the latest OpenClaw image.
   *
   * This pulls the latest image and restarts the machine.
   * User data in /data is preserved (it's on a persistent volume).
   */
  async updateMoltbot(moltbotName: string): Promise<MoltbotInstance> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, operation: "update" };

    this.logger.info(`Updating moltbot to latest image: ${moltbotName}`, context);

    const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
    if (machines.length === 0) {
      throw new Error(`No machine found for moltbot: ${moltbotName}`);
    }

    const machine = machines[0];
    const machineId = machine.id;

    // Update the machine config with the latest image
    // The config is preserved except for the image
    const updatedConfig = {
      ...machine.config,
      image: "ghcr.io/openclaw/openclaw:latest",
    };

    await this.machinesRequest<FlyMachine>(
      appName,
      "POST",
      `/machines/${machineId}`,
      {
        config: updatedConfig,
        skip_launch: false,
      }
    );

    // Wait for the machine to be running again, then install sudo and repair pairing
    const moltbot = await this.waitForState(appName, machineId, "started");
    await this.installSudoAccess(appName);
    await this.repairGatewayPairing(appName);
    this.logger.info(`Moltbot updated: ${moltbotName}`, context);
    return moltbot;
  }

  /**
   * Restarts a moltbot.
   */
  async restartMoltbot(moltbotName: string): Promise<MoltbotInstance> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, operation: "restart" };

    this.logger.info(`Restarting moltbot: ${moltbotName}`, context);

    const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
    if (machines.length === 0) {
      throw new Error(`No machine found for moltbot: ${moltbotName}`);
    }

    const machineId = machines[0].id;
    await this.machinesRequest<void>(appName, "POST", `/machines/${machineId}/restart`);

    // Wait for restart, then reinstall sudo and repair pairing (container resets to base image)
    const moltbot = await this.waitForState(appName, machineId, "started");
    await this.installSudoAccess(appName);
    await this.repairGatewayPairing(appName);
    this.logger.info(`Moltbot restarted: ${moltbotName}`, context);
    return moltbot;
  }

  /**
   * Gets the public URL for a moltbot's OpenClaw Control UI.
   */
  getMoltbotUrl(moltbot: MoltbotInstance): string {
    return `https://${moltbot.hostname}`;
  }

  /**
   * Lists volumes for a moltbot.
   */
  async listVolumes(moltbotName: string): Promise<FlyVolume[]> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;

    return this.machinesRequest<FlyVolume[]>(appName, "GET", "/volumes");
  }

  /**
   * Lists snapshots for a specific volume.
   */
  async listVolumeSnapshots(moltbotName: string, volumeId: string): Promise<FlyVolumeSnapshot[]> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;

    return this.machinesRequest<FlyVolumeSnapshot[]>(appName, "GET", `/volumes/${volumeId}/snapshots`);
  }

  /**
   * Creates a manual snapshot of a volume.
   */
  async createVolumeSnapshot(moltbotName: string, volumeId: string): Promise<FlyVolumeSnapshot> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, volumeId, operation: "create-snapshot" };

    this.logger.info(`Creating snapshot for volume ${volumeId}`, context);

    const snapshot = await this.machinesRequest<FlyVolumeSnapshot>(
      appName,
      "POST",
      `/volumes/${volumeId}/snapshots`
    );

    this.logger.info(`Snapshot created: ${snapshot.id}`, { ...context, snapshotId: snapshot.id });
    return snapshot;
  }

  /**
   * Lists all snapshots across all moltbots.
   * Returns snapshots with moltbot context for the "deploy from snapshot" picker.
   */
  async listAllSnapshots(): Promise<Array<{
    id: string;
    moltbotName: string;
    volumeId: string;
    createdAt: string;
    sizeGb: number;
    label: string;
  }>> {
    const apps = await this.listMoltbotApps();
    const allSnapshots: Array<{
      id: string;
      moltbotName: string;
      volumeId: string;
      createdAt: string;
      sizeGb: number;
      label: string;
    }> = [];

    for (const app of apps) {
      const moltbotName = app.name.slice(MOLTBOT_APP_PREFIX.length);
      try {
        const volumes = await this.listVolumes(moltbotName);
        for (const volume of volumes) {
          try {
            const snapshots = await this.listVolumeSnapshots(moltbotName, volume.id);
            for (const snapshot of snapshots) {
              const date = new Date(snapshot.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              allSnapshots.push({
                id: snapshot.id,
                moltbotName,
                volumeId: volume.id,
                createdAt: snapshot.created_at,
                sizeGb: Math.ceil(snapshot.size / (1024 * 1024 * 1024)),
                label: `${moltbotName} - ${date}`,
              });
            }
          } catch {
            // Skip volumes we can't access snapshots for
          }
        }
      } catch {
        // Skip apps we can't access volumes for
      }
    }

    // Sort by creation date, newest first
    return allSnapshots.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Gets the list of hidden snapshot IDs for a moltbot.
   */
  async getHiddenSnapshots(moltbotName: string): Promise<string[]> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;

    try {
      const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
      if (machines.length === 0) {
        return [];
      }

      const metadata = await this.getMachineMetadata(appName, machines[0].id);
      const hiddenStr = metadata[HIDDEN_SNAPSHOTS_METADATA_KEY];
      return hiddenStr ? hiddenStr.split(",").filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Hides a snapshot by adding its ID to the hidden list in machine metadata.
   */
  async hideSnapshot(moltbotName: string, snapshotId: string): Promise<void> {
    const appName = moltbotName.startsWith(MOLTBOT_APP_PREFIX)
      ? moltbotName
      : `${MOLTBOT_APP_PREFIX}${moltbotName}`;
    const context = { moltbotName, appName, snapshotId, operation: "hide-snapshot" };

    this.logger.info(`Hiding snapshot: ${snapshotId}`, context);

    const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
    if (machines.length === 0) {
      throw new Error(`No machine found for moltbot: ${moltbotName}`);
    }

    const machineId = machines[0].id;
    const currentHidden = await this.getHiddenSnapshots(moltbotName);

    if (!currentHidden.includes(snapshotId)) {
      const newHidden = [...currentHidden, snapshotId].join(",");
      await this.setMachineMetadata(appName, machineId, HIDDEN_SNAPSHOTS_METADATA_KEY, newHidden);
    }

    this.logger.info(`Snapshot hidden: ${snapshotId}`, context);
  }

  /**
   * Deploys a new moltbot from an existing snapshot.
   * The snapshot must be from a volume in the same region.
   */
  async deployFromSnapshot(config: {
    snapshotId: string;
    sourceAppName: string;  // App where the snapshot exists
    newName: string;
    size?: "1gb" | "2gb" | "4gb";
    model?: string;
    env?: Record<string, string>;
  }): Promise<MoltbotInstance> {
    const appName = `${MOLTBOT_APP_PREFIX}${config.newName}`;
    const context = {
      newName: config.newName,
      appName,
      snapshotId: config.snapshotId,
      operation: "deploy-from-snapshot"
    };

    this.logger.info(`Deploying moltbot from snapshot: ${config.snapshotId}`, context);

    // 1. Create the app
    await this.createApp(appName);
    this.logger.info(`App created: ${appName}`, context);

    // 2. Allocate shared IPv4
    await this.allocateSharedIp(appName);
    this.logger.info(`IP allocated for: ${appName}`, context);

    // 3. Create volume from snapshot
    // Note: Fly requires size_gb to match the original volume size when forking
    // We create at 5GB (legacy size) then extend to 20GB
    const volumeName = "openclaw_data";
    const volumeResponse = await this.machinesRequest<{ id: string; name: string; size_gb: number }>(
      appName,
      "POST",
      "/volumes",
      {
        name: volumeName,
        region: this.config.region,
        size_gb: 5,  // Must match original snapshot's volume size
        snapshot_id: config.snapshotId,
      }
    );
    this.logger.info(`Volume created from snapshot: ${volumeResponse.id}`, context);

    // Extend volume to 20GB (our new default size)
    await this.machinesRequest<void>(
      appName,
      "PUT",
      `/volumes/${volumeResponse.id}/extend`,
      { size_gb: 20 }
    );
    this.logger.info(`Volume extended to 20GB`, context);

    // 4. Create the machine with gateway token
    const gatewayToken = crypto.randomUUID();
    const primaryModel = config.model || "anthropic/claude-sonnet-4-5";

    // Build OpenClaw config with selected model
    const openclawConfig = {
      agents: {
        defaults: {
          workspace: "/data/workspace",
          model: {
            primary: primaryModel,
            fallbacks: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
          },
          maxConcurrent: 4,
        },
        list: [{ id: "main", default: true }],
      },
      auth: {
        profiles: {
          "anthropic:default": { mode: "token", provider: "anthropic" },
          "openai:default": { mode: "token", provider: "openai" },
          "openrouter:default": { mode: "token", provider: "openrouter" },
        },
      },
      gateway: {
        mode: "local",
        bind: "lan",
        trustedProxies: ["172.16.0.0/12", "10.0.0.0/8"],
        controlUi: {
          allowInsecureAuth: true,
          dangerouslyDisableDeviceAuth: true,
          allowedOrigins: [`https://${appName}.fly.dev`, "http://localhost:3000", "http://127.0.0.1:3000"],
        },
      },
      meta: { lastTouchedVersion: "2026.1.29" },
    };

    const configJson = JSON.stringify(openclawConfig).replace(/'/g, "'\\''");

    const machineConfig: FlyMachineConfig = {
      image: "ghcr.io/openclaw/openclaw:latest",
      env: {
        NODE_ENV: "production",
        OPENCLAW_STATE_DIR: "/data",
        OPENCLAW_PREFER_PNPM: "1",
        NODE_OPTIONS: "--max-old-space-size=1536",
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        ...config.env,
      },
      guest: SIZE_SPECS[config.size || "2gb"],
      init: {
        user: "root",
      },
      restart: {
        policy: "always",
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: 3000,
        },
      ],
      checks: {
        httpget: {
          type: "http",
          port: 3000,
          path: "/",
          interval: "15s",
          timeout: "10s",
          grace_period: "300s",
        },
      },
      mounts: [
        {
          volume: volumeName,
          path: "/data",
        },
      ],
      processes: [
        {
          cmd: [
            "/bin/sh",
            "-c",
            // Don't overwrite config since we're restoring from snapshot
            `mkdir -p /data && [ -f /data/openclaw.json ] || printf '%s' '${configJson}' > /data/openclaw.json && exec node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan`,
          ],
        },
      ],
    };

    const createRequest: FlyMachineCreateRequest = {
      name: config.newName,
      region: this.config.region,
      config: machineConfig,
      skip_launch: false,
    };

    try {
      const machine = await this.machinesRequest<FlyMachine>(
        appName,
        "POST",
        "/machines",
        createRequest
      );

      this.logger.info(`Moltbot created from snapshot: ${machine.id}`, {
        ...context,
        machineId: machine.id,
        region: machine.region,
      });

      // Store the gateway token in machine metadata
      await this.setMachineMetadata(appName, machine.id, GATEWAY_TOKEN_METADATA_KEY, gatewayToken);
      this.logger.info(`Gateway token stored in metadata`, { ...context, machineId: machine.id });

      // Wait for machine to be started, then install sudo access and repair pairing
      await this.waitForState(appName, machine.id, "started", 120000);
      await this.installSudoAccess(appName);
      await this.repairGatewayPairing(appName);

      const instance = this.mapMachineToInstance(machine, appName);
      instance.gatewayToken = gatewayToken;
      return instance;
    } catch (error) {
      // Clean up the app if machine creation fails
      this.logger.error(`Failed to create machine from snapshot, cleaning up app: ${appName}`,
        error instanceof Error ? error : new Error(String(error)), context);
      try {
        await this.deleteApp(appName);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async waitForState(
    appName: string,
    machineId: string,
    targetState: MoltbotStatus,
    timeoutMs = 60000
  ): Promise<MoltbotInstance> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const machines = await this.machinesRequest<FlyMachine[]>(appName, "GET", "/machines");
      const machine = machines.find((m) => m.id === machineId);

      if (!machine) {
        throw new Error(`Machine ${machineId} not found`);
      }

      if (this.mapFlyState(machine.state) === targetState) {
        return this.mapMachineToInstance(machine, appName);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
      `Timeout waiting for machine ${machineId} to reach state ${targetState}`
    );
  }

  private mapMachineToInstance(machine: FlyMachine, appName: string): MoltbotInstance {
    // Remove the prefix to get the moltbot name
    const name = appName.startsWith(MOLTBOT_APP_PREFIX)
      ? appName.slice(MOLTBOT_APP_PREFIX.length)
      : machine.name;

    return {
      id: machine.id,
      name,
      status: this.mapFlyState(machine.state),
      region: machine.region,
      createdAt: machine.created_at,
      hostname: `${appName}.fly.dev`,
      privateIp: machine.private_ip || null,
    };
  }

  private mapFlyState(flyState: string): MoltbotStatus {
    const stateMap: Record<string, MoltbotStatus> = {
      created: "created",
      starting: "starting",
      started: "started",
      stopping: "stopping",
      stopped: "stopped",
      destroying: "destroying",
      destroyed: "destroyed",
    };
    return stateMap[flyState] || "stopped";
  }

  /**
   * Repairs gateway device pairing after agent restarts.
   *
   * Background: OpenClaw has two main processes — the **gateway** (serves the web UI,
   * handles HTTP/WebSocket traffic) and the **agent** (the AI that actually does work).
   * The agent talks to the gateway over a local WebSocket RPC connection to access
   * tools like cron, the browser, scheduled tasks, etc.
   *
   * Starting in OpenClaw 2026.2.9, the gateway requires agents to be "paired" before
   * it will accept their RPC commands. This is a security feature — it prevents
   * unauthorized processes from controlling the gateway. Each agent generates a unique
   * device identity (a keypair) on first run, and the gateway must approve ("pair")
   * that identity before the agent can use any gateway-provided tools.
   *
   * The problem: when a moltbot restarts or updates, the agent process often gets a
   * brand-new device identity. The gateway sees an unknown device and puts it in a
   * "pending approval" queue (/data/devices/pending.json). Since nobody is around to
   * click "approve" in the UI, the agent gets stuck — cron jobs stop, browser tools
   * break, and all gateway RPC fails. Discord still works because it connects directly
   * to the agent, bypassing the gateway entirely.
   *
   * This method auto-approves any pending pairing requests by:
   * 1. Reading /data/devices/pending.json — if empty, exits (no-op)
   * 2. Generating auth tokens and appending approved entries to /data/devices/paired.json
   * 3. Clearing /data/devices/pending.json
   * 4. Writing /data/identity/device-auth.json so the agent knows its own token
   * 5. Sending SIGUSR1 to the gateway process (graceful config reload)
   * 6. Fixing file ownership (SSH runs as root, but gateway runs as node)
   *
   * Safe no-op when there are no pending entries — reads one file and exits.
   */
  async repairGatewayPairing(appName: string): Promise<void> {
    const context = { appName, operation: "repair-gateway-pairing" };
    this.logger.info(`Repairing gateway pairing`, context);

    // Node.js script to run on the machine via SSH
    // Reads pending.json, approves any pending entries, updates device-auth, signals gateway
    // Base64-encoded to avoid shell quoting issues with nested quotes
    const script = `
const fs = require("fs");
const crypto = require("crypto");

const PENDING_PATH = "/data/devices/pending.json";
const PAIRED_PATH = "/data/devices/paired.json";
const DEVICE_AUTH_PATH = "/data/identity/device-auth.json";

// Read pending entries
let pending = {};
try { pending = JSON.parse(fs.readFileSync(PENDING_PATH, "utf8")); } catch { process.exit(0); }

const keys = Object.keys(pending);
if (keys.length === 0) { process.exit(0); }

console.log("Found " + keys.length + " pending pairing(s), approving...");

// Read existing paired entries
let paired = {};
try { paired = JSON.parse(fs.readFileSync(PAIRED_PATH, "utf8")); } catch {}

// Approve each pending entry
const now = Date.now();
for (const deviceId of keys) {
  const entry = pending[deviceId];
  const role = entry.role || "operator";
  const scopes = entry.scopes || ["operator.admin", "operator.approvals", "operator.pairing"];
  const token = crypto.randomBytes(16).toString("hex");

  paired[deviceId] = {
    ...entry,
    tokens: {
      [role]: { token, role, scopes, createdAtMs: now }
    },
    createdAtMs: entry.createdAtMs || now,
    approvedAtMs: now,
  };

  // Update device-auth for this device
  try {
    fs.mkdirSync("/data/identity", { recursive: true });
    fs.writeFileSync(DEVICE_AUTH_PATH, JSON.stringify({
      version: 1,
      deviceId,
      tokens: { [role]: { token, role, scopes, updatedAtMs: now } }
    }, null, 2));
  } catch (e) { console.error("Failed to write device-auth:", e.message); }
}

// Write updated paired entries
fs.mkdirSync("/data/devices", { recursive: true });
fs.writeFileSync(PAIRED_PATH, JSON.stringify(paired, null, 2));

// Clear pending
fs.writeFileSync(PENDING_PATH, JSON.stringify({}, null, 2));

// Fix ownership - SSH runs as root but gateway runs as node
const { execSync } = require("child_process");
try { execSync("chown -R node:node /data/devices /data/identity"); } catch {}

// Signal gateway to reload (SIGUSR1) — match OpenClaw's process name (not always "node ... gateway")
try {
  const pid = execSync("pgrep -f openclaw-gateway || pgrep -f 'node.*gateway' || true")
    .toString()
    .trim()
    .split("\\n")[0];
  if (pid) { process.kill(parseInt(pid), "SIGUSR1"); console.log("Sent SIGUSR1 to gateway pid " + pid); }
} catch (e) { console.error("Failed to signal gateway:", e.message); }

console.log("Gateway pairing repaired for " + keys.length + " device(s)");
`.trim();

    const scriptB64 = Buffer.from(script).toString("base64");

    const maxRetries = 5;
    const retryDelayMs = 10000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`Repair pairing (attempt ${attempt}/${maxRetries})`, context);
        await execAsync(
          `fly ssh console -a ${appName} -C "echo ${scriptB64} | base64 -d | node"`,
          { timeout: 60000 }
        );
        this.logger.info(`Gateway pairing repair completed`, context);
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          this.logger.info(`SSH attempt ${attempt} failed, retrying in ${retryDelayMs / 1000}s...`, context);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } else {
          this.logger.error(
            `Failed to repair gateway pairing after ${maxRetries} attempts (non-fatal)`,
            error instanceof Error ? error : new Error(String(error)),
            context
          );
        }
      }
    }
  }

  /**
   * Installs sudo and configures passwordless access for the node user.
   * This must be done via SSH because the startup command runs as 'node' user
   * (docker-entrypoint.sh switches from root to node for security).
   * SSH sessions connect as root, bypassing the entrypoint.
   */
  async installSudoAccess(appName: string): Promise<void> {
    const context = { appName, operation: "install-sudo" };
    this.logger.info(`Installing sudo access for node user`, context);

    // Retry logic for SSH connection - moltbots can take 2-3 minutes to fully start
    const maxRetries = 10;
    const retryDelayMs = 15000; // 15 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`Installing sudo (attempt ${attempt}/${maxRetries})`, context);
        // Run commands via fly ssh console (connects as root)
        await execAsync(`fly ssh console -a ${appName} -C 'apt-get update -qq'`, { timeout: 120000 });
        await execAsync(`fly ssh console -a ${appName} -C 'apt-get install -y -qq sudo'`, { timeout: 120000 });
        await execAsync(
          `fly ssh console -a ${appName} -C "sh -c 'echo \\"node ALL=(ALL) NOPASSWD: ALL\\" > /etc/sudoers.d/node && chmod 440 /etc/sudoers.d/node'"`,
          { timeout: 60000 }
        );
        this.logger.info(`Sudo access installed successfully`, context);
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          this.logger.info(`SSH attempt ${attempt} failed, retrying in ${retryDelayMs / 1000}s...`, context);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } else {
          // Log but don't fail - sudo is nice to have but not critical
          this.logger.error(
            `Failed to install sudo access after ${maxRetries} attempts (non-fatal)`,
            error instanceof Error ? error : new Error(String(error)),
            context
          );
        }
      }
    }
  }
}
