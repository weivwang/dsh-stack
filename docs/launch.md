# Launch playbook

The adoption goal is not “another plugin in a catalog.” It is to make Stackfiles the default way people share a working Harness setup. Every public Stackfile should be both useful content and an installation path back to `dsh-stack`.

## Positioning

> `dsh-stack` is the share button for your entire DeepSeek Harness: exact plugins, correct order, portable configuration, no copied secrets.

Use that sentence consistently in the npm description, GitHub About field, catalog entry, and launch posts. Lead with the outcome—a working setup on another machine—not the file format.

## Release checklist

1. Create the public GitHub repository and enable branch protection plus npm trusted publishing.
2. Add `repository`, `bugs`, and `homepage` fields to `package.json` using the final repository URL.
3. Run `pnpm run check` from a clean checkout and inspect the tarball with `npm pack --dry-run`.
4. Publish `dsh-stack@0.1.0` with provenance; never publish from an unreviewed working tree.
5. Install from npm into a fresh temporary DSH home and repeat export, inspect, plan, apply, and `dsh --dump-config`.
6. Submit the catalog entry and attach a 30–45 second terminal recording showing machine A export and machine B apply.
7. Publish three genuinely useful starter Stackfiles in separate repositories, each with screenshots, expected use cases, and required environment variable names.

## Copy-ready catalog entry

```markdown
- [dsh-stack](https://github.com/weivwang/dsh-stack) - Export, inspect, and safely reproduce an entire DSH profile as an integrity-checked, secret-redacted Stackfile.
```

## The first three shared stacks

- **Daily Driver** — a small general-purpose profile that demonstrates the shortest happy path.
- **Research Desk** — a complete research workflow that proves bundle ordering and configuration portability.
- **Plugin Dev Kit** — a reproducible profile for plugin authors to use in bug reports and CI fixtures.

Each recipe should begin with the same two commands:

```sh
dsh-stack inspect recipe.dsh-stack.json
dsh-stack apply recipe.dsh-stack.json --profile <name> --yes
```

## Growth loop

1. A maintainer publishes a useful Stackfile beside a project, tutorial, benchmark, or bug report.
2. A recipient sees the exact composition before installing it.
3. Applying the recipe installs `dsh-stack` into their workflow.
4. The recipient improves the setup and exports another Stackfile.

Keep the format decentralized. Git repositories, release assets, raw HTTPS files, and Gists already provide hosting, review history, and distribution. A central gallery can come later, once real recipes reveal the right discovery and ranking signals.

## Metrics that matter

Track the funnel weekly rather than optimizing download count in isolation:

- public repositories containing `*.dsh-stack.json`;
- unique Stackfile authors;
- successful `plan` to `apply` conversion, if future opt-in telemetry is added;
- npm weekly downloads and repeat install ratio;
- recipes maintained by projects other than the core repository;
- security reports and failed-apply causes.

Do not add default-on telemetry to manufacture a metric. Public Stackfile count is the clearest early signal that the sharing protocol—not only the CLI—is spreading.

## Launch post

> DeepSeek Harness makes every capability a plugin. We built the missing share button for the composition. `dsh-stack` exports a working profile—ordered plugins, exact versions, and portable config—into one reviewable file. Secrets become environment references, apply shows a plan first, and failed verification rolls back. Share the setup that worked, not a screenshot of your plugin list.

Suggested title: **“Your DeepSeek Harness works. Now make it reproducible.”**
