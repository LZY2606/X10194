/**
 * 构建指纹舱 —— 核心领域类型
 *
 * 原始动作清单（Manifest）不可变；规范化键与解释全部是派生记录。
 */

/** 输入文件摘要 */
export interface InputFile {
  /** 清单中声明的路径（可能含别名、\\ 分隔符、symlink 路径） */
  path: string;
  /** 摘要算法，默认 sha256 */
  algo: string;
  /** 内容摘要（hex）；发现摘要错误后以纠正记录覆盖，不修改原始清单 */
  digest: string;
  /** 该路径是否为 symlink */
  isSymlink?: boolean;
  /** symlink 指向（规范化会展开） */
  symlinkTarget?: string;
  /** 是否可执行（POSIX mode 中的 x 位） */
  executable?: boolean;
}

/** 输出摘要（仅记录来源事实，不参与 key 计算） */
export interface OutputDigest {
  path: string;
  algo: string;
  digest: string;
}

/** 一条不可变的原始构建动作清单 */
export interface ActionManifest {
  id: string;
  /** 命令 argv[0..]；规范化只处理规则明确声明等价的部分 */
  command: string[];
  /** 环境白名单：只有这里出现的变量允许进入指纹 */
  envWhitelist: string[];
  /** 执行时实际观察到的环境（可能含白名单外变量） */
  envObserved: Record<string, string>;
  /** 工具链描述：名称/版本/平台属性 */
  toolchain: {
    name: string;
    version: string;
    /** 平台属性，如 os / arch / libc */
    platform: Record<string, string>;
  };
  inputs: InputFile[];
  /** 依赖动作 id；动作 key 必须钉住依赖结果版本 */
  deps: string[];
  outputs: OutputDigest[];
  /** 该动作执行是否失败（失败节点同样入图并产生失败版本） */
  failed?: boolean;
}

/** 导入批次（清单可乱序到达：deps 可能指向尚未导入的动作） */
export interface ImportBatch {
  batchId: string;
  receivedAt: string;
  actions: ActionManifest[];
}

/** 规范化规则（版本化、不可变；草案可干跑） */
export interface RuleSpec {
  version: number;
  /** 路径别名：键为别名前缀（工作区逻辑名），值为真实前缀 */
  pathAliases: Array<{ from: string; to: string }>;
  /** 是否把路径中的 \ 与 / 视为等价（明确声明才启用） */
  normalizeSeparators: boolean;
  /** 是否展开 symlink 到目标路径 */
  expandSymlinks: boolean;
  /** 声明为可交换的命令行标志：其紧随的值在同标志内排序 */
  commutativeFlags: string[];
  /** 声明为“路径参数”的标志：其值要做路径规范化 */
  pathFlags: string[];
  /** 声明为等价的环境变量取值映射，如 DEBUG: {"1":"true"} */
  envValueAliases: Record<string, Record<string, string>>;
  /** 摘要算法规范化（声明后等价） */
  digestAlgoAliases: Record<string, string>;
}

/** 指纹中一个组成部分的展开解释 */
export interface FingerprintComponent {
  tag: string;
  label: string;
  /** 规范化后的规范条目（人类可读，已排序/展开） */
  canonical: string[];
  /** 参与哈希的原始条目（规范化前，用于解释差异） */
  observed: string[];
  /** 该部分的摘要 hex */
  digest: string;
  /** 解释注记：声明等价、被排除的风险项等 */
  notes: string[];
}

export type ActionStatus = 'ok' | 'failed' | 'blocked' | 'missing-deps';

/** 一条动作的完整派生指纹 */
export interface Fingerprint {
  actionId: string;
  /** 最终 key（组件摘要的有序哈希） */
  key: string;
  components: FingerprintComponent[];
  /** 依赖钉住的结果版本快照 depId -> resultVersion */
  depPins: Record<string, string>;
  status: ActionStatus;
  ruleVersion: number;
  /** 输出摘要的有序哈希（不进 key） */
  outputHash: string;
  /** 结果版本 = hash(key + outputHash + failed)，依赖钉住的就是它 */
  resultVersion: string;
  /** 该指纹计算时使用了纠正后的输入摘要 */
  correctedInputPaths?: string[];
}

/** 两次动作的单组件比较 */
export interface ComponentDiff {
  tag: string;
  label: string;
  match: boolean;
  left: string[];
  right: string[];
  notes: string[];
}

export interface FingerprintComparison {
  leftId: string;
  rightId: string;
  /** key 是否一致（是否“命中”） */
  hit: boolean;
  leftKey: string;
  rightKey: string;
  components: ComponentDiff[];
  /** 导致未命中的组件标签 */
  mismatchedTags: string[];
}
