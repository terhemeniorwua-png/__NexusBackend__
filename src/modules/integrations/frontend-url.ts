/**
 * First frontend origin from FRONTEND_URL. FRONTEND_URL may hold several
 * origins separated by "," or "||"; only the first is used for redirects.
 * A trailing dot on the hostname is stripped.
 */
export function frontendOrigin(): string {
  const first = (process.env.FRONTEND_URL ?? '').split(/\s*(?:,|\|\|)\s*/)[0]?.trim();
  if (!first) return 'http://localhost:3000';
  try {
    const url = new URL(first);
    url.hostname = url.hostname.replace(/\.+$/, '');
    return url.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

export function integrationResultUrl(
  integration: string,
  status: 'connected' | 'denied' | 'error',
): string {
  return `${frontendOrigin()}/app/integrations?integration=${encodeURIComponent(integration)}&status=${encodeURIComponent(status)}`;
}
