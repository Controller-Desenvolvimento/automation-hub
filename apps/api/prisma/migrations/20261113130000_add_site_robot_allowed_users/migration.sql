-- AlterTable
ALTER TABLE "Robot" ADD COLUMN "allowedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Site" ADD COLUMN "allowedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
