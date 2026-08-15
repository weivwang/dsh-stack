# dsh-stack

[English](README.md) | [中文](README.zh.md)

**A share button for your entire DeepSeek Harness.**

`dsh-stack` turns a working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile into one portable, secret-redacted, integrity-checked Stackfile. A teammate can inspect the file, see an exact change plan, and reproduce the stack with one command.

Think `Brewfile` or `Dockerfile`, but for a Harness made of plugins.

```text
your profile                         one shareable file
├── ordered plugin bundles          ├── exact versions
├── profile patch          export   ├── portable patch
├── local paths            ───────> ├── {{HOME}} placeholders
└── credentials                      └── secret references, never values
```

## Why this can become infrastructure

Plugin discovery solves “what can I install?” `dsh-stack` solves the next question: “what exact setup made this work?” Every published Stackfile becomes a reproducible recommendation, starter kit, benchmark environment, team standard, or bug reproduction. The users who share a stack create the acquisition path for the users who apply it.

## Quick start

From this checkout:

```sh
pnpm install --ignore-scripts
pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-stack
```

After the package is published to npm, the install becomes:

```sh
dsh plugin --profile web add dsh-stack
```

The package ships prebuilt JavaScript and has no install-time lifecycle script.

Export your profile:

```sh
dsh-stack export --profile web --name "My daily driver"
```

Inspect and plan on another machine:

```sh
dsh-stack inspect my-daily-driver.dsh-stack.json
dsh-stack plan my-daily-driver.dsh-stack.json --profile web
```

Apply only after reviewing the plan:

```sh
dsh-stack apply my-daily-driver.dsh-stack.json --profile web --yes
```

Stackfiles also work from HTTPS, so a raw GitHub file or Gist is enough:

```sh
dsh-stack plan https://example.com/team-stack.dsh-stack.json --profile web
```

## The safe default path

`apply` is deliberately harder than `export`:

1. The Stackfile's SHA-256 integrity is verified.
2. Unknown fields, unsafe package specifiers, local paths, and mutable package sources are rejected.
3. A dry-run plan is printed before any mutation.
4. `--yes` is mandatory.
5. A different non-empty target patch needs an additional `--replace-patch`; `--skip-patch` is the non-destructive alternative.
6. The profile is locked and its manifest, patch, lockfile, and pnpm workspace file are backed up.
7. Dependencies are installed at exact versions, the bundle order is written, and the profile is verified with `dsh --dump-config`.
8. A failed verification restores the backed-up profile files.

The apply operation never removes extra installed plugins. Existing bundles not named by the Stackfile stay after the shared stack's ordered layers.

## Secret and path portability

The exporter parses `cordis.patch.yml` as data. It preserves but never evaluates `!!js` expressions. It replaces values under common sensitive keys (`apiKey`, `token`, `password`, `authorization`, private keys, cookies, webhook URLs, and related camel/snake-case names) and recognizable token literals with placeholders:

```yaml
apiKey: "{{DSH_STACK_SECRET:API_KEY}}"
cacheDir: "{{DSH_HOME}}/cache"
workspace: "{{HOME}}/code"
```

The Stackfile stores only the required variable name and redacted YAML path. The recipient hydrates the value at apply time:

```sh
export DSH_STACK_SECRET_API_KEY='...'
dsh-stack apply team.dsh-stack.json --profile web --yes
```

Secret detection is defense in depth, not magic. A maintainer may invent a credential format or an innocent-looking key name the exporter does not know. Always inspect a Stackfile before publishing it. Prefer DSH's managed credentials or environment references so secrets never enter `cordis.patch.yml` in the first place.

## Commands

| Command | Purpose |
|---|---|
| `dsh-stack export` | Export an installed profile, exact package versions, and an optional portable patch |
| `dsh-stack inspect` | Verify integrity and summarize a local or HTTPS Stackfile |
| `dsh-stack plan` | Compare a Stackfile with a target profile without writing anything |
| `dsh-stack apply` | Apply a reviewed plan with lock, backup, verification, and rollback |

Use `dsh-stack <command> --help` for every option.

## Agent tool

Installing the bundle adds one read-only model tool, `stack_inspect`. In `summary` mode it reports portability, bundle counts, and warnings. In `stack` mode it returns the complete secret-redacted JSON so the agent can save it using DSH's ordinary, permission-governed file tools. The plugin itself never writes a Stackfile from a model call.

## What v1 captures

- Ordered `dsh.profile.bundles`
- Exact installed versions for registry packages
- Commit-pinned git sources
- Harness version metadata
- The profile-level `cordis.patch.yml`, with secret and home placeholders
- Export warnings and whole-file integrity

It intentionally does not copy session history, credentials, `.env` files, global `$DSH_HOME/cordis.patch.yml`, arbitrary skills, or workspace files. Those are different trust and ownership domains.

## Compatibility

The first release targets DeepSeek Harness `0.1.0-rc.6` and Node `^22.19.0 || >=24`. Harness is in developer preview and may make breaking changes; the Stackfile records the source Harness version and warns when the target differs.

## Development

```sh
pnpm install --ignore-scripts
pnpm run check
pnpm run build
```

The source is TypeScript, the checked-in `lib/` directory is the installable artifact, and the test suite covers redaction, integrity, export, planning, successful application, and rollback.

See [the design note](docs/design.md), [security policy](SECURITY.md), and [launch playbook](docs/launch.md) for the decisions behind the format, mutation model, and adoption loop.

MIT
