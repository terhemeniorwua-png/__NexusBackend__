-- CreateEnum
CREATE TYPE "SsoProviderType" AS ENUM ('OIDC', 'SAML');

-- CreateEnum
CREATE TYPE "SsoConfigStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "WorkspaceSsoConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerType" "SsoProviderType" NOT NULL,
    "providerName" TEXT NOT NULL,
    "issuer" TEXT,
    "clientId" TEXT,
    "clientSecretCiphertext" TEXT,
    "metadataUrl" TEXT,
    "certificate" TEXT,
    "authorizationUrl" TEXT,
    "tokenUrl" TEXT,
    "userInfoUrl" TEXT,
    "redirectUri" TEXT,
    "config" JSONB,
    "status" "SsoConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requireSso" BOOLEAN NOT NULL DEFAULT false,
    "jitProvisioningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakGlassEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakGlassCodeHashes" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSsoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceSsoDomain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "configId" TEXT,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "txtRecordName" TEXT NOT NULL DEFAULT '_nexus-sso-verification',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSsoDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoOidcState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "configId" TEXT,
    "stateHash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "browserBindingHash" TEXT NOT NULL,
    "redirectUri" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoOidcState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceSsoConfig_workspaceId_isEnabled_idx" ON "WorkspaceSsoConfig"("workspaceId", "isEnabled");

-- CreateIndex
CREATE INDEX "WorkspaceSsoConfig_workspaceId_requireSso_idx" ON "WorkspaceSsoConfig"("workspaceId", "requireSso");

-- CreateIndex
CREATE INDEX "WorkspaceSsoConfig_providerType_idx" ON "WorkspaceSsoConfig"("providerType");

-- CreateIndex
CREATE INDEX "WorkspaceSsoDomain_domain_idx" ON "WorkspaceSsoDomain"("domain");

-- CreateIndex
CREATE INDEX "WorkspaceSsoDomain_workspaceId_verifiedAt_idx" ON "WorkspaceSsoDomain"("workspaceId", "verifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSsoDomain_workspaceId_domain_key" ON "WorkspaceSsoDomain"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "SsoOidcState_stateHash_key" ON "SsoOidcState"("stateHash");

-- CreateIndex
CREATE INDEX "SsoOidcState_workspaceId_expiresAt_idx" ON "SsoOidcState"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "SsoOidcState_expiresAt_idx" ON "SsoOidcState"("expiresAt");

-- AddForeignKey
ALTER TABLE "WorkspaceSsoConfig" ADD CONSTRAINT "WorkspaceSsoConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSsoConfig" ADD CONSTRAINT "WorkspaceSsoConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSsoDomain" ADD CONSTRAINT "WorkspaceSsoDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSsoDomain" ADD CONSTRAINT "WorkspaceSsoDomain_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WorkspaceSsoConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoOidcState" ADD CONSTRAINT "SsoOidcState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoOidcState" ADD CONSTRAINT "SsoOidcState_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WorkspaceSsoConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
