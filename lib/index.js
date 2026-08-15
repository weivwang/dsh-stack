import { A as canonicalJson, C as STACK_FORMAT, D as isEmptyPatch, E as hydratePatch, O as redactPatch, S as DEFAULT_MAX_STACK_BYTES, T as assertPatchSyntax, _ as computeStackIntegrity, a as planStack, b as validateStack, c as stackShareability, d as installedPackageVersion, f as isExactRegistryVersion, g as resolveDshHome, h as readInstalledProfile, i as formatPlan, j as sha256, k as StackError, l as classifySpecifier, m as profileDirectory, n as applyStack, o as exportStack, p as isPinnedGitSpecifier, r as previewApply, s as formatStackJson, t as loadStackSource, u as discoverHarnessVersion, v as parseStackJson, w as STACK_FORMAT_VERSION, x as DEFAULT_MAX_PATCH_BYTES, y as sealStack } from "./load-CAVzSs-b.js";
import "./core.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/index.ts
/** Cordis plugin name shown by Harness diagnostics. */
const name = "dsh-stack";
/** Harness services required by the model-facing inspector. */
const inject = ["tools"];
/** Register the secret-safe profile inspection tool. */
function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "stack_inspect",
		description: "Inspect an installed DeepSeek Harness profile as a secret-redacted portable Stackfile. Use summary for a compact portability report or stack when the user wants the complete JSON saved or shared.",
		parameters: {
			profile: {
				type: "string",
				required: true,
				description: "Harness profile name, such as web or headless."
			},
			detail: {
				type: "string",
				enum: ["summary", "stack"],
				description: "summary returns a compact report; stack returns the complete integrity-sealed JSON."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const stack = exportStack({ profile: args.profile });
			if (args.detail === "stack") return formatStackJson(stack);
			const shareability = stackShareability(stack);
			const external = stack.bundles.filter((bundle) => bundle.sourceKind !== "builtin");
			const lines = [
				`Stack: ${stack.name}`,
				`Source profile: ${stack.source.profile}`,
				`Harness: ${stack.source.harnessVersion ?? "unknown"}`,
				`Bundles: ${stack.bundles.length} total, ${external.length} external`,
				`Shareability: ${shareability.score}/100 (${shareability.label})`,
				`Patch secrets: ${stack.profilePatch?.secrets.length ?? 0} redacted`
			];
			if (stack.warnings.length > 0) lines.push("Warnings:", ...stack.warnings.map((warning) => `- ${warning}`));
			lines.push("Use detail=\"stack\" to return the complete Stackfile JSON.");
			return lines.join("\n");
		}
	}));
}
//#endregion
export { DEFAULT_MAX_PATCH_BYTES, DEFAULT_MAX_STACK_BYTES, STACK_FORMAT, STACK_FORMAT_VERSION, StackError, apply, applyStack, assertPatchSyntax, canonicalJson, classifySpecifier, computeStackIntegrity, discoverHarnessVersion, exportStack, formatPlan, formatStackJson, hydratePatch, inject, installedPackageVersion, isEmptyPatch, isExactRegistryVersion, isPinnedGitSpecifier, loadStackSource, name, parseStackJson, planStack, previewApply, profileDirectory, readInstalledProfile, redactPatch, resolveDshHome, sealStack, sha256, stackShareability, validateStack };
