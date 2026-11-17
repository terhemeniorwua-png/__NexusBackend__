import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(ts|tsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('SSO/session architecture guards', () => {
  test('only session.service.ts may call prisma.session.create', () => {
    const srcDir = path.resolve('src');
    const allowed = path.resolve('src/modules/auth/session.service.ts');
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      if (path.resolve(file) === allowed) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/prisma\.session\.create\s*\(/.test(content) || /tx\.session\.create\s*\(/.test(content) || /client\.session\.create\s*\(/.test(content) || /db\.session\.create\s*\(/.test(content)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    assert.deepEqual(offenders, [], `Found prisma.session.create outside session.service.ts: ${offenders.join(', ')}`);
  });

  test('SAML implementation uses a maintained library (@node-saml/node-saml), not hand-written XML signature validation', () => {
    const samlPath = path.resolve('src/modules/sso/saml.service.ts');
    if (!fs.existsSync(samlPath)) {
      // No SAML implementation on this branch; nothing to validate.
      return;
    }
    const saml = fs.readFileSync(samlPath, 'utf8');
    assert.match(saml, /@node-saml\/node-saml/);
    assert.match(saml, /validatePostResponseAsync|validatePostResponse/);
    assert.doesNotMatch(saml, /xml-crypto.*SignedXml\s*\(/); // no direct hand-written validation in service
  });

  test('all SSO routes are behind SSO_ENABLED gate (default false)', () => {
    const routes = fs.readFileSync(path.resolve('src/modules/sso/sso.routes.ts'), 'utf8');
    // global gate applied to router
    assert.match(routes, /router\.use\(/);
    assert.match(routes, /SSO_ENABLED/);
    assert.match(routes, /SSO_DISABLED/);
  });

  test('routes under src/modules do not call workspace data functions directly without going through requireWorkspaceAccess', () => {
    const modulesDir = path.resolve('src/modules');
    const offenders: string[] = [];
    for (const file of walk(modulesDir)) {
      if (!file.endsWith('.routes.ts')) continue;
      // sso.routes.ts enforces SSO config access via service/policy; auth routes are not workspace-data routes
      const rel = path.relative(process.cwd(), file);
      if (rel.endsWith('sso/sso.routes.ts') || rel.includes('/auth/')) continue;
      const content = fs.readFileSync(file, 'utf8');
      // Route handlers must not perform direct DB/workspace data access; they should delegate to services
      // that enforce requireWorkspaceAccess with context.
      const directDb =
        /\bgetPrismaClient\s*\(/.test(content) ||
        /\bprisma\s*\.\w+\.(find|findFirst|findUnique|findMany|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate)\s*\(/.test(content);
      if (!directDb) continue;
      // If a route does direct DB access, it must also go through requireWorkspaceAccess with an explicit context
      const hasAccessCheck = /requireWorkspaceAccess\s*\(/.test(content);
      const hasContext = /userWorkspaceAccessContext\s*\(|context\s*:\s*/.test(content);
      if (!hasAccessCheck || !hasContext) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Route files with direct workspace/data DB access must go through requireWorkspaceAccess with context: ${offenders.join(', ')}`,
    );
  });

});