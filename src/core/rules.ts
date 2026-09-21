// 规范化规则：只处理“明确声明为等价”的部分，绝不为了提高命中率随意排序全部参数。
export interface PathAlias {
  from: string;
  to: string;
}

export interface CommutativeFlag {
  flag: string;
  valueCount: number;
}

export interface CommandAlias {
  from: string;
  to: string;
}

export interface RuleSet {
  version: number;
  name: string;
  note: string;
  pathAliases: PathAlias[];
  symlinkAnchors: string[];
  ignoreExecBit: boolean;
  commandAliases: CommandAlias[];
  commutativeFlags: CommutativeFlag[];
  envAliases: Record<string, string>;
  extraIgnoredEnv: string[];
}

export function baselineRules(): RuleSet {
  return {
    version: 1,
    name: 'baseline-v1',
    note: '基线规则：仅做路径分隔符统一，其余一律保持原样（保守、不误并）。',
    pathAliases: [],
    symlinkAnchors: [],
    ignoreExecBit: false,
    commandAliases: [],
    commutativeFlags: [],
    envAliases: {},
    extraIgnoredEnv: [],
  };
}

export function parseRules(json: string): RuleSet {
  const raw = JSON.parse(json) as Partial<RuleSet>;
  const base = baselineRules();
  return {
    version: typeof raw.version === 'number' ? raw.version : base.version,
    name: typeof raw.name === 'string' ? raw.name : base.name,
    note: typeof raw.note === 'string' ? raw.note : '',
    pathAliases: Array.isArray(raw.pathAliases) ? raw.pathAliases : [],
    symlinkAnchors: Array.isArray(raw.symlinkAnchors) ? raw.symlinkAnchors : [],
    ignoreExecBit: raw.ignoreExecBit === true,
    commandAliases: Array.isArray(raw.commandAliases) ? raw.commandAliases : [],
    commutativeFlags: Array.isArray(raw.commutativeFlags) ? raw.commutativeFlags : [],
    envAliases: raw.envAliases && typeof raw.envAliases === 'object' ? raw.envAliases : {},
    extraIgnoredEnv: Array.isArray(raw.extraIgnoredEnv) ? raw.extraIgnoredEnv : [],
  };
}
