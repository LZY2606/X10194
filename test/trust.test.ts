import { describe, expect, it } from "vitest";
import { action, hx, manifest, resetMemory } from "./helpers.ts";
import {
  correctDigest,
  importManifest,
  listActions,
  listDistrust,
  lookupHit,
} from "../src/server/store.ts";

describe("摘要纠正只使可达动作失信", () => {
  it("共享子图上：util 被纠正时其下游失信，无关分支不受影响", () => {
    resetMemory();
    importManifest(
      manifest("m", [
        action({ id: "app-x", deps: ["util"], inputs: [{ path: "x.c", kind: "file", digest: hx("x"), mode: 0o644 }] }),
        action({ id: "app-y", deps: ["util"], inputs: [{ path: "y.c", kind: "file", digest: hx("y"), mode: 0o644 }] }),
        action({ id: "util" }),
        action({ id: "isolated", inputs: [{ path: "z.c", kind: "file", digest: hx("z"), mode: 0o644 }] }),
      ]),
    );
    const result = correctDigest({ importId: 1, path: "src.c", newDigest: hx("corrected-src") });
    const affected = result.distrustedActions.map((d) => d.actionId).sort();
    // util（根）+ 其两个下游；isolated 不在传播范围
    expect(affected).toEqual(["app-x", "app-y", "util"]);

    const health = Object.fromEntries(listActions().map((a) => [a.id, a.health]));
    expect(health.isolated).toBe("ok");
    expect(health.util).toBe("distrusted");
    expect(listDistrust()).toHaveLength(3);

    const hit = lookupHit("app-x", 1);
    expect(hit!.verdict).toBe("contaminated");
    expect(hit!.distrustReasons.join(" ")).toContain("摘要");
  });

  it("纠正不存在的路径或相同摘要应报错", () => {
    resetMemory();
    importManifest(manifest("m", [action({ id: "a" })]));
    expect(() => correctDigest({ importId: 1, path: "nope.c", newDigest: hx("x") })).toThrow();
    expect(() => correctDigest({ importId: 1, path: "src.c", newDigest: hx("src.c") })).toThrow();
  });
});
