# dsh-doctor

DeepSeek Harness 本地环境一键体检。社区 Ideas 区 #1719 提案的落地实现(零依赖)。

## 用法

    npx github:ciceroyang/dsh-doctor
    node doctor.mjs --json                    # 检查项数组
    node doctor.mjs --json --envelope         # dsh-doctor/v1 信封(社区统一契约)
    node doctor.mjs --profile <目录>          # 指定 DSH_HOME/目录

## 社区契约(dsh-doctor/v1)

与 zoahdev、moonquake2004 三方实现对齐(官方讨论 #1719):
- 信封:`{ schema, generatedAt, profile, exitCode, summary{pass,warn,fail}, ok, checks:[{name,status,detail}] }`
- status 字面量:`pass` / `warn` / `fail` / `skip`(r5 起,原 `ok` 字面量已废弃;顶层布尔仍为 `ok`)
- 退出码:0 全过 / 1 有 warn / 2 有 fail(只属于 CLI 入口,见 #1719 r4/r5)
- 检查名词汇表(v1.1 草案,见 #1719):`node` / `pnpm` / `dsh` / `ds_home` / `profiles` / `sessions` / `log_health` / `dedupe` / `port` —— 本实现已全部使用核心名
- `node` 阈值对齐官方仓库根 package.json 声明的 engines(`^22.19.0 || >=24.0.0`);#2259 在推进该声明传播进发布包

## 检查项

- node 版本(≥18 可用,≥22.15 才支持历史会话日志读取)
- pnpm(dsh plugin 依赖;缺失给安装命令)
- dsh 是否在 PATH
- DSH_HOME / settings.yaml 是否存在且可写(含 sudo 属主问题的提示)
- profiles 清单完整性(逐个 profile 的 bundle 数,损坏项标出)
- 会话日志数量(多帧 zstd 健康度)
- Node 内置 zstd 可用性
- 端口 3080 占用情况
- 关键包重复检查(dsh-tools/dsh-skill/cordis 多副本 = 工具调度崩溃风险,#1849)
- 会话日志健康抽查(多帧 zstd 帧扫描 + 全量解码,独家检查项)

输出 ok / warn / fail 三态,每项附可执行建议。

## 常见问题速查(doctor 直接给答案)

- pnpm not found on PATH → npm i -g pnpm(国内用 npmmirror 镜像)
- 弹窗"暂时无法保存确认状态" → settings.yaml 不可写,chown 修复
- plugin tree failed to load → 用 --dump-config 定位条目 + node 手动 import 验证
- 历史会话读不出 → Node < 22.15 无内置 zstd

## 参考

- 提案来源:官方 Discussions #1719
- 开发踩坑全记录:https://github.com/ciceroyang/dsh-report-studio/blob/main/docs/tutorial-zh.md
