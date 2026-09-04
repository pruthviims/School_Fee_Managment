import type { Role } from "../permissions.js";

export interface RequestUser {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  password_hash: string | null;
}

export interface RequestMembership {
  id: string;
  role: Role;
  is_active: boolean;
}

export interface RequestSchool {
  id: string;
  name: string;
  short_code: string;
  address: string;
  logo_key: string;
  receipt_footer: string;
  is_active: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser | null;
      membership?: RequestMembership | null;
      school?: RequestSchool | null;
    }
  }
}

export {};
