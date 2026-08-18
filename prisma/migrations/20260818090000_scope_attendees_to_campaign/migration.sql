-- Audiences are campaign-specific. Legacy event-level attendees are assigned to the
-- earliest campaign in their event. Orphaned legacy attendee rows are preserved but
-- excluded from every campaign until an organiser imports an audience.
ALTER TABLE "Attendee" ADD COLUMN "campaignId" TEXT;

UPDATE "Attendee" AS attendee
SET "campaignId" = (
  SELECT campaign."id"
  FROM "Campaign"
  AS campaign
  WHERE campaign."eventId" = attendee."eventId"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
WHERE attendee."campaignId" IS NULL;

ALTER TABLE "Attendee" ADD CONSTRAINT "Attendee_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Attendee_campaignId_status_idx" ON "Attendee"("campaignId", "status");
