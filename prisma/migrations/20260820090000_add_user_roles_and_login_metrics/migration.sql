-- User-facing accounts start as regular users. ADMIN is assigned only by the
-- server-side ADMIN_EMAILS bootstrap allow-list.
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER',
  ADD COLUMN "loginCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

CREATE INDEX "User_role_createdAt_idx" ON "User"("role", "createdAt");
CREATE INDEX "User_lastLoginAt_idx" ON "User"("lastLoginAt");
