import { randomUUID } from "node:crypto";

export const ID_PREFIXES = [
  "usr",
  "ext",
  "grp",
  "mem",
  "agt",
  "key",
  "msg",
  "thr",
  "tsk",
  "run",
  "evt",
  "evd",
  "aud",
  "chl",
  "ses",
  "tkt",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const ID_PATTERN = new RegExp(`^(${ID_PREFIXES.join("|")})_[0-9a-f]{32}$`);

/**
 * All primary keys are prefixed UUIDv4 values without dashes: opaque, stable
 * and safe to expose in URLs. One scheme for the whole project (plan §6.2).
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function idOfPrefix(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`);
}
