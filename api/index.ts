// Vercel loads this file as a single Function and forwards every request
// under /api/* to it (see vercel.json's rewrites). The whole Express app
// — routes, middleware, everything in server/ — runs inside this one
// function; Express itself does the routing from here.
import { app } from "../server/app.js";

export default app;
