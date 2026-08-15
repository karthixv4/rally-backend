-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "sarvamCampaignId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_sarvamCampaignId_key" ON "Campaign"("sarvamCampaignId");
