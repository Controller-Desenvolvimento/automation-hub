-- AlterTable
-- Colunas novas, opcionais ou com valor padrao: a versao anterior do Hub as ignora (compativel com o deploy).
ALTER TABLE "ScheduledTask" ADD COLUMN "verifyT0Minutes" INTEGER,
ADD COLUMN "verifyT1Minutes" INTEGER,
ADD COLUMN "verifyT2Minutes" INTEGER;

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "restartOfId" TEXT,
ADD COLUMN "checkStage" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Execution_restartOfId_idx" ON "Execution"("restartOfId");
