import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
//#region src/canonical.ts
/** Return a SHA-256 digest with an explicit algorithm prefix. */
function sha256(value) {
	return `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
/**
* Serialize JSON with recursively sorted object keys while retaining array
* order. The Stackfile digest uses this form so formatting cannot alter trust.
*/
function canonicalJson(value) {
	return JSON.stringify(sortJson(value));
}
function sortJson(value) {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== "object") return value;
	const record = value;
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}
//#endregion
//#region src/errors.ts
/** Error safe to print without exposing patch or credential contents. */
var StackError = class extends Error {
	/** Stable category for CLI and API callers. */
	code;
	/**
	* Create a public dsh-stack failure.
	* @param code - Stable machine-readable category.
	* @param message - Secret-free user-facing explanation.
	*/
	constructor(code, message) {
		super(message);
		this.name = "StackError";
		this.code = code;
	}
};
//#endregion
//#region src/patch.ts
const JS_TAG = {
	tag: "tag:yaml.org,2002:js",
	resolve: (value) => value
};
const SENSITIVE_KEY_ENDINGS = [
	"API_KEY",
	"ACCESS_KEY",
	"PRIVATE_KEY",
	"SIGNING_KEY",
	"CLIENT_SECRET",
	"ACCESS_TOKEN",
	"REFRESH_TOKEN",
	"AUTH_TOKEN",
	"PASSWORD",
	"PASSWD",
	"SECRET",
	"TOKEN",
	"COOKIE",
	"AUTHORIZATION",
	"WEBHOOK_URL"
];
const SENSITIVE_LITERALS = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
	/\bAKIA[A-Z0-9]{16}\b/,
	/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];
/** Convert a profile patch into a share-safe, hydratable YAML artifact. */
function redactPatch(raw, options) {
	const doc = parsePatch(raw);
	const secrets = [];
	const secretIds = /* @__PURE__ */ new Set();
	const allocated = /* @__PURE__ */ new Map();
	const homes = normalizeHomes(options.dshHome, options.home ?? homedir());
	walkNode(doc.contents, [], false, (node, path, forcedSensitive) => {
		if (!isScalar(node)) return;
		if (typeof node.value === "string") for (const id of existingSecretIds(node.value)) {
			if (secretIds.has(id)) continue;
			secretIds.add(id);
			secrets.push({
				id,
				env: `DSH_STACK_SECRET_${id}`,
				path: formatPath(path)
			});
		}
		if (forcedSensitive && !isPortableReference(node)) {
			const reference = allocateSecret(path, allocated, secretIds);
			secrets.push(reference);
			node.value = `{{DSH_STACK_SECRET:${reference.id}}}`;
			delete node.tag;
			return;
		}
		if (typeof node.value !== "string") return;
		if (containsSensitiveLiteral(node.value)) {
			const reference = allocateSecret(path, allocated, secretIds, "LITERAL");
			secrets.push(reference);
			node.value = `{{DSH_STACK_SECRET:${reference.id}}}`;
			delete node.tag;
			return;
		}
		node.value = makePathPortable(node.value, homes);
	});
	const content = scrubResidualLiterals(String(doc));
	return {
		content,
		sha256: sha256(content),
		secrets
	};
}
/** Restore home paths and environment-supplied secrets into portable YAML. */
function hydratePatch(patch, options) {
	const env = options.env ?? process.env;
	const missing = patch.secrets.filter((secret) => env[secret.env] === void 0);
	if (missing.length > 0) throw new StackError("MISSING_SECRETS", `Set the required environment variable${missing.length === 1 ? "" : "s"} before applying: ` + missing.map((secret) => secret.env).join(", "));
	const values = new Map(patch.secrets.map((secret) => [secret.id, env[secret.env]]));
	const doc = parsePatch(patch.content);
	walkNode(doc.contents, [], false, (node) => {
		if (!isScalar(node) || typeof node.value !== "string") return;
		node.value = node.value.replaceAll("{{DSH_HOME}}", options.dshHome).replaceAll("{{HOME}}", options.home ?? homedir()).replace(/\{\{DSH_STACK_SECRET:([A-Z0-9_]+)\}\}/g, (_placeholder, id) => {
			const value = values.get(id);
			if (value === void 0) throw new StackError("INVALID_PATCH", `No value was declared for secret placeholder ${id}.`);
			return value;
		});
	});
	return String(doc);
}
/** Return whether a patch is an empty top-level list. */
function isEmptyPatch(raw) {
	const doc = parsePatch(raw);
	return isSeq(doc.contents) && doc.contents.items.length === 0;
}
/** Validate patch syntax without evaluating `!!js` expressions. */
function assertPatchSyntax(raw) {
	parsePatch(raw);
}
function parsePatch(raw) {
	const doc = parseDocument(raw, {
		customTags: [JS_TAG],
		keepSourceTokens: false
	});
	if (doc.errors.length > 0) {
		const position = doc.errors[0]?.linePos?.[0];
		throw new StackError("INVALID_PATCH", `Profile patch is not valid YAML${position === void 0 ? "" : ` near line ${position.line}`}.`);
	}
	if (!isSeq(doc.contents)) throw new StackError("INVALID_PATCH", "Profile patch must be a top-level YAML array.");
	return doc;
}
function walkNode(node, path, forcedSensitive, visitScalar) {
	if (isScalar(node)) {
		visitScalar(node, path, forcedSensitive);
		return;
	}
	if (isSeq(node)) {
		node.items.forEach((item, index) => walkNode(item, [...path, index], forcedSensitive, visitScalar));
		return;
	}
	if (!isMap(node)) return;
	for (const pair of node.items) {
		if (!isPair(pair)) continue;
		const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
		const childPath = [...path, key];
		const sensitive = forcedSensitive || isSensitiveKey(key);
		walkNode(pair.value, childPath, sensitive, visitScalar);
	}
}
function normalizeHomes(dshHome, home) {
	return [{
		token: "{{DSH_HOME}}",
		path: trimTrailingSeparators(dshHome)
	}, {
		token: "{{HOME}}",
		path: trimTrailingSeparators(home)
	}].sort((left, right) => right.path.length - left.path.length);
}
function makePathPortable(value, homes) {
	let portable = value;
	for (const home of homes) {
		if (home.path.length === 0) continue;
		portable = portable.replace(new RegExp(`${escapeRegExp(home.path)}(?=$|[/\\\\])`, "g"), home.token);
	}
	return portable;
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function trimTrailingSeparators(value) {
	return value.replace(/[\\/]+$/, "");
}
function isSensitiveKey(key) {
	const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
	return SENSITIVE_KEY_ENDINGS.some((ending) => normalized === ending || normalized.endsWith(`_${ending}`));
}
function isPortableReference(node) {
	if (typeof node.value !== "string") return false;
	return node.value.includes("{{DSH_STACK_SECRET:") || node.value.includes("process.env") || node.value.includes("ctx.credentials") || /^\$\{[A-Z0-9_]+\}$/.test(node.value);
}
function containsSensitiveLiteral(value) {
	return SENSITIVE_LITERALS.some((pattern) => pattern.test(value));
}
function allocateSecret(path, allocated, secretIds, fallback = "SECRET") {
	const reversedKeys = [...path].reverse().filter((part) => typeof part === "string");
	const lastKey = reversedKeys.find(isSensitiveKey) ?? reversedKeys[0];
	const base = String(lastKey ?? fallback).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || fallback;
	let next = allocated.get(base) ?? 0;
	let id;
	do {
		next += 1;
		id = next === 1 ? base : `${base}_${next}`;
	} while (secretIds.has(id));
	allocated.set(base, next);
	secretIds.add(id);
	return {
		id,
		env: `DSH_STACK_SECRET_${id}`,
		path: formatPath(path)
	};
}
function existingSecretIds(value) {
	return [...value.matchAll(/\{\{DSH_STACK_SECRET:([A-Z][A-Z0-9_]*)\}\}/g)].map((match) => match[1]);
}
function formatPath(path) {
	return path.reduce((result, part) => typeof part === "number" ? `${result}[${part}]` : `${result}.${part}`, "$");
}
function scrubResidualLiterals(content) {
	let safe = content;
	for (const pattern of SENSITIVE_LITERALS) safe = safe.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[redacted]");
	return safe;
}
//#endregion
//#region src/types.ts
/** Stable marker for files produced by dsh-stack. */
const STACK_FORMAT = "dsh-stack";
/** Current Stackfile format version. */
const STACK_FORMAT_VERSION = 1;
/** Default maximum accepted Stackfile size. */
const DEFAULT_MAX_STACK_BYTES = 1048576;
/** Default maximum profile patch size included in a Stackfile. */
const DEFAULT_MAX_PATCH_BYTES = 524288;
//#endregion
//#region src/validation.ts
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i;
const PROFILE_NAME = /^(?!node_modules$)[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SECRET_PLACEHOLDER = /\{\{DSH_STACK_SECRET:([A-Z0-9_]+)\}\}/g;
const SOURCE_KINDS = /* @__PURE__ */ new Set([
	"builtin",
	"registry",
	"git",
	"local",
	"other"
]);
/** Compute the integrity field for a Stackfile. */
function computeStackIntegrity(stack) {
	return sha256(canonicalJson(stack));
}
/** Return a complete Stackfile with a fresh integrity digest. */
function sealStack(stack) {
	return {
		...stack,
		integrity: computeStackIntegrity(stack)
	};
}
/** Parse and fully validate untrusted Stackfile JSON. */
function parseStackJson(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new StackError("INVALID_JSON", "Stackfile is not valid JSON.");
	}
	return validateStack(parsed);
}
/** Validate an untrusted JavaScript value as a v1 Stackfile. */
function validateStack(value) {
	const root = expectRecord(value, "Stackfile");
	expectExactKeys(root, [
		"format",
		"formatVersion",
		"name",
		"description",
		"createdAt",
		"source",
		"bundles",
		"profilePatch",
		"warnings",
		"integrity"
	], "Stackfile");
	if (root.format !== "dsh-stack") throw invalid("Stackfile format must be \"dsh-stack\".");
	if (root.formatVersion !== 1) throw new StackError("UNSUPPORTED_VERSION", `Stackfile format version ${String(root.formatVersion)} is not supported; expected 1.`);
	const name = expectBoundedString(root.name, "Stackfile name", 1, 120);
	const description = root.description === void 0 ? void 0 : expectBoundedString(root.description, "Stackfile description", 1, 2e3);
	const createdAt = expectBoundedString(root.createdAt, "createdAt", 1, 80);
	if (Number.isNaN(Date.parse(createdAt))) throw invalid("createdAt must be an ISO-8601 timestamp.");
	const sourceRecord = expectRecord(root.source, "source");
	expectExactKeys(sourceRecord, ["profile", "harnessVersion"], "source");
	const profile = expectProfileName(sourceRecord.profile);
	const harnessVersion = sourceRecord.harnessVersion === void 0 ? void 0 : expectBoundedString(sourceRecord.harnessVersion, "harnessVersion", 1, 80);
	if (!Array.isArray(root.bundles) || root.bundles.length === 0 || root.bundles.length > 1e3) throw invalid("bundles must contain between 1 and 1000 entries.");
	const bundles = root.bundles.map((entry, index) => validateBundle(entry, index));
	const names = /* @__PURE__ */ new Set();
	for (const bundle of bundles) {
		if (names.has(bundle.name)) throw invalid(`Bundle ${bundle.name} appears more than once.`);
		names.add(bundle.name);
	}
	const profilePatch = root.profilePatch === void 0 ? void 0 : validateProfilePatch(root.profilePatch);
	if (!Array.isArray(root.warnings) || root.warnings.length > 1e3) throw invalid("warnings must be an array.");
	const warnings = root.warnings.map((warning, index) => expectBoundedString(warning, `warnings[${index}]`, 1, 2e3));
	const integrity = expectBoundedString(root.integrity, "integrity", 71, 71);
	if (!/^sha256-[0-9a-f]{64}$/.test(integrity)) throw invalid("integrity must be a SHA-256 digest.");
	const withoutIntegrity = {
		format: STACK_FORMAT,
		formatVersion: 1,
		name,
		...description === void 0 ? {} : { description },
		createdAt,
		source: {
			profile,
			...harnessVersion === void 0 ? {} : { harnessVersion }
		},
		bundles,
		...profilePatch === void 0 ? {} : { profilePatch },
		warnings
	};
	if (integrity !== computeStackIntegrity(withoutIntegrity)) throw new StackError("INTEGRITY_MISMATCH", "Stackfile integrity check failed; the file may be incomplete or modified.");
	return {
		...withoutIntegrity,
		integrity
	};
}
/** Validate a profile name before joining it to the Harness home. */
function expectProfileName(value) {
	const profile = expectBoundedString(value, "profile", 1, 120);
	if (!PROFILE_NAME.test(profile)) throw invalid(`Invalid profile name ${JSON.stringify(profile)}.`);
	return profile;
}
/** Return all secret placeholder ids present in YAML content. */
function secretPlaceholderIds(content) {
	return [...content.matchAll(SECRET_PLACEHOLDER)].map((match) => match[1]);
}
function validateBundle(value, index) {
	const bundle = expectRecord(value, `bundles[${index}]`);
	expectExactKeys(bundle, [
		"name",
		"specifier",
		"installedVersion",
		"sourceKind"
	], `bundles[${index}]`);
	const name = expectBoundedString(bundle.name, `bundles[${index}].name`, 1, 214);
	if (!PACKAGE_NAME.test(name)) throw invalid(`Invalid bundle package name ${JSON.stringify(name)}.`);
	const sourceKind = expectBoundedString(bundle.sourceKind, `bundles[${index}].sourceKind`, 1, 20);
	if (!SOURCE_KINDS.has(sourceKind)) throw invalid(`Unsupported source kind ${JSON.stringify(sourceKind)}.`);
	const specifier = bundle.specifier === void 0 ? void 0 : expectBoundedString(bundle.specifier, `bundles[${index}].specifier`, 1, 2e3);
	const installedVersion = bundle.installedVersion === void 0 ? void 0 : expectBoundedString(bundle.installedVersion, `bundles[${index}].installedVersion`, 1, 120);
	if (sourceKind === "builtin" && specifier !== void 0) throw invalid(`Built-in bundle ${name} must not declare a specifier.`);
	if (sourceKind !== "builtin" && specifier === void 0) throw invalid(`Bundle ${name} must declare a specifier.`);
	if (specifier !== void 0) assertSafeSpecifier(name, specifier);
	return {
		name,
		...specifier === void 0 ? {} : { specifier },
		...installedVersion === void 0 ? {} : { installedVersion },
		sourceKind
	};
}
function assertSafeSpecifier(name, specifier) {
	if (/\s|[&|;<>()`$]/.test(specifier)) throw invalid(`Bundle ${name} has a dependency specifier containing unsafe shell characters.`);
	if (/(?:https?|git\+https):\/\/[^/@]+:[^/@]+@/i.test(specifier) || /[?&](?:token|key|secret|password)=/i.test(specifier)) throw invalid(`Bundle ${name} must not embed credentials in its dependency specifier.`);
}
function validateProfilePatch(value) {
	const patch = expectRecord(value, "profilePatch");
	expectExactKeys(patch, [
		"content",
		"sha256",
		"secrets"
	], "profilePatch");
	const content = expectBoundedString(patch.content, "profilePatch.content", 1, 524288);
	const digest = expectBoundedString(patch.sha256, "profilePatch.sha256", 71, 71);
	if (digest !== sha256(content)) throw invalid("profilePatch digest does not match its content.");
	if (!Array.isArray(patch.secrets) || patch.secrets.length > 1e3) throw invalid("profilePatch.secrets must be an array.");
	const secrets = patch.secrets.map((secret, index) => validateSecret(secret, index));
	const ids = /* @__PURE__ */ new Set();
	for (const secret of secrets) {
		if (ids.has(secret.id)) throw invalid(`Secret id ${secret.id} appears more than once.`);
		ids.add(secret.id);
	}
	const placeholders = secretPlaceholderIds(content);
	if (placeholders.some((id) => !ids.has(id)) || secrets.some((secret) => !placeholders.includes(secret.id))) throw invalid("profilePatch secret references and placeholders must match exactly.");
	return {
		content,
		sha256: digest,
		secrets
	};
}
function validateSecret(value, index) {
	const secret = expectRecord(value, `profilePatch.secrets[${index}]`);
	expectExactKeys(secret, [
		"id",
		"env",
		"path"
	], `profilePatch.secrets[${index}]`);
	const id = expectBoundedString(secret.id, "secret id", 1, 80);
	if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw invalid(`Invalid secret id ${JSON.stringify(id)}.`);
	const env = expectBoundedString(secret.env, "secret env", 1, 120);
	if (env !== `DSH_STACK_SECRET_${id}`) throw invalid(`Secret ${id} has an invalid environment variable name.`);
	return {
		id,
		env,
		path: expectBoundedString(secret.path, "secret path", 1, 1e3)
	};
}
function expectRecord(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object.`);
	return value;
}
function expectExactKeys(value, allowed, label) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${label} contains unsupported field ${JSON.stringify(key)}.`);
}
function expectBoundedString(value, label, min, max) {
	if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\0")) throw invalid(`${label} must be a string between ${min} and ${max} characters.`);
	return value;
}
function invalid(message) {
	return new StackError("INVALID_STACK", message);
}
//#endregion
//#region src/profile.ts
/** Resolve `$DSH_HOME`, falling back to `~/.dsh`. */
function resolveDshHome(configured, env = process.env) {
	const selected = configured ?? (env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
	return resolve(selected === "~" ? homedir() : selected.replace(/^~(?=[/\\])/, homedir()));
}
/** Resolve and validate one profile directory. */
function profileDirectory(profile, dshHome = resolveDshHome()) {
	return join(dshHome, "profiles", expectProfileName(profile));
}
/** Read one initialized profile without evaluating any plugin code. */
function readInstalledProfile(profile, options = {}) {
	const dshHome = resolveDshHome(options.dshHome);
	const dir = profileDirectory(profile, dshHome);
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		if (options.allowMissing === true) return void 0;
		throw new StackError("PROFILE_NOT_FOUND", `Profile ${JSON.stringify(profile)} does not exist under ${symbolicDshHome(dshHome)}/profiles.`);
	}
	const manifest = readProfileManifest(manifestPath);
	const patchPath = join(dir, "cordis.patch.yml");
	const maxPatchBytes = options.maxPatchBytes ?? 524288;
	let patch = "[]\n";
	if (existsSync(patchPath)) {
		if (statSync(patchPath).size > maxPatchBytes) throw new StackError("PATCH_TOO_LARGE", `Profile patch exceeds the ${maxPatchBytes}-byte export limit.`);
		patch = readFileSync(patchPath, "utf8");
	}
	return {
		name: profile,
		dir,
		manifestPath,
		patchPath,
		manifest,
		patch
	};
}
/** Read the installed version for a package through the profile's Node lookup. */
function installedPackageVersion(profile, packageName) {
	for (const searchPath of createRequire(profile.manifestPath).resolve.paths(packageName) ?? []) {
		const manifestPath = join(searchPath, packageName, "package.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			return typeof manifest.version === "string" ? manifest.version : void 0;
		} catch {
			return;
		}
	}
}
/** Classify a dependency specifier by portability and installer behavior. */
function classifySpecifier(specifier) {
	if (/^(?:file|link|workspace):/i.test(specifier) || /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return "local";
	if (/^(?:git\+|github:|gitlab:|bitbucket:)/i.test(specifier) || /^(?:https?|ssh):\/\/.*(?:\.git|github\.com|gitlab\.com)/i.test(specifier)) return "git";
	if (/^(?:npm:)?(?:[~^<>=*]|v?\d|latest$|next$|beta$|canary$)/i.test(specifier)) return "registry";
	return "other";
}
/** Return whether a git source is pinned to an immutable commit hash. */
function isPinnedGitSpecifier(specifier) {
	return /#[0-9a-f]{7,64}(?:&.*)?$/i.test(specifier);
}
/** Return whether a registry source names one immutable semantic version. */
function isExactRegistryVersion(specifier) {
	return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(specifier);
}
/** Ask the installed `dsh` binary for its version without booting a profile. */
function discoverHarnessVersion(binary = "dsh") {
	const result = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		]
	});
	if (result.status !== 0) return void 0;
	const version = result.stdout.trim();
	return version.length > 0 && version.length <= 80 ? version : void 0;
}
/** Make the configured home safe and stable in diagnostics. */
function symbolicDshHome(dshHome) {
	return resolve(dshHome) === resolve(join(homedir(), ".dsh")) ? "~/.dsh" : "$DSH_HOME";
}
function readProfileManifest(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new StackError("INVALID_PROFILE", "Profile package.json is not valid JSON.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new StackError("INVALID_PROFILE", "Profile package.json must contain an object.");
	const manifest = parsed;
	if (manifest.dependencies !== void 0 && (manifest.dependencies === null || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies))) throw new StackError("INVALID_PROFILE", "Profile dependencies must be an object.");
	const bundles = manifest.dsh?.profile?.bundles;
	if (bundles !== void 0 && (!Array.isArray(bundles) || bundles.some((name) => typeof name !== "string"))) throw new StackError("INVALID_PROFILE", "Profile dsh.profile.bundles must be an array of package names.");
	return manifest;
}
//#endregion
//#region src/export.ts
/** Export an installed profile as a secret-safe, integrity-sealed Stackfile. */
function exportStack(options) {
	const dshHome = resolveDshHome(options.dshHome);
	const profile = readInstalledProfile(options.profile, {
		dshHome,
		maxPatchBytes: options.maxPatchBytes ?? 524288
	});
	if (profile === void 0) throw new Error("unreachable");
	const bundleNames = profile.manifest.dsh?.profile?.bundles ?? [];
	if (bundleNames.length === 0) throw new StackError("EMPTY_PROFILE", `Profile ${JSON.stringify(options.profile)} has no bundle layers to export.`);
	const warnings = [];
	const bundles = bundleNames.map((name) => {
		const originalSpecifier = profile.manifest.dependencies?.[name];
		if (originalSpecifier === void 0) return {
			name,
			sourceKind: "builtin"
		};
		const sourceKind = classifySpecifier(originalSpecifier);
		const installedVersion = installedPackageVersion(profile, name);
		const specifier = sourceKind === "registry" && installedVersion !== void 0 ? installedVersion : originalSpecifier;
		if (sourceKind === "local") warnings.push(`${name} uses a machine-local dependency and cannot be applied elsewhere automatically.`);
		else if (sourceKind === "git" && !isPinnedGitSpecifier(specifier)) warnings.push(`${name} uses a mutable git ref; pin a commit before publishing this Stackfile.`);
		else if (sourceKind === "other") warnings.push(`${name} uses an unrecognized dependency source and requires manual review.`);
		if (installedVersion === void 0) warnings.push(`Could not discover the installed version of ${name}.`);
		return {
			name,
			specifier,
			...installedVersion === void 0 ? {} : { installedVersion },
			sourceKind
		};
	});
	const harnessVersion = options.harnessVersion ?? discoverHarnessVersion();
	if (harnessVersion === void 0) warnings.push("Could not discover the installed DeepSeek Harness version.");
	const profilePatch = options.includePatch === false ? void 0 : redactPatch(profile.patch, { dshHome });
	if (profilePatch !== void 0 && profilePatch.secrets.length > 0) warnings.push(`The profile patch requires ${profilePatch.secrets.length} secret environment variable${profilePatch.secrets.length === 1 ? "" : "s"} when applied.`);
	return validateStack(sealStack({
		format: STACK_FORMAT,
		formatVersion: 1,
		name: options.name?.trim() || options.profile,
		...options.description?.trim() ? { description: options.description.trim() } : {},
		createdAt: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
		source: {
			profile: options.profile,
			...harnessVersion === void 0 ? {} : { harnessVersion }
		},
		bundles,
		...profilePatch === void 0 ? {} : { profilePatch },
		warnings
	}));
}
/** Render a Stackfile as stable, review-friendly JSON. */
function formatStackJson(stack) {
	return `${JSON.stringify(stack, null, 2)}\n`;
}
/** Score how easily another machine can reproduce a Stackfile. */
function stackShareability(stack) {
	let score = 100;
	score -= Math.min(60, stack.bundles.filter((bundle) => bundle.sourceKind === "local").length * 30);
	score -= Math.min(30, stack.bundles.filter((bundle) => bundle.sourceKind === "git" && bundle.specifier !== void 0 && !isPinnedGitSpecifier(bundle.specifier)).length * 15);
	score -= Math.min(15, stack.bundles.filter((bundle) => bundle.sourceKind === "other").length * 10);
	if (stack.source.harnessVersion === void 0) score -= 5;
	if (stack.profilePatch === void 0) score -= 5;
	score = Math.max(0, score);
	return {
		score,
		label: score >= 90 ? "excellent" : score >= 70 ? "good" : score >= 40 ? "needs review" : "local only"
	};
}
//#endregion
//#region src/plan.ts
/** Build a read-only installation plan against one target profile. */
function planStack(stack, options) {
	validateStack(stack);
	const dshHome = resolveDshHome(options.dshHome);
	const target = readInstalledProfile(options.profile, {
		dshHome,
		allowMissing: true
	});
	const install = [];
	const update = [];
	const unchanged = [];
	const builtin = [];
	const warnings = [...stack.warnings];
	const errors = [];
	for (const bundle of stack.bundles) {
		if (bundle.sourceKind === "builtin") {
			builtin.push(bundle.name);
			continue;
		}
		const specifier = bundle.specifier;
		const currentSpecifier = target?.manifest.dependencies?.[bundle.name];
		const currentVersion = target === void 0 ? void 0 : installedPackageVersion(target, bundle.name);
		const desired = desiredLabel(bundle);
		const matches = currentSpecifier !== void 0 && dependencyMatches(bundle, currentSpecifier, currentVersion);
		if (!matches) {
			if (bundle.sourceKind === "local") errors.push(`${bundle.name} uses a local path and must be installed manually on the target machine.`);
			else if (bundle.sourceKind === "other") errors.push(`${bundle.name} uses an unsupported dependency source: ${specifier}`);
			else if (bundle.sourceKind === "git" && !isPinnedGitSpecifier(specifier)) errors.push(`${bundle.name} uses a mutable git ref; pin a commit or explicitly allow unpinned sources.`);
			else if (bundle.sourceKind === "registry" && !isExactRegistryVersion(desired)) errors.push(`${bundle.name} does not name an exact registry version and cannot be reproduced safely.`);
		}
		if (currentSpecifier === void 0) install.push({
			name: bundle.name,
			to: desired
		});
		else if (matches) unchanged.push(bundle.name);
		else update.push({
			name: bundle.name,
			from: currentVersion ?? currentSpecifier,
			to: desired
		});
	}
	const currentHarness = discoverHarnessVersion();
	if (stack.source.harnessVersion !== void 0 && currentHarness !== void 0 && stack.source.harnessVersion !== currentHarness) warnings.push(`Stackfile was exported with Harness ${stack.source.harnessVersion}; target reports ${currentHarness}. Developer-preview compatibility is not guaranteed.`);
	const patch = planPatch(stack, target?.patch, dshHome, options.skipPatch === true);
	if (patch.action === "replace" && options.skipPatch !== true) warnings.push("Target profile has a different non-empty patch; applying it requires --replace-patch or --skip-patch.");
	return {
		profile: options.profile,
		profileExists: target !== void 0,
		install,
		update,
		unchanged,
		builtin,
		patch,
		warnings: unique(warnings),
		errors: unique(errors)
	};
}
/** Render a plan for human review. */
function formatPlan(plan) {
	const lines = [`Target profile: ${plan.profile}${plan.profileExists ? "" : " (will be initialized)"}`, `Built-in layers: ${plan.builtin.length === 0 ? "none" : plan.builtin.join(", ")}`];
	appendChanges(lines, "Install", plan.install);
	appendChanges(lines, "Update", plan.update);
	lines.push(`Already matching: ${plan.unchanged.length === 0 ? "none" : plan.unchanged.join(", ")}`);
	lines.push(`Profile patch: ${plan.patch.action}`);
	if (plan.patch.requiredSecrets.length > 0) lines.push(`Required environment: ${plan.patch.requiredSecrets.join(", ")}`);
	if (plan.warnings.length > 0) {
		lines.push("", "Warnings:");
		plan.warnings.forEach((warning) => lines.push(`- ${warning}`));
	}
	if (plan.errors.length > 0) {
		lines.push("", "Blocking issues:");
		plan.errors.forEach((error) => lines.push(`- ${error}`));
	}
	return `${lines.join("\n")}\n`;
}
function desiredLabel(bundle) {
	if (bundle.sourceKind === "registry") return bundle.installedVersion ?? bundle.specifier;
	return bundle.specifier;
}
function dependencyMatches(bundle, currentSpecifier, currentVersion) {
	if (bundle.sourceKind === "registry") {
		const desiredVersion = bundle.installedVersion ?? bundle.specifier;
		return currentVersion !== void 0 && currentVersion === desiredVersion;
	}
	return currentSpecifier === bundle.specifier;
}
function planPatch(stack, targetPatch, dshHome, skipPatch) {
	if (skipPatch || stack.profilePatch === void 0) return {
		action: "none",
		requiredSecrets: []
	};
	const requiredSecrets = stack.profilePatch.secrets.map((secret) => secret.env);
	if (targetPatch === void 0) return {
		action: "write",
		requiredSecrets
	};
	if (redactPatch(targetPatch, { dshHome }).sha256 === stack.profilePatch.sha256) return {
		action: "unchanged",
		requiredSecrets
	};
	if (isEmptyPatch(targetPatch)) return {
		action: "write",
		requiredSecrets
	};
	return {
		action: "replace",
		requiredSecrets
	};
}
function appendChanges(lines, title, changes) {
	if (changes.length === 0) {
		lines.push(`${title}: none`);
		return;
	}
	lines.push(`${title}:`);
	for (const change of changes) lines.push(`- ${change.name}${change.from === void 0 ? "" : ` (${change.from})`} -> ${change.to}`);
}
function unique(values) {
	return [...new Set(values)];
}
//#endregion
//#region src/apply.ts
const BACKUP_FILES = [
	"package.json",
	"cordis.patch.yml",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml"
];
const defaultRuntime = { run(binary, args, options) {
	const result = spawnSync(binary, args, {
		encoding: "utf8",
		env: options.env,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		shell: process.platform === "win32"
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		...result.error === void 0 ? {} : { error: result.error }
	};
} };
/** Apply a Stackfile with review gates, backup, locking, and rollback. */
function applyStack(stack, options, runtime = defaultRuntime) {
	if (!options.yes) throw new StackError("CONFIRMATION_REQUIRED", "Review the plan, then run apply again with --yes.");
	const dshHome = resolveDshHome(options.dshHome, options.env);
	const env = {
		...options.env ?? process.env,
		DSH_HOME: dshHome
	};
	const plan = planStack(stack, {
		profile: options.profile,
		dshHome,
		...options.skipPatch === void 0 ? {} : { skipPatch: options.skipPatch }
	});
	const blocking = filterAllowedErrors(plan.errors, options.allowUnpinned === true);
	if (blocking.length > 0) throw new StackError("UNSAFE_PLAN", `Stackfile cannot be applied safely:\n${blocking.map((error) => `- ${error}`).join("\n")}`);
	if (plan.patch.action === "replace" && options.replacePatch !== true && options.skipPatch !== true) throw new StackError("PATCH_CONFLICT", "Target profile has a different non-empty patch. Re-run with --replace-patch or --skip-patch.");
	const hydratedPatch = stack.profilePatch === void 0 || options.skipPatch === true ? void 0 : hydratePatch(stack.profilePatch, {
		dshHome,
		env
	});
	const profileDir = profileDirectory(options.profile, dshHome);
	const stateDir = join(profileDir, ".dsh-stack");
	mkdirSync(stateDir, { recursive: true });
	const releaseLock = acquireLock(join(stateDir, "apply.lock"), stack.integrity);
	let backup;
	try {
		backup = createBackup(profileDir, stateDir, options.now ?? /* @__PURE__ */ new Date(), stack.integrity);
		if (!plan.profileExists) runDsh(runtime, options.dshBinary ?? "dsh", [
			"plugin",
			"--profile",
			options.profile,
			"root"
		], env, "initialize profile");
		const changes = [...plan.install, ...plan.update];
		if (changes.length > 0) {
			const bundleByName = new Map(stack.bundles.map((bundle) => [bundle.name, bundle]));
			const specs = changes.map((change) => {
				const bundle = bundleByName.get(change.name);
				if (bundle?.specifier === void 0) throw new StackError("INVALID_STACK", `Missing specifier for ${change.name}.`);
				const desired = bundle.sourceKind === "registry" ? bundle.installedVersion ?? bundle.specifier : bundle.specifier;
				return `${bundle.name}@${desired}`;
			});
			runDsh(runtime, options.dshBinary ?? "dsh", [
				"plugin",
				"--profile",
				options.profile,
				"add",
				"--save-exact",
				...specs
			], env, "install bundle dependencies");
		}
		const installed = readInstalledProfile(options.profile, { dshHome });
		if (installed === void 0) throw new StackError("PROFILE_NOT_FOUND", "Profile initialization did not create package.json.");
		const desiredOrder = stack.bundles.map((bundle) => bundle.name);
		const extras = (installed.manifest.dsh?.profile?.bundles ?? []).filter((name) => !desiredOrder.includes(name));
		const manifest = {
			...installed.manifest,
			dsh: {
				...installed.manifest.dsh,
				profile: {
					...installed.manifest.dsh?.profile,
					bundles: [...desiredOrder, ...extras]
				}
			}
		};
		atomicWrite(installed.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const patchChanged = hydratedPatch !== void 0 && plan.patch.action !== "unchanged" && plan.patch.action !== "none";
		if (patchChanged) atomicWrite(installed.patchPath, hydratedPatch);
		const verification = runDsh(runtime, options.dshBinary ?? "dsh", [
			"--profile",
			options.profile,
			"--dump-config"
		], env, "verify composed profile").stdout.trim();
		return {
			profile: options.profile,
			backupDir: backup.dir,
			changedBundles: changes.map((change) => change.name),
			patchChanged,
			verification
		};
	} catch (error) {
		if (backup !== void 0) restoreBackup(profileDir, backup);
		if (error instanceof StackError) throw error;
		throw new StackError("APPLY_FAILED", `Stack application failed and profile files were restored: ${safeError(error)}`);
	} finally {
		releaseLock();
	}
}
/** Render the exact dry-run text used before `--yes`. */
function previewApply(stack, options) {
	return formatPlan(planStack(stack, {
		profile: options.profile,
		...options.dshHome === void 0 ? {} : { dshHome: options.dshHome },
		...options.skipPatch === void 0 ? {} : { skipPatch: options.skipPatch }
	}));
}
function createBackup(profileDir, stateDir, now, integrity) {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const dir = join(stateDir, "backups", `${stamp}-${integrity.slice(-8)}`);
	mkdirSync(dir, { recursive: true });
	const files = Object.fromEntries(BACKUP_FILES.map((filename) => [filename, existsSync(join(profileDir, filename))]));
	for (const filename of BACKUP_FILES) if (files[filename]) copyFileSync(join(profileDir, filename), join(dir, filename));
	writeFileSync(join(dir, "backup.json"), `${JSON.stringify({ files }, null, 2)}\n`, { flag: "wx" });
	return {
		dir,
		files
	};
}
function restoreBackup(profileDir, backup) {
	for (const filename of BACKUP_FILES) {
		const target = join(profileDir, filename);
		if (backup.files[filename]) copyFileSync(join(backup.dir, filename), target);
		else rmSync(target, { force: true });
	}
}
function acquireLock(path, integrity) {
	if (existsSync(path)) {
		const stale = readLockPid(path);
		if (stale !== void 0 && !processExists(stale)) unlinkSync(path);
	}
	let descriptor;
	try {
		descriptor = openSync(path, "wx");
	} catch {
		throw new StackError("APPLY_LOCKED", `Another dsh-stack apply is active. If it crashed, remove ${basename(path)} manually.`);
	}
	writeFileSync(descriptor, `${JSON.stringify({
		pid: process.pid,
		integrity,
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
	})}\n`);
	return () => {
		closeSync(descriptor);
		try {
			unlinkSync(path);
		} catch {}
	};
}
function readLockPid(path) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return typeof value.pid === "number" && Number.isSafeInteger(value.pid) ? value.pid : void 0;
	} catch {
		return;
	}
}
function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
function runDsh(runtime, binary, args, env, action) {
	const result = runtime.run(binary, args, { env });
	if (result.error !== void 0) throw new StackError("COMMAND_FAILED", `Could not ${action}: ${safeError(result.error)}`);
	if (result.status !== 0) {
		const diagnostic = scrubOutput(result.stderr || result.stdout, env.DSH_HOME).trim();
		throw new StackError("COMMAND_FAILED", `Could not ${action}${diagnostic.length === 0 ? "." : `:\n${diagnostic.slice(0, 4e3)}`}`);
	}
	return {
		stdout: result.stdout,
		stderr: result.stderr
	};
}
function atomicWrite(path, content) {
	const temp = join(dirname(path), `.${basename(path)}.dsh-stack-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		writeFileSync(temp, content, { flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
function filterAllowedErrors(errors, allowUnpinned) {
	if (!allowUnpinned) return [...errors];
	return errors.filter((error) => !error.includes("uses a mutable git ref"));
}
function scrubOutput(value, dshHome) {
	let safe = value.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[redacted]@");
	safe = safe.replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]");
	if (dshHome !== void 0) safe = safe.replaceAll(dshHome, "$DSH_HOME");
	return safe;
}
function safeError(error) {
	if (error instanceof Error) return error.message.replace(/[\r\n]+/g, " ").slice(0, 1e3);
	return String(error).replace(/[\r\n]+/g, " ").slice(0, 1e3);
}
//#endregion
//#region src/load.ts
/** Load and validate a Stackfile from disk or an HTTPS URL. */
async function loadStackSource(source, options = {}) {
	const maxBytes = options.maxBytes ?? 1048576;
	return parseStackJson(/^https:\/\//i.test(source) ? await fetchStack(source, maxBytes, options.timeoutMs ?? 1e4) : readStackFile(source, options.cwd ?? process.cwd(), maxBytes));
}
function readStackFile(source, cwd, maxBytes) {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new StackError("UNSAFE_SOURCE", "Only local files and HTTPS Stackfile URLs are accepted.");
	const path = resolve(cwd, source);
	let size;
	try {
		size = statSync(path).size;
	} catch {
		throw new StackError("SOURCE_NOT_FOUND", `Stackfile ${JSON.stringify(source)} could not be read.`);
	}
	if (size > maxBytes) throw new StackError("STACK_TOO_LARGE", `Stackfile exceeds the ${maxBytes}-byte limit.`);
	try {
		return readFileSync(path, "utf8");
	} catch {
		throw new StackError("SOURCE_NOT_FOUND", `Stackfile ${JSON.stringify(source)} could not be read.`);
	}
}
async function fetchStack(source, maxBytes, timeoutMs) {
	let response;
	try {
		response = await fetch(source, {
			headers: { accept: "application/json, text/plain;q=0.9" },
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch {
		throw new StackError("FETCH_FAILED", "Stackfile URL could not be fetched over HTTPS.");
	}
	if (!response.ok) throw new StackError("FETCH_FAILED", `Stackfile server returned HTTP ${response.status}.`);
	if (!response.url.startsWith("https://")) throw new StackError("UNSAFE_SOURCE", "Stackfile redirects must remain on HTTPS.");
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new StackError("STACK_TOO_LARGE", `Stackfile exceeds the ${maxBytes}-byte limit.`);
	const body = await response.arrayBuffer();
	if (body.byteLength > maxBytes) throw new StackError("STACK_TOO_LARGE", `Stackfile exceeds the ${maxBytes}-byte limit.`);
	return new TextDecoder().decode(body);
}
//#endregion
export { canonicalJson as A, STACK_FORMAT as C, isEmptyPatch as D, hydratePatch as E, redactPatch as O, DEFAULT_MAX_STACK_BYTES as S, assertPatchSyntax as T, computeStackIntegrity as _, planStack as a, validateStack as b, stackShareability as c, installedPackageVersion as d, isExactRegistryVersion as f, resolveDshHome as g, readInstalledProfile as h, formatPlan as i, sha256 as j, StackError as k, classifySpecifier as l, profileDirectory as m, applyStack as n, exportStack as o, isPinnedGitSpecifier as p, previewApply as r, formatStackJson as s, loadStackSource as t, discoverHarnessVersion as u, parseStackJson as v, STACK_FORMAT_VERSION as w, DEFAULT_MAX_PATCH_BYTES as x, sealStack as y };
