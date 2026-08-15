# Changelog

## 0.1.0 - 2026-08-15

- Introduce Stackfile v1 with canonical SHA-256 integrity.
- Export ordered bundles and exact installed registry versions.
- Preserve Cordis `!!js` expressions without evaluation.
- Redact common credentials and token literals into environment-backed placeholders.
- Make OS and Harness home paths portable.
- Add local and HTTPS inspect/plan/apply workflows.
- Require review gates for mutable sources and patch replacement.
- Add per-profile apply locks, timestamped backups, DSH config verification, and rollback.
- Add the read-only `stack_inspect` Harness tool.
