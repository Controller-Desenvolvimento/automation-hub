-- AlterTable
-- Colunas novas e opcionais: a versao anterior do Hub simplesmente as ignora (compativel com o deploy sem reinicio imediato).
ALTER TABLE "Dashboard" ADD COLUMN "lastUpdateError" TEXT,
ADD COLUMN "updateRetryAt" TIMESTAMP(3);
