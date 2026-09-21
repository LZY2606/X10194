// 规范化规则与指纹派生。
// 原则：只对规则中“明确声明为等价”的部分归一；其余原样入 key。
import { ByteWriter, componentBytes, digestBytes, sha256Hex } from "./encoding.ts";
import type {
  ComponentExplanation,
  DepPin,
  InputFile,
  KeyDerivation,
  RawAction,
  RuleSpec,
} from "./types.ts";

export const BASELINE_RULE_ID = 1;

export const DEFAULT_RULE: RuleSpec = {
  normalizePathSeparators: false,
  pathAliases: [],
  argCommutativeFlags: [],
  symlinkPolicy: "link",
  ignoreMode: false,
  ignorePlatform: false,
};

export function cloneRule(rule: RuleSpec): RuleSpec {
  return JSON.parse(JSON.stringify(rule)) as RuleSpec;
}

export function validateRule(rule: RuleSpec): string[] {
  const errors: string[] = [];
  for (const alias of rule.pathAliases) {
    if (!alias.prefix || !alias.as) {
      errors.push("路径别名的 prefix 与 as 均不可为空");
    }
  }
  const prefixes = rule.pathAliases.map((a) => a.prefix);
  if (new Set(prefixes).size !== prefixes.length) {
    errors.push("路径别名存在重复的物理前缀");
  }
  const flags = new Set<string>();
  for (const flag of rule.argCommutativeFlags) {
    if (!flag.startsWith("-")) {
      errors.push(`可交换标志必须以 - 开头：${flag}`);
    }
    if (flags.has(flag)) errors.push(`可交换标志重复：${flag}`);
    flags.add(flag);
  }
  if (rule.symlinkPolicy !== "link" && rule.symlinkPolicy !== "target-digest") {
    errors.push("symlinkPolicy 必须是 link 或 target-digest");
  }
  return errors;
}

function normalizeSeparators(path: string, enabled: boolean): string {
  return enabled ? path.replace(/\\/g, "/") : path;
}

/** 路径：先（显式开启时）归一分隔符，再按最长前缀别名替换 */
export function normalizePath(path: string, rule: RuleSpec): { value: string; notes: string[] } {
  const notes: string[] = [];
  let value = path;
  if (rule.normalizePathSeparators && value.includes("\\")) {
    value = value.replace(/\\/g, "/");
    notes.push("路径分隔符 \\ 已归一为 /");
  }
  const aliases = [...rule.pathAliases]
    .map((a) => ({ ...a, prefix: normalizeSeparators(a.prefix, rule.normalizePathSeparators) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const alias of aliases) {
    if (value === alias.prefix) {
      value = `<${alias.as}>`;
      notes.push(`前缀 ${alias.prefix} 映射为 <${alias.as}>`);
      break;
    }
    if (value.startsWith(alias.prefix + "/") || value.startsWith(alias.prefix + "\\")) {
      value = `<${alias.as}>/${value.slice(alias.prefix.length + 1)}`;
      notes.push(`前缀 ${alias.prefix} 映射为 <${alias.as}>`);
      break;
    }
  }
  return { value, notes };
}

function normalizeArgs(args: string[], rule: RuleSpec): { value: string[]; notes: string[] } {
  const notes: string[] = [];
  if (rule.argCommutativeFlags.length === 0) return { value: args, notes };
  const commutative = new Set(rule.argCommutativeFlags);
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!commutative.has(token)) {
      out.push(token);
      i += 1;
      continue;
    }
    // 收集相邻的 “可交换标志(+取值)” 单元
    const group: string[] = [token];
    let j = i + 1;
    if (j < args.length && !args[j].startsWith("-")) {
      group.push(args[j]);
      j += 1;
    }
    const cells: string[] = [group.join("\u0000")];
    while (j < args.length && commutative.has(args[j])) {
      const cell = [args[j]];
      j += 1;
      if (j < args.length && !args[j].startsWith("-")) {
        cell.push(args[j]);
        j += 1;
      }
      cells.push(cell.join("\u0000"));
    }
    const sorted = [...cells].sort();
    out.push(...sorted.flatMap((cell) => cell.split("\u0000")));
    if (cells.slice().sort().join("|") !== cells.join("|")) {
      notes.push(`相邻可交换参数自 ${JSON.stringify(token)} 起按 (标志,取值) 单元排序`);
    }
    i = j;
  }
  return { value: out, notes };
}

export interface EnvCapture {
  captured: Record<string, string>;
  undeclared: string[];
}

