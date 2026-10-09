-- AlterTable
ALTER TABLE "Dashboard" ADD COLUMN "minRole" "UserRole" NOT NULL DEFAULT 'employee';
ALTER TABLE "Dashboard" ADD COLUMN "allowedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
