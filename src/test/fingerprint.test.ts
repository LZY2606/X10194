import { describe, expect, it } from 'vitest';
import { compareFingerprints, computeFingerprint, computeResultVersion } from '../core/fingerprint';
import { action, fixedFile, makeRules } from './helpers';
import type { RawAction } from '../core/types';

const resolveNone = () => null;

describe('动作 key 组成', () => {
  it('key 对命令、环境、输入摘要、平台、工具链逐字节敏感', () => {
    const base = action({ id: 'a', inputs: [fixedFile('x.c', 'h1')], outputs: [fixedFile('x.o', 'o1')] });
    const fp1 = computeFingerprint({ action: base, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });

    const changed: RawAction = { ...base, envObserved: { CC: 'gcc' } };
    const fp2 = computeFingerprint({ action: changed, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    expect(fp1.key).not.toBe(fp2.key);

    const digestChanged = { ...base, inputs: [fixedFile('x.c', 'h2')] };
    const fp3 = computeFingerprint({ action: digestChanged, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    expect(fp1.key).not.toBe(fp3.key);

    const platformChanged = { ...base, platform: { ...base.platform, arch: 'arm64' } };
    const fp4 = computeFingerprint({ action: platformChanged, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    expect(fp1.key).not.toBe(fp4.key);
  });

  it('未声明环境变量变化不改变 key', () => {
    const a1 = action({ id: 'a', envObserved: { CC: 'clang', NOISE: '1' } });
    const a2 = action({ id: 'a', envObserved: { CC: 'clang', NOISE: '2' } });
    const k1 = computeFingerprint({ action: a1, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone }).key;
    const k2 = computeFingerprint({ action: a2, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone }).key;
    expect(k1).toBe(k2);
  });

  it('规则版本号钉入 key：同一动作换版本号 key 必变', () => {
    const a = action({ id: 'a' });
    const k1 = computeFingerprint({ action: a, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone }).key;
    const k2 = computeFingerprint({ action: a, rules: makeRules(), ruleVersionId: 2, resolveDep: resolveNone }).key;
    expect(k1).not.toBe(k2);
  });
});

describe('依赖结果版本钉住', () => {
  const dep = action({
    id: 'gen',
    inputs: [fixedFile('g.in', 'gin')],
    outputs: [fixedFile('g.out', 'gout-v1')],
  });

  it('依赖输出摘要变化 -> 消费方 key 变化', () => {
    const consumer = action({ id: 'use', dependencies: ['gen'], inputs: [fixedFile('g.out', 'gout-v1')] });
    const k1 = computeFingerprint({
      action: consumer,
      rules: makeRules(),
      ruleVersionId: 1,
      resolveDep: (id) => (id === 'gen' ? { actionId: id, outputs: dep.outputs, failed: false } : null),
    }).key;
    const k2 = computeFingerprint({
      action: consumer,
      rules: makeRules(),
      ruleVersionId: 1,
      resolveDep: (id) =>
        id === 'gen'
          ? { actionId: id, outputs: [fixedFile('g.out', 'gout-v2')], failed: false }
          : null,
    }).key;
    expect(k1).not.toBe(k2);
  });

  it('缺失依赖（乱序导入）不成键，状态 missing_dependency', () => {
    const consumer = action({ id: 'use', dependencies: 'gen-not-yet' });
    const fp = computeFingerprint({ action: consumer, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    expect(fp.status).toBe('missing_dependency');
    expect(fp.key).toBe('');
  });

  it('失败依赖钉入失败哨兵', () => {
    const consumer = action({ id: 'use', dependencies: ['gen'] });
    const fp = computeFingerprint({
      action: consumer,
      rules: makeRules(),
      ruleVersionId: 1,
      resolveDep: (id) =>
        id === 'gen'
          ? { actionId: id, outputs: [], failed: true, failureReason: 'boom' }
          : null,
    });
    expect(fp.status).toBe('failed_dependency');
    expect(fp.key).not.toBe('');
    expect(fp.dependencyPins[0].failed).toBe(true);
    expect(fp.dependencyPins[0].outputVersion.startsWith('failed:')).toBe(true);
  });
});

describe('命中比较', () => {
  it('逐组件报告分歧来源', () => {
    const a = action({ id: 'a', envObserved: { CC: 'clang' }, inputs: [fixedFile('x.c', 'h1')] });
    const b = action({ id: 'b', envObserved: { CC: 'gcc' }, inputs: [fixedFile('x.c', 'h1')] });
    const fpA = computeFingerprint({ action: a, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    const fpB = computeFingerprint({ action: b, rules: makeRules(), ruleVersionId: 1, resolveDep: resolveNone });
    const cmp = compareFingerprints(fpA, fpB);
    expect(cmp.sameKey).toBe(false);
    const envCmp = cmp.components.find((c) => c.name === 'env');
    expect(envCmp?.equal).toBe(false);
    const inputsCmp = cmp.components.find((c) => c.name === 'inputs');
    expect(inputsCmp?.equal).toBe(true);
  });
});

describe('结果版本', () => {
  it('输出集合相同（顺序不同）结果版本相同；内容不同则不同', () => {
    const rules = makeRules();
    const v1 = computeResultVersion([fixedFile('a.o', '1'), fixedFile('b.o', '2')], rules);
    const v2 = computeResultVersion([fixedFile('b.o', '2'), fixedFile('a.o', '1')], rules);
    const v3 = computeResultVersion([fixedFile('a.o', '1'), fixedFile('b.o', '9')], rules);
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
  });
});
