import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJsonVersion {
  readonly version?: unknown;
}

function readPackageVersion(): string {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonVersion;
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`package.json is missing a string version: ${packageJsonPath}`);
  }
  return packageJson.version;
}

export const CICLO_VERSION = readPackageVersion();
