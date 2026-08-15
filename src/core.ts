export { applyStack, previewApply, type ApplyRuntime } from './apply.js'
export { canonicalJson, sha256 } from './canonical.js'
export { StackError } from './errors.js'
export { exportStack, formatStackJson, stackShareability } from './export.js'
export { loadStackSource } from './load.js'
export { assertPatchSyntax, hydratePatch, isEmptyPatch, redactPatch } from './patch.js'
export { formatPlan, planStack } from './plan.js'
export {
  classifySpecifier,
  discoverHarnessVersion,
  installedPackageVersion,
  isExactRegistryVersion,
  isPinnedGitSpecifier,
  profileDirectory,
  readInstalledProfile,
  resolveDshHome,
} from './profile.js'
export {
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_MAX_STACK_BYTES,
  STACK_FORMAT,
  STACK_FORMAT_VERSION,
  type ApplyStackOptions,
  type ApplyStackResult,
  type BundleSourceKind,
  type DshStack,
  type ExportStackOptions,
  type StackBundle,
  type StackDependencyChange,
  type StackPlan,
  type StackProfilePatch,
  type StackSecretReference,
  type StackSource,
} from './types.js'
export { computeStackIntegrity, parseStackJson, sealStack, validateStack } from './validation.js'
