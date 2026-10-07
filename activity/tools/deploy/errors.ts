/**
 * A failure the deploy explains to its operator.
 *
 * The CLI prints its message as it stands, without a stack, and exits 1. Use
 * it for everything an operator can act on — a refused config, a check that
 * failed, a process that never came up — and let anything else (a bug in
 * this tool) surface with its stack, so the two are never confused.
 */
export class DeployError extends Error {
  override readonly name = "DeployError";
}

/** The same failure, with the command that moves `app` back to what it ran before. */
export function withRollbackHint(error: unknown, app: string): unknown {
  if (!(error instanceof DeployError)) return error;
  return new DeployError(`${error.message}\nGo back with \`bun run deploy rollback ${app}\`.`);
}
