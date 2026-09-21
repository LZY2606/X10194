export interface InputFile {
  path: string;
  digest: string;
  symlinkTarget?: string | null;
  executable?: boolean;
}

export interface OutputFile {
  path: string;
  digest: string;
}

export interface ActionManifest {
  id: string;
  command: { argv: string[]; cwd: string };
  env: Record<string, string>;
  envWhitelist: string[];
  toolchain: { name: string; version: string; digest: string };
  inputs: InputFile[];
  deps: string[];
  outputs: OutputFile[];
  platform: Record<string, string>;
  status: 'ok' | 'failed';
}

export interface CacheEntry {
  id: string;
  key: string;
  outputs: OutputFile[];
  source: string;
}

export interface NormalizationRules {
  version: number;
  pathAliases: { from: string; to: string }[];
  normalizePathSeparator: boolean;
  argOrderEquivalences: { argv0: string; flags: string[] }[];
  ignoreUndeclaredEnv: boolean;
  symlinkMode: 'target' | 'opaque';
  includeExecutableBit: boolean;
  platformProperties: string[];
}

export const DEFAULT_RULES: Omit<NormalizationRules, 'version'> = {
  pathAliases: [],
  normalizePathSeparator: false,
  argOrderEquivalences: [],
  ignoreUndeclaredEnv: false,
  symlinkMode: 'opaque',
  includeExecutableBit: true,
  platformProperties: ['os', 'arch'],
};

export interface DigestCorrection {
  id: string;
  path: string;
  oldDigest: string;
  newDigest: string;
  createdAt: number;
}

export interface KeyComponent {
  name: string;
  value: unknown;
  notes: string[];
}

export interface Fingerprint {
  actionId: string;
  key: string;
  components: KeyComponent[];
  pending: boolean;
}

export interface DisputeEntry {
  entryId: string;
  source: string;
  observedSeq: number;
  outputs: OutputFile[];
}

export interface Dispute {
  key: string;
  entries: DisputeEntry[];
}
