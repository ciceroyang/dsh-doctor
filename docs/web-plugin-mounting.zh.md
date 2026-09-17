# DSH web 插件是怎么挂上去的，以及「装上了但永远不会加载」这个坑

*2026-09-17。写于一次「安装成功、页面上什么都没有」之后。*

## 三个环节

**1. profile 树。** `$DSH_HOME/profiles/<name>/package.json` 里有两个东西:`dependencies` 和
`dsh.profile.bundles`(有序的 bundle 层栈)。整棵树在**启动时组合一次**:依次应用栈里每个 bundle 的
`cordis.patch.yml`,再应用 profile 自己的 patch 层,最后是 `--patch` 覆盖层。

**2. 宿主挂载。** 一个包只有当某个 loader 条目点了它的名字才可达。bundle 通过自己的 patch 文件贡献
条目;profile 的 patch 也可以手写一条:

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```

**3. 浏览器半。** `@deepseek-ai/dsh-client-modules` 扫描**当前 loader 里活着的条目**,找到清单里声明了
`dsh.client` 且 `platform: web` 的包,解析 `exports["./client"]`,把文件挂在
`/plugins/??<name>/client.js&rev=<hash>`,并组合出 `window.__DSH_BOOT__`。宿主半没挂上,浏览器半根本不会
被看一眼。

## 坑在哪

`dsh plugin add` 会拿已安装的树去校准 profile。一个依赖如果解析到的包**声明了 `dsh.bundle`**,它就加入
bundle 栈,它的 patch 会被应用、宿主半被挂载。而一个**只声明 `dsh.client`** 的包,只是一个普通依赖:装上了、
出现在 `dependencies` 里,然后**永远不会被挂载**。没有报错,命令退出码 0,页面上就是没有这个插件。

我们本机的 profile 里就有一段注释在说这件事:

> llm-as-verifier 只声明了 dsh.client(无 bundle patch),`dsh plugin add` 只会把它装成普通依赖而不激活;
> 这一行才把它挂进 loader 树。

作者侧的修法是一个文件加一个字段:

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: my-plugin
```

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

一个包可以同时声明 `dsh.bundle` 和 `dsh.client`:bundle 那半把宿主条目挂上去,client 那半才有机会到页面。
正是这个组合让 `dsh plugin --profile web add github:owner/repo#v1.2.3` 成为一条**真的会生效**的命令。

## 不安装也能先验:`--web-plugin`

`dsh-doctor --web-plugin <目录>` 判断一个包能不能被挂载,以及为什么不能:

| 检查 | 何时失败 |
| --- | --- |
| `plugin_manifest` | `package.json` 缺失、无法解析,或没有 `name` |
| `plugin_host_mount` | 没有 `dsh.bundle.patch`(warn:一条命令装完不会挂载),或补丁文件不存在,或它插入的是别的包名 |
| `plugin_client_export` | `dsh.client.platform` 不是 `web`,或 `exports["./client"]` 缺失、指向不存在的文件 |
| `plugin_client_bundle` | 产物没有恰好注册一个 loader 条目、注册的 id 与包名不一致、物化失败、没有导出 `apply(ctx)`、`inject` 格式不对,或请求了 `dsh.client.external` 未声明的包 |
| `plugin_npm_files` | `files` 漏掉补丁文件或浏览器端产物,发布出去的包装不上 |

产物会在隔离的 `node:vm` 上下文里执行,作用域里只有一个 `window.__ModuleLoader__` 桩:一次同时证明
产物有效、且注册阶段不碰任何浏览器全局。

```sh
node doctor.mjs --web-plugin /path/to/plugin
```

## 为什么注册 id 必须等于包名

组合器用**包名**构造图里的行(`id`),浏览器用产物**内部**的 `id` 注册工厂。同一个身份有两个独立来源。
两者不一致时,图里那一行没有任何工厂应答,页面一旦尝试物化就失败。我们的构建脚本专门读 `pkg.name`,
`plugin_client_bundle` 专门比对这两个值。

## 怎么在不动正在跑的实例的前提下验证

新加的 bundle **不会**热加载进正在跑的 `dsh web`。做这组测量的那个 profile 里,插件已经装好、也已经出现在
`dsh.profile.bundles` 里,但实时服务器对它的组合路由返回 **404**,而启动前就装好的插件返回 200——bundle 栈是
启动时读的,`patchReload: live` 只管 patch 文件、不管 bundle 列表。所以下结论「插件坏了」之前,先重启,或者
另起一个实例。

另起实例是安全的验证方式,下面的证据就是这么来的:

```sh
VH=/tmp/dsh-verify-home
mkdir -p "$VH/profiles"
cp ~/.dsh/settings.yaml "$VH/" 2>/dev/null || true
cp -a ~/.dsh/profiles/web "$VH/profiles/web"   # 真拷贝:硬链接会写穿到实时 profile

DSH_HOME="$VH" dsh web --port 3081 --no-open   # `dsh web` 本身就是 profile 别名

# token 从新进程的日志里取,然后:
#   - 页面 boot graph 里要有插件 id
#   - /plugins/??<name>/client.js&rev=<rev> 要返回 200,且声明 id: "<name>"
```

如果做测试的 agent 本身就跑在那个进程里,就别为了验证去重启实时服务器。隔离拷贝只花几秒和一个端口。

## 对照组说明什么

| 包 | 形态 | `--web-plugin` 结论 |
| --- | --- | --- |
| 三个新插件(`dsh-privacy-guard`、`dsh-prompt-library`、`dsh-followup-actions`) | `dsh.bundle` + `dsh.client` | 五项全过;在隔离实例里成功启动、出现在 `__DSH_BOOT__`、产物 200 |
| `dsh-report-studio` | 只有 `dsh.bundle` | 宿主挂载通过,两项客户端检查 skip |
| `dsh-peak-meter` | 只有 `dsh.client`,靠手写 insert 挂载 | 宿主挂载 warn——正是它 README 里写的做法 |
| `@deepseek-ai/dsh-client-ui-llm-verifier` | 只有 `dsh.client`,已安装 | 宿主挂载 warn——与 profile patch 层里的注释一致 |

## 小结

装上不等于挂上,挂上不等于有路由,有路由不等于渲染出来。每一步都有一个很便宜的检查,而前两步失败时都是
静默的。插件不出现时,按这个顺序问:清单里声明了 `dsh.bundle` 吗;补丁里 insert 的是这个包名吗;安装之后
服务器启动过吗;产物注册的 loader id 等于包名吗。
