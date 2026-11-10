/** Fail before Vitest starts workers on unsupported runtimes. */
export function assertVitestNodeVersion(version: string = process.versions.node) {
  if (!/^22\./.test(version)) {
    throw new Error(`Vitest requires Node 22 (.nvmrc); running Node ${version}. Select Node 22 before running tests.`);
  }
}
