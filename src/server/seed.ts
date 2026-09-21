import type { ManifestImport, RawAction, RawInput, RuleSet } from "../domain/types.js";
import { fingerprint } from "../domain/bytes.js";
import type { VaultStore } from "./store.js";

function digest(label: string) {
  return fingerprint(label, (writer) => writer.text(label));
}

function outputs(label: string) {
  return [{ path: `out/${label}.bin`, digest: digest(`output:${label}`) }];
}

function input(id: string, path: string, value: string, extra: Partial<RawInput> = {}): RawInput {
  return {
    id,
    path,
    separator: path.includes("\\") ? "\\" : "/",
    digest: digest(`input:${value}`),
    executable: false,
    ...extra,
  };
}

export function demoManifest(): ManifestImport {
  const actions: RawAction[] = [
    {
      id: "compile-core",
      command: "cc",
      argv: ["-c", "/workspace/core.c", "-o", "out/core.o"],
      envWhitelist: ["CC", "BUILD_PROFILE"],
      observedEnv: { CC: "clang-18", BUILD_PROFILE: "release", SECRET_TOKEN: "machine-a" },
      toolchain: { compiler: "clang-18", sysroot: "/opt/sdk" },
      platform: { os: "darwin", arch: "arm64", shell: "zsh" },
      inputs: [
        input("core.c", "/workspace/core.c", "core-v1"),
        input("core.h", "/workspace/include/core.h", "core-header-v1"),
      ],
      dependencies: [],
      status: "succeeded",
      outputs: outputs("core"),
    },
    {
      id: "compile-app",
      command: "cc",
      argv: ["-c", "/workspace/app.c", "-o", "out/app.o"],
      envWhitelist: ["CC", "BUILD_PROFILE"],
      observedEnv: { CC: "clang-18", BUILD_PROFILE: "release", SECRET_TOKEN: "machine-b" },
      toolchain: { compiler: "clang-18", sysroot: "/opt/sdk" },
      platform: { os: "darwin", arch: "arm64", shell: "zsh" },
      inputs: [
        input("app.c", "/workspace/app.c", "app-v1"),
        input("core.h", "/workspace/include/core.h", "core-header-v1"),
      ],
      dependencies: ["compile-core"],
      status: "succeeded",
      outputs: outputs("app"),
    },
    {
      id: "test-core",
      command: "ctest",
      argv: ["--test-dir", "out", "--tests", "core"],
      envWhitelist: ["CC"],
      observedEnv: { CC: "clang-18", REMOTE_BUILDER: "builder-7" },
      toolchain: { compiler: "clang-18", sysroot: "/opt/sdk" },
      platform: { os: "darwin", arch: "arm64", shell: "zsh" },
      inputs: [input("test-core.c", "/workspace/test/core.c", "core-test-v1")],
      dependencies: ["compile-core"],
      status: "succeeded",
      outputs: outputs("test-core"),
    },
    {
      id: "package-windows",
      command: "cc",
      argv: ["-c", "C:\\workspace\\app.c", "-o", "out\\app-win.o"],
      envWhitelist: ["CC", "BUILD_PROFILE"],
      observedEnv: { CC: "clang-18", BUILD_PROFILE: "release" },
      toolchain: { compiler: "clang-18", sysroot: "C:\\sdk" },
      platform: { os: "windows", arch: "arm64", shell: "cmd" },
      inputs: [input("app-win.c", "C:\\workspace\\app.c", "app-v1"), input("core-win.h", "C:\\workspace\\include\\core.h", "core-header-v1")],
      dependencies: ["compile-app"],
      status: "succeeded",
      outputs: [{ path: "out\\app-win.zip", digest: digest("output:app-win") }],
    },
    {
      id: "link-legacy-failed",
      command: "ld",
      argv: ["--frozen", "out/app.o"],
      envWhitelist: ["LD_PATH"],
      observedEnv: {},
      toolchain: { linker: "ld-classic" },
      platform: { os: "linux", arch: "x64", shell: "bash" },
      inputs: [input("legacy.map", "/workspace/legacy.map", "legacy-v1")],
      dependencies: ["compile-core"],
      status: "failed",
      outputs: [],
    },
    {
      id: "copy-artifact-a",
      command: "install",
      argv: ["-m", "755", "/workspace/artifact", "/staging/artifact"],
      envWhitelist: ["BUILD_PROFILE"],
      observedEnv: { BUILD_PROFILE: "release", LOCAL_PAGER: "less" },
      toolchain: { install: "coreutils-9" },
      platform: { os: "linux", arch: "x64", shell: "bash" },
      inputs: [
        input("artifact", "/workspace/artifact", "artifact-script", {
          executable: true,
          symlinkTarget: "/workspace/artifact-real",
          targetSeparator: "/",
        }),
      ],
      dependencies: [],
      status: "succeeded",
      outputs: [{ path: "/staging/artifact", digest: digest("output:artifact-a") }],
    },
    {
      id: "copy-artifact-b",
      command: "install",
      argv: ["-m", "755", "/workspace/artifact", "/staging/artifact"],
      envWhitelist: ["BUILD_PROFILE"],
      observedEnv: { BUILD_PROFILE: "release", LOCAL_PAGER: "more" },
      toolchain: { install: "coreutils-9" },
      platform: { os: "linux", arch: "x64", shell: "bash" },
      inputs: [
        input("artifact", "/workspace/artifact", "artifact-script", {
          executable: true,
          symlinkTarget: "/workspace/artifact-real",
          targetSeparator: "/",
        }),
      ],
      dependencies: [],
      status: "succeeded",
      outputs: [{ path: "/staging/artifact", digest: "output:artifact-b-stale" }],
    },
  ];
  return { id: "manifest-demo-001", importedAt: "2026-09-22T04:50:00.000Z", actions };
}

