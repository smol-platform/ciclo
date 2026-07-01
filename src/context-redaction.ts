import type { ContextSourceKind } from "./context-classifier.js";

export type RedactionKind =
  | "secret"
  | "token"
  | "private_key"
  | "raw_transcript"
  | "remote_host"
  | "remote_path";

export interface ContextMemoryRedactionPolicy {
  readonly redactSecrets?: boolean;
  readonly redactRawTranscripts?: boolean;
  readonly redactRemoteDetails?: boolean;
}

export interface RedactionMetadata {
  readonly kind: RedactionKind;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly metadata: readonly RedactionMetadata[];
  readonly evidence: readonly string[];
}

const defaultPolicy: Required<ContextMemoryRedactionPolicy> = {
  redactSecrets: true,
  redactRawTranscripts: true,
  redactRemoteDetails: true
};

function policyWithDefaults(
  policy: ContextMemoryRedactionPolicy | undefined
): Required<ContextMemoryRedactionPolicy> {
  return {
    redactSecrets: policy?.redactSecrets ?? defaultPolicy.redactSecrets,
    redactRawTranscripts: policy?.redactRawTranscripts ?? defaultPolicy.redactRawTranscripts,
    redactRemoteDetails: policy?.redactRemoteDetails ?? defaultPolicy.redactRemoteDetails
  };
}

function addMetadata(
  metadata: Map<RedactionKind, number>,
  kind: RedactionKind,
  count: number
): void {
  if (count <= 0) return;
  metadata.set(kind, (metadata.get(kind) ?? 0) + count);
}

function replaceWithCount(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...args: string[]) => string)
): { readonly text: string; readonly count: number } {
  let count = 0;
  const redacted = text.replace(pattern, (...args: string[]) => {
    count += 1;
    return typeof replacement === "string" ? replacement : replacement(args[0] ?? "", ...args.slice(1));
  });
  return { text: redacted, count };
}

function metadataList(metadata: Map<RedactionKind, number>): readonly RedactionMetadata[] {
  return [...metadata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
}

function redactSecrets(text: string, metadata: Map<RedactionKind, number>): string {
  let current = text;
  let result = replaceWithCount(
    current,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "[redacted private key]"
  );
  current = result.text;
  addMetadata(metadata, "private_key", result.count);

  result = replaceWithCount(current, /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu, "Bearer [redacted token]");
  current = result.text;
  addMetadata(metadata, "token", result.count);

  result = replaceWithCount(
    current,
    /\b(api[_-]?key|token|secret|password|credential|refresh[_-]?token|device[_-]?code)\s*[:=]\s*([^\s,;]+)/giu,
    (_match, key: string) => `${key}=[redacted secret]`
  );
  current = result.text;
  addMetadata(metadata, "secret", result.count);
  return current;
}

function redactRawTranscripts(text: string, metadata: Map<RedactionKind, number>): string {
  let current = text;
  let result = replaceWithCount(
    current,
    /```(?:terminal|transcript|shell)\n[\s\S]*?```/giu,
    "[redacted raw transcript]"
  );
  current = result.text;
  addMetadata(metadata, "raw_transcript", result.count);

  result = replaceWithCount(current, /^raw transcript:\s.*$/gimu, "raw transcript: [redacted]");
  current = result.text;
  addMetadata(metadata, "raw_transcript", result.count);
  return current;
}

function redactRemoteDetails(text: string, metadata: Map<RedactionKind, number>): string {
  let current = text;
  let result = replaceWithCount(
    current,
    /\b(?:ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\b/gu,
    "[redacted remote host]"
  );
  current = result.text;
  addMetadata(metadata, "remote_host", result.count);

  result = replaceWithCount(
    current,
    /\b(?:remote\s+host|host)\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})\b/giu,
    (match) => match.replace(/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})/u, "[redacted remote host]")
  );
  current = result.text;
  addMetadata(metadata, "remote_host", result.count);

  result = replaceWithCount(
    current,
    /(?:\/(?:Users|home|srv|var|opt|tmp|etc)\/[^\s,;:)]+|~\/[^\s,;:)]+)/gu,
    "[redacted remote path]"
  );
  current = result.text;
  addMetadata(metadata, "remote_path", result.count);
  return current;
}

export function redactContextMemory(input: {
  readonly text: string;
  readonly source?: ContextSourceKind;
  readonly policy?: ContextMemoryRedactionPolicy;
}): RedactionResult {
  const policy = policyWithDefaults(input.policy);
  const metadata = new Map<RedactionKind, number>();
  let text = input.text;

  if (policy.redactRawTranscripts && input.source === "transcript" && text.trim().length > 0) {
    addMetadata(metadata, "raw_transcript", 1);
    text = "[redacted raw transcript memory]";
  } else if (policy.redactRawTranscripts) {
    text = redactRawTranscripts(text, metadata);
  }

  if (policy.redactSecrets) {
    text = redactSecrets(text, metadata);
  }

  if (policy.redactRemoteDetails) {
    text = redactRemoteDetails(text, metadata);
  }

  const redactionMetadata = metadataList(metadata);
  return {
    text,
    redacted: redactionMetadata.length > 0,
    metadata: redactionMetadata,
    evidence: redactionMetadata.map((item) => `context.redaction.${item.kind}:${item.count}`)
  };
}
