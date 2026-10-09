-- AlterTable
ALTER TABLE "SiteChatMessage" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'hub';

-- CreateIndex
CREATE INDEX "SiteChatMessage_userId_scope_createdAt_idx" ON "SiteChatMessage"("userId", "scope", "createdAt");
