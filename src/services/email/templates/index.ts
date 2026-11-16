import type { AppConfig } from '../../../config/env';
import type { EmailBrand } from './layout';

/**
 * Builds the brand used by every template from the application configuration,
 * so the sender name, the support address and the public URL stay in one
 * place.
 */
export function buildEmailBrand(config: AppConfig): EmailBrand {
  return {
    appName: config.emailFromName || config.appName,
    supportAddress: config.emailSupportAddress || undefined,
    appUrl: config.emailAppUrl || undefined,
  };
}

export * from './layout';
export * from './account';
export * from './collaboration';
export * from './workspace';
export * from './billing';
