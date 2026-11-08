const emailAddressPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Redacts secrets that can end up in a log message even when the surrounding
 * metadata is already sanitised.
 *
 * Provider and transport errors can embed the SMTP conversation, which includes
 * the recipient address. Request errors and stack traces can embed a
 * single-use invitation token, a webhook URL token or an authentication token
 * carried in a query string.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(emailAddressPattern, '[REDACTED_EMAIL]')
    .replace(/(\/api\/v1\/invitations\/)[^/\s?#]+/g, '$1[REDACTED]')
    .replace(/(\/api\/v1\/webhooks\/email\/)[^/\s?#]+/g, '$1[REDACTED]')
    .replace(/([?&](?:token|invitationToken)=)[^&\s]+/gi, '$1[REDACTED]');
}

/** Removes credentials embedded in the path that an HTTP request logged. */
export function redactSensitivePath(path: string): string {
  return redactSensitiveText(path);
}
