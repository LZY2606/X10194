import { createHash } from 'node:crypto';

/**
 * 所有哈希输入都使用明确字节编码：
 *   frame(s) = utf8 字节长度（十进制 ASCII） + ':' + utf8(s)
 * 序列以条目数 + 每条 frame 拼接，杜绝分隔符歧义与隐式编码。
 */
export function frame(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const head = Buffer.from(`${body.length}:`, 'ascii');
  return Buffer.concat([head, body]);
}

export function encodeList(items: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from(`${items.length}:`, 'ascii')];
  for (const item of items) {
    const buf = Buffer.isBuffer(item) ? item : frame(item);
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

/** 对字符串或字节做 sha256，返回 hex */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 组件摘要：tag 与规范化条目序列的明确字节编码 */
export function digestComponent(tag: string, canonical: string[]): string {
  return sha256(encodeList([tag, ...canonical]));
}

/** 最终 key：有序的 (tag, digest) 对列表 */
export function composeKey(pairs: Array<{ tag: string; digest: string }>, ruleVersion: number): string {
  const ordered = pairs.map((p) => `${p.tag}=${p.digest}`);
  return sha256(encodeList([`rule-v${ruleVersion}`, ...ordered]));
}
