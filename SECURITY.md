# Security policy

## Report a vulnerability

Please report vulnerabilities privately to the repository owner before opening a public issue. Include the affected version, a minimal reproduction, impact, and whether the report involves secret disclosure, dependency installation, path traversal, command execution, or rollback failure.

Do not include real credentials in a report. Use synthetic tokens that match the relevant format.

## Security boundaries

- `inspect`, `plan`, and the `stack_inspect` model tool do not install packages or evaluate Cordis `!!js` expressions.
- Remote Stackfiles must use HTTPS and are size bounded.
- Stackfile validation rejects unknown fields, unsafe package names and specifiers, embedded URL credentials, and integrity mismatches.
- `apply` requires explicit confirmation, backs up profile-owned files, verifies the composed configuration, and restores those files on failure.
- Secret redaction covers common keys and recognizable token formats but cannot prove that arbitrary configuration contains no secret. Authors must review exported files.
- dsh-stack does not sandbox plugins. Applying a Stackfile installs third-party code with the same trust implications as `dsh plugin add`.

## Supported versions

Security fixes are applied to the latest release. The initial `0.1.x` series targets DeepSeek Harness `0.1.0-rc.6`.
