export type CicloPromptInjectionScope = "all" | "brain" | "worker" | "review" | "beads";

export interface CicloPromptInjection {
  readonly id: string;
  readonly scope: CicloPromptInjectionScope;
  readonly text: string;
  readonly enabled?: boolean;
}

export interface PromptInjectionApplyResult {
  readonly prompt: string;
  readonly evidence: readonly string[];
}

const secretPatterns = [
  /\$\{secret:\/\//iu,
  /\$\{secret:/iu,
  /\bop:\/\//iu,
  /\bsecret\/data\//iu,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/iu
];

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizePromptInjection(input: {
  readonly id?: string;
  readonly scope?: string;
  readonly text?: string;
  readonly enabled?: boolean;
}, index: number, path = "prompts.system_injections"): CicloPromptInjection {
  const id = clean(input.id) ?? `prompt-injection-${index + 1}`;
  const scope = clean(input.scope) ?? "all";
  if (scope !== "all" && scope !== "brain" && scope !== "worker" && scope !== "review" && scope !== "beads") {
    throw new Error(`${path}[${index}].scope must be all, brain, worker, review, or beads`);
  }
  const text = clean(input.text);
  if (text === undefined) throw new Error(`${path}[${index}].text is required`);
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${path}[${index}].text appears to contain a secret reference or secret-like value`);
  }
  return {
    id,
    scope,
    text,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled })
  };
}

export function promptInjectionsForTarget(
  injections: readonly CicloPromptInjection[] | undefined,
  target: Exclude<CicloPromptInjectionScope, "all">
): readonly CicloPromptInjection[] {
  return (injections ?? []).filter((injection) =>
    injection.enabled !== false && (injection.scope === "all" || injection.scope === target)
  );
}

export function promptInjectionEvidence(
  injections: readonly CicloPromptInjection[] | undefined,
  target: Exclude<CicloPromptInjectionScope, "all">
): readonly string[] {
  const matching = promptInjectionsForTarget(injections, target);
  return [
    `prompt.injections.${target}:${matching.length}`,
    ...matching.map((injection) => `prompt.injection.${target}:${injection.id}`)
  ];
}

export function applyPromptInjections(
  prompt: string,
  injections: readonly CicloPromptInjection[] | undefined,
  target: Exclude<CicloPromptInjectionScope, "all">
): PromptInjectionApplyResult {
  const matching = promptInjectionsForTarget(injections, target);
  if (matching.length === 0) {
    return {
      prompt,
      evidence: [`prompt.injections.${target}:0`]
    };
  }
  const section = [
    "",
    "Configured Ciclo guidance:",
    ...matching.map((injection) => `[${injection.id}] ${injection.text}`)
  ].join("\n");
  return {
    prompt: `${prompt.trimEnd()}${section}`,
    evidence: promptInjectionEvidence(matching, target)
  };
}
