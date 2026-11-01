const emailAddressPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Redacts email addresses and secret-bearing invitation/webhook URL segments. */
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
