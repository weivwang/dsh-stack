# Design: profiles as shareable stacks

## Product thesis

An ecosystem gets a package manager first and reproducible compositions second. DeepSeek Harness already makes individual bundles installable; `dsh-stack` makes a successful ordered composition portable. The format is deliberately useful without a central registry: a Stackfile in any Git repository, release asset, or HTTPS endpoint is enough.

This creates a two-sided growth loop. Maintainers distribute an opinionated working environment instead of a prose list of plugins. Recipients reproduce it without surrendering review or overwriting an existing profile blindly.

## Format choices

Stackfile v1 is JSON because it has a strict, portable data model, strong tool support, and an unambiguous canonical form for integrity. The embedded Cordis user patch stays YAML because converting `!!js` expressions into JSON would either execute them or destroy their meaning.

The whole-file digest uses recursively sorted object keys and order-preserving arrays. Bundle order remains semantically meaningful. The digest detects corruption and casual modification; it is not an author signature. A future version can add detached signatures without changing the v1 integrity rule.

## Reproduction model

Registry dependencies are exported at the installed exact version, not the range from the profile's `package.json`. Git dependencies are accepted by safe apply only when the source ends in an immutable commit hash. Local path dependencies remain visible in the file but block automatic apply. Built-in bundles are recorded by name and resolved from the recipient's DSH installation.

Apply is additive: Stackfile bundles take their declared order, while target-only bundles remain afterward. Removing other people's plugins is not a reasonable default for a shared recipe. A later exact-clone mode would need a separate, explicit deletion protocol.

## Mutation model

The CLI separates planning from mutation. `apply` repeats the plan, requires `--yes`, acquires a per-profile lock, copies all profile-owned installation files into a timestamped backup, mutates, and calls DSH's own config dumper. Failure restores the profile files. Extra package contents may remain in `node_modules` after rollback, but the restored manifest and lockfile no longer activate them; avoiding destructive recursive cleanup is intentional.

An existing non-empty user patch is a second confirmation boundary. The user must choose replacement or omission. Silent YAML merging would be misleading because Cordis patch order and whole-config replacement are semantic, not ordinary deep-merge behavior.

## Trust model

A Stackfile is untrusted input. Validation is closed-world: unknown fields fail, sizes are bounded, package names are constrained, shell metacharacters and embedded URL credentials are rejected, HTTPS is mandatory for remote sources, and neither YAML nor plugin code is evaluated during inspect or plan.

Installing any DSH plugin still executes third-party code with the user's permissions. `dsh-stack` makes the requested sources and versions reviewable; it does not sandbox those plugins or claim they are trustworthy.

## Deferred scope

- Cryptographic author signatures and transparency logs
- A hosted gallery, social ranking, or namespace service
- Global patch, credentials, sessions, skills, and workspace synchronization
- Exact-clone removal semantics
- Graphical settings panel
- Cross-platform end-to-end CI with a released DSH binary on every supported OS

The v1 format stays small so these features can evolve without turning a profile recipe into a backup archive or credential transport.
