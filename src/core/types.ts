// 构建指纹舱 —— 核心类型定义
// 原始清单（manifest）一旦导入即不可变；规范化键、解释、规则版本等均为派生记录。

export interface PlatformInfo {
  os: string;
  arch: string;
  attributes?: Record<string, string>;
}

export interface ToolchainInfo {
  name: string;
  version: string;
  path?: string;
}

/** 输入/输出文件摘要。symlink 同时给出 linkTarget。 */
export interface FileRecord {
  path: string;
  digest: string;
  mode: number; // 权限位，如 0o755
  symlink?: { target: string; targetDigest?: string } | null;
}

export interface RawAction {
  id: string;
  command: string[];
  cwd: string;
  envWhitelist: string[];
  envObserved: Record<string, string>;
  toolchain: ToolchainInfo;
  platform: PlatformInfo;
  inputs: FileRecord[];
  dependencies: string[];
  outputs: FileRecord[];
  failed?: boolean;
  failureReason?: string;
  observedAt: string; // ISO
}

export interface RawManifest {
  manifestId: string;
  importedAt: string;
  actions: RawAction[];
}

/** 规范化规则：只有明确声明等价的部分才会被折叠 */
export interface RuleSet {
  /** 路径前缀别名，长前缀优先 */
  pathAliases: { from: string; to: string }[];
  /** 是否折叠 / 与 \ 为统一分隔符 */
  normalizeSeparators: boolean;
  /** 这些 flag 之后的值在指纹中等价（排序），不影响其他参数顺序 */
  unorderedFlags: string[];
  /** 环境变量名等价（不同名字视为同一变量） */
  envAliases: { from: string; to: string }[];
  /** symlink 目标路径别名 */
  symlinkAliases: { from: string; to: string }[];
  /** 忽略可执行位 */
  ignoreExecutableBit: boolean;
  /** 忽略的平台属性键（os/arch 本身永不忽略） */
  ignoredPlatformAttributes: string[];
}

export type RuleEventType = 'created' | 'approved' | 'rolled_back';

export interface RuleVersion {
  id: number;
  status: 'draft' | 'active' | 'retired';
  parentVersionId: number | null;
  rules: RuleSet;
  note: string;
  createdAt: string;
  approvedAt: string | null;
}

export interface RuleEvent {
  id: number;
  versionId: number;
  type: RuleEventType;
  at: string;
  detail: string;
}

/** 规范化过程中单个 token / 字段的解释 */
export interface Transform {
  segment: string;
  raw: unknown;
  canonical: unknown;
  reason: string;
}

/** 指纹的一个组成部分 */
export interface FingerprintComponent {
  name: string;
  raw: unknown;
  canonical: unknown;
  transforms: Transform[];
  hash: string;
}

export type FingerprintStatus = 'ok' | 'missing_dependency' | 'failed_dependency';

export interface DependencyPin {
  actionId: string;
  outputVersion: string; // 被钉住的依赖结果版本（输出摘要集 hash）
  present: boolean;
  failed: boolean;
}

export interface Fingerprint {
  actionId: string;
  ruleVersionId: number;
  key: string;
  status: FingerprintStatus;
  components: FingerprintComponent[];
  dependencyPins: DependencyPin[];
  resultVersion: string; // 本动作输出结果版本
  distrusted: boolean;
  distrustReason: string | null;
}

/** 未声明在白名单、却在执行环境中出现的变量 */
export interface UndeclaredEnv {
  actionId: string;
  key: string;
}

export interface CacheEntry {
  id: number;
  actionId: string;
  manifestId: string;
  key: string;
  resultVersion: string;
  outputs: FileRecord[];
  source: string;
  observedSeq: number;
  observedAt: string;
}

export type DisputeStatus = 'open' | 'resolved';

export interface Dispute {
  id: number;
  key: string;
  status: DisputeStatus;
  firstResultVersion: string;
  firstObservedSeq: number;
  openedAt: string;
  entries: {
    entryId: number;
    actionId: string;
    manifestId: string;
    resultVersion: string;
    source: string;
    observedSeq: number;
    observedAt: string;
    isFirst: boolean;
  }[];
}

export interface DigestCorrection {
  id: number;
  path: string;
  oldDigest: string;
  newDigest: string;
  at: string;
  note: string;
}

/** 干跑：在草案规则上重放历史动作 */
export interface DryRunDiff {
  actionId: string;
  baselineKey: string;
  candidateKey: string;
  changed: boolean;
  changes: { component: string; baselineHash: string; candidateHash: string }[];
}

export interface CollisionExample {
  key: string;
  actionIds: string[];
  resultVersions: string[];
  sameOutputs: boolean;
}

export interface DryRunResult {
  draftVersionId: number;
  diffs: DryRunDiff[];
  changedCount: number;
  collisions: CollisionExample[];
  missingOutputCollisions: CollisionExample[];
}

export interface ImportRecord {
  manifestId: string;
  importedAt: string;
  actionCount: number;
  pending: boolean;
  importedActions: number;
}

export interface ActionNode {
  id: string;
  manifestId: string;
  status: 'succeeded' | 'failed' | 'unresolved';
  distrusted: boolean;
  key: string | null;
  ruleVersionId: number | null;
}

export interface DagView {
  nodes: ActionNode[];
  edges: { from: string; to: string; dep: string; missing: boolean }[];
  sharedDeps: string[];
}

export interface DistrustPropagation {
  correctionId: number;
  path: string;
  oldDigest: string;
  newDigest: string;
  at: string;
  note: string;
  directlyAffected: string[];
  reachable: { actionId: string; paths: string[][] }[];
}

export interface CompareResult {
  actionA: string;
  actionB: string;
  sameKey: boolean;
  keyA: string;
  keyB: string;
  components: {
    name: string;
    equal: boolean;
    hashA: string | null;
    hashB: string | null;
    canonicalA: unknown;
    canonicalB: unknown;
    transformsA: Transform[];
    transformsB: Transform[];
  }[];
  dependencyDiffs: {
    dep: string;
    pinA: string | null;
    pinB: string | null;
    equal: boolean;
  }[];
}

export interface ChamberState {
  actions: (RawAction & { manifestId: string; key: string | null; distrusted: boolean; distrustReason: string | null; resultVersion: string; status: FingerprintStatus })[];
  fingerprints: Fingerprint[];
  undeclaredEnv: UndeclaredEnv[];
  ruleVersions: RuleVersion[];
  ruleEvents: RuleEvent[];
  activeRuleVersionId: number;
  cacheEntries: CacheEntry[];
  disputes: Dispute[];
  corrections: DigestCorrection[];
  propagation: DistrustPropagation[];
  imports: ImportRecord[];
  dag: DagView;
}
