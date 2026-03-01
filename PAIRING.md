# OpenClaw Pairing Explained

## Two Different Pairing Flows

OpenClaw has **two** separate pairing mechanisms:

### 1. Agent pairing (inside the container)
The **agent** process (the AI) must pair with the gateway to use tools like cron, browser, etc. When the agent restarts, it gets a new device identity and goes into a "pending" queue.

**ClawnBoard's "Repair Pairing"** fixes this: it SSHes in, reads `/data/devices/pending.json`, approves any agent devices, and signals the gateway to reload.

### 2. Browser/Control UI pairing (your web session)
When you open the Control UI in a **browser** at `https://moltbot-gary.fly.dev/?token=xxx`, your **browser** is also a "device" that must pair. Even with the correct token, the gateway requires a one-time approval for remote connections.

**What you see:** "disconnected (1008): pairing required"

**Why:** Local connections (127.0.0.1) are auto-approved. Remote connections (LAN, internet, Fly.io proxy) require explicit approval.

## How to Fix "Pairing required" in the Browser

### Option A: Approve from inside the container (recommended)

1. **Open the dashboard** in your browser first — this creates the pending request:
   ```
   https://moltbot-gary.fly.dev/?token=YOUR_GATEWAY_TOKEN
   ```
   (Leave it on the "pairing required" screen)

2. **SSH in and approve** the pending device:
   ```bash
   fly ssh console -a moltbot-gary
   ```
   Then inside the container:
   ```bash
   openclaw devices list
   openclaw devices approve --latest
   ```
   Or approve a specific request:
   ```bash
   openclaw devices approve <requestId>
   ```

3. **Refresh the browser** — it should connect.

### Option B: Delete and recreate the moltbot
If the above doesn't work, delete the moltbot in ClawnBoard and create a new one. A fresh deploy sometimes avoids pairing issues.

## Timing
Pending requests **expire after 5 minutes**. If you run `devices approve` and nothing is pending, open the browser again to create a new request, then approve quickly.

## Why "Repair Pairing" didn't help
The Repair Pairing button approves **agent** devices (the AI process). Your **browser** is a separate device that needs approval via `openclaw devices approve`. The repair script and the devices CLI both use `/data/devices/`, but the repair script may run before your browser creates its pending request, or the formats might differ slightly.
