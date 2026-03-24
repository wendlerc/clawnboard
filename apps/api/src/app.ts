import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { moltbotsRouter, snapshotsRouter } from "./routes/moltbots.js";
import { healthRouter } from "./routes/health.js";
import { errorHandler } from "./middleware/error-handler.js";

export const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: (origin) => {
      const fromEnv = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
      if (fromEnv?.length) {
        return fromEnv.includes(origin ?? "") ? origin : fromEnv[0];
      }
      // Dev: allow Next.js on localhost or 127.0.0.1 (any port)
      if (!origin) {
        return "http://localhost:3000";
      }
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return origin;
      }
      return "http://localhost:3000";
    },
    credentials: true,
  })
);

// Error handling
app.onError(errorHandler);

// Routes
app.route("/health", healthRouter);
app.route("/api/moltbots", moltbotsRouter);
app.route("/api/snapshots", snapshotsRouter);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found",
      },
    },
    404
  );
});
