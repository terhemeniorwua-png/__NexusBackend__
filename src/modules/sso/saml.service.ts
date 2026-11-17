import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { SAML, ValidateInResponseTo, type SamlConfig } from '@node-saml/node-saml';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import {
  assertVerifiedIdpEmail,
  isEmailDomainAllowed,
  getVerifiedDomainsForWorkspace,
  resolveSsoUser,
} from './oidc.service';

export const SSO_SAML_BINDING_COOKIE = 'nexus_sso_saml_binding';

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface CreateSamlRequestStateInput {
  workspaceId: string;
  configId?: string | null;
  requestId: string;
  browserBindingValue: string;
  relayState?: string | null;
  ttlMs?: number;
}

export async function createSamlRequestState(
  input: CreateSamlRequestStateInput,
  db = getPrismaClient(),
): Promise<void> {
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    await db.ssoSamlRequestState.create({
      data: {
        workspaceId: input.workspaceId,
        configId: input.configId ?? null,
        requestId: input.requestId,
        requestIdHash: hashValue(input.requestId),
        browserBindingHash: hashValue(input.browserBindingValue),
        relayState: input.relayState ?? null,
        expiresAt,
      },
    });
  } catch {
    throw new AppError(503, 'SSO_STATE_STORE_UNAVAILABLE', 'SSO state store is unavailable');
  }
}

export async function consumeSamlRequestState(
  input: { requestId: string; browserBindingValue: string; workspaceId?: string },
  db = getPrismaClient(),
): Promise<{ workspaceId: string; configId: string | null; relayState: string | null }> {
  const requestIdHash = hashValue(input.requestId);
  const browserBindingHash = hashValue(input.browserBindingValue);
  try {
    const record = await db.ssoSamlRequestState.findUnique({ where: { requestIdHash } });
    if (!record) {
      throw new AppError(400, 'SSO_SAML_INRESPONSETO_INVALID', 'SAML InResponseTo is invalid or expired');
    }
    if (record.consumedAt) {
      throw new AppError(400, 'SSO_SAML_REPLAYED', 'SAML response has already been used');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'SSO_SAML_REQUEST_EXPIRED', 'SAML request has expired');
    }
    if (record.browserBindingHash !== browserBindingHash) {
      throw new AppError(400, 'SSO_SAML_STATE_INVALID', 'SAML browser binding mismatch');
    }
    if (input.workspaceId && record.workspaceId !== input.workspaceId) {
      throw new AppError(400, 'SSO_SAML_STATE_INVALID', 'SAML request workspace mismatch');
    }
    if (record.requestId !== input.requestId) {
      throw new AppError(400, 'SSO_SAML_INRESPONSETO_INVALID', 'SAML InResponseTo mismatch');
    }
    const updated = await db.ssoSamlRequestState.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new AppError(400, 'SSO_SAML_REPLAYED', 'SAML response has already been used');
    }
    return { workspaceId: record.workspaceId, configId: record.configId, relayState: record.relayState };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'SSO_STATE_STORE_UNAVAILABLE', 'SSO state store is unavailable');
  }
}

export interface SamlValidationConfig {
  entryPoint?: string;
  issuer: string; // SP entity ID / audience
  callbackUrl: string; // ACS/destination
  idpIssuer: string; // expected IdP issuer
  idpCert: string; // pinned IdP signing certificate from admin metadata
  wantAssertionsSigned?: boolean;
  wantAuthnResponseSigned?: boolean;
  validateInResponseTo: ValidateInResponseTo;
  requestId?: string;
  audience?: string;
}

export function createSamlValidator(config: SamlValidationConfig): SAML {
  const samlConfig: SamlConfig = {
    entryPoint: config.entryPoint ?? 'https://idp.invalid/sso',
    issuer: config.issuer,
    callbackUrl: config.callbackUrl,
    idpIssuer: config.idpIssuer,
    idpCert: config.idpCert,
    audience: config.audience ?? config.issuer,
    wantAssertionsSigned: config.wantAssertionsSigned ?? true,
    wantAuthnResponseSigned: config.wantAuthnResponseSigned ?? false,
    validateInResponseTo: config.validateInResponseTo,
    ...(config.requestId ? { requestIdExpirationPeriodMs: 10 * 60 * 1000 } : {}),
    // @node-saml/node-saml validates conditions (NotBefore/NotOnOrAfter), audience, destination/recipient (callbackUrl),
    // issuer (idpIssuer), InResponseTo when configured, and signatures via xml-crypto (no hand-written validation).
    acceptedClockSkewMs: 60_000,
  } as SamlConfig;
  return new SAML(samlConfig);
}



