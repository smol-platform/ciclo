import { basename, resolve } from "node:path";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function repoSessionName(root = process.cwd()): string {
  const explicit = clean(process.env.CICLO_SESSION_NAME);
  if (explicit !== undefined) return explicit;
  const name = basename(resolve(root))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length === 0 ? "ciclo" : name;
}
