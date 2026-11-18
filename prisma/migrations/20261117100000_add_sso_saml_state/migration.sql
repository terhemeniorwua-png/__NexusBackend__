-- CreateTable
CREATE TABLE "SsoSamlRequestState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "configId" TEXT,
    "requestIdHash" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "browserBindingHash" TEXT NOT NULL,
    "relayState" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoSamlRequestState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoSamlRequestState_requestIdHash_key" ON "SsoSamlRequestState"("requestIdHash");

-- CreateIndex
CREATE INDEX "SsoSamlRequestState_workspaceId_expiresAt_idx" ON "SsoSamlRequestState"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "SsoSamlRequestState_expiresAt_idx" ON "SsoSamlRequestState"("expiresAt");

-- AddForeignKey
ALTER TABLE "SsoSamlRequestState" ADD CONSTRAINT "SsoSamlRequestState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoSamlRequestState" ADD CONSTRAINT "SsoSamlRequestState_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WorkspaceSsoConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
