ALTER TABLE "Dashboard" ADD COLUMN "updateTimesOfDay" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "Dashboard"
SET "updateTimesOfDay" = ARRAY["updateTimeOfDay"]
WHERE "updateTimeOfDay" IS NOT NULL;

ALTER TABLE "Dashboard" DROP COLUMN "updateTimeOfDay";