export async function generateSamlAuthorizeRedirect(input: {
  config: SamlValidationConfig;
  relayState?: string | null;
}): Promise<{ redirectUrl: string; requestId: string }> {
  const saml = createSamlValidator(input.config);
  const requestXml = await (saml as any).generateAuthorizeRequestAsync(false);
  const m = String(requestXml).match(/\bID=(["'])([^"']+)\1/);
  if (!m?.[2]) {
    throw new AppError(500, 'SSO_SAML_REQUEST_INVALID', 'Failed to generate SAML AuthnRequest');
  }
  const requestId = m[2];
  const samlRequest = zlib.deflateRawSync(Buffer.from(String(requestXml))).toString('base64');
  const base = input.config.entryPoint;
  if (!base) throw new AppError(400, 'SSO_CONFIG_INVALID', 'SAML IdP SSO URL is not configured');
  const url = new URL(base);
  url.searchParams.set('SAMLRequest', samlRequest);
  if (input.relayState) url.searchParams.set('RelayState', input.relayState);
  // If SP signing is configured in future, SigAlg/Signature would be added; node-saml handles when options set.
  return { redirectUrl: url.toString(), requestId };
}

export function extractInResponseToFromSamlResponse(samlResponseBase64: string): string | undefined {
  try {
    const xml = Buffer.from(samlResponseBase64, 'base64').toString('utf8');
    // Match Response-level InResponseTo first (common); fallback to any InResponseTo.
    const resp = xml.match(/<(?:\w+:)?Response\b[^>]*\bInResponseTo=(["'])([^"']+)\1/);
    if (resp?.[2]) return resp[2];
    const any = xml.match(/\bInResponseTo=(["'])([^"']+)\1/);
    return any?.[2];
  } catch {
    return undefined;
  }
}

export async function validateSamlResponse(input: {
  samlResponseXmlOrBase64: string;
  config: SamlValidationConfig;
}): Promise<{ profile: Record<string, unknown>; loggedOut: boolean }> {
  const saml = createSamlValidator(input.config);
  const body = { SAMLResponse: input.samlResponseXmlOrBase64 };
  const result = await saml.validatePostResponseAsync(body);
  if (!result.profile) {
    throw new AppError(401, 'SSO_SAML_INVALID_ASSERTION', 'SAML assertion is invalid');
  }
  return { profile: result.profile as Record<string, unknown>, loggedOut: Boolean(result.loggedOut) };
}

export function extractSamlEmailAndName(profile: Record<string, unknown>): { email?: string; emailVerified?: boolean; name?: string; nameId?: string } {
  const nameId = typeof profile.nameID === 'string' ? profile.nameID : (typeof profile.nameID === 'object' && profile.nameID && 'value' in (profile.nameID as any) ? String((profile.nameID as any).value) : undefined);
  // Common attribute names
  const email =
    (typeof profile.email === 'string' && profile.email) ||
    (typeof profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] === 'string' && profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']) ||
    (typeof profile.mail === 'string' && profile.mail) ||
    (nameId && nameId.includes('@') ? nameId : undefined);
  const name =
    (typeof profile.displayName === 'string' && profile.displayName) ||
    (typeof profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] === 'string' && profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']) ||
    undefined;
  // SAML doesn't have a universal email_verified claim; for SAML we treat assertion from trusted/pinned IdP+verified domain as verified email source
  // when admin explicitly configures it. For strict "verified email from IdP" parity with OIDC, require explicit attribute/flag.
  const emailVerified =
    profile.email_verified === true ||
    profile.emailVerified === true ||
    profile['http://schemas.auth0.com/email_verified'] === true ||
    profile['http://schemas.auth0.com/email_verified'] === 'true';
  return { email: email ? String(email).toLowerCase() : undefined, emailVerified, name, nameId };
}

export async function resolveSamlUser(input: {
  workspaceId: string;
  configId: string;
  email: string;
  emailVerifiedByIdp: boolean;
  sub: string;
  name?: string | null;
}, db = getPrismaClient()) {
  const config = await db.workspaceSsoConfig.findFirst({ where: { id: input.configId, workspaceId: input.workspaceId, providerType: 'SAML' } });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SAML configuration not found');
  const verifiedDomains = await getVerifiedDomainsForWorkspace(input.workspaceId, db);
  const domainVerified = isEmailDomainAllowed(input.email, verifiedDomains);
  return resolveSsoUser({
    workspaceId: input.workspaceId,
    email: input.email,
    emailVerifiedByIdp: input.emailVerifiedByIdp,
    jitEnabled: config.jitProvisioningEnabled,
    domainVerified,
    sub: input.sub,
    provider: `saml:${config.providerName}`,
    name: input.name ?? null,
  }, db);
}
