<p align="center">
  <img src="https://raw.githubusercontent.com/weivwang/dsh-stack/main/assets/hero.svg" alt="dsh-stack — 交付环境，而不是安装说明" width="100%">
</p>

<h1 align="center">dsh-stack</h1>

<p align="center">
  <strong>让 Agent 环境真正可复现。</strong><br>
  把整个 DeepSeek Harness profile——插件、顺序、版本与可移植配置——收进一份可审阅的 Stackfile。
</p>

<p align="center">
  <a href="https://github.com/weivwang/dsh-stack/actions/workflows/ci.yml"><img src="https://github.com/weivwang/dsh-stack/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/DeepSeek_Harness-0.1.0--rc.6-54e4ff" alt="DeepSeek Harness 0.1.0-rc.6">
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-72f0cb" alt="Node.js 22.19+">
  <img src="https://img.shields.io/badge/license-MIT-9299ff" alt="MIT license">
</p>

<p align="center">中文 · <a href="README.md">English</a></p>

---

## 插件清单不等于运行环境

一套好用的 Harness profile，不只取决于装了哪些包。Bundle 顺序会改变组合结果，版本漂移会改变行为，而 profile patch 才真正保存了这套环境为什么好用。

`dsh-stack` 捕获的是完整运行契约：

- 按组合顺序排列的插件 bundles；
- registry 包的精确安装版本，以及固定到 commit 的 Git 来源；
- profile 级 Cordis patch，并把本机路径转换为可移植占位符；
- 只保存 secret 引用，不保存凭据值；
- 来源 Harness 版本和整文件 SHA-256 完整性。

结果是一份很小的 JSON Stackfile，可以和项目、Release、基准测试、团队手册或 bug 报告放在一起。任何人都能先看清它要做什么，再决定是否允许它修改 profile。

## 从可用环境到经过验证的副本

<p align="center">
  <img src="https://raw.githubusercontent.com/weivwang/dsh-stack/main/assets/demo.gif" alt="使用 dsh-stack 安装、导出、检查、计划、应用并验证 profile" width="100%">
</p>

```sh
# 机器 A：捕获已经调顺的环境
dsh-stack export --profile web --name "research-workbench"

# 机器 B：先检查，再信任
dsh-stack inspect web.dsh-stack.json
dsh-stack plan web.dsh-stack.json --profile research

# 复现环境，并通过 Harness 自身验证最终组合
dsh-stack apply web.dsh-stack.json --profile research --yes
```

`apply` 不会在“包装完了”这里停下。它会写入声明的 bundle 顺序、注入可移植配置，再调用 `dsh --dump-config` 验证最终组合；验证失败时自动从备份恢复 profile 文件。

Stackfile 也可以直接通过 HTTPS 使用：

```sh
dsh-stack plan https://example.com/research.dsh-stack.json --profile research
```

## 安装

安装 CLI，并把 bundle 加入 Harness profile：

```sh
npm install --global dsh-stack
dsh plugin --profile web add dsh-stack
```

package 已包含构建产物，并且没有安装期 lifecycle script。

无需 clone 仓库即可检查公开示例：

```sh
dsh-stack inspect https://raw.githubusercontent.com/weivwang/dsh-stack/main/examples/web.dsh-stack.json
dsh-stack plan https://raw.githubusercontent.com/weivwang/dsh-stack/main/examples/web.dsh-stack.json --profile web-copy
```

如需从源码安装：clone 仓库，运行 `pnpm install --ignore-scripts && pnpm run build`，然后执行 `npm link` 和 `dsh plugin --profile web add "$PWD"`。

## 先审阅，再写入

读取路径和写入路径拥有不同权限：

| 命令 | 修改 profile | 用途 |
|---|:---:|---|
| `dsh-stack inspect` | 否 | 校验完整性，并解释本地或 HTTPS Stackfile |
| `dsh-stack plan` | 否 | 对比 Stackfile 和目标 profile |
| `dsh-stack export` | 否 | 把已安装 profile 捕获为新文件 |
| `dsh-stack apply` | 是 | 加锁、备份、应用、验证，并在失败时回滚 |

写入前，`apply` 会：

1. 校验封闭 schema 和整文件摘要；
2. 拒绝危险 package specifier、本机路径、可变来源和内嵌 URL 凭据；
3. 输出精确的安装、升级、排序、patch 和 secret 计划；
4. 要求显式传入 `--yes`；
5. 替换不同的非空 patch 前，要求第二次明确选择。

它不会删除目标机器独有的插件。未出现在 Stackfile 中的 bundle 会保留在声明层之后。

## Secret 不进入文件

导出器把 `cordis.patch.yml` 当作数据解析，绝不执行 `!!js`。常见凭据字段和可识别 token 字面量会变成由环境变量提供的占位符：

```yaml
apiKey: "{{DSH_STACK_SECRET:API_KEY}}"
cacheDir: "{{DSH_HOME}}/cache"
workspace: "{{HOME}}/code"
```

`inspect` 会列出所有必需变量；只在接收机器上提供它们：

```sh
export DSH_STACK_SECRET_API_KEY='...'
dsh-stack apply team.dsh-stack.json --profile web --yes
```

自动检测属于纵深防御，不能证明任意配置绝对不含 secret。公开前仍应检查 Stackfile；更好的做法是使用托管凭据或环境变量引用，让原始 secret 从一开始就不进入 profile patch。

## 跨越边界的内容

| 会包含 | 明确不包含 |
|---|---|
| 有顺序的 `dsh.profile.bundles` | 会话记录 |
| 精确 package 版本 | 凭据和 `.env` 文件 |
| profile 级 `cordis.patch.yml` | 全局 `$DSH_HOME/cordis.patch.yml` |
| 可移植 home 路径占位符 | 工作区文件和任意 skills |
| Harness 版本和完整性摘要 | 整台机器的状态 |

Stackfile 是环境声明，不是备份归档。

## Harness 工具

安装 bundle 后会注册一个只读模型工具：`stack_inspect`。

- `summary` 返回 bundle 数量、可移植性评分、必需 secret 和警告。
- `stack` 返回完整、带完整性校验且已经脱敏的 JSON。

工具本身不会写 Stackfile；保存返回的 JSON 仍然受到 Harness 常规文件权限控制。

## 兼容性与开发

首版面向 DeepSeek Harness `0.1.0-rc.6` 和 Node.js `^22.19.0 || >=24`。Harness 尚处 developer preview；Stackfile 会记录来源版本，并在目标版本不同时给出警告。

```sh
pnpm install --ignore-scripts
pnpm run check
```

仓库中的 `lib/` 是可安装构建产物。CI 会在 Linux、macOS 和 Windows 的 Node 22.19/24 上运行类型检查、18 个测试、生产构建与 package 检查。

进一步阅读：[格式与变更设计](docs/design.md) · [安全策略](SECURITY.md)

MIT
