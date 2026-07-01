import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function stringValue(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const cleaned = clean(value);
      if (cleaned !== undefined) return cleaned;
    }
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseHerdrStatusSessionName(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const root = objectValue(parsed);
  if (root === undefined) return undefined;
  for (const sectionName of ["client", "server"]) {
    const section = objectValue(root[sectionName]);
    const session = section?.session;
    if (typeof session === "string") {
      const cleaned = clean(session);
      if (cleaned !== undefined) return cleaned;
    }
    const sessionObject = objectValue(session);
    const fromObject = sessionObject === undefined
      ? undefined
      : stringValue(sessionObject, "name", "id", "session");
    if (fromObject !== undefined) return fromObject;
  }
  return stringValue(root, "session", "session_name", "sessionName");
}

export function activeHerdrSessionName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const reuse = clean(env.CICLO_REUSE_HERDR_SESSION)?.toLowerCase();
  if (reuse === "0" || reuse === "false" || reuse === "no") return undefined;

  const fromEnv = clean(env.CICLO_HERDR_SESSION) ??
    clean(env.HERDR_SESSION_NAME) ??
    clean(env.HERDR_SESSION);
  if (fromEnv !== undefined) return fromEnv;

  const result = spawnSync("herdr", ["status", "--json"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseHerdrStatusSessionName(result.stdout);
}

export function repoSessionName(root = process.cwd()): string {
  const explicit = clean(process.env.CICLO_SESSION_NAME);
  if (explicit !== undefined) return explicit;
  const activeHerdr = activeHerdrSessionName();
  if (activeHerdr !== undefined) return activeHerdr;
  const name = basename(resolve(root))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length === 0 ? "ciclo" : name;
}
