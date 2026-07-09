-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner_admin', 'reviewer', 'coworker');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('dry_run', 'sandbox_post', 'live_post');

-- CreateEnum
CREATE TYPE "RolloutStage" AS ENUM ('dry_run', 'sandbox_manual', 'sandbox_auto', 'live_manual', 'live_auto');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'reviewer',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_changes" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qbo_credentials" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenExpires" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpires" TIMESTAMP(3),
    "scope" TEXT,
    "connectedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qbo_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_sync_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" "SyncMode" NOT NULL,
    "rolloutStage" "RolloutStage" NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "tabsScanned" TEXT[],
    "rowsScanned" INTEGER NOT NULL DEFAULT 0,
    "rowsPosted" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "rowsError" INTEGER NOT NULL DEFAULT 0,
    "rowsWarning" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "css_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_sheet_rows" (
    "id" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "sheetGid" TEXT,
    "tabName" TEXT NOT NULL,
    "rowNumberLastSeen" INTEGER NOT NULL,
    "rowUuid" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TIMESTAMP(3),
    "rcvByOrPaidTo" TEXT,
    "name" TEXT,
    "purpose" TEXT,
    "invNumber" TEXT,
    "backup" TEXT,
    "approvedBy" TEXT,
    "amtCollected" DECIMAL(14,2),
    "amountPaidOut" DECIMAL(14,2),
    "bankDeposit" DECIMAL(14,2),
    "cashBalanceEnvelope" DECIMAL(14,2),
    "amountType" TEXT,
    "normalizedFingerprint" TEXT NOT NULL,
    "originalHash" TEXT,
    "currentHash" TEXT,
    "originalSnapshotJson" JSONB,
    "currentSnapshotJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'New',
    "statusReason" TEXT,
    "removedFromSheetAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByEmail" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByEmail" TEXT,
    "qboTransactionId" TEXT,
    "qboTransactionType" TEXT,
    "qboAccountId" TEXT,
    "qboPostedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "css_sheet_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_row_events" (
    "id" TEXT NOT NULL,
    "sheetRowId" TEXT,
    "syncRunId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventMessage" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "diffJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "css_row_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_qbo_transactions" (
    "id" TEXT NOT NULL,
    "sheetRowId" TEXT,
    "syncRunId" TEXT,
    "qboCompanyId" TEXT NOT NULL,
    "qboEnvironment" TEXT NOT NULL,
    "qboTransactionId" TEXT NOT NULL,
    "qboTransactionType" TEXT NOT NULL,
    "qboSyncToken" TEXT,
    "qboDocNumber" TEXT,
    "requestJsonRedacted" JSONB,
    "responseJsonRedacted" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "css_qbo_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_purpose_mappings" (
    "id" TEXT NOT NULL,
    "purposePattern" TEXT NOT NULL,
    "normalizedPurpose" TEXT NOT NULL,
    "amountType" TEXT,
    "qboAction" TEXT NOT NULL,
    "qboAccountName" TEXT,
    "qboAccountId" TEXT,
    "postToQbo" BOOLEAN NOT NULL DEFAULT true,
    "auditOnly" BOOLEAN NOT NULL DEFAULT false,
    "requiresPayee" BOOLEAN NOT NULL DEFAULT false,
    "requiresManualApproval" BOOLEAN NOT NULL DEFAULT false,
    "invoiceMatching" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "css_purpose_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_account_mappings" (
    "id" TEXT NOT NULL,
    "friendlyName" TEXT NOT NULL,
    "qboAccountName" TEXT,
    "qboAccountId" TEXT,
    "qboAccountType" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "css_account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_payee_mappings" (
    "id" TEXT NOT NULL,
    "sheetNameValue" TEXT NOT NULL,
    "qboEntityType" TEXT,
    "qboEntityId" TEXT,
    "qboDisplayName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "css_payee_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "css_alerts" (
    "id" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "relatedSheetRowId" TEXT,
    "relatedSyncRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "css_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_provider_providerAccountId_key" ON "auth_accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_sessionToken_key" ON "auth_sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "auth_verification_tokens_token_key" ON "auth_verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "auth_verification_tokens_identifier_token_key" ON "auth_verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "config_key_key" ON "config"("key");

-- CreateIndex
CREATE INDEX "config_changes_key_idx" ON "config_changes"("key");

-- CreateIndex
CREATE UNIQUE INDEX "qbo_credentials_environment_realmId_key" ON "qbo_credentials"("environment", "realmId");

-- CreateIndex
CREATE INDEX "css_sync_runs_startedAt_idx" ON "css_sync_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "css_sheet_rows_qboTransactionId_key" ON "css_sheet_rows"("qboTransactionId");

-- CreateIndex
CREATE INDEX "css_sheet_rows_status_idx" ON "css_sheet_rows"("status");

-- CreateIndex
CREATE INDEX "css_sheet_rows_tabName_idx" ON "css_sheet_rows"("tabName");

-- CreateIndex
CREATE INDEX "css_sheet_rows_normalizedFingerprint_idx" ON "css_sheet_rows"("normalizedFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "css_sheet_rows_spreadsheetId_rowUuid_key" ON "css_sheet_rows"("spreadsheetId", "rowUuid");

-- CreateIndex
CREATE INDEX "css_row_events_sheetRowId_idx" ON "css_row_events"("sheetRowId");

-- CreateIndex
CREATE INDEX "css_row_events_eventType_idx" ON "css_row_events"("eventType");

-- CreateIndex
CREATE INDEX "css_qbo_transactions_sheetRowId_idx" ON "css_qbo_transactions"("sheetRowId");

-- CreateIndex
CREATE UNIQUE INDEX "css_qbo_transactions_qboEnvironment_qboCompanyId_qboTransac_key" ON "css_qbo_transactions"("qboEnvironment", "qboCompanyId", "qboTransactionId");

-- CreateIndex
CREATE INDEX "css_purpose_mappings_active_idx" ON "css_purpose_mappings"("active");

-- CreateIndex
CREATE UNIQUE INDEX "css_purpose_mappings_normalizedPurpose_key" ON "css_purpose_mappings"("normalizedPurpose");

-- CreateIndex
CREATE UNIQUE INDEX "css_account_mappings_friendlyName_key" ON "css_account_mappings"("friendlyName");

-- CreateIndex
CREATE UNIQUE INDEX "css_payee_mappings_sheetNameValue_key" ON "css_payee_mappings"("sheetNameValue");

-- CreateIndex
CREATE INDEX "css_alerts_alertType_idx" ON "css_alerts"("alertType");

-- CreateIndex
CREATE INDEX "css_alerts_status_idx" ON "css_alerts"("status");

-- AddForeignKey
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_changes" ADD CONSTRAINT "config_changes_configId_fkey" FOREIGN KEY ("configId") REFERENCES "config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_changes" ADD CONSTRAINT "config_changes_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_row_events" ADD CONSTRAINT "css_row_events_sheetRowId_fkey" FOREIGN KEY ("sheetRowId") REFERENCES "css_sheet_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_row_events" ADD CONSTRAINT "css_row_events_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "css_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_qbo_transactions" ADD CONSTRAINT "css_qbo_transactions_sheetRowId_fkey" FOREIGN KEY ("sheetRowId") REFERENCES "css_sheet_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_qbo_transactions" ADD CONSTRAINT "css_qbo_transactions_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "css_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_alerts" ADD CONSTRAINT "css_alerts_relatedSheetRowId_fkey" FOREIGN KEY ("relatedSheetRowId") REFERENCES "css_sheet_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "css_alerts" ADD CONSTRAINT "css_alerts_relatedSyncRunId_fkey" FOREIGN KEY ("relatedSyncRunId") REFERENCES "css_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

