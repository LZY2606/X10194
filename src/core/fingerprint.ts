// 指纹计算：把规范化后的各组成部分编码为明确字节，再汇总成动作 key。
// key 钉住依赖结果版本；依赖缺失则无法成键，依赖失败则钉入失败哨兵。

import { hashCanonical, type CanonicalValue, type HashFn } from './encoding';
import {
  canonicalCommand,
  canonicalEnv,
  canonicalFile,
  canonicalPath,
  canonicalPlatform,
} from './normalize';
import type {
  DependencyPin,
  FileRecord,
  Fingerprint,
  FingerprintComponent,
  FingerprintStatus,
  RawAction,
  RuleSet,
  Transform,
} from './types';

export interface DepResolution {
  actionId: string;
  outputs: FileRecord[];
  failed: boolean;
  failureReason?: string;
}

export interface FingerprintInput {
  action: RawAction;
  rules: RuleSet;
  ruleVersionId: number;
  resolveDep: (id: string) => DepResolution | null;
  /** path -> 纠正后的 digest（摘要纠错后重算使用） */
  digestOverrides?: Map<string, string>;
  /** 直接命中摘要错误的输入路径（标记失信原因） */
  correctedPaths?: Set<string>;
}

/** 结果版本：对（规范化后的）输出摘要集求 hash，作为依赖被钉住的“产物版本”。 */
export function computeResultVersion(
  outputs: FileRecord[],
  rules: RuleSet,
  hashFn?: HashFn,
): string {
  const transforms: Transform[] = [];
  const files = outputs
    .map((o) => canonicalFile(o, rules, transforms))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload: CanonicalValue = files.map((f) => ({
    path: f.path,
    digest: f.digest,
    mode: f.mode,
    symlinkTarget: f.symlink?.target ?? null,
    symlinkTargetDigest: f.symlink?.targetDigest ?? null,
  }));
  return hashCanonical(['result-version/v1', payload], hashFn);
}

function component(name: string, raw: unknown, canonical: CanonicalValue, transforms: Transform[], hashFn?: HashFn): FingerprintComponent {
  return { name, raw, canonical, transforms, hash: hashCanonical(canonical, hashFn) };
}

