"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { VM_SPECS, AI_MODELS, DEFAULT_MODEL, ACP_AGENTS } from "@clawnboard/shared";
import type { MoltbotSize, AIModelId, AcpAgent, AcpConfig } from "@clawnboard/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

interface CreateMoltbotDialogProps {
  children: React.ReactNode;
}

interface ProviderStatus {
  anthropic: boolean;
  openai: boolean;
  openrouter: boolean;
}

export function CreateMoltbotDialog({ children }: CreateMoltbotDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [size, setSize] = useState<MoltbotSize>("2gb");
  const [model, setModel] = useState<AIModelId>(DEFAULT_MODEL);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus>({ anthropic: false, openai: false, openrouter: false });

  // ACP state
  const [acpEnabled, setAcpEnabled] = useState(true);
  const [acpDefaultAgent, setAcpDefaultAgent] = useState<AcpAgent>("claude");
  const [acpAllowedAgents, setAcpAllowedAgents] = useState<AcpAgent[]>(
    ["claude", "codex", "gemini", "opencode", "pi"]
  );

  // Fetch available providers when dialog opens
  useEffect(() => {
    if (open) {
      fetch(`${API_URL}/health/providers`)
        .then((res) => res.json())
        .then((data) => {
          setProviders(data.providers);
          // If current model's provider is unavailable, switch to an available one
          const currentProvider = AI_MODELS[model].provider;
          if (!data.providers[currentProvider]) {
            // Find first available model
            const availableModel = (Object.entries(AI_MODELS) as [AIModelId, typeof AI_MODELS[AIModelId]][]).find(
              ([, m]) => data.providers[m.provider]
            );
            if (availableModel) {
              setModel(availableModel[0]);
            }
          }
        })
        .catch(() => {
          // Assume all available if we can't check
          setProviders({ anthropic: true, openai: true, openrouter: true });
        });
    }
  }, [open, model]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const acpConfig: AcpConfig | undefined = acpEnabled
      ? {
          enabled: true,
          defaultAgent: acpDefaultAgent,
          allowedAgents: acpAllowedAgents,
          maxConcurrentSessions: 8,
        }
      : undefined;

    try {
      const res = await fetch(`${API_URL}/api/moltbots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, size, model, acpConfig }),
      });
      const data = await res.json();

      if (data.success) {
        setOpen(false);
        setName("");
        setSize("2gb");
        setModel(DEFAULT_MODEL);
        router.refresh();
        window.location.reload();
      } else {
        setError(data.error?.message || "Failed to create moltbot");
      }
    } catch {
      setError("Failed to connect to API");
    } finally {
      setIsLoading(false);
    }
  };

  const isModelAvailable = (modelId: AIModelId) => {
    const provider = AI_MODELS[modelId].provider;
    return providers[provider as keyof ProviderStatus];
  };

  const hasAnyProvider = providers.anthropic || providers.openai || providers.openrouter;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[475px]">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Bot className="h-5 w-5 text-primary" />
            <span>Create New Moltbot</span>
          </DialogTitle>
          <DialogDescription>
            Deploy a new OpenClaw instance on Fly.io.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <div>
              <Label htmlFor="name">Name</Label>
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only</p>
            </div>
            <Input
              id="name"
              placeholder="e.g., my-assistant"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              required
            />
          </div>

          <div className="space-y-1.5">
            <div>
              <Label htmlFor="model">Default Model</Label>
              <p className="text-xs text-muted-foreground">You can change this later</p>
            </div>
            <Select value={model} onValueChange={(v) => setModel(v as AIModelId)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(AI_MODELS) as [AIModelId, typeof AI_MODELS[AIModelId]][]).map(([key, m]) => {
                  const available = isModelAvailable(key);
                  return (
                    <SelectItem key={key} value={key} disabled={!available}>
                      <div className="flex items-center gap-2">
                        <span className={available ? "font-medium" : "text-muted-foreground"}>
                          {m.label}
                        </span>
                        {!available && (
                          <span className="text-xs text-muted-foreground">
                            (no API key)
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="size">Instance Size</Label>
            <Select value={size} onValueChange={(v) => setSize(v as MoltbotSize)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(VM_SPECS) as [MoltbotSize, typeof VM_SPECS["2gb"]][]).map(([key, spec]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-medium">{spec.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {spec.pricePerMonth}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ACP Subagents */}
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>ACP Subagents</Label>
                <p className="text-xs text-muted-foreground">
                  Enable coding agents (Claude Code, Codex, etc.) as subagents
                </p>
              </div>
              <Switch checked={acpEnabled} onCheckedChange={setAcpEnabled} />
            </div>

            {acpEnabled && (
              <div className="space-y-3 pl-1">
                <div className="space-y-1.5">
                  <Label>Default Agent</Label>
                  <Select value={acpDefaultAgent} onValueChange={(v) => setAcpDefaultAgent(v as AcpAgent)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.entries(ACP_AGENTS) as [AcpAgent, (typeof ACP_AGENTS)[AcpAgent]][]).map(
                        ([key, agent]) => (
                          <SelectItem
                            key={key}
                            value={key}
                            disabled={!acpAllowedAgents.includes(key)}
                          >
                            <span className="font-medium">{agent.label}</span>
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Allowed Agents</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.entries(ACP_AGENTS) as [AcpAgent, (typeof ACP_AGENTS)[AcpAgent]][]).map(
                      ([key, agent]) => (
                        <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded border-input"
                            checked={acpAllowedAgents.includes(key)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setAcpAllowedAgents((prev) => [...prev, key]);
                              } else {
                                const remaining = acpAllowedAgents.filter((a) => a !== key);
                                setAcpAllowedAgents(remaining);
                                if (acpDefaultAgent === key && remaining.length > 0) {
                                  setAcpDefaultAgent(remaining[0]);
                                }
                              }
                            }}
                          />
                          {agent.label}
                        </label>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {!hasAnyProvider && (
            <p className="text-sm text-destructive">
              No AI provider API keys configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to your .env file.
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name || isLoading || !hasAnyProvider}>
              {isLoading ? "Creating..." : "Create Moltbot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
