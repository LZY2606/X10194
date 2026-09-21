// 构建指纹舱：核心领域类型（原始清单不可变，以下类型描述导入与派生记录）

export type NodeKind = "file" | "symlink";

export interface InputFile {
  path: string;
  kind: NodeKind;
  /** 文件内容摘要（hex）；symlink 时为链接字符串摘要（除非规则改按目标内容） */
  digest: string;
  /** symlink 的原始链接目标 */
  target?: string;
  /** symlink 目标解析后的内容摘要（可观测但默认不直接入 key） */
  targetDigest?: string;
  /** POSIX 权限位，例如 0o755 / 0o644；可执行位 0o100 */
  mode: number;
}

export interface OutputFile {
  path: string;
  kind: NodeKind;
  digest: string;
  target?: string;
  mode?: number;
}

export interface Toolchain {
  name: string;
  version: string;
  path?: string;
}

export interface Platform {
  os: string;
  arch: string;
  libc?: string;
}

export interface ActionFailure {
  code: number;
  message?: string;
}

export interface RawAction {
  id: string;
  command: string;
  args: string[];
  /** 明确声明会影响语义的环境变量白名单 */
  envWhitelist: string[];
  /** 构建节点捕获到的环境（可能包含白名单之外的变量，那些不进 key） */
  env?: Record<string, string>;
  toolchain: Toolchain;
  platform: Platform;
  inputs: InputFile[];
  /** 依赖动作 id；允许乱序（前向引用） */
  deps: string[];
  outputs: OutputFile[];
  result: "success" | "failure";
  failure?: ActionFailure;
}

export interface Manifest {
  manifestId: string;
  importedAt?: string;
  actions: RawAction[];
}

/** 规范化规则——只有显式声明等价的部分才会被归一 */
export interface RuleSpec {
  /** true 时把反斜杠路径分隔符归一为 "/"（POSIX 下默认 false） */
  normalizePathSeparators: boolean;
  /** 路径前缀别名：不同物理前缀映射到同一规范 token */
  pathAliases: PathAlias[];
  /** 声明这些参数标志与其取值构成可交换单元（相邻成组排序），其余参数保持原序 */
  argCommutativeFlags: string[];
  /** link：symlink 按链接字符串取证；target-digest：按目标内容摘要取证 */
  symlinkPolicy: "link" | "target-digest";
  /** true 时忽略可执行位/权限位（必须显式声明） */
  ignoreMode: boolean;
  /** true 时平台属性不进 key（必须显式声明） */
  ignorePlatform: boolean;
}

export interface PathAlias {
  /** 物理前缀，例如 /opt/sdk-v1 或 C:\\sdk */
  prefix: string;
  /** 规范 token，例如 SDK */
  as: string;
}

export interface RuleVersion {
  id: number;
  spec: RuleSpec;
  status: "approved" | "draft";
  note: string;
  createdAt: number;
  /** 回滚生成的版本记录其恢复的目标版本 */
  restoresVersionId?: number;
}

/** 指纹组成部分的展开解释（派生记录） */
export interface ComponentExplanation {
  component: string;
  raw: unknown;
  normalized: unknown;
  notes: string[];
  /** 该组件实际喂给哈希的明确字节（hex） */
  bytes: string;
}

export interface DepPin {
  depId: string;
  depKey: string;
  resultHash: string;
  status: "success" | "failure";
}

export interface KeyDerivation {
  actionId: string;
  ruleVersionId: number;
  key: string;
  resultHash: string;
  components: ComponentExplanation[];
  depPins: DepPin[];
  warnings: string[];
}

export interface ImportRow {
  id: number;
  manifestId: string;
  status: string;
  importedAt: number;
  committedAt: number | null;
  actionCount: number;
}

export interface CacheEntry {
  id: number;
  key: string;
  ruleVersionId: number;
  resultHash: string;
  source: string;
  actionId?: string;
  importId?: number;
  seq: number;
  observedAt: number;
  status: "active" | "disputed";
}

export interface Dispute {
  id: number;
  key: string;
  ruleVersionId: number;
  firstEntryId: number;
  secondEntryId: number;
  firstSource: string;
  secondSource: string;
  firstResultHash: string;
  secondResultHash: string;
  observedAt: number;
}

export interface DigestCorrection {
  id: number;
  importId: number;
  path: string;
  oldDigest: string;
  newDigest: string;
  correctedAt: number;
}

export interface DistrustRow {
  id: number;
  actionId: string;
  importId: number;
  reason: string;
  rootActions: string;
  correctionId: number;
  createdAt: number;
}

export type ActionHealth = "ok" | "failed" | "blocked" | "distrusted" | "invalid";

export interface ActionNode extends RawAction {
  importId: number;
  health: ActionHealth;
  /** 当前生效规则版本下的 key（可能尚未派生） */
  key?: string;
  resultHash?: string;
  distrustReasons?: string[];
}

export interface CompareResult {
  a: string;
  b: string;
  ruleVersionId: number;
  keyA: string;
  keyB: string;
  resultHashA: string;
  resultHashB: string;
  verdict: "true-hit" | "disputed-hit" | "miss";
  equalKey: boolean;
  equalResult: boolean;
  componentDiffs: {
    component: string;
    equal: boolean;
    a: ComponentExplanation;
    b: ComponentExplanation;
  }[];
  firstDifferingComponent?: string;
  warnings: string[];
}

export interface DryRunResult {
  baseRuleVersionId: number;
  candidate: RuleSpec;
  derived: { actionId: string; oldKey: string; newKey: string }[];
  /** 候选规则下同键异动作（碰撞） */
  collisions: { key: string; actionIds: string[]; resultHashes: string[] }[];
  /** 相比基线新合并的动作对 */
  merges: { a: string; b: string; oldKeysDiffer: boolean }[];
  /** 合并但输出不同：危险碰撞反例 */
  dangerousMerges: { a: string; b: string; key: string }[];
}
