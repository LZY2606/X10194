import { describe, expect, it } from "vitest";
import { action, hx, manifest, resetMemory } from "./helpers.ts";
import {
  importManifest,
  listDisputes,
  listEntries,
  observeEntry,
  listActions,
  lookupHit,
} from "../src/server/store.ts";

describe("同键异输出争议", () => {
  it("两个条目共用 key 但输出不同：进入争议，保留双方来源与首次观察顺序，绝不覆盖", () => {
    resetMemory();
    const res = importManifest(
      manifest("m", [
        action({ id: "a", outputs: [{ path: "o", kind: "file", digest: hx("o-v1"), mode: 0o644 }] }),
      ]),
      { autoObserve: false },
    );
    const node = listActions().find((n) => n.id === "a")!;
    const key = node.key!;

    // 先到：旧文件来源
    observeEntry({ key, ruleVersionId: 1, resultHash: hx("STALE"), source: "remote/old" });
    // 后到：本地正确结果
    observeEntry({ key, ruleVersionId: 1, resultHash: node.resultHash!, source: "local/new" });
    // 第三个：再次异输出
    observeEntry({ key, ruleVersionId: 1, resultHash: hx("OTHER"), source: "remote/other" });

    const entries = listEntries();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.key === key)).toBe(true);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    // 绝不覆盖：三条全部保留
    expect(entries.map((e) => e.source)).toEqual(["remote/old", "local/new", "remote/other"]);

    const disputes = listDisputes();
    expect(disputes).toHaveLength(1);
    expect(disputes[0].firstSource).toBe("remote/old");
    expect(disputes[0].secondSource).toBe("local/new");
    expect(disputes[0].firstResultHash).toBe(hx("STALE"));
    expect(entries.every((e) => e.status === "disputed")).toBe(true);
    void res;
  });

  it("同 key 同输出不产生争议，为真命中", () => {
    resetMemory();
    importManifest(
      manifest("m", [action({ id: "a" })]),
      { autoObserve: false },
    );
    const node = listActions().find((n) => n.id === "a")!;
    observeEntry({ key: node.key!, ruleVersionId: 1, resultHash: node.resultHash!, source: "s1" });
    observeEntry({ key: node.key!, ruleVersionId: 1, resultHash: node.resultHash!, source: "s2" });
    expect(listDisputes()).toHaveLength(0);
    expect(lookupHit("a", 1)!.verdict).toBe("true-hit");
  });
});
