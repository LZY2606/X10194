import { describe, expect, it } from "vitest";
import { action, digest, input, makeStore, manifest, reopen } from "./helpers.js";

describe("vault store", () => {
  it("accepts dependencies declared out of order and rejects cycles and missing deps", () => {
    const { store } = makeStore();
    const child = action("child");
    const parent = action("parent", { dependencies: ["child"] });
    expect(() => store.importManifest(manifest([parent, child], "unordered"))).not.toThrow();

    const store2 = makeStore().store;
    const cycleA = action("a", { dependencies: ["b"] });
    const cycleB = action("b", { dependencies: ["a"] });
    expect(() => store2.importManifest(manifest([cycleA, cycleB], "cycle"))).toThrow(/cycle|成环/);

    const store3 = makeStore().store;
    expect(() => store3.importManifest(manifest([action("x", { dependencies: ["ghost"] })], "missing"))).toThrow(/不存在/);
  });

  it("pins shared dependency result versions and failed nodes", () => {
    const { store } = makeStore();
    const shared = action("shared");
    const left = action("left-user", { dependencies: ["shared"] });
    const right = action("right-user", { dependencies: ["shared"] });
    store.importManifest(manifest([shared, left, right], "deps-v1"));
    const before = store.snapshot();
    const leftKeyBefore = before.actions.find((item) => item.action.id === "left-user")!.fingerprint.key;

    const changedShared = action("shared", { outputs: [{ path: "out/shared.o", digest: digest("changed-shared-output") }] });
    const store2 = makeStore().store;
    store2.importManifest(manifest([changedShared, left, right], "deps-v2"));
    const after = store2.snapshot();
    const leftKeyAfter = after.actions.find((item) => item.action.id === "left-user")!.fingerprint.key;
    expect(leftKeyBefore).not.toBe(leftKeyAfter);

    const failed = action("failed-shared", { status: "failed", outputs: [] });
    const success = action("success-shared", { status: "succeeded", outputs: [] });
    const failedUser = action("failed-user", { dependencies: ["failed-shared"] });
    const successUser = action("success-user", { dependencies: ["success-shared"] });
    const store3 = makeStore().store;
    store3.importManifest(manifest([failed, success, failedUser, successUser], "failed-nodes"));
    const state = store3.snapshot();
    expect(
      state.actions.find((item) => item.action.id === "failed-user")!.fingerprint.key,
    ).not.toBe(state.actions.find((item) => item.action.id === "success-user")!.fingerprint.key);
  });

  it("distrusts only reverse-reachable actions after an input digest correction", () => {
    const { store } = makeStore();
    const badDigest = digest("bad");
    const trueDigest = digest("true");
    const shared = action("shared", { inputs: [input("shared.c", badDigest)] });
    const user = action("user", { dependencies: ["shared"] });
    const unrelated = action("unrelated", { inputs: [input("other.c", digest("other"))] });
    store.importManifest(manifest([shared, user, unrelated], "correction"));
    const result = store.correctInput("correction", "shared.c", badDigest, trueDigest);
    expect(result.reachable.sort()).toEqual(["shared", "user"]);
    const state = store.snapshot();
    const byId = new Map(state.actions.map((item) => [item.action.id, item]));
    expect(byId.get("shared")!.trusted).toBe(false);
    expect(byId.get("user")!.trusted).toBe(false);
    expect(byId.get("unrelated")!.trusted).toBe(true);
    expect(byId.get("shared")!.fingerprint.components.find((c) => c.component === "inputs")!.digest).not.toBe(
      digest("placeholder"),
    );
  });

  it("preserves same-key different-output disputes without last-write overwrite", () => {
    const { store } = makeStore();
    const build = action("build");
    store.importManifest(manifest([build], "dispute"));
    const fingerprintRecord = store.snapshot().actions[0]!.fingerprint;
    store.observeCache({
      actionKey: fingerprintRecord.key,
      resultVersion: fingerprintRecord.resultVersion,
      outputDigest: digest("good-output"),
      outputs: [{ path: "a", digest: digest("good-output") }],
      source: "first",
      observedAt: "2026-09-22T00:00:00.000Z",
    });
    const result = store.observeCache({
      actionKey: fingerprintRecord.key,
      resultVersion: digest("different-result-version"),
      outputDigest: digest("stale-output"),
      outputs: [{ path: "a", digest: digest("stale-output") }],
      source: "second",
      observedAt: "2026-09-22T00:01:00.000Z",
    });
    expect(result.dispute?.firstSource).toBe("first");
    expect(result.dispute?.conflictingSource).toBe("second");
    const state = store.snapshot();
    expect(state.cache.every((entry) => entry.state === "disputed")).toBe(true);
    expect(state.actions[0]!.cacheState).toBe("disputed");
  });

  it("dry-runs rules, reports collision counterexamples, approval creates a version and rollback appends history", () => {
    const { store } = makeStore();
    const linux = action("linux", {
      id: "same-build",
      argv: ["-c", "/work/a.c"],
      inputs: [input("same-source", digest("same-source"))],
      platform: { os: "linux", arch: "x64", shell: "bash" },
      outputs: [{ path: "a.o", digest: digest("linux-output") }],
    });
    const darwin = action("darwin", {
      id: "same-build",
      argv: ["-c", "/work/a.c"],
      inputs: [input("same-source", digest("same-source"))],
      platform: { os: "darwin", arch: "arm64", shell: "zsh" },
      outputs: [{ path: "a.o", digest: digest("darwin-output") }],
    });
    store.importManifest(manifest([linux], "rules-linux"));
    store.importManifest(manifest([darwin], "rules-darwin"));
    const draft = store.createDraft([
      { id: "dangerous-platform", scope: "platform", kind: "valueAlias", name: "os", from: "linux", to: "unix", description: "linux" },
      { id: "dangerous-platform-2", scope: "platform", kind: "valueAlias", name: "os", from: "darwin", to: "unix", description: "darwin" },
      { id: "dangerous-arch", scope: "platform", kind: "valueAlias", name: "arch", from: "x64", to: "same", description: "x" },
      { id: "dangerous-arch-2", scope: "platform", kind: "valueAlias", name: "arch", from: "arm64", to: "same", description: "a" },
      { id: "dangerous-shell", scope: "platform", kind: "valueAlias", name: "shell", from: "bash", to: "sh", description: "b" },
      { id: "dangerous-shell-2", scope: "platform", kind: "valueAlias", name: "shell", from: "zsh", to: "sh", description: "z" },
    ], "dangerously broad");
    const dry = store.dryRun(draft.version);
    expect(dry.newCollisions.length).toBeGreaterThan(0);
    store.approveDraft(draft.version);
    expect(store.activeRuleSet().version).toBe(draft.version);
    const rolledBack = store.rollbackTo(0);
    expect(rolledBack.version).toBeGreaterThan(draft.version);
    expect(store.activeRuleSet().rules).toEqual([]);
    expect(store.listRuleVersions().filter((ruleSet) => ruleSet.status === "approved")).toHaveLength(1);
    expect(store.listRuleVersions().filter((ruleSet) => ruleSet.status === "rolledBack").length).toBeGreaterThan(0);
  });

  it("recovers durable records after reopening SQLite", () => {
    const harness = makeStore();
    const build = action("recover");
    harness.store.importManifest(manifest([build], "recover"));
    const fingerprintRecord = harness.store.snapshot().actions[0]!.fingerprint;
    harness.store.observeCache({
      actionKey: fingerprintRecord.key,
      resultVersion: fingerprintRecord.resultVersion,
      outputDigest: digest("recover-output"),
      outputs: build.outputs,
      source: "durable",
      observedAt: "2026-09-22T00:00:00.000Z",
    });
    harness.db.close();
    const reopened = reopen(harness.path).store;
    const state = reopened.snapshot();
    expect(state.manifests[0]!.id).toBe("recover");
    expect(state.actions[0]!.cacheState).toBe("hit");
    expect(state.cache[0]!.source).toBe("durable");
  });
});
