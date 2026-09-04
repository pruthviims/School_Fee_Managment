/**
 * The actual enforcement boundary. A restriction that only hides a
 * button in the browser isn't a restriction at all — anyone can call the
 * API directly — so every capability check has to live here, on the
 * server, regardless of what the frontend does or doesn't show.
 */

import type { NextFunction, Request, Response } from "express";
import { membershipCan } from "../permissions.js";

export function requireMember(req: Request, res: Response, next: NextFunction) {
  if (!req.membership) {
    return res.status(403).json({ detail: "You don't have access to this school." });
  }
  next();
}

export function requireCapability(capability: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!membershipCan(req.membership, capability)) {
      return res.status(403).json({ detail: `Your role doesn't include '${capability}'.` });
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ detail: "Sign in required." });
  }
  next();
}
