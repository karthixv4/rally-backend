-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'RELEASED', 'OFFERED');

-- CreateEnum
CREATE TYPE "SeatOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Campaign"
  ADD COLUMN "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "sessionSlotOptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Response"
  ADD COLUMN "dietaryRequirements" TEXT,
  ADD COLUMN "accessibilityNeeds" TEXT,
  ADD COLUMN "teamStatus" TEXT;

-- AlterTable
ALTER TABLE "FollowUp"
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "owner" TEXT,
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'follow_up',
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "attendeeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" "CallOutcome",
    "transcript" TEXT,
    "details" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attendeeId" TEXT,
    "seatNumber" INTEGER NOT NULL,
    "status" "SeatStatus" NOT NULL DEFAULT 'AVAILABLE',
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatOffer" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "attendeeId" TEXT NOT NULL,
    "status" "SeatOfferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "SeatOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallEvent_campaignId_occurredAt_idx" ON "CallEvent"("campaignId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_attendeeId_key" ON "Seat"("attendeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_eventId_seatNumber_key" ON "Seat"("eventId", "seatNumber");

-- CreateIndex
CREATE INDEX "Seat_eventId_status_idx" ON "Seat"("eventId", "status");

-- CreateIndex
CREATE INDEX "SeatOffer_campaignId_status_idx" ON "SeatOffer"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatOffer" ADD CONSTRAINT "SeatOffer_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeatOffer" ADD CONSTRAINT "SeatOffer_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeatOffer" ADD CONSTRAINT "SeatOffer_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
