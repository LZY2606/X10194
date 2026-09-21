import { ByteWriter, fingerprint } from "./bytes.js";
import type {
  ActionFingerprint,
  CanonicalizationRule,
  ComponentExplanation,
  RawAction,
  RawInput,
  RuleSet,
  TokenKind,
} from "./types.js";

function rulesOf(rules: CanonicalizationRule[], scope: CanonicalizationRule["scope"]) {
  return rules.filter((rule) => rule.scope === scope);
}

function applyTokenRules(value: string, rules: CanonicalizationRule[], applied: Set<string>): string {
  let output = value;
  for (const rule of rules) {
    if (rule.kind === "pathAlias" && rule.from !== undefined && output === rule.from) {
      output = rule.to ?? output;
      applied.add(rule.id);
    }
    if (rule.kind === "flagAlias" && rule.flag !== undefined && output === rule.flag) {
      output = rule.aliases?.[0] ?? output;
      applied.add(rule.id);
    }
  }
  return output;
}

function applySeparators(value: string, rules: CanonicalizationRule[], tokenKind: TokenKind, applied: Set<string>) {
  let output = value;
  for (const rule of rules) {
    if (rule.scope === "separator" && rule.kind === "separatorAlias" && rule.tokenKind === tokenKind) {
      output = output.split(rule.from).join(rule.to);
      applied.add(rule.id);
    }
  }
  return output;
}

function digestList(tag: string, values: string[]) {
  return fingerprint(tag, (writer) => writer.list(values, (itemWriter, value) => itemWriter.text(value)));
}

function canonicalCommand(action: RawAction, ruleSet: RuleSet): ComponentExplanation {
  const applied = new Set<string>();
  const notes: string[] = [];
  const commandRules = rulesOf(ruleSet.rules, "command");
  const argv = [action.command, ...action.argv].map((token) => applyTokenRules(token, commandRules, applied));

  for (const rule of commandRules) {
    if (rule.kind !== "permutableFlagGroup" || !rule.flags) continue;
    const positions = rule.flags
      .map((flag) => argv.indexOf(flag))
      .filter((position) => position >= 0);
    if (positions.length > 1) {
      const orderedFlags = positions.map((position) => argv[position]!).sort((a, b) => a.localeCompare(b));
      positions.sort((a, b) => a - b).forEach((position, index) => {
        argv[position] = orderedFlags[index]!;
      });
      applied.add(rule.id);
      notes.push(`仅重排明确批准的参数组: ${rule.flags.join(" ")}`);
    }
  }

  return {
    component: "command",
    before: [action.command, ...action.argv],
    canonical: argv,
    rulesApplied: [...applied],
    notes,
    digest: digestList("command", argv),
  };
}

function canonicalEnvironment(action: RawAction, ruleSet: RuleSet): ComponentExplanation {
  const applied: string[] = [];
  const notes: string[] = [];
  const undeclared = Object.keys(action.observedEnv)
    .filter((name) => !action.envWhitelist.includes(name))
    .sort();
  if (undeclared.length) notes.push(`未声明环境不进入 key: ${undeclared.join(", ")}`);
  const canonical: Record<string, string> = {};
  for (const name of [...action.envWhitelist].sort()) {
    let value = action.observedEnv[name] ?? "__MISSING_ENV__";
    if (!(name in action.observedEnv)) notes.push(`${name} 缺失，按显式缺失哨兵编码`);
    for (const rule of ruleSet.rules) {
      if (rule.scope === "environment" && rule.kind === "valueAlias" && rule.name === name && rule.from === value) {
        value = rule.to;
        applied.push(rule.id);
      }
    }
    canonical[name] = value;
  }
  const entries = Object.entries(canonical).flatMap(([name, value]) => [name, value]);
  return {
    component: "environment",
    before: action.observedEnv,
    canonical,
    rulesApplied: applied,
    notes,
    digest: digestList("environment", entries),
  };
}

function canonicalNamedValues(
  component: "toolchain" | "platform",
  values: Record<string, string>,
  before: unknown,
  ruleSet: RuleSet,
): ComponentExplanation {
  const applied: string[] = [];
  const canonical: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    let value = raw;
    for (const rule of ruleSet.rules) {
      if (rule.scope === component && rule.kind === "valueAlias" && rule.name === name && rule.from === value) {
        value = rule.to;
        applied.push(rule.id);
      }
    }
    canonical[name] = value;
  }
  return {
    component,
    before,
    canonical,
    rulesApplied: applied,
    notes: [],
    digest: digestList(component, Object.entries(canonical).flatMap(([name, value]) => [name, value])),
  };
}

