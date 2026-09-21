# 构建指纹舱

离线复盘远程构建缓存 key 的 TypeScript + Node.js + SQLite + Vite 应用，不连接真实缓存服务。

## 运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5254 --strictPort
```

打开 http://127.0.0.1:5254 后点击“载入离线演示”。数据库默认位于 `data/fingerprint-vault.sqlite`，可用 `FINGERPRINT_DB` 覆盖。

## 核心语义

- 原始 manifest 和动作只追加，不原地修改；摘要纠正生成新一代派生记录。
- Action key 钉住命令、白名单环境、工具链、平台、输入路径 separator/symlink/可执行位/摘要、依赖 result version 和失败状态。
- 输出只进入 result version，不进入 action key；命中必须同时匹配 key 和 result version。
- 未声明环境不参与指纹；白名单中的缺失值用显式哨兵编码。
- 路径 alias、separator、参数交换都必须由规则显式批准；普通参数顺序绝不自动排序。
- 共享依赖变化和输入纠正沿反向 DAG 传播，只失信可达动作。
- 同 key 异输出进入争议，保留双方来源、输出和首次观察顺序，不做最后写入覆盖。
- 规则草案可干跑历史动作，展示变化 key、等价组和碰撞反例；批准形成新版本，回滚也追加新版本，不改写历史。

## 测试

`tests/canonical.test.ts` 覆盖 separator、symlink、环境缺失、参数顺序、可执行位和平台。`tests/store.test.ts` 覆盖依赖共享、失败节点、摘要纠正、同键异输出、规则回滚、乱序导入与 SQLite 重开恢复。所有 hash 输入在 `src/domain/bytes.ts` 中使用带标签、长度前缀的明确 UTF-8 字节编码。
