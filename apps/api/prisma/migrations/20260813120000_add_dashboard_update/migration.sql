ALTER TABLE "Dashboard"
  ADD COLUMN "updatePath" TEXT,
  ADD COLUMN "warmupPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "updateFrequency" TEXT,
  ADD COLUMN "updateTimeOfDay" TEXT,
  ADD COLUMN "updateDayOfWeek" INTEGER,
  ADD COLUMN "updateDayOfMonth" INTEGER,
  ADD COLUMN "lastUpdateAt" TIMESTAMP(3),
  ADD COLUMN "lastUpdateStatus" TEXT;
