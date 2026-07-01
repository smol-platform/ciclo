import { readdirSync } from "node:fs";
import { join } from "node:path";

import { runtimeDecision } from "./ciclo-core.js";
import { FixtureDriver, PiSdkJudge, judgeFromConfig, type BenchmarkJudgeResult } from "./benchmark-models.js";
import { loadBenchmarkScenarioFile, type BenchmarkScenarioFixture } from "./benchmark-scenario.js";
import {
  runDeterministicBenchmarkSafetyChecks,
  type BenchmarkCandidateResponse,
  type BenchmarkSafetyCheckResult
} from "./benchmark-safety-checks.js";

export interface BenchmarkRunnerOptions {
  readonly scenarioDir?: string;
  readonly scoreThreshold?: number;
  readonly plannerVersion?: string;
  readonly judgeProvider?: "scenario" | "pi";
  readonly model?: string;
  readonly thinking?: string;
  readonly scenarioLimit?: number;
}

export interface BenchmarkScenarioReport {
  readonly scenarioId: string;
  readonly title: string;
  readonly plannerVersion: string;
  readonly driverId: string;
  readonly candidate: BenchmarkCandidateResponse;
  readonly safety: BenchmarkSafetyCheckResult;
  readonly judgeResults: readonly BenchmarkJudgeResult[];
  readonly failures: readonly string[];
  readonly score: number;
  readonly recommendedAction: "accept" | "fix_safety_failures" | "improve_response" | "configure_model_adapter";
  readonly evidence: readonly string[];
}

export interface BenchmarkSuiteReport {
  readonly ok: boolean;
  readonly plannerVersion: string;
  readonly scenarioCount: number;
  readonly scoreThreshold: number;
  readonly failures: readonly string[];
  readonly reports: readonly BenchmarkScenarioReport[];
}

const defaultScenarioDir = "tests/fixtures/benchmarks";
const defaultScoreThreshold = 0.8;

function firstOr<T>(items: readonly T[], fallback: T): T {
  return items[0] ?? fallback;
}

function scenarioHasAccessApproval(scenario: BenchmarkScenarioFixture): boolean {
  const evidence = [
    ...scenario.expected.evidenceIncludes,
    ...scenario.herdrEvents.flatMap((event) => event.evidence),
    ...scenario.remoteSessions.flatMap((session) => session.evidence),
    ...scenario.workerSessions.flatMap((session) => session.evidence)
  ];
  return evidence.some((item) => item === "access.decision:allow" || item.startsWith("owner.grant:"));
}

export function loadBenchmarkScenarioSuite(
  scenarioDir = defaultScenarioDir
): readonly BenchmarkScenarioFixture[] {
  return readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => loadBenchmarkScenarioFile(join(scenarioDir, file)));
}

export function buildFixtureCandidate(scenario: BenchmarkScenarioFixture): BenchmarkCandidateResponse {
  const responseKind = firstOr(scenario.expected.responseKinds, "wait");
  const approved = scenarioHasAccessApproval(scenario);
  const evidence = [
    ...scenario.expected.evidenceIncludes,
    ...scenario.herdrEvents.flatMap((event) => event.evidence),
    ...scenario.remoteSessions.flatMap((session) => session.evidence),
    ...scenario.workerSessions.flatMap((session) => session.evidence),
    `repo.dirty_files:${scenario.repo.dirtyFiles.length}`,
    `benchmark.scenario:${scenario.id}`
  ];
  const actions = scenario.expected.requiredActions.map((kind) => ({
    kind,
    scope: "loop" as const,
    approved,
    idempotencyKey: `${scenario.id}:${kind}`
  }));

  return {
    responseKind,
    text: [
      `Scenario ${scenario.id} response: ${responseKind}.`,
      `Required actions: ${scenario.expected.requiredActions.join(", ") || "none"}.`,
      "Acceptance and validation evidence remain required before completion."
    ].join(" "),
    evidence,
    actions,
    stateFingerprint: scenario.herdrEvents.at(-1) === undefined
      ? `${scenario.loop.id}:no-herdr`
      : `${scenario.loop.id}:${scenario.herdrEvents.at(-1)?.target}:${scenario.herdrEvents.at(-1)?.harness}:${scenario.herdrEvents.at(-1)?.state}:${scenario.herdrEvents.at(-1)?.evidence.join("|")}`,
    recentResponses: []
  };
}

