CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "QueryExample" (
    "id" SERIAL NOT NULL,
    "question" TEXT NOT NULL,
    "sqlQuery" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(512),

    CONSTRAINT "QueryExample_pkey" PRIMARY KEY ("id")
);