function canonicalInputs(action: RawAction, ruleSet: RuleSet): ComponentExplanation {
  const applied = new Set<string>();
  const notes: string[] = [];
  const separatorRules = ruleSet.rules.filter((rule) => rule.scope === "separator");
  const pathRules = ruleSet.rules.filter(
    (rule): rule is Extract<CanonicalizationRule, { scope: "command" }> =>
      rule.scope === "command" && rule.kind === "pathAlias",
  );
  const canonical = [...action.inputs]
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path))
    .map((input) => {
      const declaredSeparator = separatorRules.some(
        (rule) =>
          rule.kind === "separatorAlias" &&
          rule.tokenKind === "inputPath" &&
          rule.from === input.separator,
      )
        ? separatorRules.find(
            (rule) =>
              rule.kind === "separatorAlias" &&
              rule.tokenKind === "inputPath" &&
              rule.from === input.separator,
          )!.to
        : input.separator;
      let path = applySeparators(input.path, separatorRules, "inputPath", applied);
      path = applyTokenRules(path, pathRules, applied);
      let target = input.symlinkTarget;
      let targetSeparator = input.targetSeparator ?? null;
      if (target !== undefined) {
        target = applySeparators(target, separatorRules, "symlinkTarget", applied);
        target = applyTokenRules(target, pathRules, applied);
        if (targetSeparator) {
          const targetRule = separatorRules.find(
            (rule) =>
              rule.kind === "separatorAlias" &&
              rule.tokenKind === "symlinkTarget" &&
              rule.from === targetSeparator,
          );
          if (targetRule) targetSeparator = targetRule.to;
        }
      }
      return {
        id: input.id,
        path,
        declaredSeparator: declaredSeparator === "\\" ? "backslash" : "slash",
        digest: input.digest,
        executable: input.executable,
        symlinkTarget: target ?? null,
        targetSeparator: targetSeparator === "\\" ? "backslash" : targetSeparator,
      };
    });

  const digest = fingerprint("inputs", (writer) => {
    writer.list(canonical, (itemWriter, input) => {
      itemWriter.text(input.id).text(input.path).text(input.declaredSeparator).text(input.digest).boolean(input.executable);
      itemWriter.boolean(input.symlinkTarget !== null);
      if (input.symlinkTarget !== null) itemWriter.text(input.symlinkTarget).text(String(input.targetSeparator));
    });
  });
  return { component: "inputs", before: action.inputs, canonical, rulesApplied: [...applied], notes, digest };
}

export function computeActionKey(
  manifestId: string,
  action: RawAction,
  ruleSet: RuleSet,
  dependencyResults: Record<string, string>,
): ActionFingerprint {
  const components = [
    canonicalCommand(action, ruleSet),
    canonicalEnvironment(action, ruleSet),
    canonicalNamedValues("toolchain", action.toolchain, action.toolchain, ruleSet),
    canonicalNamedValues(
      "platform",
      action.platform as unknown as Record<string, string>,
      action.platform,
      ruleSet,
    ),
    canonicalInputs(action, ruleSet),
  ];

  const sortedDependencies = [...action.dependencies].sort();
  const dependencyCanonical = Object.fromEntries(
    sortedDependencies.map((id) => [id, dependencyResults[id] ?? "__MISSING_DEPENDENCY__"]),
  );
  const dependencyComponent: ComponentExplanation = {
    component: "dependencyResults",
    before: action.dependencies,
    canonical: dependencyCanonical,
    rulesApplied: [],
    notes: ["key 钉住每个依赖的结果版本；共享子图变更会传播到全部可达动作"],
    digest: fingerprint("dependencyResults", (writer) => {
      writer.list(sortedDependencies, (itemWriter: ByteWriter, dependencyId: string) => {
        itemWriter.text(dependencyId).text(dependencyResults[dependencyId] ?? "__MISSING_DEPENDENCY__");
      });
    }),
  };

  const statusComponent: ComponentExplanation = {
    component: "status",
    before: action.status,
    canonical: action.status,
    rulesApplied: [],
    notes: ["失败节点显式入指纹，不能命中成功产物"],
    digest: fingerprint("status", (writer) => writer.text(action.status)),
  };
  components.push(dependencyComponent, statusComponent);

  const key = fingerprint("actionKey-v1", (writer) => {
    writer.list(components, (itemWriter, component) => itemWriter.text(component.digest));
  });
  const resultVersion = fingerprint("resultVersion-v1", (writer) => {
    writer.text(key).text(action.status);
    writer.list(action.outputs, (outputWriter, output) => outputWriter.text(output.path).text(output.digest));
  });

  return {
    actionId: action.id,
    manifestId,
    ruleVersion: ruleSet.version,
    key,
    components,
    resultVersion,
    trusted: true,
    distrustReasons: [],
  };
}

export function computeAllFingerprints(
  manifestId: string,
  actions: RawAction[],
  ruleSet: RuleSet,
  effectiveInputs: Record<string, RawInput> = {},
): Map<string, ActionFingerprint> {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const state = new Map<string, ActionFingerprint>();
  const visiting = new Set<string>();

  function visit(id: string, trail: string[] = []): ActionFingerprint {
    const existing = state.get(id);
    if (existing) return existing;
    const action = byId.get(id);
    if (!action) throw new Error(`unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
    visiting.add(id);
    const dependencyResults: Record<string, string> = {};
    for (const dependencyId of action.dependencies) dependencyResults[dependencyId] = visit(dependencyId).resultVersion;
    visiting.delete(id);

    const merged: RawAction = {
      ...action,
      inputs: action.inputs.map((input) => effectiveInputs[input.id] ?? input),
    };
    const computed = computeActionKey(manifestId, merged, ruleSet, dependencyResults);
    state.set(id, computed);
    return computed;
  }

  for (const action of actions) visit(action.id);
  return state;
}

export function compareFingerprints(left: ActionFingerprint, right: ActionFingerprint) {
  return left.components.map((component, index) => ({
    component: component.component,
    match: component.digest === right.components[index]?.digest,
    left: component,
    right: right.components[index],
  }));
}
