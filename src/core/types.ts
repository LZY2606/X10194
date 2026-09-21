export type HexDigest = string;

export interface InputFile {
  path: string;
  digest: HexDigest;
  mode: number;
  symlinkTarget?: string | null;
}

export interface OutputFile {
  path: string;
  digest: HexDigest;
  mode: number;
  symlinkTarget?: string | null;
}

export interface Toolchain {
  name: string;
  version: string;
}

export interface Platform {
  os: string;
  arch: string;
}

export type ObservationStatus = 'success' | 'failed';

/** Immutable record of one build action as imported. */
export interface ActionSpec {
  id: string;
  observedAt: number;
  command: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  envWhitelist: string[];
  toolchain: Toolchain;
  platform: Platform;
  inputs: InputFile[];
  deps: string[];
  outputs: OutputFile[];
  status: ObservationStatus;
  exitCode?: number | null;
  errorText?: string | null;
}

export interface Manifest {
  manifestId: string;
  importedAt: number;
  actions: ActionSpec[];
}

export type RuleKind = 'pathAlias' | 'pathSeparator' | 'unorderedFlag';

export interface PathAliasRule {
  kind: 'pathAlias';
  name: string;
  from: string;
  to: string;
}

export interface PathSeparatorRule {
  kind: 'pathSeparator';
  name: string;
}

/**
 * Only argv tokens belonging to a declared group may be sorted.
 * groupForFlag maps a flag token (e.g. "-I") to a group id; values immediately
 * following a flag inherit its group. Bare tokens are grouped at their index.
 */
export interface UnorderedFlagRule {
  kind: 'unorderedFlag';
  name: string;
  flags: string[];
}

export type NormalizationRule = PathAliasRule | PathSeparatorRule | UnorderedFlagRule;

export interface RuleVersion {
  version: number;
  label: string;
  status: 'active' | 'draft' | 'archived';
  parentVersion: number | null;
  rules: NormalizationRule[];
  createdAt: number;
  approvedAt?: number | null;
}

export interface NormalizedToken {
  raw: string;
  normalized: string;
  notes: string[];
  group?: string | null;
}

export interface EnvComponent {
  name: string;
  present: boolean;
  rawValue: string | null;
  normalizedValue: string | null;
  declared: boolean;
}

export interface InputComponent {
  rawPath: string;
  normalizedPath: string;
  digest: HexDigest;
  mode: number;
  symlinkTarget: string | null;
  notes: string[];
}

export interface DepComponent {
  actionId: string;
  pinnedResultVersion: number;
  outputSetHash: HexDigest;
  status: ObservationStatus;
}

export interface FingerprintExplain {
  actionId: string;
  ruleVersion: number;
  command: NormalizedToken;
  argv: NormalizedToken[];
  cwd: NormalizedToken;
  toolchain: Toolchain;
  platform: Platform;
  env: EnvComponent[];
  inputs: InputComponent[];
  deps: DepComponent[];
  status: ObservationStatus;
}

export interface ComponentHash {
  name: string;
  hash: HexDigest;
}

export interface Fingerprint {
  key: HexDigest;
  explain: FingerprintExplain;
  components: ComponentHash[];
}

export interface ResolvedDep {
  actionId: string;
  resultVersion: number;
  outputSetHash: HexDigest;
  status: ObservationStatus;
}

export type DiffVerdict = 'hit' | 'miss';

export interface ComponentDiff {
  component: string;
  same: boolean;
  a: string;
  b: string;
  detail: string;
}

export interface FingerprintComparison {
  actionA: string;
  actionB: string;
  ruleVersion: number;
  verdict: DiffVerdict;
  keyA: HexDigest;
  keyB: HexDigest;
  diffs: ComponentDiff[];
}

export interface DryRunResult {
  ruleVersion: number;
  baselineVersion: number;
  observedActions: number;
  hitsGained: number;
  hitsLost: number;
  unchanged: number;
  changes: { actionId: string; oldKey: HexDigest; newKey: HexDigest }[];
  collisions: {
    key: HexDigest;
    outputSetHashes: HexDigest[];
    members: { actionId: string; resultVersion: number }[];
    counterexample: string;
  }[];
}