/** 环境只捕获白名单内变量；未声明环境永远不进 key，仅作风险提示 */
export function captureEnv(action: RawAction): EnvCapture {
  const env = action.env ?? {};
  const captured: Record<string, string> = {};
  const declared = new Set(action.envWhitelist);
  for (const key of action.envWhitelist) {
    captured[key] = env[key] ?? "";
  }
  const undeclared = Object.keys(env).filter((key) => !declared.has(key)).sort();
  return { captured, undeclared };
}

function inputFingerprint(file: InputFile, rule: RuleSpec): {
  bytes: Uint8Array;
  normalized: Record<string, unknown>;
  notes: string[];
} {
  const notes: string[] = [];
  const pathNorm = normalizePath(file.path, rule);
  notes.push(...pathNorm.notes);
  let kind = file.kind;
  let digestHex = file.digest;
  if (file.kind === "symlink") {
    if (rule.symlinkPolicy === "target-digest") {
      if (file.targetDigest === undefined) {
        notes.push("symlink 规则要求 target-digest，但清单缺少目标内容摘要，回退按链接字符串取证");
      } else {
        digestHex = file.targetDigest;
        notes.push(`symlink 按目标内容摘要取证（链接目标 ${file.target ?? "?"}）`);
      }
    } else {
      notes.push("symlink 按链接字符串取证");
    }
  }
  const execBit = (file.mode & 0o100) !== 0;
  const normalized: Record<string, unknown> = {
    path: pathNorm.value,
    kind,
    digest: digestHex,
  };
  if (!rule.ignoreMode) {
    normalized.mode = file.mode;
    if (execBit) notes.push("该输入带有可执行位（计入指纹）");
  } else {
    notes.push("规则声明忽略权限/可执行位");
  }
  const bytes = componentBytes("input", (w) => {
    w.text(String(normalized.path));
    w.text(String(normalized.kind));
    w.bytes(digestBytes(String(normalized.digest)));
    if (!rule.ignoreMode) w.varint(Number(normalized.mode));
    w.boolean(rule.ignoreMode);
  });
  return { bytes, normalized, notes };
}

