import type { HarnessId, LoopConfig } from "./ciclo-core.js";

export interface TriggerConfig {
  readonly event: string;
  readonly when: string;
}

export interface PolicyConfig {
  readonly mode: "dry_run" | "supervised" | "autonomous";
  readonly requireApprovalFor: readonly string[];
  readonly allowCommands: readonly string[];
}

export interface ExitCriteria {
  readonly success: readonly string[];
  readonly failure: readonly string[];
}

export interface ProjectLoopConfig {
  readonly loop: LoopConfig;
  readonly triggers: readonly TriggerConfig[];
  readonly policy: PolicyConfig;
  readonly exitCriteria: ExitCriteria;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitKeyValue(line: string): readonly [string, string] {
  const separator = line.indexOf(":");
  if (separator <= 0) {
    throw new ConfigError(`invalid loop config line: ${line}`);
  }
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
}

function appendScalarListItem(container: Record<string, unknown>, key: string, value: string): void {
  const items = container[key];
  if (!Array.isArray(items)) {
    throw new ConfigError(`${key} must be a list`);
  }
  items.push(parseScalar(value));
}

export function parseLoopYamlSubset(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentSection: string | undefined;
  let currentNestedList: string | undefined;
  let currentTrigger: Record<string, unknown> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (indent === 0) {
      const [key, value] = splitKeyValue(line);
      currentSection = undefined;
      currentNestedList = undefined;
      currentTrigger = undefined;

      if (value.length > 0) {
        root[key] = parseScalar(value);
        continue;
      }

      root[key] = key === "harnesses" || key === "triggers" ? [] : {};
      currentSection = key;
      continue;
    }

    if (currentSection === undefined) {
      throw new ConfigError(`nested value without section: ${line}`);
    }

    if (currentSection === "harnesses") {
      if (indent !== 2 || !line.startsWith("- ")) {
        throw new ConfigError("harnesses must be a scalar list");
      }
      appendScalarListItem(root, "harnesses", line.slice(2).trim());
      continue;
    }

    if (currentSection === "triggers") {
      const triggers = root.triggers;
      if (!Array.isArray(triggers)) throw new ConfigError("triggers must be a list");
      if (indent === 2 && line.startsWith("- ")) {
        currentTrigger = {};
        triggers.push(currentTrigger);
        const itemLine = line.slice(2).trim();
        if (itemLine.length > 0) {
          const [key, value] = splitKeyValue(itemLine);
          currentTrigger[key] = parseScalar(value);
        }
        continue;
      }
      if (indent === 4 && currentTrigger !== undefined) {
        const [key, value] = splitKeyValue(line);
        currentTrigger[key] = parseScalar(value);
        continue;
      }
      throw new ConfigError("triggers must be a list of objects");
    }

    if (currentSection === "policy" || currentSection === "exit_criteria") {
      const section = root[currentSection];
      if (section === null || typeof section !== "object" || Array.isArray(section)) {
        throw new ConfigError(`${currentSection} must be an object`);
      }
      const record = section as Record<string, unknown>;
      if (indent === 2) {
        const [key, value] = splitKeyValue(line);
        if (value.length > 0) {
          record[key] = parseScalar(value);
          currentNestedList = undefined;
        } else {
          record[key] = [];
          currentNestedList = key;
        }
        continue;
      }
      if (indent === 4 && line.startsWith("- ") && currentNestedList !== undefined) {
        appendScalarListItem(record, currentNestedList, line.slice(2).trim());
        continue;
      }
      throw new ConfigError(`${currentSection} contains unsupported YAML`);
    }

    throw new ConfigError(`unsupported loop config section: ${currentSection}`);
  }

  return root;
}

function asRecord(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
  return value;
}

function expectStringList(data: Record<string, unknown>, key: string): readonly string[] {
  const value = data[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${key} must be a list of strings`);
  }
  return value as readonly string[];
}

function expectHarness(value: string): HarnessId {
  if (value === "pi" || value === "codex" || value === "claude-code" || value === "unknown") {
    return value;
  }
  throw new ConfigError(`harnesses must contain supported harness ids; got ${value}`);
}

function expectLoopKind(value: string): LoopConfig["kind"] {
  if (
    value === "review" ||
    value === "deploy" ||
    value === "triage" ||
    value === "benchmark" ||
    value === "beads_work"
  ) {
    return value;
  }
  throw new ConfigError(`kind must be review, deploy, triage, benchmark, or beads_work; got ${value}`);
}

function validatePolicy(raw: unknown): PolicyConfig {
  const data = asRecord(raw ?? {}, "policy");
  const mode = (data.mode ?? "dry_run") as unknown;
  if (mode !== "dry_run" && mode !== "supervised" && mode !== "autonomous") {
    throw new ConfigError("policy.mode must be dry_run, supervised, or autonomous");
  }
  return {
    mode,
    requireApprovalFor: expectStringList(data, "require_approval_for"),
    allowCommands: expectStringList(data, "allow_commands")
  };
}

function validateExitCriteria(raw: unknown): ExitCriteria {
  const data = asRecord(raw, "exit_criteria");
  const success = expectStringList(data, "success");
  if (success.length === 0) {
    throw new ConfigError("exit_criteria.success must include at least one condition");
  }
  return {
    success,
    failure: expectStringList(data, "failure")
  };
}

function validateTriggers(raw: unknown): readonly TriggerConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("triggers must be a list");
  return raw.map((item) => {
    const data = asRecord(item, "trigger");
    return {
      event: expectString(data, "event"),
      when: typeof data.when === "string" ? data.when : "always"
    };
  });
}

export function projectLoopConfigFromObject(raw: Record<string, unknown>): ProjectLoopConfig {
  const harnesses = expectStringList(raw, "harnesses").map(expectHarness);
  const loop: LoopConfig = {
    id: expectString(raw, "id"),
    kind: expectLoopKind(expectString(raw, "kind")),
    goal: expectString(raw, "goal"),
    harnesses: harnesses.length > 0 ? harnesses : ["pi", "codex", "claude-code"],
    dryRun: raw.dry_run === undefined ? true : raw.dry_run === true
  };

  return {
    loop,
    triggers: validateTriggers(raw.triggers),
    policy: validatePolicy(raw.policy),
    exitCriteria: validateExitCriteria(raw.exit_criteria)
  };
}

export function loadProjectLoopConfigText(text: string): ProjectLoopConfig {
  return projectLoopConfigFromObject(parseLoopYamlSubset(text));
}
