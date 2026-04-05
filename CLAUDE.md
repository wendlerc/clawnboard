# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawnBoard is a local dashboard for deploying and managing OpenClaw AI agents ("moltbots") on Fly.io. Full-stack TypeScript monorepo with a Next.js frontend (port 3000) and Hono API backend (port 3001).

## Commands

```bash
pnpm dev          # Start all dev servers (Next.js + Hono via Turbo)
pnpm build        # Build all packages
pnpm lint         # Run linting
pnpm test         # Run all tests (Vitest)
pnpm setup        # One-time setup (checks prerequisites, creates .env)
```

Run a single test file:
```bash
pnpm --filter vm-provisioner exec vitest run src/fly-provisioner.test.ts
pnpm --filter api exec vitest run src/routes/moltbots.test.ts
```

## Architecture

**Monorepo** (Turbo + pnpm 9.15):
- `apps/web` — Next.js 15 dashboard (App Router, Tailwind, Radix UI)
- `apps/api` — Hono REST API server
- `packages/shared` — Shared TypeScript types and constants (Moltbot, MoltbotStatus, AI model definitions)
- `packages/vm-provisioner` — Fly.io VM provisioning (`FlyProvisioner`, `HealthChecker`, logger)

**No database.** All state lives in Fly.io: machine metadata stores gateway tokens, hidden snapshot lists, and provider config. OpenClaw workspace data lives on persistent volumes.

**Per-app model:** Each moltbot is its own Fly.io app (not a machine in a shared app) — gives automatic DNS, isolation, and independent lifecycle.

**AI provider failover chain:** openrouter/free → Gemini 2.5 Flash → Gemini 2.5 Pro → GPT-4o → Claude Sonnet 4.5 → Claude Opus 4.5. Configured per-moltbot via machine env vars.

**Gateway token security:** Each moltbot gets a unique UUID stored in Fly.io machine metadata. Only org-token holders can retrieve it.

## Key Patterns

- API request validation uses Zod schemas
- Tests mock `node:child_process` (SSH commands), `node:crypto` (UUIDs), and `fetch` (Fly API). Test files are colocated with source (`.test.ts` suffix).
- Volume snapshots support cloning moltbots; hidden snapshots are tracked in machine metadata
- Docker image (`docker/Dockerfile.moltbot`) runs as non-root `moltbot` user on `node:22-slim`

## Environment Variables

API server (`apps/api/.env`):
- `FLY_API_TOKEN` — Required. Must be org token, not deploy token.
- `FLY_REGION` — Deployment region (default: `iad`)
- `ANTHROPIC_API_KEY` / `ANTHROPIC_SETUP_TOKEN` — Mutually exclusive; setup-token is for Claude subscription
- `OPENAI_API_KEY`, `OPENROUTER_API_KEY` — Optional provider keys
- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` — Optional Discord bootstrap

Web (`apps/web/.env`):
- `NEXT_PUBLIC_API_URL` — Points to API (default: `http://localhost:3001`)
