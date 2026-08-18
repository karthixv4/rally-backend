-- Track delivery of automatic waitlist-recovery calls. The seat and offer
-- records already exist; these fields let Rally retry or surface a failed
-- outbound call without allocating the same seat twice.
ALTER TABLE "SeatOffer"
  ADD COLUMN "callRequestedAt" TIMESTAMP(3),
  ADD COLUMN "sarvamOutboundId" TEXT,
  ADD COLUMN "callFailureReason" TEXT;

CREATE INDEX "SeatOffer_campaignId_status_expiresAt_idx"
  ON "SeatOffer"("campaignId", "status", "expiresAt");
