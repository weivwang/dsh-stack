# dsh-stack

[English](README.md) | [中文](README.zh.md)

**把整套 DeepSeek Harness 变成一个可分享链接。**

`dsh-stack` 会把已经调顺的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile 导出为一份可移植、自动脱敏、带完整性校验的 Stackfile。接收者先审阅精确变更计划，再用一条命令复现整套配置。

它类似 Harness 世界里的 `Brewfile` 或 `Dockerfile`。

```text
你的 profile                         一份可分享文件
├── 有顺序的插件 bundles             ├── 精确版本
├── profile patch          导出      ├── 可移植 patch
├── 本机路径               ───────>  ├── {{HOME}} 占位符
└── 凭据                              └── 只有 secret 引用，没有 secret 值
```

## 为什么这个方向有增长飞轮

插件市场回答“我能装什么”，`dsh-stack` 回答“究竟是哪套配置让它跑得这么好”。每一份公开 Stackfile 都会变成一个可复现的推荐方案、入门套装、基准环境、团队标准或 bug 复现环境。分享者会自然地为安装者创造入口。

## 快速开始

从当前 checkout 安装：

```sh
pnpm install --ignore-scripts
pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-stack
```

发布到 npm 后，安装命令会简化为：

```sh
dsh plugin --profile web add dsh-stack
```

包内已经包含构建产物，没有安装期 lifecycle script。

导出：

```sh
dsh-stack export --profile web --name "我的主力配置"
```

在另一台机器上检查并生成计划：

```sh
dsh-stack inspect my-stack.dsh-stack.json
dsh-stack plan my-stack.dsh-stack.json --profile web
```

确认计划后应用：

```sh
dsh-stack apply my-stack.dsh-stack.json --profile web --yes
```

也可以直接使用 HTTPS 上的 Stackfile，例如 GitHub raw 文件或 Gist。

## 默认安全策略

`apply` 刻意比 `export` 更谨慎：

1. 校验整份文件的 SHA-256 完整性。
2. 拒绝未知字段、危险包 specifier、本机路径和可变依赖来源。
3. 任何写入前先输出 dry-run 计划。
4. 必须显式传入 `--yes`。
5. 目标存在不同的非空 patch 时，还必须传 `--replace-patch`；也可以用 `--skip-patch` 保留目标配置。
6. 对 profile 加锁，并备份 manifest、patch、lockfile 与 pnpm workspace 文件。
7. 按精确版本安装依赖、写入 bundle 顺序，再通过 `dsh --dump-config` 验证组合结果。
8. 验证失败会恢复已备份的 profile 文件。

应用 Stackfile 不会删除目标机器已有的额外插件。未出现在 Stackfile 中的 bundle 会保留在共享 stack 的有序层之后。

## Secret 与路径脱敏

导出器会把 `cordis.patch.yml` 当作数据解析；`!!js` 只保留，不执行。常见敏感字段（API key、token、password、authorization、private key、cookie、webhook URL 等）和可识别 token 字面量会被替换：

```yaml
apiKey: "{{DSH_STACK_SECRET:API_KEY}}"
cacheDir: "{{DSH_HOME}}/cache"
workspace: "{{HOME}}/code"
```

Stackfile 只记录需要的环境变量名和已脱敏 YAML 路径。接收者在应用前注入：

```sh
export DSH_STACK_SECRET_API_KEY='...'
dsh-stack apply team.dsh-stack.json --profile web --yes
```

自动检测是纵深防御，不是绝对保证。插件作者可能使用新的凭据格式或普通名称保存 secret；公开前仍应人工检查 Stackfile。更好的做法是使用 DSH 的凭据管理或环境变量引用，让 secret 从一开始就不进入 patch。

## Agent 工具

安装 bundle 后会增加一个只读工具 `stack_inspect`。`summary` 模式返回可移植性评分、bundle 数量和警告；`stack` 模式返回完整脱敏 JSON，Agent 再通过 DSH 原生、受权限控制的文件工具保存。插件不会在模型调用中直接写文件。

## v1 会与不会收集的内容

会收集：bundle 顺序、registry 精确版本、固定 commit 的 git 来源、Harness 版本、脱敏后的 profile patch、警告和整文件完整性。

不会收集：会话记录、凭据、`.env`、全局 `$DSH_HOME/cordis.patch.yml`、任意 skills 或工作区文件。这些内容具有不同的信任与所有权边界。

## 兼容性与开发

首版面向 DeepSeek Harness `0.1.0-rc.6`，Node 要求 `^22.19.0 || >=24`。Harness 尚处 developer preview，Stackfile 会记录来源版本，并在目标版本不同时警告。

```sh
pnpm install --ignore-scripts
pnpm run check
pnpm run build
```

详见[设计说明](docs/design.md)、[安全策略](SECURITY.md)和[发布增长手册](docs/launch.md)。MIT。
