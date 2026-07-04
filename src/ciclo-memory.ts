import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { CicloEventSink } from "./ciclo-events.js";

export type CicloMemoryKind = "observation" | "learning" | "decision" | "summary";
export type CicloMemoryImportance = "low" | "normal" | "high";
export type CicloMemoryState = "active" | "compacted" | "archived";

export interface CicloMemoryScope {
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly remoteSessionId?: string;
}

export interface CicloMemoryEntry extends CicloMemoryScope {
  readonly id: string;
  readonly kind: CicloMemoryKind;
  readonly content: string;
  readonly tags: readonly string[];
  readonly importance: CicloMemoryImportance;
  readonly confidence: number;
  readonly state: CicloMemoryState;
  readonly generation: number;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
  readonly ageDays: number;
  readonly sourceIds: readonly string[];
  readonly evidence: readonly string[];
}

export interface CicloMemoryRecordInput extends CicloMemoryScope {
  readonly kind?: CicloMemoryKind;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly importance?: CicloMemoryImportance;
  readonly confidence?: number;
  readonly evidence?: readonly string[];
}

export interface CicloMemoryFilter extends CicloMemoryScope {
  readonly tag?: string;
  readonly state?: CicloMemoryState;
  readonly limit?: number;
}

export interface CicloMemoryCompactOptions {
  readonly now?: string;
  readonly archiveAfterDays?: number;
  readonly compactAfterDays?: number;
  readonly minCompoundEntries?: number;
  readonly maxSummaryCharacters?: number;
}

export interface CicloMemoryCompactResult {
  readonly at: string;
  readonly aged: readonly CicloMemoryEntry[];
  readonly compacted: readonly CicloMemoryEntry[];
  readonly archived: readonly CicloMemoryEntry[];
  readonly compounded: readonly CicloMemoryEntry[];
  readonly evidence: readonly string[];
}

export interface CicloMemoryStoreOptions {
  readonly projectRoot?: string;
  readonly persistPath?: string;
  readonly now?: () => string;
  readonly eventSink?: CicloEventSink;
}

interface PersistedMemoryRecord {
  readonly entry: CicloMemoryEntry;
}

const defaultArchiveAfterDays = 90;
const defaultCompactAfterDays = 14;
const defaultMinCompoundEntries = 3;
const defaultMaxSummaryCharacters = 1600;

export function cicloMemoryPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".ciclo", "memory.jsonl");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function dayDelta(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.floor((to - from) / 86_400_000);
}

function scopeKey(entry: CicloMemoryScope): string {
  return [
    entry.loopId ?? "*",
    entry.beadId ?? "*",
    entry.workerSessionId ?? "*",
    entry.remoteSessionId ?? "*"
  ].join("|");
}

function compactSummary(entries: readonly CicloMemoryEntry[], maxCharacters: number): string {
  const lines = entries.map((entry) => `- [${entry.kind}/${entry.importance}] ${entry.content}`);
  const text = lines.join("\n");
  return text.length <= maxCharacters ? text : `${text.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}...`;
}

function parsePersistedMemoryLine(line: string): CicloMemoryEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<PersistedMemoryRecord>;
    const entry = parsed.entry;
    if (entry === undefined || typeof entry.id !== "string" || typeof entry.content !== "string") return undefined;
    return entry as CicloMemoryEntry;
  } catch {
    return undefined;
  }
}

export class CicloMemoryStore {
  private readonly entries = new Map<string, CicloMemoryEntry>();
  private readonly persistPath: string;
  private readonly now: () => string;
  private readonly eventSink?: CicloEventSink;

