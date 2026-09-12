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

// For the small number of actions two otherwise-unrelated capabilities
// both legitimately cover — raising a TC or refund request, for
// instance, where Front Desk qualifies via manage_admissions/
// collect_payments and Accountant via manage_tc/void_payments, without
// either role needing a capability that grants them powers they don't
// actually have. Passes if the membership holds any one of the given
// capabilities; still a hard 403 if it holds none of them.
export function requireAnyCapability(...capabilities: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!capabilities.some((c) => membershipCan(req.membership, c))) {
      return res.status(403).json({ detail: `Your role doesn't include any of: ${capabilities.join(", ")}.` });
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
