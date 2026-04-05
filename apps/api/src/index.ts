import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { app } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Always load apps/api/.env (monorepo-safe; cwd is not always apps/api)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (process.env.FLY_API_TOKEN) {
  process.env.FLY_API_TOKEN = process.env.FLY_API_TOKEN.trim();
}

const flyTok = process.env.FLY_API_TOKEN;
if (!flyTok || flyTok.includes("paste-your-org-token")) {
  console.error(
    "[clawnboard-api] FLY_API_TOKEN is missing or still the placeholder in apps/api/.env.\n" +
      "  `fly auth login` only affects the CLI. Copy a token into FLY_API_TOKEN, e.g.:\n" +
      "    fly tokens create org -x 999999h\n" +
      "  Then restart the dev server."
  );
}

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`Starting ClawnBoard API server on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`ClawnBoard API server running at http://localhost:${port}`);
