/** Exit codes. CI can gate on 2 without parsing output. */
export const EXIT_OK = 0;
/** Any error: bad arguments, missing credentials, a store error, a spent request budget */
export const EXIT_ERROR = 1;
/** The command worked and found something to act on: drift, or a plan with ops */
export const EXIT_CHANGES = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_ERROR | typeof EXIT_CHANGES;

/** An error the CLI reports as is (usage, input or credential problems) */
export class CliError extends Error {
  constructor(message: string, public readonly code = 'CLI_ERROR') {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 'USAGE');
    this.name = 'UsageError';
  }
}
