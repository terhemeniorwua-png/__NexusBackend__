CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'NON_RENEWING', 'CANCELLED', 'ATTENTION');
CREATE TYPE "SubscriptionPlanId" AS ENUM ('PRO', 'BUSINESS');
CREATE TYPE "SubscriptionInterval" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "BillingCheckoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "plan" "SubscriptionPlanId" NOT NULL,
  "interval" "SubscriptionInterval" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "billableSeats" INTEGER NOT NULL,
  "providerCustomerCode" TEXT,
  "providerSubscriptionCode" TEXT,
  "providerManageTokenCiphertext" TEXT,
  "pendingSubscriptionCode" TEXT,
  "pendingManageTokenCiphertext" TEXT,
  "pendingPlan" "SubscriptionPlanId",
  "pendingInterval" "SubscriptionInterval",
  "pendingBillableSeats" INTEGER,
  "pendingEffectiveAt" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaystackPlan" (
  "id" TEXT NOT NULL,
  "plan" "SubscriptionPlanId" NOT NULL,
  "interval" "SubscriptionInterval" NOT NULL,
  "billableSeats" INTEGER NOT NULL,
  "amountSubunit" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "providerPlanCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaystackPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingCheckout" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "plan" "SubscriptionPlanId" NOT NULL,
  "interval" "SubscriptionInterval" NOT NULL,
  "billableSeats" INTEGER NOT NULL,
  "amountSubunit" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "BillingCheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "checkoutUrl" TEXT NOT NULL,
  "providerCustomerCode" TEXT,
  "providerPlanCode" TEXT,
  "providerSubscriptionCode" TEXT,
  "providerManageTokenCiphertext" TEXT,
  "providerAuthorizationReusable" BOOLEAN,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCheckout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingPayment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "checkoutId" TEXT,
  "providerReference" TEXT NOT NULL,
  "providerEventKey" TEXT,
  "amountSubunit" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3),
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingWebhookEvent" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingSeatSync" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "requestedSeats" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "providerSubscriptionCode" TEXT,
  "providerManageTokenCiphertext" TEXT,
  "previousSubscriptionCode" TEXT,
  "previousManageTokenCiphertext" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingSeatSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");
CREATE UNIQUE INDEX "Subscription_providerSubscriptionCode_key" ON "Subscription"("providerSubscriptionCode");
CREATE UNIQUE INDEX "Subscription_pendingSubscriptionCode_key" ON "Subscription"("pendingSubscriptionCode");
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");
CREATE UNIQUE INDEX "PaystackPlan_providerPlanCode_key" ON "PaystackPlan"("providerPlanCode");
CREATE UNIQUE INDEX "PaystackPlan_plan_interval_billableSeats_key" ON "PaystackPlan"("plan", "interval", "billableSeats");
CREATE UNIQUE INDEX "BillingCheckout_reference_key" ON "BillingCheckout"("reference");
CREATE INDEX "BillingCheckout_workspaceId_createdAt_idx" ON "BillingCheckout"("workspaceId", "createdAt");
CREATE INDEX "BillingCheckout_status_createdAt_idx" ON "BillingCheckout"("status", "createdAt");
CREATE UNIQUE INDEX "BillingPayment_providerReference_key" ON "BillingPayment"("providerReference");
CREATE UNIQUE INDEX "BillingPayment_providerEventKey_key" ON "BillingPayment"("providerEventKey");
CREATE INDEX "BillingPayment_workspaceId_createdAt_idx" ON "BillingPayment"("workspaceId", "createdAt");
CREATE INDEX "BillingPayment_subscriptionId_createdAt_idx" ON "BillingPayment"("subscriptionId", "createdAt");
CREATE UNIQUE INDEX "BillingWebhookEvent_eventKey_key" ON "BillingWebhookEvent"("eventKey");
CREATE UNIQUE INDEX "BillingSeatSync_workspaceId_key" ON "BillingSeatSync"("workspaceId");
CREATE INDEX "BillingSeatSync_status_nextAttemptAt_idx" ON "BillingSeatSync"("status", "nextAttemptAt");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "BillingCheckout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingSeatSync" ADD CONSTRAINT "BillingSeatSync_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