export function computeFingerprint(input: FingerprintInput, hashFn?: HashFn): Fingerprint {
  const { action, rules, ruleVersionId, resolveDep } = input;
  const overrides = input.digestOverrides ?? new Map<string, string>();
  const correctedPaths = input.correctedPaths ?? new Set<string>();

  const transforms: Transform[] = [];
  const components: FingerprintComponent[] = [];

  // 1. 规则版本本身钉入 key：换规则必换 key
  components.push(
    component(
      'ruleVersion',
      `v${ruleVersionId}`,
      ['build-fingerprint-chamber/v1', ruleVersionId],
      [],
      hashFn,
    ),
  );

  // 2. 工具链（名字、版本、路径全部逐字节钉住）
  components.push(
    component(
      'toolchain',
      action.toolchain,
      { name: action.toolchain.name, version: action.toolchain.version, path: action.toolchain.path ?? null },
      [],
      hashFn,
    ),
  );

  // 3. 平台（os/arch 不可忽略；额外属性按规则）
  const platformT: Transform[] = [];
  const platform = canonicalPlatform(action.platform, rules, platformT);
  components.push(component('platform', action.platform, { ...platform }, platformT, hashFn));

  // 4. cwd（应用路径别名）
  const cwdT: Transform[] = [];
  const cwd = canonicalPath(action.cwd, rules, cwdT, 'cwd');
  components.push(component('cwd', action.cwd, cwd, cwdT, hashFn));

  // 5. 命令：只有声明的 flag 值可重排
  const commandT: Transform[] = [];
  const cmd = canonicalCommand(action.command, rules, commandT);
  components.push(component('command', action.command, cmd, commandT, hashFn));

  // 6. 环境白名单（缺失即缺失，未声明不进入指纹）
  const envT: Transform[] = [];
  const env = canonicalEnv(action, rules, envT);
  components.push(
    component(
      'env',
      { observed: action.envObserved, whitelist: action.envWhitelist },
      { variables: env.canonical, missing: [...env.missing].sort() },
      envT,
      hashFn,
    ),
  );

  // 7. 输入文件：路径、摘要、可执行位、symlink 目标全部钉住
  const inputT: Transform[] = [];
  const files = action.inputs
    .map((file) => {
      const canonical = canonicalFile(file, rules, inputT);
      const override = overrides.get(file.path);
      if (override !== undefined && override !== file.digest) {
        canonical.digest = override;
        inputT.push({
          segment: `input:${file.path}#digest`,
          raw: file.digest,
          canonical: override,
          reason: '摘要纠错：以纠正后的摘要重算（该动作失信）',
        });
      }
      return canonical;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inputsPayload: CanonicalValue = files.map((f) => ({
    path: f.path,
    digest: f.digest,
    mode: f.mode,
    symlinkTarget: f.symlink?.target ?? null,
    symlinkTargetDigest: f.symlink?.targetDigest ?? null,
  }));
  components.push(
    component('inputs', action.inputs, inputsPayload, inputT, hashFn),
  );

  // 8. 依赖：钉住每个依赖的“结果版本”
  const depT: Transform[] = [];
  const pins: DependencyPin[] = [];
  let status: FingerprintStatus = 'ok';
  for (const depId of action.dependencies) {
    const dep = resolveDep(depId);
    if (!dep) {
      pins.push({ actionId: depId, outputVersion: '', present: false, failed: false });
      status = 'missing_dependency';
      depT.push({ segment: `dep:${depId}`, raw: null, canonical: 'UNRESOLVED', reason: '依赖动作尚未导入（乱序导入），无法成键' });
      continue;
    }
    if (dep.failed) {
      const outputVersion = 'failed:' + hashCanonical(['failed-dep', depId, dep.failureReason ?? ''], hashFn);
      pins.push({ actionId: depId, outputVersion, present: true, failed: true });
      status = status === 'ok' ? 'failed_dependency' : status;
      depT.push({ segment: `dep:${depId}`, raw: 'failed', canonical: outputVersion, reason: '依赖为失败节点：钉入失败哨兵而非产物版本' });
      continue;
    }
    const outputVersion = computeResultVersion(dep.outputs, rules, hashFn);
    pins.push({ actionId: depId, outputVersion, present: true, failed: false });
  }
  components.push(
    component(
      'dependencies',
      action.dependencies,
      pins.map((p) => ({ dep: p.actionId, outputVersion: p.outputVersion, present: p.present, failed: p.failed })),
      depT,
      hashFn,
    ),
  );

  const resultVersion = computeResultVersion(action.outputs, rules, hashFn);

  const directlyCorrected = action.inputs.some((f) => {
    const override = overrides.get(f.path);
    return override !== undefined && override !== f.digest && correctedPaths.has(f.path);
  });

  let key: string;
  if (status === 'missing_dependency') {
    key = '';
  } else {
    key = hashCanonical(
      ['action-key/v1', ruleVersionId, components.slice(1).map((c) => c.hash)],
      hashFn,
    );
  }

  return {
    actionId: action.id,
    ruleVersionId,
    key,
    status,
    components,
    dependencyPins: pins,
    resultVersion,
    distrusted: directlyCorrected,
    distrustReason: directlyCorrected ? '直接输入命中错误摘要纠正，原指纹失信' : null,
  };
}

/** 比较两次动作的指纹：逐组件给出命中/分歧来源。 */
export function compareFingerprints(a: Fingerprint, b: Fingerprint) {
  const componentNames = new Set<string>();
  a.components.forEach((c) => componentNames.add(c.name));
  b.components.forEach((c) => componentNames.add(c.name));

  const componentResults = [...componentNames].map((name) => {
    const ca = a.components.find((c) => c.name === name);
    const cb = b.components.find((c) => c.name === name);
    return {
      name,
      equal: (ca?.hash ?? null) === (cb?.hash ?? null),
      hashA: ca?.hash ?? null,
      hashB: cb?.hash ?? null,
      canonicalA: ca?.canonical ?? null,
      canonicalB: cb?.canonical ?? null,
      transformsA: ca?.transforms ?? [],
      transformsB: cb?.transforms ?? [],
    };
  });

  const depIds = new Set<string>();
  a.dependencyPins.forEach((p) => depIds.add(p.actionId));
  b.dependencyPins.forEach((p) => depIds.add(p.actionId));
  const dependencyDiffs = [...depIds].map((dep) => {
    const pa = a.dependencyPins.find((p) => p.actionId === dep) ?? null;
    const pb = b.dependencyPins.find((p) => p.actionId === dep) ?? null;
    return {
      dep,
      pinA: pa?.outputVersion ?? null,
      pinB: pb?.outputVersion ?? null,
      equal: (pa?.outputVersion ?? null) === (pb?.outputVersion ?? null),
    };
  });

  return {
    sameKey: a.key !== '' && b.key !== '' && a.key === b.key,
    components: componentResults,
    dependencyDiffs,
  };
}
