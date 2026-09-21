export type ActionStatus = "succeeded" | "failed";

export interface RawInput {
  id: string;
  path: string;
  separator: "/" | "\\";
  digest: string;
  executable: boolean;
  symlinkTarget?: string;
  targetSeparator?: "/" | "\\";
  digestWasCorrected?: boolean;
}

export interface PlatformAttributes {
  os: string;
  arch: string;
  shell: string;
}

export interface RawAction {
  id: string;
  command: string;
  argv: string[];
  envWhitelist: string[];
  observedEnv: Record<string, string>;
  toolchain: Record<string, string>;
  platform: PlatformAttributes;
  inputs: RawInput[];
  dependencies: string[];
  status: ActionStatus;
  outputs: Array<{ path: string; digest: string }>;
}

export interface ManifestImport {
  id: string;
  importedAt: string;
  actions: RawAction[];
}

export type TokenKind =
  | "argv"
  | "envName"
  | "envValue"
  | "toolchain"
  | "inputPath"
  | "symlinkTarget"
  | "outputPath";

export type RuleScope =
  | "command"
  | "environment"
  | "toolchain"
  | "input"
  | "platform"
  | "separator";

export type CanonicalizationRule =
  | {
      id: string;
      scope: "command";
      kind: "pathAlias" | "flagAlias" | "permutableFlagGroup";
      from?: string;
      to?: string;
      flag?: string;
      aliases?: string[];
      flags?: string[];
      description: string;
    }
  | {
      id: string;
      scope: "environment";
      kind: "valueAlias";
      name: string;
      from: string;
      to: string;
      description: string;
    }
  | {
      id: string;
      scope: "toolchain";
      kind: "valueAlias";
      name: string;
      from: string;
      to: string;
      description: string;
    }
  | {
      id: string;
      scope: "platform";
      kind: "valueAlias";
      name: "os" | "arch" | "shell";
      from: string;
      to: string;
      description: string;
    }
  | {
      id: string;
      scope: "separator";
      kind: "separatorAlias";
      tokenKind: TokenKind;
      from: "/" | "\\";
      to: "/" | "\\";
      description: string;
    };

export interface RuleSet {
  version: number;
  status: "draft" | "approved" | "rolledBack";
  approvedAt?: string;
  rules: CanonicalizationRule[];
  baseVersion?: number;
  description?: string;
}

export interface ComponentExplanation {
  component:
    | "command"
    | "environment"
    | "toolchain"
    | "platform"
    | "inputs"
    | "dependencyResults"
    | "status";
  before: unknown;
  canonical: unknown;
  rulesApplied: string[];
  notes: string[];
  digest: string;
}

export interface ActionFingerprint {
  actionId: string;
  manifestId: string;
  ruleVersion: number;
  key: string;
  components: ComponentExplanation[];
  resultVersion: string;
  trusted: boolean;
  distrustReasons: string[];
}

export interface CacheEntryRecord {
  id?: number;
  actionKey: string;
  resultVersion: string;
  outputDigest: string;
  outputs: RawAction["outputs"];
  source: string;
  observedAt: string;
  observationOrder: number;
  state: "clean" | "disputed" | "superseded" | "invalidated";
}

export interface DisputeRecord {
  id: number;
  actionKey: string;
  firstEntryId: number;
  conflictingEntryId: number;
  firstOutputDigest: string;
  conflictingOutputDigest: string;
  firstSource: string;
  conflictingSource: string;
  firstObservedAt: string;
  conflictingObservedAt: string;
  openedAt: string;
}
