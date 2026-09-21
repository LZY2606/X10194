// 演示种子：两批清单，覆盖全部语义维度，且动作故意乱序（前向引用）。
import { createHash } from "node:crypto";
import { getDb, logEvent } from "./db.ts";
import { currentRuleVersionId, importManifest, observeEntry } from "./store.ts";
import type { Manifest, RawAction } from "../shared/types.ts";

function hx(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function action(partial: Partial<RawAction> & Pick<RawAction, "id" | "command">): RawAction {
  return {
    args: [],
    envWhitelist: ["CC", "BUILD_TYPE"],
    env: { CC: "clang", BUILD_TYPE: "release" },
    toolchain: { name: "llvm", version: "17.0.6", path: "/usr/bin/clang" },
    platform: { os: "darwin", arch: "arm64" },
    inputs: [],
    deps: [],
    outputs: [],
    result: "success",
    ...partial,
  };
}

function buildManifests(): Manifest[] {
  // 清单 A：乱序——lib 先声明但 app 排在前面（前向引用），util 为共享子图
  const manifestA: Manifest = {
    manifestId: "demo-batch-A",
    importedAt: "2026-09-20T09:00:00+09:00",
    actions: [
      action({
        id: "app:build",
        command: "ld",
        args: ["-o", "app", "libcore.a", "libutil.a"],
        deps: ["lib:core", "lib:util"],
        inputs: [{ path: "src/main.c", kind: "file", digest: hx("main.c"), mode: 0o644 }],
        outputs: [{ path: "bin/app", kind: "file", digest: hx("app-v1"), mode: 0o755 }],
      }),
      action({
        id: "lib:core",
        command: "clang",
        args: ["-c", "<SDK>/core.c", "-O2"],
        envWhitelist: ["CC", "BUILD_TYPE", "SDK_HOME"],
        env: { CC: "clang", BUILD_TYPE: "release", SDK_HOME: "/opt/sdk-v1" },
        inputs: [
          { path: "/opt/sdk-v1/core.c", kind: "file", digest: hx("core.c"), mode: 0o644 },
          { path: "build/gen.tbl", kind: "symlink", digest: hx("target:../shared/gen.tbl"), target: "../shared/gen.tbl", targetDigest: hx("gen-content"), mode: 0o777 },
        ],
        deps: ["lib:util"],
        outputs: [{ path: "libcore.a", kind: "file", digest: hx("core-lib-v1"), mode: 0o644 }],
      }),
      action({
        id: "lib:util",
        command: "clang",
        args: ["-c", "util.c"],
        inputs: [{ path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o644 }],
        outputs: [{ path: "libutil.a", kind: "file", digest: hx("util-lib-v1"), mode: 0o644 }],
      }),
      action({
        id: "tool:gen",
        command: "python3",
        args: ["gen.py"],
        // 未声明环境：CI_TOKEN 存在但不在白名单——不能进 key
        envWhitelist: ["PYTHONHASHSEED"],
        env: { PYTHONHASHSEED: "0", CI_TOKEN: "secret-xyz" },
        inputs: [{ path: "gen.py", kind: "file", digest: hx("gen.py"), mode: 0o755 }],
        result: "failure",
        failure: { code: 2, message: "模板缺失" },
        outputs: [],
      }),
    ],
  };

  // 清单 B：语义近邻场景 + 平台差异 + 同键异输出争议
  const manifestB: Manifest = {
    manifestId: "demo-batch-B",
    importedAt: "2026-09-21T10:30:00+09:00",
    actions: [
      // 与 lib:util 的规范化潜力：路径别名 + 参数顺序
      action({
        id: "lib:util-alias",
        command: "clang",
        args: ["-c", "util.c"],
        inputs: [
          { path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o644 },
        ],
        outputs: [{ path: "libutil.a", kind: "file", digest: hx("util-lib-v1"), mode: 0o644 }],
      }),
      // 参数顺序不同：-D A -D B（默认规则下 miss；草案声明 -D 可交换后可能命中）
      action({
        id: "lib:util-defs",
        command: "clang",
        args: ["-c", "util.c", "-D", "B", "-D", "A"],
        inputs: [{ path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o644 }],
        outputs: [{ path: "libdefs.a", kind: "file", digest: hx("defs-lib"), mode: 0o644 }],
      }),
      action({
        id: "lib:util-ord",
        command: "clang",
        args: ["-c", "util.c", "-D", "A", "-D", "B"],
        inputs: [{ path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o644 }],
        outputs: [{ path: "libdefs2.a", kind: "file", digest: hx("defs-lib"), mode: 0o644 }],
      }),
      // 可执行位差异：同路径同摘要，mode 不同
      action({
        id: "lib:util-bit",
        command: "clang",
        args: ["-c", "util.c"],
        inputs: [{ path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o755 }],
        outputs: [{ path: "libutil-bit.a", kind: "file", digest: hx("util-lib-v1"), mode: 0o644 }],
      }),
      // Windows 分隔符路径：默认规则 miss，开启 separator 归一后与别名场景可能接近
      action({
        id: "lib:core-winpath",
        command: "clang",
        args: ["-c", "<SDK>\\core.c", "-O2"],
        envWhitelist: ["CC", "BUILD_TYPE", "SDK_HOME"],
        env: { CC: "clang", BUILD_TYPE: "release", SDK_HOME: "C:\\sdk" },
        platform: { os: "win32", arch: "x64" },
        inputs: [
          { path: "C:\\sdk\\core.c", kind: "file", digest: hx("core.c"), mode: 0o644 },
        ],
        deps: [],
        outputs: [{ path: "core-win.a", kind: "file", digest: hx("core-lib-v1"), mode: 0o644 }],
      }),
      // 平台差异（同输入）：默认 miss
      action({
        id: "lib:util-linux",
        command: "clang",
        args: ["-c", "util.c"],
        platform: { os: "linux", arch: "arm64", libc: "glibc" },
        inputs: [{ path: "src/util.c", kind: "file", digest: hx("util.c"), mode: 0o644 }],
        outputs: [{ path: "libutil-lx.a", kind: "file", digest: hx("util-lib-v1"), mode: 0o644 }],
      }),
    ],
  };
  return [manifestA, manifestB];
}

export function seedIfEmpty(): { imported: boolean } {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS n FROM imports").get() as { n: number };
  if (count.n > 0) return { imported: false };

  const [manifestA, manifestB] = buildManifests();
  const ruleId = currentRuleVersionId();

  const resA = importManifest(manifestA, { autoObserve: false });
  const resB = importManifest(manifestB, { autoObserve: false });

  // 制造“同键异输出”争议：取 lib:util 与 lib:util-alias 的 key，
  // 再手工登记一个同 key 但输出摘要不同的远程来源观察（旧文件污染）。
  const keyUtil = db
    .prepare("SELECT action_key FROM derivations WHERE import_id = ? AND action_id = 'lib:util' AND rule_version_id = ?")
    .get(resA.importId, ruleId) as { action_key: string };
  observeEntry({
    key: keyUtil.action_key,
    ruleVersionId: ruleId,
    resultHash: hx("util-lib-STALE"),
    source: "remote-cache/node-7/2026-09-18",
  });

  // 正常登记两批成功动作（失败动作 tool:gen 不登记）
  // 注意 observeImportActions 内部不会覆盖旧观察，只会追加并触发争议
  // 为清晰演示，改为手工登记正常结果，争议由上面的旧观察 + 这里的新观察构成
  const registerSuccessful = (importId: number) => {
    const rows = db
      .prepare(
        `SELECT d.action_id, d.action_key, d.result_hash, a.raw_json
         FROM derivations d JOIN actions a
           ON a.import_id = d.import_id AND a.action_id = d.action_id
         WHERE d.rule_version_id = ? AND d.import_id = ? ORDER BY a.ordinal`,
      )
      .all(ruleId, importId) as {
      action_id: string;
      action_key: string;
      result_hash: string;
      raw_json: string;
    }[];
    for (const row of rows) {
      const raw = JSON.parse(row.raw_json) as RawAction;
      if (raw.result === "failure") continue;
      observeEntry({
        key: row.action_key,
        ruleVersionId: ruleId,
        resultHash: row.result_hash,
        source: `manifest#${importId}:${row.action_id}`,
        actionId: row.action_id,
        importId,
      });
    }
  };
  registerSuccessful(resA.importId);
  registerSuccessful(resB.importId);

  void resB;
  logEvent(db, "seed", "已载入演示清单 A/B（含乱序、共享子图、失败节点、同键异输出）");
  return { imported: true };
}
