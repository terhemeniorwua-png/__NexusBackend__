import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import crypto from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { validateSamlResponse } from '../src/modules/sso/saml.service';

function generateKeyPairPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // extract cert-like public key in PEM for xml-crypto/node-saml (node-saml accepts cert PEM without headers in some cases, but better provide x509; easier to use public key cert)
  // Create a self-signed cert for testing
  const cert = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'pem' }) as string;
  return { privateKey, publicKey, cert };
}

// For xml-crypto signing we need a key; node-saml validates against cert. We'll generate a self-signed cert.
function generateSelfSignedCert() {
  // Use openssl-like approach via node? Not directly. Easier: generate key pair and create minimal cert is complex in pure node.
  // Alternative: use @peculiar/x509 if available? probably not. 
  // Simpler: use xml-crypto with private key for signing and pass the certificate in PEM format that node-saml expects.
  // node-saml's cert option can be a PEM certificate. Let's create one with crypto.X509Certificate? Node 15+ has X509Certificate but creating is limited.
  // Fallback: sign with xml-crypto and configure node-saml to accept the signing cert by extracting from signature? No.
  // Better approach: use a fixed test certificate/key pair generated as strings.
  return null;
}

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Create a minimal self-signed certificate using node's X509Certificate is read-only; we'll construct PEM cert via forge-like? not available.
// Workaround: node-saml accepts the cert as the public key certificate body; we can try passing the public key PEM.
// Actually @node-saml/node-saml uses xml-crypto which can work with cert strings. Let's try with a generated cert using a simple method.
// We'll create cert with node:crypto's internal? No. Let's use a helper: create cert by spawning nothing - not available.
// Alternative: build test around xml-crypto validation directly? No, requirement says "use @node-saml/node-saml (or another maintained library). Do not hand-write XML signature validation."

// Generate a self-signed cert using a quick command if openssl exists, else use a static approach.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeTestCert(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-test-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -sha256 -days 1 -nodes -subj "/CN=TestIdP" 2>/dev/null`);
  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  return { key, cert };
}

const { key: IDP_KEY, cert: IDP_CERT } = makeTestCert();

function nowIso(offsetSec = 0) {
  return new Date(Date.now() + offsetSec * 1000).toISOString();
}

function buildSignedResponse(opts: {
  requestId?: string;
  audience?: string;
  issuer?: string;
  destination?: string;
  recipient?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  nameId?: string;
  email?: string;
  emailVerified?: string;
  sign?: boolean;
  tamper?: boolean;
  wrapSignature?: boolean;
  inResponseTo?: string | null;
}) {
  const id = '_' + crypto.randomBytes(8).toString('hex');
  const assertionId = '_' + crypto.randomBytes(8).toString('hex');
  const issueInstant = nowIso();
  const notBefore = opts.notBefore ?? nowIso(-60);
  const notOnOrAfter = opts.notOnOrAfter ?? nowIso(300);
  const destination = opts.destination ?? 'https://sp.example.com/saml/acs';
  const recipient = opts.recipient ?? destination;
  const audience = opts.audience ?? 'https://sp.example.com';
  const issuer = opts.issuer ?? 'https://idp.example.com';
  const inResponseToAttr = opts.inResponseTo === null ? '' : ` InResponseTo="${opts.inResponseTo ?? opts.requestId ?? '_req1'}"`;
  const nameId = opts.nameId ?? 'user@example.com';
  const email = opts.email ?? 'user@example.com';

  const assertion = `
    <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">
      <saml:Issuer>${issuer}</saml:Issuer>
      <saml:Subject>
        <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData${inResponseToAttr} NotOnOrAfter="${notOnOrAfter}" Recipient="${recipient}"/>
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
        <saml:AudienceRestriction>
          <saml:Audience>${audience}</saml:Audience>
        </saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AttributeStatement>
        <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
        ${opts.emailVerified !== undefined ? `<saml:Attribute Name="email_verified"><saml:AttributeValue>${opts.emailVerified}</saml:AttributeValue></saml:Attribute>` : ''}
      </saml:AttributeStatement>
    </saml:Assertion>`;

  let response = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${destination}"${inResponseToAttr}>
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  ${assertion}
</samlp:Response>`;

  if (opts.sign !== false) {
    const sig = new SignedXml({ privateKey: IDP_KEY, publicCert: IDP_CERT });
    sig.addReference({
      xpath: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`,
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    });
    sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    sig.computeSignature(response, { location: { reference: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`, action: 'prepend' } });
    response = sig.getSignedXml();
  }

  if (opts.tamper) {
    response = response.replace(email, 'attacker@evil.com');
  }

  if (opts.wrapSignature) {
    // Signature wrapping attempt: insert a second unsigned assertion with different identity before signed one
    const evilAssertionId = '_' + crypto.randomBytes(8).toString('hex');
    const evilAssertion = assertion.replace(assertionId, evilAssertionId).replace(nameId, 'attacker@evil.com').replace(email, 'attacker@evil.com');
    response = response.replace(/<saml:Assertion/, evilAssertion + '\n<saml:Assertion');
  }

  return Buffer.from(response).toString('base64');
}

const baseConfig = {
  issuer: 'https://sp.example.com',
  callbackUrl: 'https://sp.example.com/saml/acs',
  idpIssuer: 'https://idp.example.com',
  idpCert: IDP_CERT,
  wantAssertionsSigned: true,
  validateInResponseTo: 'never' as const, // library cache not used in test; InResponseTo enforced separately in app state layer
  requestId: '_req1',
  audience: 'https://sp.example.com',
};

describe('SAML SSO validation (@node-saml/node-saml)', () => {
  test('rejects unsigned assertion', async () => {
    const saml = buildSignedResponse({ requestId: '_req1', sign: false });
    await assert.rejects(() => validateSamlResponse({ samlResponseXmlOrBase64: saml, config: baseConfig as any }));
  });

  test('rejects tampered signed assertion', async () => {
    const saml = buildSignedResponse({ requestId: '_req1', tamper: true });
    await assert.rejects(() => validateSamlResponse({ samlResponseXmlOrBase64: saml, config: baseConfig as any }));
  });

  test('rejects wrong audience', async () => {
    const saml = buildSignedResponse({ requestId: '_req1', audience: 'https://wrong-sp.example.com' });
    await assert.rejects(() => validateSamlResponse({ samlResponseXmlOrBase64: saml, config: baseConfig as any }));
  });

  test('rejects invalid InResponseTo (replay/unknown request) via state consumption', async () => {
    const { consumeSamlRequestState } = await import('../src/modules/sso/saml.service');
    // missing/unknown request id in state store => rejected (fail closed / replay protection)
    const db = { ssoSamlRequestState: { findUnique: async () => null } } as any;
    await assert.rejects(
      () => consumeSamlRequestState({ requestId: '_other', browserBindingValue: 'b' }, db),
      (err: any) => err?.code === 'SSO_SAML_INRESPONSETO_INVALID',
    );
  });

  test('rejects signature-wrapping sample', async () => {
    const saml = buildSignedResponse({ requestId: '_req1', wrapSignature: true });
    await assert.rejects(() => validateSamlResponse({ samlResponseXmlOrBase64: saml, config: baseConfig as any }));
  });
});
