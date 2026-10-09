-- CreateTable
CREATE TABLE "SiteChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteChatMessage_userId_createdAt_idx" ON "SiteChatMessage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "SiteChatMessage" ADD CONSTRAINT "SiteChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
