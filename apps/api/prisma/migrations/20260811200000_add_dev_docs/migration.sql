CREATE TABLE "DevDoc" (
  "id"          TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "category"    TEXT NOT NULL,
  "summary"     TEXT NOT NULL,
  "howToUse"    TEXT NOT NULL,
  "codeExample" TEXT,
  "language"    TEXT,
  "endpoint"    TEXT,
  "tags"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "order"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevDoc_pkey" PRIMARY KEY ("id")
);
