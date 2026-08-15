const express = require('express');
const prisma = require('../db/prisma');
const { createScheduledCampaign, updateCampaignStatus, uploadCohort } = require('../services/sarvamScheduling');

const router = express.Router();

async function campaignForScheduling(campaignId) {
  return prisma.campaign.findUnique({ where: { id: campaignId }, include: { event: true } });
}

router.post('/:campaignId/sarvam/schedule', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.sarvamCampaignId) return res.status(409).json({ error: 'This campaign is already scheduled with Sarvam', sarvamCampaignId: campaign.sarvamCampaignId });
    if (!req.body.startTimestamp || !req.body.endTimestamp) return res.status(400).json({ error: 'startTimestamp and endTimestamp are required' });
    const sarvamCampaign = await createScheduledCampaign(campaign, req.body);
    const sarvamCampaignId = sarvamCampaign.id || sarvamCampaign.campaign_id;
    if (!sarvamCampaignId) return res.status(502).json({ error: 'Sarvam did not return a campaign ID', sarvamCampaign });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvamCampaignId } });
    return res.status(201).json({ sarvamCampaignId, sarvamCampaign });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/cohort', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId) return res.status(409).json({ error: 'Schedule the campaign with Sarvam before uploading a cohort' });
    const attendees = await prisma.attendee.findMany({ where: { eventId: campaign.eventId, optedIn: true, phone: { not: null }, status: { not: 'WAITLISTED' } } });
    if (!attendees.length) return res.status(400).json({ error: 'No opted-in attendees with phone numbers are available for upload' });
    const sarvamCohort = await uploadCohort(campaign.sarvamCampaignId, campaign.id, attendees, req.body.name || `${campaign.name} cohort`, req.body.cohortTransformation);
    return res.status(201).json({ uploadedAttendees: attendees.length, sarvamCohort });
  } catch (error) { return next(error); }
});

router.put('/:campaignId/sarvam/status', async (req, res, next) => {
  try {
    if (!['pause', 'resume'].includes(req.body.action)) return res.status(400).json({ error: 'action must be pause or resume' });
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId) return res.status(409).json({ error: 'Campaign is not scheduled with Sarvam' });
    const sarvamStatus = await updateCampaignStatus(campaign.sarvamCampaignId, req.body.action);
    return res.json({ sarvamStatus });
  } catch (error) { return next(error); }
});

module.exports = router;