  constructor(options: CicloMemoryStoreOptions = {}) {
    const projectRoot = options.projectRoot ?? process.cwd();
    this.persistPath = options.persistPath ?? cicloMemoryPath(projectRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.eventSink = options.eventSink;
    this.load();
  }

  record(input: CicloMemoryRecordInput): CicloMemoryEntry {
    const content = normalizeText(input.content);
    if (content.length === 0) throw new Error("memory content must not be empty");
    const at = this.now();
    const entry: CicloMemoryEntry = {
      id: `mem-${randomUUID()}`,
      kind: input.kind ?? "observation",
      content,
      tags: [...new Set((input.tags ?? []).map(normalizeText).filter((tag) => tag.length > 0))],
      importance: input.importance ?? "normal",
      confidence: boundedConfidence(input.confidence),
      state: "active",
      generation: 0,
      createdAt: at,
      lastSeenAt: at,
      seenCount: 1,
      ageDays: 0,
      sourceIds: [],
      evidence: ["memory.recorded", ...(input.evidence ?? [])],
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      ...(input.beadId === undefined ? {} : { beadId: input.beadId }),
      ...(input.workerSessionId === undefined ? {} : { workerSessionId: input.workerSessionId }),
      ...(input.remoteSessionId === undefined ? {} : { remoteSessionId: input.remoteSessionId })
    };
    this.upsert(entry);
    this.eventSink?.append({
      type: "memory.recorded",
      at,
      loopId: entry.loopId,
      beadId: entry.beadId,
      workerSessionId: entry.workerSessionId,
      evidence: entry.evidence,
      data: { memory_id: entry.id, kind: entry.kind, tags: entry.tags, importance: entry.importance }
    });
    return entry;
  }

  list(filter: CicloMemoryFilter = {}): readonly CicloMemoryEntry[] {
    const state = filter.state ?? "active";
    const entries = [...this.entries.values()]
      .filter((entry) => entry.state === state)
      .filter((entry) => filter.loopId === undefined || entry.loopId === filter.loopId)
      .filter((entry) => filter.beadId === undefined || entry.beadId === filter.beadId)
      .filter((entry) => filter.workerSessionId === undefined || entry.workerSessionId === filter.workerSessionId)
      .filter((entry) => filter.remoteSessionId === undefined || entry.remoteSessionId === filter.remoteSessionId)
      .filter((entry) => filter.tag === undefined || entry.tags.includes(filter.tag))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return entries.slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)));
  }

  status(): Record<string, unknown> {
    const entries = [...this.entries.values()];
    const byState = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.state] = (acc[entry.state] ?? 0) + 1;
      return acc;
    }, {});
    return {
      total: entries.length,
      by_state: byState,
      active: byState.active ?? 0,
      compacted: byState.compacted ?? 0,
      archived: byState.archived ?? 0,
      path: this.persistPath,
      evidence: ["memory.store:loaded", `memory.entries:${entries.length}`]
    };
  }

  compact(options: CicloMemoryCompactOptions = {}): CicloMemoryCompactResult {
    const at = options.now ?? this.now();
    const archiveAfterDays = options.archiveAfterDays ?? defaultArchiveAfterDays;
    const compactAfterDays = options.compactAfterDays ?? defaultCompactAfterDays;
    const minCompoundEntries = options.minCompoundEntries ?? defaultMinCompoundEntries;
    const maxSummaryCharacters = options.maxSummaryCharacters ?? defaultMaxSummaryCharacters;
    const aged: CicloMemoryEntry[] = [];
    const archived: CicloMemoryEntry[] = [];
    const compacted: CicloMemoryEntry[] = [];
    const compounded: CicloMemoryEntry[] = [];

    for (const entry of [...this.entries.values()]) {
      const ageDays = dayDelta(entry.lastSeenAt, at);
      if (ageDays === entry.ageDays) continue;
      const next = { ...entry, ageDays, evidence: [...entry.evidence, `memory.age_days:${ageDays}`] };
      this.upsert(next);
      aged.push(next);
    }

    const active = [...this.entries.values()].filter((entry) => entry.state === "active");
    const groups = new Map<string, CicloMemoryEntry[]>();
    for (const entry of active) {
      if (entry.kind === "summary") continue;
      if (entry.ageDays < compactAfterDays && entry.importance === "high") continue;
      const tags = entry.tags.length === 0 ? ["untagged"] : entry.tags;
      const key = `${scopeKey(entry)}|${tags.slice().sort().join(",")}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }

    for (const entries of groups.values()) {
      if (entries.length < minCompoundEntries) continue;
      const sourceIds = entries.map((entry) => entry.id);
      const summary = this.record({
        kind: "summary",
        content: compactSummary(entries, maxSummaryCharacters),
        tags: [...new Set(entries.flatMap((entry) => entry.tags))],
        importance: entries.some((entry) => entry.importance === "high") ? "high" : "normal",
        confidence: Math.min(1, entries.reduce((sum, entry) => sum + entry.confidence, 0) / entries.length),
        loopId: entries[0]?.loopId,
        beadId: entries[0]?.beadId,
        workerSessionId: entries[0]?.workerSessionId,
        remoteSessionId: entries[0]?.remoteSessionId,
        evidence: ["memory.compound:summary", `memory.compound.sources:${sourceIds.length}`]
      });
      const summaryEntry = {
        ...summary,
        generation: Math.max(...entries.map((entry) => entry.generation)) + 1,
        sourceIds,
        evidence: [...summary.evidence, `memory.generation:${Math.max(...entries.map((entry) => entry.generation)) + 1}`]
      };
      this.upsert(summaryEntry);
      compounded.push(summaryEntry);
      for (const entry of entries) {
        const next = { ...entry, state: "compacted" as const, evidence: [...entry.evidence, `memory.compacted_into:${summaryEntry.id}`] };
        this.upsert(next);
        compacted.push(next);
      }
    }

    for (const entry of [...this.entries.values()]) {
      if (entry.state === "archived") continue;
      if (entry.ageDays < archiveAfterDays) continue;
      if (entry.importance === "high" && entry.kind === "summary") continue;
      const next = { ...entry, state: "archived" as const, evidence: [...entry.evidence, "memory.archived:aged"] };
      this.upsert(next);
      archived.push(next);
    }

    const evidence = [
      "memory.compaction:ran",
      `memory.aged:${aged.length}`,
      `memory.compacted:${compacted.length}`,
      `memory.archived:${archived.length}`,
      `memory.compounded:${compounded.length}`
    ];
    this.eventSink?.append({
      type: "memory.compacted",
      at,
      evidence,
      data: {
        aged: aged.length,
        compacted: compacted.length,
        archived: archived.length,
        compounded: compounded.length
      }
    });
    return { at, aged, compacted, archived, compounded, evidence };
  }

  private upsert(entry: CicloMemoryEntry): void {
    this.entries.set(entry.id, entry);
    this.persist(entry);
  }

  private persist(entry: CicloMemoryEntry): void {
    mkdirSync(dirname(this.persistPath), { recursive: true });
    appendFileSync(this.persistPath, `${JSON.stringify({ entry })}\n`, "utf8");
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    const content = readFileSync(this.persistPath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const entry = parsePersistedMemoryLine(line);
      if (entry !== undefined) this.entries.set(entry.id, entry);
    }
  }
}
