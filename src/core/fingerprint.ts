// 指纹：每个组成部分单独成帧哈希，最终 key 由各组件哈希再组合而成，
// 因此可以逐组件展开、逐组件比较两次动作为何命中/未命中。
import { hashFrame } from './bytes';
import type { NormalizedAction } from './normalize';

export interface ComponentHash {
  name: string;
  hash: string;
  detail: string;
}

export interface Fingerprint {
  key: string;
  components: ComponentHash[];
}

export function fingerprint(norm: NormalizedAction, rulesVersion: number): Fingerprint {
  const components: ComponentHash[] = [];

  const commandHash = hashFrame('command', norm.command);
  components.push({
    name: 'command',
    hash: commandHash,
    detail: `argv = [${norm.command.map((a) => JSON.stringify(a)).join(', ')}]`,
  });

  const envKeys = Object.keys(norm.env).sort();
  const envFields: string[] = [];
  for (const k of envKeys) envFields.push(k, norm.env[k]);
  const envHash = hashFrame('env', envFields);
  components.push({
    name: 'env',
    hash: envHash,
    detail:
      envKeys.length === 0
        ? '白名单内无环境变量'
        : envKeys.map((k) => `${k}=${norm.env[k]}`).join('; '),
  });

  const toolchainHash = hashFrame('toolchain', [norm.toolchain]);
  components.push({ name: 'toolchain', hash: toolchainHash, detail: norm.toolchain });

  const platformHash = hashFrame('platform', [norm.platform]);
  components.push({ name: 'platform', hash: platformHash, detail: norm.platform });

  const inputFields: string[] = [];
  const inputLines: string[] = [];
  for (const input of norm.inputs) {
    inputFields.push(
      input.path,
      input.digest,
      input.symlinkTarget ?? '',
      input.executable ? '1' : '0',
    );
    inputLines.push(
      `${input.path} digest=${input.digest}` +
        (input.symlinkTarget !== null ? ` -> ${input.symlinkTarget}` : '') +
        (input.executable ? ' (exec)' : ''),
    );
  }
  const inputsHash = hashFrame('inputs', inputFields);
  components.push({
    name: 'inputs',
    hash: inputsHash,
    detail: inputLines.length === 0 ? '无输入文件' : inputLines.join('\n'),
  });

  const depFields: string[] = [];
  const depLines: string[] = [];
  for (const dep of norm.deps) {
    depFields.push(dep.actionId, String(dep.resultVersion));
    depLines.push(`${dep.actionId}@v${dep.resultVersion}`);
  }
  const depsHash = hashFrame('deps', depFields);
  components.push({
    name: 'deps',
    hash: depsHash,
    detail: depLines.length === 0 ? '无依赖动作' : depLines.join(', '),
  });

  const key = hashFrame('action-key', [
    String(rulesVersion),
    commandHash,
    envHash,
    toolchainHash,
    platformHash,
    inputsHash,
    depsHash,
  ]);
  return { key, components };
}

export interface ComponentDiff {
  name: string;
  hashA: string;
  hashB: string;
  same: boolean;
  detailA: string;
  detailB: string;
}

export function compareFingerprints(a: Fingerprint, b: Fingerprint): ComponentDiff[] {
  return a.components.map((ca) => {
    const cb = b.components.find((c) => c.name === ca.name);
    return {
      name: ca.name,
      hashA: ca.hash,
      hashB: cb?.hash ?? '',
      same: cb !== undefined && ca.hash === cb.hash,
      detailA: ca.detail,
      detailB: cb?.detail ?? '',
    };
  });
}
