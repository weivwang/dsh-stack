//#region src/types.d.ts
/** Stable marker for files produced by dsh-stack. */
declare const STACK_FORMAT: "dsh-stack";
/** Current Stackfile format version. */
declare const STACK_FORMAT_VERSION: 1;
/** Default maximum accepted Stackfile size. */
declare const DEFAULT_MAX_STACK_BYTES = 1048576;
/** Default maximum profile patch size included in a Stackfile. */
declare const DEFAULT_MAX_PATCH_BYTES = 524288;
/** A bundle's reproducible source class. */
type BundleSourceKind = 'builtin' | 'registry' | 'git' | 'local' | 'other';
/** One bundle layer in profile order. */
interface StackBundle {
  /** npm package name used by `dsh.profile.bundles`. */
  name: string;
  /** Where the dependency came from. Built-in bundles omit this field. */
  specifier?: string;
  /** Version read from the installed package manifest, when available. */
  installedVersion?: string;
  /** Portability and installation behavior of the source. */
  sourceKind: BundleSourceKind;
}
/** A secret removed from an exported patch. */
interface StackSecretReference {
  /** Stable identifier used by the placeholder in the portable patch. */
  id: string;
  /** Environment variable read by `dsh-stack apply`. */
  env: string;
  /** Redacted YAML location; contains key names and indexes, never values. */
  path: string;
}
/** Secret-safe, portable form of a profile's user patch. */
interface StackProfilePatch {
  /** Canonical YAML with secret and home-directory placeholders. */
  content: string;
  /** SHA-256 digest of `content`. */
  sha256: string;
  /** Secrets the recipient must supply through environment variables. */
  secrets: StackSecretReference[];
}
/** Source metadata that helps recipients judge compatibility. */
interface StackSource {
  /** Name of the exported Harness profile. */
  profile: string;
  /** Version reported by the local `dsh` binary, when discoverable. */
  harnessVersion?: string;
}
/** Portable DeepSeek Harness profile recipe. */
interface DshStack {
  /** File type marker. */
  format: typeof STACK_FORMAT;
  /** Stackfile schema version. */
  formatVersion: typeof STACK_FORMAT_VERSION;
  /** Human-readable stack name. */
  name: string;
  /** Optional explanation of the stack's intended use. */
  description?: string;
  /** ISO-8601 export time. */
  createdAt: string;
  /** Origin and compatibility metadata. */
  source: StackSource;
  /** Bundle layers in activation order. */
  bundles: StackBundle[];
  /** Optional portable profile patch. */
  profilePatch?: StackProfilePatch;
  /** Non-secret limitations discovered while exporting. */
  warnings: string[];
  /** SHA-256 digest of the canonical Stackfile without this field. */
  integrity: string;
}
/** Options for exporting one installed profile. */
interface ExportStackOptions {
  /** Profile name under `$DSH_HOME/profiles`. */
  profile: string;
  /** Human-readable stack name. Defaults to the profile name. */
  name?: string;
  /** Optional public description. */
  description?: string;
  /** Include the profile's user patch. Defaults to true. */
  includePatch?: boolean;
  /** Explicit Harness home for tests or non-default installations. */
  dshHome?: string;
  /** Maximum accepted profile patch size. */
  maxPatchBytes?: number;
  /** Override reported Harness version. */
  harnessVersion?: string;
  /** Export timestamp. Defaults to the current time. */
  now?: Date;
}
/** One dependency change in an apply plan. */
interface StackDependencyChange {
  /** Bundle package name. */
  name: string;
  /** Current installed version or dependency specifier. */
  from?: string;
  /** Stackfile version or source specifier. */
  to: string;
  /** Why this dependency cannot be automatically reproduced. */
  reason?: string;
}
/** Reviewable plan produced before any profile mutation. */
interface StackPlan {
  /** Target profile name. */
  profile: string;
  /** Whether the target profile already exists. */
  profileExists: boolean;
  /** Dependencies absent from the target. */
  install: StackDependencyChange[];
  /** Dependencies present at a different version or source. */
  update: StackDependencyChange[];
  /** Bundles already matching the Stackfile. */
  unchanged: string[];
  /** Built-in layers the target Harness installation must provide. */
  builtin: string[];
  /** Planned profile-patch action. */
  patch: {
    action: 'none' | 'write' | 'replace' | 'unchanged';
    requiredSecrets: string[];
  };
  /** Non-blocking review notes. */
  warnings: string[];
  /** Conditions that block safe default application. */
  errors: string[];
}
/** Options controlling a transactional Stackfile application. */
interface ApplyStackOptions {
  /** Target profile name. */
  profile: string;
  /** Explicit confirmation required for mutations. */
  yes: boolean;
  /** Permit mutable git refs instead of commit-pinned sources. */
  allowUnpinned?: boolean;
  /** Replace a different non-empty target patch. */
  replacePatch?: boolean;
  /** Do not apply the Stackfile's profile patch. */
  skipPatch?: boolean;
  /** Harness home override. */
  dshHome?: string;
  /** `dsh` executable path. */
  dshBinary?: string;
  /** Environment used for subprocesses and secret hydration. */
  env?: NodeJS.ProcessEnv;
  /** Clock override for deterministic tests. */
  now?: Date;
}
/** Result of a successful transactional application. */
interface ApplyStackResult {
  /** Target profile. */
  profile: string;
  /** Backup directory retained for manual recovery. */
  backupDir: string;
  /** Dependencies installed or changed. */
  changedBundles: string[];
  /** Whether the profile patch changed. */
  patchChanged: boolean;
  /** Verification command output. */
  verification: string;
}
//#endregion
//#region src/apply.d.ts
/** Injectable command boundary used by transaction tests. */
interface ApplyRuntime {
  run(binary: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv;
  }): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
}
/** Apply a Stackfile with review gates, backup, locking, and rollback. */
declare function applyStack(stack: DshStack, options: ApplyStackOptions, runtime?: ApplyRuntime): ApplyStackResult;
/** Render the exact dry-run text used before `--yes`. */
declare function previewApply(stack: DshStack, options: Omit<ApplyStackOptions, 'yes'>): string;
//#endregion
//#region src/canonical.d.ts
/** Return a SHA-256 digest with an explicit algorithm prefix. */
declare function sha256(value: string): string;
/**
 * Serialize JSON with recursively sorted object keys while retaining array
 * order. The Stackfile digest uses this form so formatting cannot alter trust.
 */
