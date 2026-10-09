-- AlterTable
ALTER TABLE "Site" ADD COLUMN "linkedDashboardId" TEXT;

-- CreateIndex
CREATE INDEX "Site_linkedDashboardId_idx" ON "Site"("linkedDashboardId");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_linkedDashboardId_fkey" FOREIGN KEY ("linkedDashboardId") REFERENCES "Dashboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
