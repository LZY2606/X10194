import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization with deterministic byte encoding.
 * Object keys are sorted by UTF-16 code units; array order is preserved
 * (arrays carry semantics, we never reorder them implicitly).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number': {
      if (!Number.isFinite(value)) throw new Error('non-finite number in canonical form');
      return JSON.stringify(value);
    }
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys.map((key) => JSON.stringify(key) + ':' + canonicalize(record[key]));
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new Error(`cannot canonicalize value of type ${typeof value}`);
  }
}

/** All hash inputs are explicit UTF-8 bytes of the canonical text. */
export function hashCanonical(value: unknown): string {
  const text = canonicalize(value);
  const bytes = new TextEncoder().encode(text);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export function hashUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
