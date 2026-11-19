-- CreateEnum
CREATE TYPE "SupportTicketType" AS ENUM ('problem', 'suggestion', 'question');

-- CreateEnum
CREATE TYPE "SupportSubject" AS ENUM ('hub', 'robot', 'dashboard', 'other');

-- CreateEnum
CREATE TYPE "SupportUrgency" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('open', 'review', 'waiting', 'resolved', 'not_issue');

-- CreateEnum
CREATE TYPE "SupportMessageKind" AS ENUM ('message', 'internal', 'system', 'system_admin');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "supportTicketId" TEXT;

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "type" "SupportTicketType" NOT NULL,
    "subject" "SupportSubject" NOT NULL,
    "urgency" "SupportUrgency" NOT NULL DEFAULT 'low',
    "status" "SupportStatus" NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "hubArea" TEXT,
    "robotId" TEXT,
    "dashboardId" TEXT,
    "executionId" TEXT,
    "contextJson" JSONB,
    "authorId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "mainTicketId" TEXT,
    "needsAdmin" BOOLEAN NOT NULL DEFAULT true,
    "authorUnread" BOOLEAN NOT NULL DEFAULT false,
    "authorConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "attachmentsCleanedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" "SupportMessageKind" NOT NULL DEFAULT 'message',
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "isImage" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_number_key" ON "SupportTicket"("number");

-- CreateIndex
CREATE INDEX "SupportTicket_authorId_updatedAt_idx" ON "SupportTicket"("authorId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_status_updatedAt_idx" ON "SupportTicket"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_mainTicketId_idx" ON "SupportTicket"("mainTicketId");

-- CreateIndex
CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportAttachment_messageId_idx" ON "SupportAttachment"("messageId");

-- CreateIndex
CREATE INDEX "Notification_supportTicketId_idx" ON "Notification"("supportTicketId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_supportTicketId_fkey" FOREIGN KEY ("supportTicketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_mainTicketId_fkey" FOREIGN KEY ("mainTicketId") REFERENCES "SupportTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAttachment" ADD CONSTRAINT "SupportAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