export function demoDraftRules(): { rules: RuleSet["rules"]; description: string } {
  return {
    description: "显式批准：工作区路径别名与 Windows/POSIX separator 等价",
    rules: [
      { id: "r-workspace-alias", scope: "command", kind: "pathAlias", from: "/workspace", to: "/ci/work", description: "工作区挂载点别名" },
      { id: "r-input-slash", scope: "separator", kind: "separatorAlias", tokenKind: "inputPath", from: "\\", to: "/", description: "输入路径 separator 等价" },
      { id: "r-symlink-slash", scope: "separator", kind: "separatorAlias", tokenKind: "symlinkTarget", from: "\\", to: "/", description: "symlink 目标 separator 等价" },
      { id: "r-darwin-arm", scope: "platform", kind: "valueAlias", name: "arch", from: "arm64", to: "aarch64", description: "架构名等价" },
      { id: "r-permutable-warning", scope: "command", kind: "permutableFlagGroup", flags: ["-Wall", "-Wextra"], description: "仅这两个 warning flag 可交换" },
    ],
  };
}

export function seedDemo(store: VaultStore): { seeded: boolean } {
  const state = store.snapshot();
  if (state.manifests.some((manifest) => manifest.id === "manifest-demo-001")) return { seeded: false };
  const manifest = demoManifest();
  store.importManifest(manifest);
  const after = store.snapshot();
  const find = (id: string) => after.actions.find((entry) => entry.action.id === id)!;
  const core = find("compile-core");
  store.observeCache({
    actionKey: core.fingerprint.key,
    resultVersion: core.fingerprint.resultVersion,
    outputDigest: digest("outputs:core"),
    outputs: core.action.outputs,
    source: "ci-cache/region-tokyo/clean",
    observedAt: "2026-09-22T04:52:00.000Z",
  });
  for (const id of ["copy-artifact-a", "copy-artifact-b"]) {
    const entry = find(id);
    store.observeCache({
      actionKey: entry.fingerprint.key,
      resultVersion: entry.fingerprint.resultVersion,
      outputDigest: digest(`outputs:${id}`),
      outputs: entry.action.outputs,
      source: id === "copy-artifact-a" ? "worker-a/object-17" : "worker-b/object-42",
      observedAt: id === "copy-artifact-a" ? "2026-09-22T04:53:00.000Z" : "2026-09-22T04:54:00.000Z",
    });
  }
  return { seeded: true };
}
