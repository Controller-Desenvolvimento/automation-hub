CREATE TABLE "RobotFavorite" (
    "userId" TEXT NOT NULL,
    "robotId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RobotFavorite_pkey" PRIMARY KEY ("userId", "robotId")
);

CREATE INDEX "RobotFavorite_robotId_idx" ON "RobotFavorite"("robotId");

ALTER TABLE "RobotFavorite"
ADD CONSTRAINT "RobotFavorite_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RobotFavorite"
ADD CONSTRAINT "RobotFavorite_robotId_fkey"
FOREIGN KEY ("robotId") REFERENCES "Robot"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
