import { redactContextMemory } from "./context-redaction.js";

export type CicloBeadsMetadataAction = "claim" | "progress" | "blocker" | "validation" | "final_summary";

export interface CicloBeadsRemoteMetadata {
  readonly id?: string;
  readonly transport?: string;
  readonly herdrSession?: string;
  readonly herdrAgentTarget?: string;
  readonly state?: string;
}

export interface CicloBeadsMetadataInput {
  readonly action: CicloBeadsMetadataAction;
  readonly beadId: string;
  readonly loopId: string;
  readonly harnessId?: string;
  readonly principalId?: string;
  readonly sessionId?: string;
  readonly remoteSession?: CicloBeadsRemoteMetadata;
  readonly blockerId?: string;
}

function safeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return redactContextMemory({ text: trimmed }).text.replace(/\s+/g, "_");
}

export function formatCicloBeadsMetadata(input: CicloBeadsMetadataInput): string {
  const fields: readonly (readonly [string, string | undefined])[] = [
    ["action", input.action],
    ["bead", input.beadId],
    ["loop", input.loopId],
    ["harness", input.harnessId],
    ["principal", input.principalId],
    ["session", input.sessionId],
    ["remote_session", input.remoteSession?.id],
    ["remote_transport", input.remoteSession?.transport],
    ["herdr_session", input.remoteSession?.herdrSession],
    ["herdr_target", input.remoteSession?.herdrAgentTarget],
    ["remote_state", input.remoteSession?.state],
    ["blocker", input.blockerId]
  ];
  return [
    "ciclo.metadata",
    ...fields.flatMap(([key, value]) => {
      const safe = safeValue(value);
      return safe === undefined ? [] : [`${key}=${safe}`];
    })
  ].join(" ");
}
