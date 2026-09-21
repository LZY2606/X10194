import { describe, expect, it } from "vitest";
import { topoSort, downstreamFrom, reachableFrom } from "../src/shared/topo.ts";
import { action, hx, manifest, resetMemory } from "./helpers.ts";
import { importManifest, listActions } from "../src/server/store.ts";

describe("依赖图：乱序 / 共享子图 / 失败节点", () => {
  it("topoSort 容忍前向引用", () => {
    const actions = [
      action({ id: "app", deps: ["lib"] }),
      action({ id: "lib", deps: ["util"] }),
      action({ id: "util" }),
    ];
    const { order, invalid } = topoSort(actions);
    expect(invalid.size).toBe(0);
    expect(order.indexOf("util")).toBeLessThan(order.indexOf("lib"));
    expect(order.indexOf("lib")).toBeLessThan(order.indexOf("app"));
  });

  it("共享子图：util 被两个根共享", () => {
    const actions = [
      action({ id: "a", deps: ["util"] }),
      action({ id: "b", deps: ["util"] }),
      action({ id: "util" }),
    ];
    const byId = new Map(actions.map((x) => [x.id, x]));
    const affected = downstreamFrom(new Set(["util"]), byId);
    expect([...affected].sort()).toEqual(["a", "b", "util"]);
    expect(reachableFrom(["a"], byId).has("util")).toBe(true);
  });

  it("未知依赖与循环被标记 invalid", () => {
    const cyc = topoSort([
      action({ id: "x", deps: ["ghost", "y"] }),
      action({ id: "y", deps: ["x"] }),
    ]);
    expect(cyc.invalid.get("x")).toContain("ghost");
    expect(cyc.invalid.has("y")).toBe(true);
  });

  it("导入乱序清单成功；失败依赖的下游标为 blocked，失败动作本身为 failed", () => {
    resetMemory();
    const m = manifest("m", [
      action({ id: "app", deps: ["gen", "util"] }),
      action({ id: "util" }),
      action({
        id: "gen",
        result: "failure",
        failure: { code: 7 },
        outputs: [],
      }),
    ]);
    const res = importManifest(m);
    expect(res.rolledBack).toBe(false);
    const nodes = listActions();
    const health = Object.fromEntries(nodes.map((n) => [n.id, n.health]));
    expect(health.gen).toBe("failed");
    expect(health.app).toBe("blocked");
    expect(health.util).toBe("ok");
  });

  it("依赖结果版本被钉住：上游输出变了，下游 key 必变（即便上游自身输入相同）", () => {
    resetMemory();
    const mk = (outDigest: string) =>
      manifest("m" + outDigest, [
        action({ id: "app", deps: ["util"], outputs: [{ path: "app", kind: "file", digest: hx("app"), mode: 0o755 }] }),
        action({ id: "util", outputs: [{ path: "u.o", kind: "file", digest: hx(outDigest), mode: 0o644 }] }),
      ]);
    importManifest(mk("v1"));
    importManifest(mk("v2"));
    const nodes = listActions();
    const app1 = nodes.find((n) => n.importId === 1 && n.id === "app")!;
    const app2 = nodes.find((n) => n.importId === 2 && n.id === "app")!;
    expect(app1.key).not.toBe(app2.key);
  });
});
