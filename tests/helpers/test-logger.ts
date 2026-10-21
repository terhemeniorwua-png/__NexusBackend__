/**
 * Captures everything the application writes to stdout and stderr while an
 * action runs.
 *
 * The Phase 4 tests use it to prove that a verification token never reaches
 * the log.
 */
export interface CapturedLogs {
  output: string;
}

export async function captureLogs<T>(
  action: () => Promise<T>,
): Promise<{ result: T; logs: CapturedLogs }> {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let output = '';

  const capture = (chunk: unknown): boolean => {
    output += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };

  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;

  try {
    const result = await action();
    return { result, logs: { output } };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}