/** 结果摘要：输出清单 + 成败，随结果版本钉住下游；不受规则版本影响 */
export function computeResultHash(action: RawAction): string {
  const w = new ByteWriter();
  w.tag("result-v1");
  w.text(action.result);
  if (action.result === "failure") {
    w.varint(action.failure?.code ?? 0);
    w.text(action.failure?.message ?? "");
  }
  w.varint(action.outputs.length);
  for (const out of [...action.outputs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    w.text(out.path);
    w.text(out.kind);
    w.bytes(digestBytes(out.digest));
    if (out.target !== undefined) w.text(out.target);
    if (out.mode !== undefined) w.varint(out.mode);
  }
  return sha256Hex(w.toBytes());
}

export interface DeriveContext {
  rule: RuleSpec;
  ruleVersionId: number;
  /** actionId -> 已派生依赖信息 */
  pinsByDep?: Map<string, DepPin>;
}

export function deriveKey(action: RawAction, ctx: DeriveContext): Omit<
  KeyDerivation,
  "depPins"
> & { depPins: DepPin[] } {
  const { rule } = ctx;
  const components: ComponentExplanation[] = [];
  const warnings: string[] = [];
  const pins = ctx.pinsByDep?.get ? ctx.pinsByDep : new Map<string, DepPin>();

  const pushComponent = (
    component: string,
    raw: unknown,
    normalized: unknown,
    notes: string[],
    bytes: Uint8Array,
  ) => {
    components.push({
      component,
      raw,
      normalized,
      notes,
      bytes: Buffer.from(bytes).toString("hex"),
    });
  };

  // 1) 命令
  pushComponent(
    "command",
    action.command,
    action.command,
    [],
    componentBytes("command", (w) => w.text(action.command)),
  );

  // 2) 参数：默认保序；只有显式声明的可交换标志参与相邻排序
  const argsNorm = normalizeArgs(action.args, rule);
  pushComponent(
    "args",
    action.args,
    argsNorm.value,
    argsNorm.notes.length
      ? argsNorm.notes
      : ["规则未声明任何可交换参数，保持原始顺序（不做全量排序）"],
    componentBytes("args", (w) => {
      w.varint(argsNorm.value.length);
      for (const arg of argsNorm.value) w.text(arg);
    }),
  );

  // 3) 环境白名单
  const envCapture = captureEnv(action);
  for (const key of envCapture.undeclared) {
    warnings.push(`未声明环境变量 ${key}=${action.env?.[key] ?? ""} 不进入 key（仅记录风险）`);
  }
  const missing = action.envWhitelist.filter((key) => (action.env?.[key] ?? null) === null);
  for (const key of missing) warnings.push(`白名单变量 ${key} 在节点缺失，按空值计入 key`);
  pushComponent(
    "env",
    action.env ?? {},
    envCapture.captured,
    [
      `仅捕获白名单 ${action.envWhitelist.length} 个变量`,
      ...(missing.length ? [`缺失变量：${missing.join(", ")}`] : []),
    ],
    componentBytes("env", (w) => {
      for (const key of Object.keys(envCapture.captured).sort()) {
        w.text(key);
        w.text(envCapture.captured[key]);
      }
    }),
  );

  // 4) 工具链
  pushComponent(
    "toolchain",
    action.toolchain,
    action.toolchain,
    [],
    componentBytes("toolchain", (w) => {
      w.text(action.toolchain.name);
      w.text(action.toolchain.version);
      w.text(action.toolchain.path ?? "");
    }),
  );

  // 5) 平台属性
  const platformNotes: string[] = [];
  let platformNorm: unknown = action.platform;
  if (rule.ignorePlatform) {
    platformNorm = { ignored: true };
    platformNotes.push("规则显式声明忽略平台属性");
  }
  pushComponent(
    "platform",
    action.platform,
    platformNorm,
    platformNotes,
    componentBytes("platform", (w) => {
      if (rule.ignorePlatform) {
        w.boolean(true);
      } else {
        w.boolean(false);
        w.text(action.platform.os);
        w.text(action.platform.arch);
        w.text(action.platform.libc ?? "");
      }
    }),
  );

  // 6) 输入文件（路径/symlink/可执行位均在规则控制下归一）
  const sortedInputs = [...action.inputs].sort((a, b) => (a.path < b.path ? -1 : 1));
  const inputNormals: unknown[] = [];
  const inputNotes: string[] = [];
  pushComponent(
    "inputs",
    action.inputs.map((f) => ({ path: f.path, kind: f.kind, digest: f.digest, mode: f.mode })),
    null,
    [],
    componentBytes("inputs", (w) => {
      w.varint(sortedInputs.length);
      for (const file of sortedInputs) {
        const fp = inputFingerprint(file, rule);
        inputNormals.push(fp.normalized);
        inputNotes.push(...fp.notes);
        w.bytes(fp.bytes);
      }
    }),
  );
  const inputsComp = components[components.length - 1];
  inputsComp.normalized = inputNormals;
  inputsComp.notes = inputNotes;

  // 收集输入组件中需要上浮为告警的提示
  for (const note of inputsComp.notes) {
    if (note.includes("回退") || note.includes("缺少")) warnings.push(note);
  }

  // 7) 依赖：钉住依赖结果版本（key + resultHash + 成败）
  const depPins: DepPin[] = [];
  const depWarnings: string[] = [];
  for (const depId of action.deps) {
    const pin = pins.get(depId);
    if (!pin) {
      depWarnings.push(`依赖 ${depId} 无派生结果（失败节点或缺失），用缺失标记钉住`);
      depPins.push({
        depId,
        depKey: `<missing:${depId}>`,
        resultHash: `<missing:${depId}>`,
        status: "failure",
      });
    } else {
      depPins.push(pin);
      if (pin.status === "failure") depWarnings.push(`依赖 ${depId} 为失败节点，本动作不可命中`);
    }
  }
  pushComponent(
    "deps",
    action.deps,
    depPins,
    depWarnings,
    componentBytes("deps", (w) => {
      for (const pin of [...depPins].sort((a, b) => (a.depId < b.depId ? -1 : 1))) {
        w.text(pin.depId);
        w.text(pin.depKey);
        w.text(pin.resultHash);
        w.text(pin.status);
      }
    }),
  );

  const keyMaterial = new ByteWriter();
  keyMaterial.tag("fingerprint-v1");
  keyMaterial.varint(ctx.ruleVersionId);
  for (const c of components) keyMaterial.bytes(new Uint8Array(Buffer.from(c.bytes, "hex")));
  const key = sha256Hex(keyMaterial.toBytes());

  return {
    actionId: action.id,
    ruleVersionId: ctx.ruleVersionId,
    key,
    resultHash: computeResultHash(action),
    components,
    depPins,
    warnings,
  };
}