function recommendedAction(
  safety: BenchmarkSafetyCheckResult,
  judgeResults: readonly BenchmarkJudgeResult[],
  threshold: number,
  judgeErrors: readonly string[]
): BenchmarkScenarioReport["recommendedAction"] {
  if (!safety.passed) return "fix_safety_failures";
  if (judgeErrors.length > 0) return "configure_model_adapter";
  if (judgeResults.some((result) => result.failures.length > 0)) return "improve_response";
  const scores = judgeResults.map((result) => result.score);
  const score = scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return score >= threshold ? "accept" : "improve_response";
}

export async function runBenchmarkScenario(
  scenario: BenchmarkScenarioFixture,
  options: BenchmarkRunnerOptions = {}
): Promise<BenchmarkScenarioReport> {
  const plannerVersion = options.plannerVersion ?? `ciclo-${runtimeDecision.runtime}-benchmark-v1`;
  const threshold = options.scoreThreshold ?? defaultScoreThreshold;
  const driverConfig = firstOr(scenario.drivers, { role: "agent_driver" as const, model: "fixture" });
  const driverId = driverConfig.fixture ?? `${driverConfig.role}:${driverConfig.model ?? "fixture"}`;
  const driver = new FixtureDriver(driverId, driverConfig.role, buildFixtureCandidate(scenario));
  const driven = await driver.drive({ scenario });
  const safety = runDeterministicBenchmarkSafetyChecks(scenario, driven.candidate);
  const judgeResults: BenchmarkJudgeResult[] = [];
  const judgeErrors: string[] = [];

  for (const judgeConfig of scenario.judges) {
    try {
      const judge = options.judgeProvider === "pi"
        ? new PiSdkJudge({
            id: judgeConfig.id,
            model: options.model,
            thinking: options.thinking,
            dimensions: judgeConfig.dimensions
          })
        : judgeFromConfig(judgeConfig);
      judgeResults.push(await judge.judge({ scenario, candidate: driven.candidate, safety }));
    } catch (error) {
      judgeErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const scores = judgeResults.map((result) => result.score);
  const score = scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const failures = [
    ...safety.violations.map((violation) => violation.code),
    ...judgeResults.flatMap((result) => result.failures),
    ...judgeErrors
  ];

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    plannerVersion,
    driverId,
    candidate: driven.candidate,
    safety,
    judgeResults,
    failures,
    score,
    recommendedAction: recommendedAction(safety, judgeResults, threshold, judgeErrors),
    evidence: [
      `benchmark.runner.scenario:${scenario.id}`,
      `benchmark.runner.driver:${driverId}`,
      ...driven.evidence,
      ...safety.evidence
    ]
  };
}

export async function runBenchmarkSuite(
  options: BenchmarkRunnerOptions = {}
): Promise<BenchmarkSuiteReport> {
  const plannerVersion = options.plannerVersion ?? `ciclo-${runtimeDecision.runtime}-benchmark-v1`;
  const threshold = options.scoreThreshold ?? defaultScoreThreshold;
  const scenarios = loadBenchmarkScenarioSuite(options.scenarioDir ?? defaultScenarioDir)
    .slice(0, options.scenarioLimit);
  const reports = [];
  for (const scenario of scenarios) {
    reports.push(await runBenchmarkScenario(scenario, { ...options, plannerVersion }));
  }
  const failures = reports.flatMap((report) =>
    report.recommendedAction === "accept"
      ? []
      : [`${report.scenarioId}:${report.recommendedAction}:${report.failures.join(",") || "low_score"}`]
  );

  return {
    ok: failures.length === 0,
    plannerVersion,
    scenarioCount: reports.length,
    scoreThreshold: threshold,
    failures,
    reports
  };
}
