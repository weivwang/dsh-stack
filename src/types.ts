/** Stable marker for files produced by dsh-stack. */
export const STACK_FORMAT = 'dsh-stack' as const

/** Current Stackfile format version. */
export const STACK_FORMAT_VERSION = 1 as const

/** Default maximum accepted Stackfile size. */
export const DEFAULT_MAX_STACK_BYTES = 1_048_576

/** Default maximum profile patch size included in a Stackfile. */
export const DEFAULT_MAX_PATCH_BYTES = 524_288

/** A bundle's reproducible source class. */
export type BundleSourceKind = 'builtin' | 'registry' | 'git' | 'local' | 'other'

/** One bundle layer in profile order. */
export interface StackBundle {
  /** npm package name used by `dsh.profile.bundles`. */
  name: string
  /** Where the dependency came from. Built-in bundles omit this field. */
  specifier?: string
  /** Version read from the installed package manifest, when available. */
  installedVersion?: string
  /** Portability and installation behavior of the source. */
  sourceKind: BundleSourceKind
}

/** A secret removed from an exported patch. */
export interface StackSecretReference {
  /** Stable identifier used by the placeholder in the portable patch. */
  id: string
  /** Environment variable read by `dsh-stack apply`. */
  env: string
  /** Redacted YAML location; contains key names and indexes, never values. */
  path: string
}

/** Secret-safe, portable form of a profile's user patch. */
export interface StackProfilePatch {
  /** Canonical YAML with secret and home-directory placeholders. */
  content: string
  /** SHA-256 digest of `content`. */
  sha256: string
  /** Secrets the recipient must supply through environment variables. */
  secrets: StackSecretReference[]
}

/** Source metadata that helps recipients judge compatibility. */
export interface StackSource {
  /** Name of the exported Harness profile. */
  profile: string
  /** Version reported by the local `dsh` binary, when discoverable. */
  harnessVersion?: string
}

/** Portable DeepSeek Harness profile recipe. */
export interface DshStack {
  /** File type marker. */
  format: typeof STACK_FORMAT
  /** Stackfile schema version. */
  formatVersion: typeof STACK_FORMAT_VERSION
  /** Human-readable stack name. */
  name: string
  /** Optional explanation of the stack's intended use. */
  description?: string
  /** ISO-8601 export time. */
  createdAt: string
  /** Origin and compatibility metadata. */
  source: StackSource
  /** Bundle layers in activation order. */
  bundles: StackBundle[]
  /** Optional portable profile patch. */
  profilePatch?: StackProfilePatch
  /** Non-secret limitations discovered while exporting. */
  warnings: string[]
  /** SHA-256 digest of the canonical Stackfile without this field. */
  integrity: string
}

/** Options for exporting one installed profile. */
export interface ExportStackOptions {
  /** Profile name under `$DSH_HOME/profiles`. */
  profile: string
  /** Human-readable stack name. Defaults to the profile name. */
  name?: string
  /** Optional public description. */
  description?: string
  /** Include the profile's user patch. Defaults to true. */
  includePatch?: boolean
  /** Explicit Harness home for tests or non-default installations. */
  dshHome?: string
  /** Maximum accepted profile patch size. */
  maxPatchBytes?: number
  /** Override reported Harness version. */
  harnessVersion?: string
  /** Export timestamp. Defaults to the current time. */
  now?: Date
}

/** One dependency change in an apply plan. */
export interface StackDependencyChange {
  /** Bundle package name. */
  name: string
  /** Current installed version or dependency specifier. */
  from?: string
  /** Stackfile version or source specifier. */
  to: string
  /** Why this dependency cannot be automatically reproduced. */
  reason?: string
}

/** Reviewable plan produced before any profile mutation. */
export interface StackPlan {
  /** Target profile name. */
  profile: string
  /** Whether the target profile already exists. */
  profileExists: boolean
  /** Dependencies absent from the target. */
  install: StackDependencyChange[]
  /** Dependencies present at a different version or source. */
  update: StackDependencyChange[]
  /** Bundles already matching the Stackfile. */
  unchanged: string[]
  /** Built-in layers the target Harness installation must provide. */
  builtin: string[]
  /** Planned profile-patch action. */
  patch: {
    action: 'none' | 'write' | 'replace' | 'unchanged'
    requiredSecrets: string[]
  }
  /** Non-blocking review notes. */
  warnings: string[]
  /** Conditions that block safe default application. */
  errors: string[]
}

/** Options controlling a transactional Stackfile application. */
export interface ApplyStackOptions {
  /** Target profile name. */
  profile: string
  /** Explicit confirmation required for mutations. */
  yes: boolean
  /** Permit mutable git refs instead of commit-pinned sources. */
  allowUnpinned?: boolean
  /** Replace a different non-empty target patch. */
  replacePatch?: boolean
  /** Do not apply the Stackfile's profile patch. */
  skipPatch?: boolean
  /** Harness home override. */
  dshHome?: string
  /** `dsh` executable path. */
  dshBinary?: string
  /** Environment used for subprocesses and secret hydration. */
  env?: NodeJS.ProcessEnv
  /** Clock override for deterministic tests. */
  now?: Date
}

/** Result of a successful transactional application. */
export interface ApplyStackResult {
  /** Target profile. */
  profile: string
  /** Backup directory retained for manual recovery. */
  backupDir: string
  /** Dependencies installed or changed. */
  changedBundles: string[]
  /** Whether the profile patch changed. */
  patchChanged: boolean
  /** Verification command output. */
  verification: string
}
