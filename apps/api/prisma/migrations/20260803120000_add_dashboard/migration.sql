-- CreateEnum
CREATE TYPE "DashboardType" AS ENUM ('html', 'streamlit');

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "DashboardType" NOT NULL DEFAULT 'html',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "allowedDepartments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mainFile" TEXT NOT NULL DEFAULT 'index.html',
    "streamlitPort" INTEGER,
    "streamlitStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dashboard_slug_key" ON "Dashboard"("slug");

-- CreateIndex
CREATE INDEX "Dashboard_slug_idx" ON "Dashboard"("slug");
