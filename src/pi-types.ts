export interface PiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: object;
  readonly execute?: (input: unknown) => unknown | Promise<unknown>;
}

export interface PiCommandDefinition {
  readonly description: string;
  readonly handler: (args: readonly string[]) => unknown | Promise<unknown>;
}

export interface PiExtensionApi {
  registerTool?: (definition: PiToolDefinition) => void;
  registerCommand?: (name: string, definition: PiCommandDefinition) => void;
  on?: (event: string, handler: (...args: readonly unknown[]) => unknown) => void;
}

export interface PiExtensionContext {
  readonly cwd?: string;
  readonly mode?: string;
  isIdle?: () => boolean;
  getContextUsage?: () => unknown;
}
