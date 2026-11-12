-- AlterTable
-- Colunas novas, opcionais ou com valor padrao: a versao anterior do Hub as ignora (compativel com o deploy).
ALTER TABLE "ScheduledTask" ADD COLUMN "maxRuntimeMinutes" INTEGER,
ADD COLUMN "dependsOnTaskId" TEXT;

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN "waitingOnExecutionId" TEXT,
ADD COLUMN "dependencyNotified" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ScheduledTask_dependsOnTaskId_idx" ON "ScheduledTask"("dependsOnTaskId");

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
