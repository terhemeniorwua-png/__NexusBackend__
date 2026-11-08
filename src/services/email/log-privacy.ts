import { redactSensitiveText } from '../../utils/log-redaction';

/**
 * Removes email addresses from text that may be written to the application
 * log. Provider and transport errors can embed the SMTP conversation, which
 * includes the recipient address. Single-use tokens are redacted as well.
 */
export function redactEmailAddresses(value: string): string {
  return redactSensitiveText(value);
}

/**
 * Produces a log-safe summary of an unexpected error. The message and the
 * stack are retained for diagnosis, but email addresses are removed first.
 */
export function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;

    return {
      name: error.name,
      message: redactEmailAddresses(error.message),
      ...(error.stack ? { stack: redactEmailAddresses(error.stack) } : {}),
      ...(typeof code === 'string' || typeof code === 'number'
        ? { code: redactEmailAddresses(String(code)) }
        : {}),
    };
  }

  return { message: redactEmailAddresses(String(error)) };
}
