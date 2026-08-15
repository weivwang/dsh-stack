#!/usr/bin/env node
import { a as planStack, c as stackShareability, i as formatPlan, k as StackError, n as applyStack, o as exportStack, r as previewApply, s as formatStackJson, t as loadStackSource } from "./load-CAVzSs-b.js";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
//#region src/cli.ts
/** Run the dsh-stack CLI and return a process-style exit code. */
async function runCli(argv = process.argv) {
	const program = new Command().name("dsh-stack").description("Portable, secret-safe, review-first profiles for DeepSeek Harness").version("0.1.0").showSuggestionAfterError();
	program.command("export").description("Export an installed profile to a Stackfile").requiredOption("-p, --profile <name>", "profile under $DSH_HOME/profiles").option("-o, --output <path>", "output file (default: <profile>.dsh-stack.json)").option("-n, --name <name>", "public stack name").option("-d, --description <text>", "public stack description").option("--no-patch", "omit the profile user patch").option("--force", "replace an existing output file").option("--dsh-home <path>", "Harness home override").action((options) => {
		const stack = exportStack({
			profile: options.profile,
			...options.name === void 0 ? {} : { name: options.name },
			...options.description === void 0 ? {} : { description: options.description },
			includePatch: options.patch,
			...options.dshHome === void 0 ? {} : { dshHome: options.dshHome }
		});
		const output = resolve(options.output ?? `${slug(options.profile)}.dsh-stack.json`);
		if (existsSync(output) && options.force !== true) throw new StackError("OUTPUT_EXISTS", `Output already exists: ${output}. Use --force to replace it.`);
		atomicWrite(output, formatStackJson(stack));
		const shareability = stackShareability(stack);
		process.stdout.write(`Exported ${stack.bundles.length} bundles to ${output}\n`);
		process.stdout.write(`Shareability: ${shareability.score}/100 (${shareability.label})\n`);
		stack.warnings.forEach((warning) => process.stderr.write(`warning: ${warning}\n`));
	});
	program.command("inspect").description("Verify and explain a local or HTTPS Stackfile").argument("<source>", "Stackfile path or HTTPS URL").option("--json", "print the complete validated Stackfile").action(async (source, options) => {
		const stack = await loadStackSource(source);
		if (options.json === true) {
			process.stdout.write(formatStackJson(stack));
			return;
		}
		const shareability = stackShareability(stack);
		process.stdout.write(`${stack.name}\n`);
		process.stdout.write(`  Integrity: verified\n`);
		process.stdout.write(`  Created: ${stack.createdAt}\n`);
		process.stdout.write(`  Harness: ${stack.source.harnessVersion ?? "unknown"}\n`);
		process.stdout.write(`  Bundles: ${stack.bundles.length}\n`);
		process.stdout.write(`  Shareability: ${shareability.score}/100 (${shareability.label})\n`);
		if (stack.profilePatch?.secrets.length) process.stdout.write(`  Required environment: ${stack.profilePatch.secrets.map((secret) => secret.env).join(", ")}\n`);
		stack.warnings.forEach((warning) => process.stdout.write(`  Warning: ${warning}\n`));
	});
	program.command("plan").description("Show changes without mutating a profile").argument("<source>", "Stackfile path or HTTPS URL").option("-p, --profile <name>", "target profile (default: Stackfile source profile)").option("--skip-patch", "ignore the Stackfile profile patch").option("--dsh-home <path>", "Harness home override").option("--json", "print the plan as JSON").action(async (source, options) => {
		const stack = await loadStackSource(source);
		const plan = planStack(stack, {
			profile: options.profile ?? stack.source.profile,
			...options.dshHome === void 0 ? {} : { dshHome: options.dshHome },
			...options.skipPatch === void 0 ? {} : { skipPatch: options.skipPatch }
		});
		process.stdout.write(options.json === true ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
	});
	program.command("apply").description("Transactionally apply a reviewed Stackfile").argument("<source>", "Stackfile path or HTTPS URL").option("-p, --profile <name>", "target profile (default: Stackfile source profile)").option("--yes", "confirm profile mutation").option("--replace-patch", "replace a different non-empty target patch").option("--skip-patch", "install bundles without applying the profile patch").option("--allow-unpinned", "allow mutable git refs").option("--dsh-home <path>", "Harness home override").option("--dsh-binary <path>", "dsh executable path", "dsh").action(async (source, options) => {
		const stack = await loadStackSource(source);
		const base = {
			profile: options.profile ?? stack.source.profile,
			...options.dshHome === void 0 ? {} : { dshHome: options.dshHome },
			...options.replacePatch === void 0 ? {} : { replacePatch: options.replacePatch },
			...options.skipPatch === void 0 ? {} : { skipPatch: options.skipPatch },
			...options.allowUnpinned === void 0 ? {} : { allowUnpinned: options.allowUnpinned },
			dshBinary: options.dshBinary
		};
		process.stdout.write(previewApply(stack, base));
		if (options.yes !== true) {
			process.stderr.write("No changes made. Review the plan, then re-run with --yes.\n");
			process.exitCode = 2;
			return;
		}
		const result = applyStack(stack, {
			...base,
			yes: true
		});
		process.stdout.write(`Applied to profile ${result.profile}.\n`);
		process.stdout.write(`Backup retained at ${result.backupDir}\n`);
	});
	try {
		await program.parseAsync(argv);
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (error) {
		if (error instanceof StackError) {
			process.stderr.write(`dsh-stack: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}
function atomicWrite(path, content) {
	const directory = dirname(path);
	const temp = join(directory, `.${basename(path)}.dsh-stack-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		writeFileSync(temp, content, { flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
function slug(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
}
if (process.argv[1] !== void 0 && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli().then((code) => {
	process.exitCode = code;
}).catch((error) => {
	process.stderr.write(`dsh-stack: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
//#endregion
export { runCli };
