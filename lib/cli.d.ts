//#region src/cli.d.ts
/** Run the dsh-stack CLI and return a process-style exit code. */
declare function runCli(argv?: string[]): Promise<number>;
//#endregion
export { runCli };