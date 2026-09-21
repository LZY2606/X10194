import { describe, expect, it } from "vitest";
import { action, aliasRule, hx, manifest, resetMemory } from "./helpers.ts";
import {
  approveDraft,
  compareActions,
  createDraft,
  currentRuleVersionId,
  dryRun,
  importManifest,
  listActions,
  listEntries,
  listRuleVersions,
  rollbackTo,
} from "../src/server/store.ts";

describe("规则草案 / 干跑 / 批准 / 回滚", () => {
  it("干跑不落地：碰撞反例与危险合并可见", () => {
    resetMemory();
    importManifest(
      manifest("m", [
        action({
          id: "defs-ab",
          args: ["-c", "x.c", "-D", "A", "-D", "B"],
          outputs: [{ path: "ab.o", kind: "file", digest: hx("ab-out"), mode: 0o644 }],
        }),
        action({
          id: "defs-ba",
          args: ["-c", "x.c", "-D", "B", "-D", "A"],
          outputs: [{ path: "ba.o", kind: "file", digest: hx("ba-out"), mode: 0o644 }],
        }),
      ]),
    );
    const before = currentRuleVersionId();
    const dry = dryRun(aliasRule);
    expect(currentRuleVersionId()).toBe(before); // 仍是基线
    const pair = dry.dangerousMerges.find(
      (m) => m.a.endsWith("defs-ab") && m.b.endsWith("defs-ba"),
    );
    expect(pair).toBeTruthy();
  });

  it("批准草案形成新版本并在新命名空间重放；旧版本不可变", () => {
    resetMemory();
    importManifest(
      manifest("m", [
        action({ id: "ab", args: ["-c", "x.c", "-D", "A", "-D", "B"] }),
        action({ id: "ba", args: ["-c", "x.c", "-D", "B", "-D", "A"] }),
      ]),
    );
    const baseKeyAb = listActions().find((a) => a.id === "ab")!.key;
    const baseKeyBa = listActions().find((a) => a.id === "ba")!.key;
    expect(baseKeyAb).not.toBe(baseKeyBa);

    const draft = createDraft(aliasRule, "声明 -D 可交换");
    const approved = approveDraft(draft.id);
    expect(approved.id).toBeGreaterThan(1);
    const after = listActions(approved.id);
    expect(after.find((a) => a.id === "ab")!.key).toBe(after.find((a) => a.id === "ba")!.key);
    // 旧版本的派生仍然存在且 key 不变
    const old = listActions(1);
    expect(old.find((a) => a.id === "ab")!.key).toBe(baseKeyAb);
  });

  it("回滚生成恢复版本而非改写历史，键恢复基线语义", () => {
    resetMemory();
    importManifest(
      manifest("m", [
        action({ id: "ab", args: ["-c", "x.c", "-D", "A", "-D", "B"] }),
        action({ id: "ba", args: ["-c", "x.c", "-D", "B", "-D", "A"] }),
      ]),
    );
    const draft = createDraft(aliasRule, "v2");
    const v2 = approveDraft(draft.id);
    const restored = rollbackTo(1);
    expect(restored.restoresVersionId).toBe(1);
    expect(restored.id).toBeGreaterThan(v2.id);
    const nodes = listActions(restored.id);
    expect(nodes.find((a) => a.id === "ab")!.key).not.toBe(nodes.find((a) => a.id === "ba")!.key);
    // 历史版本谱系完整
    expect(listRuleVersions().map((r) => r.id)).toEqual([1, draft.id, v2.id, restored.id]);
  });

  it("比较：参数顺序场景在基线下 miss、批准后真命中", () => {
    resetMemory();
    importManifest(
      manifest("m", [
        action({ id: "ab", args: ["-c", "x.c", "-D", "A", "-D", "B"] }),
        action({ id: "ba", args: ["-c", "x.c", "-D", "B", "-D", "A"] }),
      ]),
    );
    const base = compareActions({ importId: 1, actionId: "ab" }, { importId: 1, actionId: "ba" });
    expect(base.verdict).toBe("miss");
    expect(base.firstDifferingComponent).toBe("args");
    const draft = createDraft(aliasRule, "声明 -D 可交换");
    const v2 = approveDraft(draft.id);
    const after = compareActions(
      { importId: 1, actionId: "ab" },
      { importId: 1, actionId: "ba" },
      v2.id,
    );
    expect(after.verdict).toBe("true-hit");
    void listEntries;
  });
});
