/** Raw manifest as imported. Raw manifests are immutable once stored. */
export interface Manifest {
  clientActionId: string;
  observedAt?: string;
  action: ActionSpec;
}

export interface ActionSpec {
  command: { argv: string[]; cwd: string };
  /** Captured environment (already filtered to what the build system saw). */
  env: Record<string, string>;
  /** Env vars the action explicitly declares as inputs. Others are "undeclared". */
  envWhitelist: string[];
  toolchain: { name: string; version: string; digest: string };
  platform: Record<string, string>;
  inputs: InputFile[];
  /** References to other actions by clientActionId. */
  dependencies: string[];
  outputs: OutputFile[];
}

export interface InputFile {
  path: string;
  digest: string;
  /** Present when the input is a symlink: the raw (unresolved) target path. */
  symlinkTarget?: string | null;
  executable?: boolean;
}

export interface OutputFile {
  path: string;
  digest: string;
}

/**
 * A normalization ruleset version. Rules may ONLY normalize things that are
 * explicitly declared equivalent. Anything not covered by a rule stays as-is.
 */
export interface Ruleset {
  version: number;
  /** Declared path prefix equivalences, e.g. { from: "/repo", to: "." }. */
  pathAliases: { from: string; to: string }[];
  /** Declares that "\\" and "/" are equivalent path separators. */
  pathSeparatorEquivalent: boolean;
  /**
   * Declared order-insensitive argument groups. Each entry is a regex source;
   * consecutive argv elements matching the same pattern may be sorted.
   * Nothing else is ever reordered.
   */
  argOrderInsensitive: string[];
  /** Env vars declared irrelevant to the build result. */
  envIgnore: string[];
  /** Declares that a symlink input is equivalent to its resolved target path. */
  resolveSymlinks: boolean;
  /** Declares that the executable bit is semantically relevant. */
  execBitMatters: boolean;
  /** Which platform attributes participate in the key. */
  platformKeys: string[];
}

export type RulesetSpec = Omit<Ruleset, 'version'>;

export interface FingerprintComponent {
  name: string;
  hash: string;
  /** Normalized value that was hashed (JSON-serializable). */
  value: unknown;
  /** Human-readable explanations of what normalization did. */
  notes: string[];
}

export interface Fingerprint {
  key: string;
  rulesVersion: number;
  components: FingerprintComponent[];
}

export type ActionStatus = 'ok' | 'pending' | 'distrusted';

export interface ActionRow {
  id: string;
  seq: number;
  status: ActionStatus;
  key: string | null;
  rulesVersion: number;
  manifest: Manifest;
  fingerprint: Fingerprint | null;
  corrections: { path: string; oldDigest: string; newDigest: string }[];
}

export interface CacheEntry {
  id: number;
  key: string;
  outputs: OutputFile[];
  source: string;
  seq: number;
}

export interface Dispute {
  key: string;
  entries: CacheEntry[];
}

export interface Invalidation {
  id: number;
  actionId: string;
  path: string;
  oldDigest: string;
  newDigest: string;
  affected: string[];
  seq: number;
}

export type ImportEvent =
  | { type: 'manifest'; manifest: Manifest }
  | { type: 'cacheEntry'; actionId: string; source: string }
  | { type: 'digestCorrection'; actionId: string; path: string; newDigest: string };

export interface DryRunResult {
  draftId: string;
  baseVersion: number;
  changedKeys: { actionId: string; oldKey: string | null; newKey: string }[];
  newHits: { key: string; actionIds: string[] }[];
  lostHits: { key: string; actionIds: string[] }[];
  /** Same new key but different declared outputs: collision counterexamples. */
  collisions: { key: string; actionIds: string[] }[];
}
