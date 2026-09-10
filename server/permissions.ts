/**
 * Capability matrix per role — the single source of truth both the
 * requireCapability middleware and the /api/auth/me response read from,
 * so the server's enforcement and whatever the frontend shows can't
 * drift apart from each other. Directly ported from
 * backend/accounts/models.py's ROLE_CAPABILITIES.
 */

export type Role = "owner" | "accountant" | "front_desk" | "viewer";

export const ROLE_CAPABILITIES: Record<Role, Set<string>> = {
  owner: new Set([
    "manage_staff", "manage_fee_structure", "manage_transport",
    "manage_admissions", "collect_payments", "manage_concessions",
    "view_reports", "edit_school_profile", "void_payments", "view_audit_log", "manage_tc",
  ]),
  accountant: new Set([
    "manage_fee_structure", "manage_transport", "collect_payments",
    "manage_concessions", "view_reports", "void_payments", "view_audit_log", "manage_tc",
  ]),
  front_desk: new Set(["manage_admissions", "collect_payments"]),
  viewer: new Set(["view_reports"]),
};

export function capabilitiesFor(role: Role, isActive: boolean): string[] {
  if (!isActive) return [];
  return Array.from(ROLE_CAPABILITIES[role] ?? []);
}

export function membershipCan(
  membership: { role: Role; is_active: boolean } | null | undefined,
  capability: string,
): boolean {
  if (!membership) return false;
  return capabilitiesFor(membership.role, membership.is_active).includes(capability);
}
