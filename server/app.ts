import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { attachAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { staffRouter } from "./routes/staff.js";

export const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(attachAuth);

// Login is the one endpoint worth a tighter, dedicated limit — it's the
// obvious target for credential-stuffing attempts. Skipped in tests: a
// legitimate test run hits these endpoints far more than 20 times in
// 15 minutes, and rate limiting is an infra concern, not something a
// correctness test should be fighting against.
if (process.env.NODE_ENV !== "test") {
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });
  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth/password-reset", loginLimiter);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/staff", staffRouter);

// Keep error details out of responses — logged server-side only, since a
// stack trace is an information leak, not a debugging aid, once this is
// live for anyone but the developer running it locally.
app.use((err: unknown, _req: express.Request, res: express.Response,
         // eslint-disable-next-line @typescript-eslint/no-unused-vars
         _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ detail: "Something went wrong." });
});