declare function canonicalJson(value: unknown): string;
//#endregion
//#region src/errors.d.ts
/** Error safe to print without exposing patch or credential contents. */
declare class StackError extends Error {
  /** Stable category for CLI and API callers. */
  readonly code: string;
  /**
   * Create a public dsh-stack failure.
   * @param code - Stable machine-readable category.
   * @param message - Secret-free user-facing explanation.
   */
  constructor(code: string, message: string);
}
//#endregion
//#region src/export.d.ts
/** Export an installed profile as a secret-safe, integrity-sealed Stackfile. */
declare function exportStack(options: ExportStackOptions): DshStack;
/** Render a Stackfile as stable, review-friendly JSON. */
declare function formatStackJson(stack: DshStack): string;
/** Score how easily another machine can reproduce a Stackfile. */
declare function stackShareability(stack: DshStack): {
  score: number;
  label: string;
};
//#endregion
//#region src/load.d.ts
/** Load and validate a Stackfile from disk or an HTTPS URL. */
declare function loadStackSource(source: string, options?: {
  cwd?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<DshStack>;
//#endregion
//#region src/patch.d.ts
/** Inputs used to remove secrets and machine-local home paths from YAML. */
interface RedactPatchOptions {
  /** Harness home represented by `{{DSH_HOME}}`. */
  dshHome: string;
  /** OS home represented by `{{HOME}}`. */
  home?: string;
}
/** Convert a profile patch into a share-safe, hydratable YAML artifact. */
declare function redactPatch(raw: string, options: RedactPatchOptions): StackProfilePatch;
/** Restore home paths and environment-supplied secrets into portable YAML. */
declare function hydratePatch(patch: StackProfilePatch, options: {
  dshHome: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): string;
/** Return whether a patch is an empty top-level list. */
declare function isEmptyPatch(raw: string): boolean;
/** Validate patch syntax without evaluating `!!js` expressions. */
declare function assertPatchSyntax(raw: string): void;
//#endregion
//#region src/plan.d.ts
/** Build a read-only installation plan against one target profile. */
declare function planStack(stack: DshStack, options: {
  profile: string;
  dshHome?: string;
  skipPatch?: boolean;
}): StackPlan;
/** Render a plan for human review. */
declare function formatPlan(plan: StackPlan): string;
//#endregion
//#region src/profile.d.ts
/** Profile manifest fields used by dsh-stack. */
interface ProfileManifest {
  name?: string;
  dependencies?: Record<string, string>;
  dsh?: {
    profile?: {
      bundles?: string[];
    };
  };
}
/** Profile files and metadata resolved from a Harness home. */
interface InstalledProfile {
  name: string;
  dir: string;
  manifestPath: string;
  patchPath: string;
  manifest: ProfileManifest;
  patch: string;
}
/** Resolve `$DSH_HOME`, falling back to `~/.dsh`. */
declare function resolveDshHome(configured?: string, env?: NodeJS.ProcessEnv): string;
/** Resolve and validate one profile directory. */
declare function profileDirectory(profile: string, dshHome?: string): string;
/** Read one initialized profile without evaluating any plugin code. */
declare function readInstalledProfile(profile: string, options?: {
  dshHome?: string;
  maxPatchBytes?: number;
  allowMissing?: boolean;
}): InstalledProfile | undefined;
/** Read the installed version for a package through the profile's Node lookup. */
declare function installedPackageVersion(profile: InstalledProfile, packageName: string): string | undefined;
/** Classify a dependency specifier by portability and installer behavior. */
declare function classifySpecifier(specifier: string): BundleSourceKind;
/** Return whether a git source is pinned to an immutable commit hash. */
declare function isPinnedGitSpecifier(specifier: string): boolean;
/** Return whether a registry source names one immutable semantic version. */
declare function isExactRegistryVersion(specifier: string): boolean;
/** Ask the installed `dsh` binary for its version without booting a profile. */
declare function discoverHarnessVersion(binary?: string): string | undefined;
//#endregion
//#region src/validation.d.ts
/** Compute the integrity field for a Stackfile. */
declare function computeStackIntegrity(stack: Omit<DshStack, 'integrity'>): string;
/** Return a complete Stackfile with a fresh integrity digest. */
declare function sealStack(stack: Omit<DshStack, 'integrity'>): DshStack;
/** Parse and fully validate untrusted Stackfile JSON. */
declare function parseStackJson(raw: string): DshStack;
/** Validate an untrusted JavaScript value as a v1 Stackfile. */
declare function validateStack(value: unknown): DshStack;
//#endregion
export { ApplyStackResult as A, StackPlan as B, StackError as C, applyStack as D, ApplyRuntime as E, ExportStackOptions as F, StackSecretReference as H, STACK_FORMAT as I, STACK_FORMAT_VERSION as L, DEFAULT_MAX_PATCH_BYTES as M, DEFAULT_MAX_STACK_BYTES as N, previewApply as O, DshStack as P, StackBundle as R, stackShareability as S, sha256 as T, StackSource as U, StackProfilePatch as V, isEmptyPatch as _, classifySpecifier as a, exportStack as b, isExactRegistryVersion as c, readInstalledProfile as d, resolveDshHome as f, hydratePatch as g, assertPatchSyntax as h, validateStack as i, BundleSourceKind as j, ApplyStackOptions as k, isPinnedGitSpecifier as l, planStack as m, parseStackJson as n, discoverHarnessVersion as o, formatPlan as p, sealStack as r, installedPackageVersion as s, computeStackIntegrity as t, profileDirectory as u, redactPatch as v, canonicalJson as w, formatStackJson as x, loadStackSource as y, StackDependencyChange as z };