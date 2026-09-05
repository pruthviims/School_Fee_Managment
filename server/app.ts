import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { attachAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { collectionRouter, webhookHandler } from "./routes/collection.js";
import { importRouter } from "./routes/import.js";
import { promotionRouter } from "./routes/promotion.js";
import { setupRouter } from "./routes/setup.js";
import { staffRouter } from "./routes/staff.js";
import { studentsRouter } from "./routes/students.js";

export const app = express();

app.use(helmet());
// Vercel gives one project several real URLs — a production alias, a
// per-branch preview (what's actually being tested here), and a
// per-deployment preview — so locking CORS to one exact string is
// fragile by construction, not a one-off oversight. Accepting any
// *.vercel.app origin (plus FRONTEND_URL and localhost for local dev)
// covers all of them without needing to know which one a given request
// came from. This app is self-hosted for one person's own use rather
// than a multi-tenant SaaS, which is what makes this trade-off
// reasonable — the real access control is still the session cookie and
// login credentials underneath, not the origin check.
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // curl, server-to-server, same-origin
    const allowed = origin === process.env.FRONTEND_URL ||
      origin.endsWith(".vercel.app") ||
      origin.startsWith("http://localhost");
    callback(allowed ? null : new Error("Not allowed by CORS"), allowed);
  },
  credentials: true,
}));

// Registered ahead of the general JSON parser, deliberately: HMAC
// verification needs the exact bytes the gateway signed, and by the time
// express.json() below has parsed and could re-serialise a body, key
// ordering may have changed and every signature would fail. attachAuth
// still needs to run first so req.user/school resolve the same way here
// as everywhere else, even though this route is otherwise unauthenticated
// (the signature check IS the authentication).
app.use(cookieParser());
app.use(attachAuth);
app.post("/api/collection/webhook/:gateway", express.raw({ type: "*/*" }), webhookHandler);

app.use(express.json());

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
app.use("/api/setup", setupRouter);
app.use("/api/students", studentsRouter);
app.use("/api/billing", billingRouter);
app.use("/api/collection", collectionRouter);
app.use("/api/promotion", promotionRouter);
app.use("/api/import", importRouter);

// Keep error details out of responses — logged server-side only, since a
// stack trace is an information leak, not a debugging aid, once this is
// live for anyone but the developer running it locally.
app.use((err: unknown, _req: express.Request, res: express.Response,
         // eslint-disable-next-line @typescript-eslint/no-unused-vars
         _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ detail: "Something went wrong." });
});
