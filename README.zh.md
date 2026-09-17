# dsh-doctor

DeepSeek Harness 本地环境一键体检。社区 Ideas 区 #1719 提案的落地实现(零依赖)。

> 状态:可用。当前版本请以 [Releases](https://github.com/ciceroyang/dsh-doctor/releases) 为准。本项目是面向 DeepSeek Harness 开发者预览版的独立社区工具,接口可能变化。

## 用法

    npx github:ciceroyang/dsh-doctor
    node doctor.mjs --json                    # 检查项数组
    node doctor.mjs --json --envelope         # dsh-doctor/v1 信封(社区统一契约)
    node doctor.mjs --profile <目录>          # 指定 DSH_HOME/目录
    node doctor.mjs --all-logs                # 全库扫描会话日志(默认只抽样最新的 3 个)
    node doctor.mjs --strict-peer             # 把「插件未声明兼容范围」提升为 warning
    node doctor.mjs --lint-peers [目录]        # 检查本包自己的 @deepseek-ai/* peer 区间(不匹配时退出码 1)
    node doctor.mjs --candidate-peer <补丁>     # 对某个 profile 预检一份待应用的补丁(不写入)
    node doctor.mjs --web-plugin <目录>         # 预检一个插件包能不能被挂载(不安装)

## 在 CI 里检查自己的声明

`--lint-peers` 是 `ciceroyang/peer_range` 的作者侧:读当前包的 `@deepseek-ai/*` peer 声明,与一个 DSH 安装提供的 host 版本逐条比对。

```yaml
- run: npm install -g @deepseek-ai/dsh
- run: node doctor.mjs --lint-peers .
```

退出码:`0` 所有声明区间都覆盖已装 host;`1` 至少一条不覆盖;`2` 用法错误**或本机没找到 DSH 安装**——没有可比对对象时绝不静默通过。`*` 声明会显示为通配,而不是通过。

规则本身写成了文档:[docs/host-peer-declarations.md](docs/host-peer-declarations.md)(解析顺序、三态、以及决定实现是否可用的预发布合并规则)。

全生态的评分快照以滚动 release 发布,见下一节。

## 全生态快照

`scripts/ecosystem-compat.mjs` 读取一个插件目录的仓库清单,抓取各仓库根 `package.json`,把每条 `@deepseek-ai/*` peer 声明与一个 DSH 安装提供的 host 版本比对打分。一个每周的 workflow 会跑它并把结果作为滚动 release 发布:

- JSON:`https://github.com/ciceroyang/dsh-doctor/releases/download/ecosystem-compat/compat.json`
- Markdown 摘要:`https://github.com/ciceroyang/dsh-doctor/releases/download/ecosystem-compat/compat-summary.md`

也可以对任意来源跑:

```sh
node scripts/ecosystem-compat.mjs --source <url或文件> --out compat.json --summary compat-summary.md
```

首次手动运行(2026-09-15,社区目录的 503 个仓库):305 个声明了至少一条 host peer,41 个至少有一条区间不包含已装 host,162 个完全没有 host 声明。

## 预检一份补丁(`candidate`,v1.2 草案)

`--candidate-peer <patch.yml> --profile <profileDir>` 判定「这份补丁应用**之后**的树」,但不实际写入。它实现了 v1.2 `candidate` 草案(deepseek-ai/deepseek-harness#1719)里与声明相关的那一部分:

| 检查 | 何时失败 |
| --- | --- |
| `candidate-insert-collision` | 插入的 id 已存在于当前树(warn) |
| `candidate-module-installed` | 插入的包在变更后的树里找不到(fail) |
| `candidate-peer-range` | 插入包声明的 `@deepseek-ai/*` 区间不包含它将拿到的 host(fail) |

## 预检一个插件包(`--web-plugin`)

`--web-plugin <目录>` 回答的是插件作者在 `dsh plugin add` 看起来成功之后一分钟就会问的问题:**这个包到底会不会出现在 Web 界面里?** 不安装、不写入任何文件。

它来自一个很容易踩的坑:只声明 `dsh.client` 的包,`dsh plugin add` 会把它装成依赖但**永远不会挂载**,因为 profile 只对声明了 `dsh.bundle` 的包做分层。我们本机的 profile 里就有一段关于 `@deepseek-ai/dsh-client-ui-llm-verifier` 的注释在说这件事,这个检查第一次运行就把复现出来了。

| 检查 | 何时失败 |
| --- | --- |
| `plugin_manifest` | `package.json` 缺失或无法解析,或没有 `name` |
| `plugin_host_mount` | 没有 `dsh.bundle.patch`(warn:一条命令装完不会挂载),或补丁文件不存在,或它插入的是别的包名 |
| `plugin_client_export` | `dsh.client.platform` 不是 `web`,或 `exports["./client"]` 缺失、指向不存在的文件 |
| `plugin_client_bundle` | 产物没有恰好注册一个 loader 条目、注册的 id 与包名不一致、物化失败、没有导出 `apply(ctx)`、`inject` 格式不对,或请求了 `dsh.client.external` 未声明的包 |
| `plugin_npm_files` | `files` 漏掉补丁文件或浏览器端产物,发布出去的包装不上 |

产物会在一个隔离的 `node:vm` 上下文里执行,作用域里只有一个 `window.__ModuleLoader__` 桩。这一件事同时证明两点:产物是有效的,而且它在注册阶段不碰任何浏览器全局。

任一检查 fail 时退出码 1,否则 0;`--json` 把同样的检查按数据输出。

完整机理——「装上 / 挂上 / 提供」三者的区别、只声明 `dsh.client` 的包为什么一直隐身、以及怎么在隔离的第二个实例里验证——见 [docs/web-plugin-mounting.zh.md](docs/web-plugin-mounting.zh.md)。

`--json` 会输出带 `mode: "candidate"` 的信封;默认信封永远不带该字段。本模式**不做任何写入**:隔离/回滚属于执行写入的安装器,输出里也这么写明。

## 社区契约(dsh-doctor/v1)

与 zoahdev、moonquake2004 三方实现对齐(官方讨论 #1719):
- 信封:`{ schema, generatedAt, profile, exitCode, summary{pass,warn,fail}, ok, checks:[{name,status,detail}] }`
- status 字面量:`pass` / `warn` / `fail` / `skip`(r5 起,原 `ok` 字面量已废弃;顶层布尔仍为 `ok`)
- 退出码:0 全过 / 1 有 warn / 2 有 fail(只属于 CLI 入口,见 #1719 r4/r5)
- 检查名词汇表(v1.1 草案,见 #1719):`node` / `pnpm` / `dsh` / `ds_home` / `profiles` / `sessions` / `log_health` / `dedupe` / `port` —— 本实现已全部使用核心名
- `node` 阈值对齐官方仓库根 package.json 声明的 engines(`^22.19.0 || >=24.0.0`);#2259 在推进该声明传播进发布包
- 词汇表 r5 兼容 — 起草:@ciceroyang(本仓库),评审:@sjh9714(dsh-win32)、@moonquake2004
- 规范全文见 [docs/contract-v1.zh.md](docs/contract-v1.zh.md)(中文)/ [docs/contract-v1.md](docs/contract-v1.md)(英文)——冻结文本,可引用

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
- 会话日志健康抽查(多帧 zstd 帧扫描 + 全量解码,独家检查项),含 #6651 的首帧条件(首帧必须恰好一行 `session` header;违反时日志能正常解码,却会阻断 `dsh web` 启动并使会话列表为空)。`--all-logs` 改为全库扫描(默认只抽样最新 3 个),避免唯一那个坏日志落在抽样之外
- 插件包预检(`--web-plugin`):一个包能不能被 web profile 挂载——`dsh.bundle` 宿主挂载点、`exports["./client"]`、产物注册的 loader id 是否等于包名、`dsh.client.external` 是否声明了实际请求的依赖、npm `files` 是否覆盖挂载所需文件。来自一个真实的坑(只声明 `dsh.client` 的包被 `dsh plugin add` 装成依赖但永不激活);第一次对我们自己那三个插件和 `@deepseek-ai/dsh-client-ui-llm-verifier` 运行就复现了它
- 已装插件兼容性(`ciceroyang/peer_range`,按契约规则 1 使用厂商前缀本地 id):对每个 profile `dependencies` 里的插件,把它声明的 `@deepseek-ai/*` peer 范围与磁盘上实际安装的 host 版本比对,完全离线。三态:兼容 / 不兼容 / 未知(`*`、未声明、无法解析、rc 语义无法判定);未知只报未知、绝不当作兼容,`--strict-peer` 可把它升级为 warning。这是 #4792 插件 × harness 兼容性问题的离线一半

输出 ok / warn / fail 三态,每项附可执行建议。

## 常见问题速查(doctor 直接给答案)

- pnpm not found on PATH → npm i -g pnpm(国内用 npmmirror 镜像)
- 弹窗"暂时无法保存确认状态" → settings.yaml 不可写,chown 修复
- plugin tree failed to load → 用 --dump-config 定位条目 + node 手动 import 验证
- 历史会话读不出 → Node < 22.15 无内置 zstd

## 参考

- 提案来源:官方 Discussions #1719
- 开发踩坑全记录:https://github.com/ciceroyang/dsh-report-studio/blob/main/docs/tutorial-zh.md
