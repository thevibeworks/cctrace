<p align="center"><img src="assets/cctrace-logo.svg" width="84" alt="cctrace"></p>

# cctrace

> **看看 Claude 到底发了什么。**
>
> Claude Code 发出的每一个请求 -- messages、OAuth、用量/额度、MCP --
> 全部实时呈现在你的浏览器里。

[English](README.md) | 简体中文

[![tests](https://github.com/thevibeworks/cctrace/actions/workflows/test.yml/badge.svg)](https://github.com/thevibeworks/cctrace/actions/workflows/test.yml)
[![version](https://img.shields.io/github/v/tag/thevibeworks/cctrace?label=version&sort=semver)](https://github.com/thevibeworks/cctrace/tags)
[![license](https://img.shields.io/github/license/thevibeworks/cctrace)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-bun-f9f1e1)](https://bun.sh)

<p align="center">
  <img src="assets/cctrace-demo.gif" alt="cctrace 实时演示" width="100%">
</p>

cctrace 卡在 Claude Code 和 Anthropic API 中间，把每一个 HTTP 请求记录到本地的分
类 Web 界面，结束后保存一份自包含的 HTML 快照，随时打开都能看。无云端、无账号，
数据不出你的机器。

```bash
cctrace
```

就这一行。Claude 照常启动，你多了一个浏览器标签页，里面是它干的所有事。

## 为什么需要它

cctrace 只为两件事而生：

1. **LLM 追踪** -- 看清 Claude Code 每轮到底发送和接收了什么：system prompt、
   上下文、工具定义、流式回复、token 与缓存用量。
2. **安全/隐私审计** -- 看清哪些请求从本机出站、去了哪些 host、有没有遥测、
   每个 payload 里实际带了什么。

这两件事都需要完整的图景 -- 每一个请求都得看到，而不只是好拿的那部分 -- 而做到
这一点比听起来难：

Claude Code 现在以 Bun 编译的**原生二进制**分发。过去用 `node --require` 注入
`fetch()` 钩子的做法，对原生二进制已经彻底失效 -- 那条路走不通了。cctrace 用的是
当下真正管用的方式：一个本地的 **TLS 拦截代理**（类似 Charles/mitmproxy，但零配
置）。Claude 通过 `HTTPS_PROXY` 走这个代理，并信任自动生成的 CA。

拦截发生在传输层 -- URL 还没拼出来的那一层 -- 所以它能看到**完整的第一方全貌**，
包括 base-url 代理在结构上就碰不到的 OAuth 和用量/额度端点（Claude 把那些 host
写死了）。从 0.16 起这个范围是刻意为之：第一方 host 才解密，会话碰到的其他一切
（npm、GitHub、apt）都以不解密的字节计数隧道透传 -- 留下审计线索，不留 payload
副本。

## 你能得到什么

- **完整全貌。** `/v1/messages`、OAuth、**用量/额度**、MCP registry、bootstrap、
  遥测 -- 不只是聊天端点。
- **实时分类界面。** 带计数的筛选标签、彩色徽章、可展开的 headers/bodies、解码后
  的 SSE 流。界面做得不错，你会愿意一直开着它。
- **可重开的 trace。** 每次运行写一份 `.jsonl` trace；`cctrace view` 随时在同一
  界面里重开它，`cctrace view --html` 按需渲染一份自包含快照发给同事（离线可看）。
- **零配置。** 自动生成 CA、自动识别 Claude 安装、默认捕获完整的第一方全貌。
  不用改配置文件，不用背参数。
- **范围即设计。** 只有第一方 host 会被解密。agent 子进程碰到的外部 host --
  npm、GitHub、apt -- 以不透明隧道透传，只记录 host + 字节数，`go install` 再也
  不会往 trace 里塞 53MB 的 tarball，`gh` 的 API 响应也不会落盘。调试时用
  `--capture-external` 全部解密；`--intercept-host` 单独纳入指定 host（比如远程
  MCP 服务器）。
- **默认安全。** 凭据在落盘前就已从 headers、bodies **和** URL 中脱敏（见
  [安全与隐私](#安全与隐私)）。你的 API key 还是你的 API key。

## 对比

|  | **cctrace** | base-URL 代理 | claude-trace (`node --require`) | Charles / mitmproxy |
|---|:---:|:---:|:---:|:---:|
| 支持原生二进制 | 是 | 是 | **否** | 是 |
| 捕获 `/v1/messages` | 是 | 是 | 是 | 是 |
| 捕获 **OAuth / 用量 / 额度** | 是 | **否** | **否** | 需手动 |
| 零配置（自动 CA 与信任） | 是 | 是 | 是 | **否** |
| 懂 Claude 的界面（分类、SSE 解码） | 是 | -- | 部分 | **否** |
| 纯本地，数据不外流 | 是 | 是 | 是 | 是 |

`fetch()` 钩子方案（claude-trace 之类）在 Claude Code 转原生之后就废了。base-URL
代理还能用，但只看得到 `/v1/messages` -- OAuth、用量、额度全是盲区。Charles 这类通
用 TLS 代理什么都看得到，但要手动装 CA，而且完全不理解 Claude 的端点。cctrace 走中
间路线：零配置、全覆盖、懂 Claude。

## 快速开始

需要 [Bun](https://bun.sh)、`openssl`，以及已安装的 Claude Code（`claude` 在
PATH 中）。

### 从 npm 安装

```bash
npm install -g @thevibeworks/cctrace
```

### 或直接运行（无需安装）

```bash
bunx @thevibeworks/cctrace
```

### 或克隆仓库

```bash
git clone https://github.com/thevibeworks/cctrace
cd cctrace
bun install
bun link            # 可选：把 `cctrace` 加入 PATH
```

### 或构建独立二进制（推荐）

```bash
git clone https://github.com/thevibeworks/cctrace
cd cctrace
make install        # 编译 dist/cctrace 并安装到 ~/.local/bin
```

`make install`（或 `make build`）用 `bun build --compile` 把 cctrace 编译成单个
可执行文件 -- 构建需要 Bun，**运行不需要**。它也是让 `cctrace -- <claude 参数>`
原样透传的安装方式（见下方透传说明）。`make help` 列出所有目标；
`PREFIX=/usr/local make install` 可更换安装位置。

然后直接运行：

```bash
cctrace                       # 追踪 claude，打开实时界面
cctrace -- --continue         # 继续上一个 Claude 会话，并全程追踪
cctrace -- -p "hello"         # 把参数原样传给 Claude
```

启动后你会看到：

```
[cctrace] Live UI: http://localhost:9317
[cctrace] Capture: MITM proxy http://127.0.0.1:44775 (all Anthropic hosts)
```

打开 **Live UI** 链接即可看到请求实时流入。结束后按 Ctrl-C -- `.jsonl` trace 留在
`.cctrace/` 里，随时 `cctrace view` 重开（直接回车选最新一份）。

## 运行方式（Bun 与 `bin`）

cctrace **跑在 [Bun](https://bun.sh) 上** -- CLI 就是直接执行的 `src/cli.ts`
（shebang `#!/usr/bin/env bun`）。没有编译后的 JS，也没有 Node 回退；底下全是
`Bun.serve`/`Bun.spawn`。

| 命令 | 可用 | 说明 |
|---|---|---|
| `cctrace`（`make install` 之后） | 是 | 编译后的二进制，运行不需要 Bun，`--` 原样透传 |
| `bun run src/cli.ts [args]` | 是 | 在克隆的仓库里 |
| `bun start` | 是 | 上一条的别名 |
| `./src/cli.ts` | 是 | 借助 Bun shebang 直接执行 |
| `cctrace`（`bun link` 之后） | 是 | 需要 `~/.bun/bin` 在 PATH 中；bun 会吃掉开头的 `--` |
| 无 Bun 的 `node .../cli.ts` / `npm i -g` | **否** | 会直接报错：`env: 'bun': No such file or directory` |

**三个前置条件缺一不可：**

- **Bun** -- 运行时，不只是安装工具。没有 Bun 就什么都跑不起来。
  [装一个](https://bun.sh)。
- **PATH 中的 `openssl`** -- `mitm` 模式靠它生成 CA 和叶子证书。没有 openssl？用
  `--mode base-url`（不需要 CA，但只能看到 messages）。
- **真正安装过的 Claude Code** -- 自动模式会读 `claude` 二进制的魔数来选捕获方式。
  PATH 里没有 `claude`？cctrace 会以 `Claude not found` 退出（或用 `--claude-path`
  手动指定）。

> **独立二进制：** `make build` 会为你的平台编译一个（`bun build --compile`），
> `make install` 会把它装进 PATH。唯一限制：编译后的二进制不含遗留的 `node`
> 捕获模式（它依赖仓库源码）-- 原生 Claude 安装本来就走默认的 `mitm`。

## 捕获模式

cctrace 会根据你的 Claude 安装自动选择；用 `--mode` 可强制指定。

| 模式 | 捕获范围 | 配置 |
|------|----------|------|
| **`mitm`**（原生二进制默认） | **完整的第一方全貌** -- messages、OAuth、用量/额度、MCP registry、遥测 | 自动生成 CA；Claude 通过 `NODE_EXTRA_CA_CERTS` 信任它 |
| **`base-url`** | 仅 `/v1/messages` | 零配置 -- 只设置 `ANTHROPIC_BASE_URL` |
| **`node`**（npm/JS 安装自动选用） | 通过 `fetch()` 钩子捕获第一方流量 | 遗留方案；仅适用于非原生（JS）Claude |

捕获范围是一份白名单，在任何 TLS 发生之前、按每个连接在 CONNECT 行上决定
（Charles 的 SSL-proxying 模型）：第一方 host、client 固定的遥测上报域名、
`ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` 指向的 host、以及 `--intercept-host`
补充的 host 才会真正拦截（按 host 动态签发证书）。其余一切 -- 包管理器、`gh`
调用、apt -- 都以**不透明隧道**透传，只记一行小小的元数据：host、上下行字节数、
时长。这些 host 不会收到伪造证书，所以证书固定（cert-pinning）的工具和读系统
信任库的程序照常工作。`--capture-external` 恢复全部解密 -- 但外部 host 的
*报文体*超过 64KB 时只记录精确字节数和 content-type，不落盘（URL/状态码/
头部/时延始终保留），npm tarball 或带 token 的 API 响应不会进 trace。想要
某个 host 的完整报文，用 `--intercept-host` 单独纳入。

## Web 界面

- **行内摘要** -- 每行请求一眼可读：模型、输入/输出 token、缓存读/写与命中率、
  count_tokens 结果、用量窗口百分比（5h / 7d / 按模型）、遥测事件数、错误类型。
- **首 token 延迟** -- 每个流式模型调用都带 `ttft` 标签（在代理泵里实时测量；
  SSE 事件不带时间戳，事后无法从 trace 还原）和按首 token 之后的流式时间计算
  的 tok/s -- 起步慢还是生成慢，一眼分清。
- **分类筛选标签**，带实时计数 -- 只显示这份 trace 真正有的分类（Codex 运行
  不会出现空的 Count Tokens 标签）。点击筛选，可与文本搜索组合。
- **分栏详情面板** -- 点击某行，详情在列表旁展开（可按请求 ID 深链）。Messages
  以对话形式呈现，流式回复从 SSE 解码；用量请求渲染成限额进度条；原始
  headers/bodies 折叠可查。`j`/`k` 在筛选后的列表中移动。
- **Session 视图** -- 网络请求与重建的对话左右并排：主对话与子代理运行
  （自动匹配到派发它们的 Task 调用）分线程展示，工具结果折叠进对应的工具调用，
  每个助手回合的 token/耗时都链接回产生它的请求。
- **会话续接** -- `cctrace -- --continue`（或 `--resume`）会接续上次被追踪的
  运行：Claude Code 的每个请求都在线上携带 session id，cctrace 据此在日志目录里
  精确匹配到之前运行的 trace 并合并进来。旧回合保留各自的 token、耗时和请求
  链接，不再是干巴巴的回放历史；合并进来的请求带 `prev` 徽标，可一键隐藏。
  `--fresh` 关闭合并；`--with FILE` 强制合并任意 trace 文件。
- **离线快照** -- 保存的 `.html` 内嵌完整 trace，无需服务器。一年后打开还是能用。

## 处理已保存的 trace

子命令直接作用于磁盘上已有的 trace -- 不启代理、不拉起 Claude。三个清理类命令
**默认 dry-run**（只打印将要处理的清单，不动任何文件），加 `--yes` 才真正执行。

```bash
# 在 web 界面里重开已保存的 trace -- 不带参数也行
cctrace view                               # 列出所有 trace（最新在前），回车选最新
cctrace view latest                        # 直接打开最新一份
cctrace view 4f9a2c1e                      # Claude Code 的 session id（可用前缀）
cctrace view trace-2026-07-08              # 或文件名片段 / 路径
cctrace view <target> --html               # 改为写出自包含快照 .html（可分享；
                                           # 超大 trace 会撑爆浏览器，默认的
                                           # 本地服务方式没这个问题）

# 回收空间：删掉可重建的 .html 快照 + 0 字节的中断 trace
cctrace clean                              # dry-run：列出将删除的文件
cctrace clean --yes

# 合并：把一个 session 的多次运行（--continue 会跨文件）并成一个 .jsonl
cctrace merge                              # 每个 session 一个 session-<id>.jsonl
cctrace merge --prune --yes                # 同时删除已被完全合并的源文件

# 归档备份：zstd（view 能直接读 .jsonl.zst / 旧的 .gz）
cctrace compress --older-than 7 --yes      # 只压缩 7 天前的 trace

# 从已保存的 trace 里丢掉噪音分类（遥测、count_tokens、外部隧道行）
cctrace purge --yes                        # 删行不省盘 -- 省空间用 compress

# 折叠冗余请求体（真实会话可省 95%+）
cctrace compact --yes                      # 被后续请求覆盖的请求体折成 stub；
                                           # Session 视图渲染结果完全一致
cctrace compact --zstd --yes               # 折叠后顺带 zstd 归档

# 现在哪些 cctrace 会话在跑、各在哪个端口？
cctrace ps                                 # URL、PID、client、项目、session
```

清理绝不会让数据变少。`clean` 只删除源 `.jsonl`/`.jsonl.gz` 仍然存在的
`.html`（逐个检查，不是想当然 -- 孤儿快照会被保留）。`merge` 和 `compress`
会与已有的输出做并集，重复执行只会让合并文件或归档变大、不会变小。`merge`
只在源文件里**每一个** pair 都归属到某个 session 时才 prune 它，因此带有
OAuth/用量/遥测（无 session id）的 trace 绝不会被误删。每次删除前还会复查
文件在 plan 之后有没有变化，所以就算有 live 抓取正在追加写入，清理也是安全的。

`compact` 是唯一一个刻意"减料"的命令，而且明说：每次 API 调用都会重发整段
对话历史，所以 trace 的大部分字节是冗余请求体。它保留每个对话 epoch 里
历史最长的那次请求的完整请求体，把被覆盖的折成小 stub（遥测/外部噪音则按
端点保留首个/末个/最大/最慢/所有报错，其余折成只剩字节数的 meta 行）。
不删除任何 pair、绝不动响应体，重建出的 Session 视图完全一致 -- 失去的
只是被覆盖请求体的原始线上字节。默认 dry-run。

## 选项

```
cctrace [CLIENT] [OPTIONS] [-- CLIENT_ARGS...]
```

| 选项 | 说明 |
|--------|-------------|
| `--mode MODE` | `auto`（默认）、`mitm`、`base-url`、`node` |
| `-s, --static` | 静态模式（不启动实时服务器，只写文件） |
| `-p, --port PORT` | 实时界面端口（默认 9317；被占用时自动回退） |
| `--messages-only` | 只捕获 `/v1/messages` |
| `--capture-external` | 解密所有 host（默认：非第一方 host 走不透明的字节计数隧道）；外部报文体超 64KB 只记字节数 |
| `--intercept-host H` | 额外解密 host `H`（可重复 -- 远程 MCP 服务器、少见的服务方） |
| `--no-open` | 不自动打开浏览器 |
| `--print-ca` | 打印 MITM CA 证书路径并退出 |
| `--log NAME` | 自定义日志文件基名 |
| `--dir PATH` | 日志目录（默认 `.cctrace`） |
| `--fresh` | 续接会话时不合并之前的 trace |
| `--with FILE` | 把指定 trace 文件合并进视图（可重复） |
| `--claude-path PATH` | 自定义 Claude 二进制路径 |
| `--client-path PATH` | 自定义任意 client 的二进制路径（codex/grok 也适用） |
| `--data-dir PATH` | MITM CA / 数据目录（默认 `~/.local/share/cctrace`；或用 `CCTRACE_DATA_DIR`。旧的 `--cache-dir` / `CCTRACE_CACHE_DIR` 仍然可用；0.6 之前留在 `~/.cache/cctrace` 的 CA 会自动迁移） |

### 把参数传给 Claude

`--` 之后的所有参数会原样传给 Claude CLI，之前的参数属于 cctrace：

```bash
cctrace -- --continue                       # claude --continue，全程追踪
cctrace -- -p "为什么会报错？"               # Claude print 模式，全程追踪
cctrace --mode base-url -- --model opus     # cctrace 选项 + Claude 选项
```

`--` 之前出现 cctrace 不认识的参数会直接报错并给出提示，不会被静默吞掉。
唯一需要注意的冲突：`-p` 在 `--` 之前是 cctrace 的端口，之后是 Claude 的
print 模式。

> **bun 运行方式的坑：** 通过 bun 的 CLI 运行时（`bunx`、`bun run`、
> `bun link` 的 shim），bun 自己会吃掉**开头的** `--`，于是
> `cctrace -- --help` 到达 cctrace 时变成了 `cctrace --help`。编译后的二进制
> （`make install`）没有这个问题 -- 这也是推荐的安装方式。若用 bun 方式运行，
> 在 `--` 前放任意一个 cctrace 选项即可（如 `cctrace --no-open -- --continue`）。

## 不止 Claude

抓包内核与 client 无关 -- 本质是一个 TLS 拦截代理，任何遵守 `HTTPS_PROXY`
和标准证书环境变量的 CLI 都能被追踪。

**其他 client** -- 在最前面加一个 client 名即可：

```bash
cctrace codex -- exec "修掉这些失败的测试"   # OpenAI Codex CLI
cctrace grok -- -p "解释这段堆栈"            # Grok CLI
```

非 Claude client 一律走 mitm 抓包，并且享受完整待遇：模型调用
（`.../responses`、`.../chat/completions`）归入 Messages，Session 视图同样
重建它们的对话 -- 线程按各 client 的 wire header 分组，工具调用和推理归一到
同一套 turn 模型，每轮的用量、费用、回放一应俱全。Codex 的加密推理显示为占位
符；Grok 的推理摘要可以完整阅读。

**第三方 Anthropic 兼容服务** -- 把 `ANTHROPIC_BASE_URL` 指向网关或兼容
端点，照常运行 `cctrace` 即可。mitm 模式无需额外配置：非 Anthropic 域名
首次连接时会现场签发按域名的证书（需要 `openssl`），`/v1/messages` 按
wire 形态而非域名分类，所以第三方流量会落进 Messages，每一行都能看到
服务方域名。OAuth/用量/额度分类会直接缺席 -- 这些端点硬编码 Anthropic
域名、绕过 `ANTHROPIC_BASE_URL`（这正是 mitm 模式存在的原因）。

## 输出

每次运行都会写入 `.cctrace/`（或 `--dir`）：

- `trace-<timestamp>.jsonl` -- 每行一个请求/响应对（机器可读）。这个文件就是
  trace 本体：`cctrace view` 随时在 web 界面里重开，`cctrace view <target>
  --html` 按需渲染可分享的自包含快照（0.13 起 live 运行退出时不再自动写
  .html -- 一次 2 小时的会话能渲染出 400MB）。
- `trace-<timestamp>.html` -- 自包含的分类查看器（人类可读）

## 工作原理

```mermaid
flowchart LR
    CC["Claude Code<br/>(原生二进制)"]
    FD{"cctrace<br/>CONNECT 前门"}
    TLS["TLS 终止<br/>(我们的叶子证书)"]
    BT["TLS 终止<br/>(动态证书)"]
    TUN["不透明隧道<br/>(只记字节数)"]
    API[("api.anthropic.com")]
    PIN[("白名单内的<br/>host")]
    EXT[("外部 host<br/>npm · github · apt")]
    TEE(["tee 响应"])
    RD["脱敏<br/>headers · bodies · URLs"]
    UI["实时界面<br/>(分类)"]
    OUT[[".cctrace/ · jsonl"]]

    CC -- "HTTPS_PROXY +<br/>NODE_EXTRA_CA_CERTS" --> FD
    FD -- "Anthropic host" --> TLS
    FD -- "白名单 host" --> BT
    FD -- "其余一切" --> TUN
    TLS --> API
    BT --> PIN
    TUN --> EXT
    PIN -- "响应流" --> TEE
    API -- "响应流" --> TEE
    TUN -- "一行元数据" --> RD
    TEE -- "流式给 Claude,<br/>不缓冲" --> CC
    TEE -- "捕获副本" --> RD
    RD --> UI
    RD --> OUT

    classDef accent stroke:#3fb950,stroke-width:2px;
    class RD accent
```

代理用自动生成的叶子证书（带 Anthropic SANs）终止 TLS，转发到真实 API，并对响应
流做 `tee` -- Claude 立即拿到字节，cctrace 同时抓一份副本，SSE 响应完全不缓冲。
每个捕获到的请求对，在进入任何落点之前都会先脱敏。

我们往 Claude 环境里注入 `HTTPS_PROXY`（让流量走我们的代理）和
`NODE_EXTRA_CA_CERTS`（它会把我们的 CA **追加**到 Bun 的信任库，于是 Claude 信任
我们的叶子证书，同时公网 TLS 照常工作）。

Claude 的子进程同样会继承 `HTTPS_PROXY` -- bash 工具里的 `curl`/`gh`、python
钩子、statusline 脚本 -- 而 `NODE_EXTRA_CA_CERTS` 对它们毫无意义，TLS 校验会
直接失败。所以我们为它们构建一份**合并证书包**（系统 CA + 我们的 CA -- 标准
环境变量是**替换**信任库而不是追加，只放 mitm 证书会弄坏所有不走代理的连接），
并导出为 `SSL_CERT_FILE`、`CURL_CA_BUNDLE`、`REQUESTS_CA_BUNDLE` 和
`NIX_SSL_CERT_FILE`：走代理的请求用我们的证书校验，直连的用系统 CA --
子进程根本不需要知道请求走了哪条路。

我们刻意**不**设置 `HTTP_PROXY` -- 前门只会说 CONNECT，设了会弄坏子进程的
明文 `http://` 调用。这种 bug 能让你凌晨两点开始怀疑人生。

## 安全与隐私

cctrace 是本地调试工具，但它拦截的是真实的带凭据流量，所以写入任何东西之前都会先
脱敏：

- **Headers** -- `authorization`、`x-api-key`、`cookie` 等被掩码为「前 10/后 4」
  的预览（足以判断用了**哪个** key，但看不到 key 本身）。
- **Bodies** -- 凭据字段（`access_token`、`refresh_token`、`client_secret`、
  `code`、`api_key` 等）在 JSON 和 form-encoded body 中被掩码。你的 `/v1/messages`
  对话内容保持原样。
- **URL** -- 携带凭据的查询参数（如 OAuth 的 `?code=`）被掩码。

脱敏在单一收口处完成，对 `.jsonl`、可分享的 `.html` 和实时 WebSocket 一视同仁。
`.cctrace/` 输出默认已在 gitignore 中。

**但请注意：** trace 就是你真实会话的记录。分享前请先检查，切勿把原始输出贴到公开
issue 里。真的别这么干。

## 路线图

- **会话回放 P3/P4** -- 可选的 `--record-timing` 记录分块时序，实现真正的
  打字机节奏回放。P1+P2（步进、播放条、minimap、深链接）已发布。
- **WebSocket 中继** -- 终止器现在快速拒绝 ws 升级（client 干净地回退到
  HTTP）；真正捕获帧的中继是 #20 剩下的尾巴。
- **隧道行的进程归属** -- Linux 上代理可以把连接的源端口映射到发起进程，
  让隧道行标出是哪个子进程在调 npm。2026-07-15 devlog 里已调研，暂缓。
- **对话导出** -- 将还原的对话导出为 Markdown 或 JSON，方便分享或事后分析。
- **MCP 服务器** -- 以编程方式查询捕获的流量（agent skill 已随
  [skills/cctrace](skills/cctrace/SKILL.md) 发布；MCP 是剩下的另一半）。
- **`inference_geo` / 更深的层级可见性** -- 在现有费用估算旁展示推理发生地
  和按层级的细分。

已发布的变更见 [CHANGELOG.md](CHANGELOG.md)。

## 开发

```bash
bun test                                # 单元测试
bun run tests/e2e-live.ts mitm "hi"     # 对真实 Claude 做端到端测试
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
