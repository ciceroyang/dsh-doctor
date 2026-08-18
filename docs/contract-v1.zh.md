# dsh-doctor/v1 契约 · 词汇表 r5(冻结)+ v1.1 增补

社区契约的正式记录,定稿于 deepseek-harness 讨论 #1719(2026-08-16 冻结)。
三个合规实现:ciceroyang/dsh-doctor、moonquake2004/dsh-doctor、dsh-win32。

## 信封

```json
{
  "schema": "dsh-doctor/v1",
  "generatedAt": "2026-08-16T00:00:00.000Z",
  "profile": "/path/to/dsh-home",
  "exitCode": 0,
  "summary": { "pass": 9, "warn": 1, "fail": 0, "skip": 0 },
  "ok": true,
  "checks": [ { "name": "node", "status": "pass", "detail": "..." } ]
}
```

## 状态字面量

`pass | warn | fail | skip`(小写;旧 `ok` 字面量已废弃,顶层布尔仍为 `ok`)。

- `skip` 必须在 `detail` 里写原因;既不算 pass 也不算 fail。
- `summary.skip` 恒出现(未用时为 0)。
- `ok` = 无 fail。

## 退出码(仅属于 CLI 入口)

0 全过 / 1 有 warn / 2 有 fail。退出码是"直接调用 doctor"的属性,不是"跑了检查"的属性;嵌入式调用方(安装器、setup 命令)自定策略。采用退出码是破坏性变更:必须 minor bump + release note;消费方只拿 exit 2 当门禁,exit 1 视为信息性。

## 核心检查名词汇表

每条 = 四元组(名称、语义、状态、出处)。

| name | 语义 | 状态 | 出处 |
|---|---|---|---|
| `node` | Node 对照仓库声明的 engines `^22.19.0 || >=24.0.0` | 范围内 pass;范围外 warn(npm EBADENGINE 语义,不设硬 fail 档) | 根 package.json;#2259 待传播进发布包 |
| `pnpm` | pnpm 可用性 | 存在 pass;缺失 warn(corepack 可恢复) | - |
| `dsh` | dsh 在 PATH | pass;仅 npx 可用 warn | - |
| `ds_home` | DSH_HOME 存在 + settings.yaml 可写 | pass;缺 settings warn;不可写 fail | #1027 |
| `profiles` | profile 清单可解析 | pass;无应用组合包(启动挂起)/损坏条目 warn | #964、#2321 |
| `sessions` | 会话日志可枚举 | pass;缺失/不可读 warn | - |
| `log_health` | zstd 容器结构 + 可解码性(多帧扫描+解码) | pass;坏帧/解码失败 fail | #1043 |
| `dedupe` | 关键包单副本(cordis/dsh-tools/dsh-skill) | pass;多副本 fail | #1849 |
| `port` | 默认端口可用 | 空闲 pass;被占 warn | - |

## 规则

1. 未入词汇表的检查保留厂商前缀的本地 id,直到提名。
2. 新名字通过四元组入表;CI 只按 name + status 断言,`detail` 保持自由文本。
3. `schema` 恒为 `"dsh-doctor/v1"`;词汇增补不升版本。

## v1.1 增补:可选信封字段 `remediation`(三方 +1 通过)

- 仅 opt-in:显式 flag(`--json --envelope --remediation`)才发射;冻结的 r5 消费者永远看不到
- 数组行格式 `"[检查名] 自由文本"`——键为 `checks[].name` 的精确值,到第一个 `]` 为止;解析规则是**边界而非字符集**:`/^\[([^\]]+)\] /`。`]` 是检查名唯一不能包含的字符。
- 空格后的正文为自由文本(语言不钉);消费者不得越过边界解析
- 聚合:仅 warn/fail 子集,按检查顺序;各实现自有的逐检查修复文本(字段名实现自定,如 `fix`,或内联在 `detail`)不被假定存在
- 出处:ciceroyang/dsh-doctor 0.5.2(提案);moonquake2004/dsh-doctor、dsh-win32(评审)

## 历史与署名

起草:@ciceroyang(ciceroyang/dsh-doctor);评审:@sjh9714(dsh-win32)、
@moonquake2004(moonquake2004/dsh-doctor)。讨论串:#1719。
信封基础:@zoahdev 的原始设计。`skip` 状态与"退出码只属于 CLI 入口"规则
来自 @sjh9714 的实装报告。v1.1 的 remediation 字段源自 ciceroyang/dsh-doctor
0.5.1 的人类输出修复建议,经 moonquake2004 的键控边界细化与 sjh9714 的
"边界而非字符集"修正而泛化。
