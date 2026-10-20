export const ROLES = ['operator', 'supervisor', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Roles are ordered: each one can do everything the previous one can. */
export function atLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  fullName: string;
}

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export const EVENT_TYPES = [
  'fight',
  'person_down',
  'perimeter_breach',
  'restricted_zone',
  'gathering',
  'camera_tamper',
  'camera_offline',
  'running',
  'abandoned_object',
  'prolonged_inactivity',
  'count_mismatch',
] as const;

/** Why an operator dismissed an alert. Used to measure and fix false alarms. */
export const DISMISS_REASONS = ['false_detection', 'normal_activity', 'duplicate', 'camera_issue', 'other'] as const;
