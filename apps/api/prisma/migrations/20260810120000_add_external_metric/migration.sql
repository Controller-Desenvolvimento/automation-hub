-- CreateTable
CREATE TABLE "ExternalMetric" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "sourceName" TEXT,
    "action" TEXT NOT NULL,
    "label" TEXT,
    "unitLabel" TEXT NOT NULL DEFAULT 'empresa',
    "userName" TEXT,
    "userEmail" TEXT,
    "department" TEXT,
    "unitsProcessed" INTEGER NOT NULL DEFAULT 1,
    "manualSecondsPerUnit" INTEGER NOT NULL DEFAULT 0,
    "manualEstimatedSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExternalMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalMetric_createdAt_idx" ON "ExternalMetric"("createdAt");

-- CreateIndex
CREATE INDEX "ExternalMetric_source_createdAt_idx" ON "ExternalMetric"("source", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalMetric_userEmail_createdAt_idx" ON "ExternalMetric"("userEmail", "createdAt");
