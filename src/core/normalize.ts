import type {
  EnvComponent,
  NormalizationRule,
  NormalizedToken,
} from './types';

function normSep(p: string): string {
  return p.replace(/\\/g, '/');
}

type AliasRule = Extract<NormalizationRule, { kind: 'pathAlias' }>;

function longestAlias(
  value: string,
  aliases: AliasRule[],
): { rule: AliasRule; replaced: string } | null {
  const probe = normSep(value);
  let best: { rule: AliasRule; replaced: string } | null = null;
  for (const a of aliases) {
    const from = normSep(a.from);
    const prefix = from.endsWith('/') ? from : from + '/';
    if (probe === from || probe.startsWith(prefix)) {
      if (!best || from.length > normSep(best.rule.from).length) {
        best = { rule: a, replaced: normSep(a.to) + probe.slice(from.length) };
      }
    }
  }
  return best;
}

export function normalizePathValue(
  raw: string,
  rules: NormalizationRule[],
): NormalizedToken {
  const notes: string[] = [];
  let value = raw;
  const aliases = rules.filter((r): r is AliasRule => r.kind === 'pathAlias');
  const sepOn = rules.some((r) => r.kind === 'pathSeparator');
  const hit = longestAlias(value, aliases);
  if (hit) {
    value = hit.replaced;
    notes.push(`${hit.rule.name}: ${hit.rule.from} -> ${hit.rule.to}`);
  }
  if (sepOn && /\\/.test(value)) {
    value = normSep(value);
    notes.push('pathSeparator: backslash -> slash');
  }
  return { raw, normalized: value, notes, group: null };
}

interface ArgItem {
  /** indices into output tokens, 1 or 2 (flag + separate value) */
  tokens: NormalizedToken[];
  group: string | null;
  sortKey: string;
  rawText: string;
}

/**
 * Normalize argv. We never globally sort parameters: only values belonging to
 * an explicitly declared unordered-flag group are reordered inside their
 * contiguous run, and every reorder is recorded as a note.
 */
export function normalizeArgv(
  command: string,
  argv: string[],
  rules: NormalizationRule[],
): { command: NormalizedToken; argv: NormalizedToken[] } {
  const unordered = rules.filter(
    (r): r is Extract<NormalizationRule, { kind: 'unorderedFlag' }> => r.kind === 'unorderedFlag',
  );
  const unorderedFlags = new Set<string>();
  unordered.forEach((u) => u.flags.forEach((f) => unorderedFlags.add(f)));
  // Flags whose value is path-like (alias + separator rules apply).
  const pathFlags = new Set(['-I', '-L', '-isystem', '--sysroot', '-o']);

  const commandTok = normalizePathValue(command, rules);

  const items: ArgItem[] = [];
  let i = 0;
  while (i < argv.length) {
    const raw = argv[i];
    const unorderedFlag = [...unorderedFlags].find((f) => raw === f || raw.startsWith(f));
    if (unorderedFlag) {
      if (raw.length > unorderedFlag.length) {
        // inline value: -Ifoo
        const valueTok = normalizePathValue(raw.slice(unorderedFlag.length), rules);
        const flagTok: NormalizedToken = {
          raw: unorderedFlag,
          normalized: unorderedFlag + valueTok.normalized,
          notes: [...valueTok.notes.map((n) => n)],
          group: `flag:${unorderedFlag}`,
        };
        items.push({
          tokens: [flagTok],
          group: `flag:${unorderedFlag}`,
          sortKey: valueTok.normalized,
          rawText: raw,
        });
      } else {
        const valueRaw = argv[i + 1] ?? '';
        const valueTok = normalizePathValue(valueRaw, rules);
        valueTok.group = `flag:${unorderedFlag}`;
        const flagTok: NormalizedToken = {
          raw: unorderedFlag,
          normalized: unorderedFlag,
          notes: [],
          group: `flag:${unorderedFlag}`,
        };
        items.push({
          tokens: [flagTok, valueTok],
          group: `flag:${unorderedFlag}`,
          sortKey: valueTok.normalized,
          rawText: raw,
        });
        i += 1;
      }
    } else {
      const isFlag = raw.startsWith('-');
      const isPathLike =
        !isFlag &&
        ((i > 0 && pathFlags.has(argv[i - 1])) || /[\\/]/.test(raw));
      const tok = isPathLike
        ? normalizePathValue(raw, rules)
        : { raw, normalized: raw, notes: [], group: null };
      items.push({ tokens: [tok], group: null, sortKey: raw, rawText: raw });
    }
    i += 1;
  }

  // Reorder contiguous runs sharing one unordered group.
  let runStart = 0;
  while (runStart < items.length) {
    const group = items[runStart].group;
    if (!group) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < items.length && items[runEnd].group === group) runEnd += 1;
    const run = items.slice(runStart, runEnd);
    const before = run.map((r) => r.sortKey);
    const sorted = [...run].sort((a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
    );
    const after = sorted.map((r) => r.sortKey);
    if (before.some((v, k) => v !== after[k])) {
      for (const it of sorted) {
        for (const tok of it.tokens) {
          tok.notes.push(`unorderedFlag: ${group.slice(5)} group canonicalized (declared equivalent)`);
        }
      }
    }
    for (let k = 0; k < run.length; k++) items[runStart + k] = sorted[k];
    runStart = runEnd;
  }

  return { command: commandTok, argv: items.flatMap((it) => it.tokens) };
}

/** Declared whitelist is authoritative; undeclared observed vars are flagged. */
export function buildEnvComponents(
  env: Record<string, string>,
  whitelist: string[],
): EnvComponent[] {
  const declared = new Set(whitelist);
  const names = new Set<string>([...whitelist, ...Object.keys(env)]);
  return [...names].sort().map((name) => {
    const present = Object.prototype.hasOwnProperty.call(env, name);
    return {
      name,
      present,
      rawValue: present ? env[name] : null,
      normalizedValue: present ? env[name] : null,
      declared: declared.has(name),
    };
  });
}
