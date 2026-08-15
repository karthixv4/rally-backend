const express = require('express');
const prisma = require('../db/prisma');
const { createScheduledCampaign, updateCampaignStatus, uploadCohort, triggerImmediateCall } = require('../services/sarvamScheduling');

const router = express.Router();

async function campaignForScheduling(campaignId) {
  return prisma.campaign.findUnique({ where: { id: campaignId }, include: { event: true } });
}

router.get('/:campaignId/sarvam/execution-status', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const [attendees, callEvents] = await Promise.all([
      prisma.attendee.findMany({ where: { eventId: campaign.eventId }, select: { id: true, phone: true, optedIn: true, status: true } }),
      prisma.callEvent.findMany({ where: { campaignId: campaign.id }, orderBy: { occurredAt: 'desc' }, take: 10, include: { attendee: { select: { name: true } } } })
    ]);
    const demoRecipientEnabled = process.env.SARVAM_FORCE_DEMO_RECIPIENT === 'true';
    const eligible = attendees.filter((attendee) => attendee.optedIn && !['WAITLISTED', 'RELEASED'].includes(attendee.status) && (demoRecipientEnabled || Boolean(attendee.phone)));
    const count = (predicate) => attendees.filter(predicate).length;
    const callsRequested = callEvents.filter((event) => event.eventType === 'call_triggered').length;
    const callResultsReceived = callEvents.filter((event) => event.eventType === 'call_completed').length;
    const hasSarvamSchedule = Boolean(campaign.sarvamCampaignId);
    const schedulerState = hasSarvamSchedule
      ? campaign.state === 'PAUSED' ? 'paused' : 'scheduled'
      : campaign.state === 'PAUSED' ? 'paused_before_launch' : 'not_started';
    return res.json({
      execution: {
        schedulerState,
        hasSarvamSchedule,
        sarvamCampaignId: campaign.sarvamCampaignId,
        demoRecipientEnabled,
        attendees: {
          total: attendees.length,
          eligible: eligible.length,
          notOptedIn: count((attendee) => !attendee.optedIn),
          waitlistedOrReleased: count((attendee) => ['WAITLISTED', 'RELEASED'].includes(attendee.status)),
          missingPhone: demoRecipientEnabled ? 0 : count((attendee) => attendee.optedIn && !attendee.phone)
        },
        callsRequested,
        callResultsReceived,
        latestActivity: callEvents[0] ? { eventType: callEvents[0].eventType, occurredAt: callEvents[0].occurredAt, attendeeName: callEvents[0].attendee?.name || null } : null
      }
    });
  } catch (error) { return next(error); }
});

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
    const useDemoRecipient = process.env.SARVAM_FORCE_DEMO_RECIPIENT === 'true';
    const attendees = await prisma.attendee.findMany({ where: { eventId: campaign.eventId, optedIn: true, ...(useDemoRecipient ? {} : { phone: { not: null } }), status: { not: 'WAITLISTED' } } });
    if (!attendees.length) return res.status(400).json({ error: 'No eligible opted-in attendees are available for upload' });
    const sarvamCohort = await uploadCohort(campaign.sarvamCampaignId, attendees, req.body.name || `${campaign.name} cohort`, req.body.cohortTransformation);
    return res.status(201).json({ uploadedAttendees: attendees.length, sarvamCohort });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/launch', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId && (!req.body.startTimestamp || !req.body.endTimestamp)) {
      return res.status(400).json({ error: 'startTimestamp and endTimestamp are required for the first launch' });
    }

    let sarvamCampaignId = campaign.sarvamCampaignId;
    let sarvamCampaign = null;
    if (!sarvamCampaignId) {
      sarvamCampaign = await createScheduledCampaign(campaign, req.body);
      sarvamCampaignId = sarvamCampaign.id || sarvamCampaign.campaign_id;
      if (!sarvamCampaignId) return res.status(502).json({ error: 'Sarvam did not return a campaign ID', sarvamCampaign });
      await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvamCampaignId } });
    }

    const useDemoRecipient = process.env.SARVAM_FORCE_DEMO_RECIPIENT === 'true';
    const attendees = await prisma.attendee.findMany({
      where: { eventId: campaign.eventId, optedIn: true, ...(useDemoRecipient ? {} : { phone: { not: null } }), status: { not: 'WAITLISTED' } }
    });
    if (!attendees.length) return res.status(400).json({ error: 'No eligible opted-in attendees are available for launch' });
    const sarvamCohort = await uploadCohort(sarvamCampaignId, attendees, req.body.cohortName || `${campaign.name} cohort`);
    const launchedCampaign = await prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'ACTIVE' } });
    return res.status(201).json({ campaign: launchedCampaign, sarvamCampaignId, sarvamCampaign, sarvamCohort, uploadedAttendees: attendees.length });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/call-now', async (req, res, next) => {
  try {
    if (process.env.SARVAM_ENABLE_ADMIN_CALL_NOW !== 'true') return res.status(404).json({ error: 'Admin test calls are disabled' });
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const attendee = await prisma.attendee.findFirst({
      where: {
        eventId: campaign.eventId,
        optedIn: true,
        status: { notIn: ['WAITLISTED', 'RELEASED'] },
        ...(req.body.attendeeId ? { id: req.body.attendeeId } : {})
      },
      orderBy: { createdAt: 'asc' }
    });
    if (!attendee) return res.status(400).json({ error: 'Select an eligible opted-in attendee before placing a call' });
    const sarvamOutbound = await triggerImmediateCall(campaign, attendee);
    const activity = await prisma.callEvent.create({
      data: {
        eventId: campaign.eventId,
        campaignId: campaign.id,
        attendeeId: attendee.id,
        eventType: 'call_triggered',
        details: { mode: 'immediate_outbound', sarvamOutboundId: sarvamOutbound.attempt_id || sarvamOutbound.id || sarvamOutbound.outbound_id || null }
      }
    });
    return res.status(201).json({ message: 'Immediate call requested', attendee: { id: attendee.id, name: attendee.name }, sarvamOutbound, activity });
  } catch (error) { return next(error); }
});

router.put('/:campaignId/sarvam/status', async (req, res, next) => {
  try {
    if (!['pause', 'resume'].includes(req.body.action)) return res.status(400).json({ error: 'action must be pause or resume' });
    const campaign = await campaignForScheduling(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const isScheduled = Boolean(campaign.sarvamCampaignId);
    const sarvamStatus = isScheduled ? await updateCampaignStatus(campaign.sarvamCampaignId, req.body.action) : null;
    const nextState = req.body.action === 'pause' ? 'PAUSED' : isScheduled ? 'ACTIVE' : 'DRAFT';
    const updatedCampaign = await prisma.campaign.update({ where: { id: campaign.id }, data: { state: nextState }, include: { event: true } });
    return res.json({
      sarvamStatus,
      campaign: updatedCampaign,
      message: isScheduled
        ? `Campaign ${req.body.action === 'pause' ? 'paused' : 'resumed'} in Sarvam`
        : req.body.action === 'pause'
          ? 'Campaign paused locally; no Sarvam schedule exists yet'
          : 'Campaign is ready to launch; no Sarvam schedule exists yet'
    });
  } catch (error) { return next(error); }
});

module.exports = router;
