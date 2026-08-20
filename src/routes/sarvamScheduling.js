const express = require('express');
const prisma = require('../db/prisma');
const { createScheduledCampaign, defaultAllowedSchedule, getCampaignStatus, updateCampaignStatus, uploadCohort } = require('../services/sarvamScheduling');
const { getTranscript, listAttempts } = require('../services/sarvamAnalytics');
const { completeCampaignWhenSettled } = require('../services/campaignCompletion');

const router = express.Router();

async function campaignForScheduling(campaignId, userId) {
  return prisma.campaign.findFirst({ where: { id: campaignId, event: { userId } }, include: { event: true } });
}

router.param('campaignId', async (req, res, next, campaignId) => {
  try {
    const campaign = await campaignForScheduling(campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    req.authorizedCampaign = campaign;
    return next();
  } catch (error) { return next(error); }
});

async function callableAttendeeReport(campaignId) {
  const attendees = await prisma.attendee.findMany({
    where: { campaignId },
    select: { id: true, name: true, phone: true, optedIn: true, status: true }
  });
  // The bulk run is the primary invitation cohort only. Waitlisted people are
  // contacted by the recovery outbound only after Rally has assigned them a
  // released seat; confirmations and completed results must never be re-dialled.
  const callable = attendees.filter((attendee) => attendee.optedIn && attendee.phone && attendee.status === 'INVITED');
  return {
    attendees: callable,
    readiness: {
      total: attendees.length,
      callable: callable.length,
      notOptedIn: attendees.filter((attendee) => !attendee.optedIn).length,
      waitlistedOrReleased: attendees.filter((attendee) => ['WAITLISTED', 'RELEASED', 'OFFERED'].includes(attendee.status)).length,
      missingPhone: attendees.filter((attendee) => attendee.optedIn && !attendee.phone).length
    }
  };
}

function noCallableAttendees(res, readiness) {
  return res.status(400).json({
    error: 'No callable attendees were found. Import at least one attendee with optedIn set to TRUE, a phone number, and an INVITED status.',
    attendeeReadiness: readiness
  });
}

const terminalSarvamStatuses = new Set(['ended', 'cancelled']);
const isTerminalSarvamStatus = (status) => terminalSarvamStatuses.has(String(status || '').toLowerCase());

function safeSarvamCampaign(campaign) {
  if (!campaign) return null;
  return {
    id: campaign.campaign_id || campaign.id,
    name: campaign.name,
    status: campaign.status,
    startTimestamp: campaign.start_timestamp,
    endTimestamp: campaign.end_timestamp,
    allowedSchedule: campaign.allowed_schedule,
    updatedAt: campaign.updated_at
  };
}

function allowedScheduleForLaunch(input) {
  const schedule = input || defaultAllowedSchedule;
  if (!Array.isArray(schedule.allowed_days) || !schedule.allowed_days.length || !/^\d{2}:\d{2}$/.test(schedule.allowed_start_time || '') || !/^\d{2}:\d{2}$/.test(schedule.allowed_end_time || '')) {
    const error = new Error('allowedSchedule must include allowed_days plus allowed_start_time and allowed_end_time in HH:MM format');
    error.status = 400;
    throw error;
  }
  if (schedule.allowed_start_time >= schedule.allowed_end_time) {
    const error = new Error('allowedSchedule.allowed_end_time must be later than allowed_start_time');
    error.status = 400;
    throw error;
  }
  return { timezone: schedule.timezone || 'Asia/Kolkata', ...schedule };
}

function ensureStartIsCallable(startTimestamp, allowedSchedule) {
  const start = new Date(startTimestamp);
  const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: allowedSchedule.timezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(start);
  const part = (type) => dateParts.find((item) => item.type === type)?.value;
  const day = part('weekday');
  const time = `${part('hour')}:${part('minute')}`;
  if (!allowedSchedule.allowed_days.includes(day) || time < allowedSchedule.allowed_start_time || time > allowedSchedule.allowed_end_time) {
    const error = new Error(`The selected start time is outside the permitted Sarvam calling policy: ${allowedSchedule.allowed_days.join(', ')}, ${allowedSchedule.allowed_start_time}–${allowedSchedule.allowed_end_time} (${allowedSchedule.timezone}).`);
    error.status = 400;
    throw error;
  }
}

function analyticsRange(campaign, query) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const candidateStart = campaign.sarvamScheduleStartsAt || (campaign.createdAt > thirtyDaysAgo ? campaign.createdAt : thirtyDaysAgo);
  // A campaign scheduled for the future cannot have attempts yet. Query a short
  // completed window instead of sending Sarvam an invalid start-after-end range.
  const fallbackStart = candidateStart >= now ? new Date(now.getTime() - 60 * 60 * 1000) : candidateStart;
  return {
    startDatetime: query.startDatetime || fallbackStart.toISOString(),
    endDatetime: query.endDatetime || now.toISOString()
  };
}

function isCampaignAttempt(attempt, campaign) {
  const variables = attempt.agent_variables || {};
  return variables.campaign_id === campaign.id || attempt.campaign_id === campaign.sarvamCampaignId;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function meaningfulFailureReason(value) {
  const reason = String(value || '').trim();
  return !reason || reason.toUpperCase() === 'NO_FAILURE_REASON' ? null : reason;
}

function safeAttempt(attempt, attendeeNames) {
  const variables = attempt.agent_variables || {};
  const attendeeId = variables.attendee_id || attempt.user_identifier || null;
  return {
    attemptId: attempt.attempt_id,
    interactionId: attempt.interaction_id,
    attendeeId,
    attendeeName: attendeeNames.get(attendeeId) || 'Unknown attendee',
    attemptedAt: attempt.attempted_at || attempt.start_datetime,
    endedAt: attempt.end_datetime || null,
    connectivityStatus: attempt.connectivity_status || 'unknown',
    durationSeconds: Number(attempt.duration_in_seconds || 0),
    failureReason: meaningfulFailureReason(attempt.failure_reason),
    endedBy: attempt.ended_by || null,
    nextActionStatus: attempt.next_action_status || null,
    retryAttempt: Number(attempt.retry_attempt || 0),
    serverRetryAttempt: Number(attempt.server_retry_attempt || 0),
    // Sarvam reports the initial try as attempt 1. Rally exposes extra tries only.
    retryCount: Math.max(0, Math.max(Number(attempt.retry_attempt || 0), Number(attempt.server_retry_attempt || 0)) - 1),
    language: attempt.language_name || null,
    messageCount: Number(attempt.num_messages || 0),
    hasLogIssues: Boolean(attempt.has_log_issues),
    hasRecording: Boolean(attempt.audio_url),
    isDebugCall: Number(attempt.is_debug_call || 0) === 1
  };
}

async function campaignAnalytics(campaign, query) {
  const range = analyticsRange(campaign, query);
  const allAttempts = await listAttempts(range);
  const attempts = allAttempts.filter((attempt) => isCampaignAttempt(attempt, campaign));
  const attendeeNames = new Map((await prisma.attendee.findMany({ where: { campaignId: campaign.id }, select: { id: true, name: true } })).map((attendee) => [attendee.id, attendee.name]));
  const safeAttempts = attempts.map((attempt) => safeAttempt(attempt, attendeeNames)).sort((a, b) => new Date(b.attemptedAt) - new Date(a.attemptedAt));
  return {
    range,
    summary: {
      totalAttempts: safeAttempts.length,
      uniqueAttendees: new Set(safeAttempts.map((attempt) => attempt.attendeeId).filter(Boolean)).size,
      totalDurationSeconds: safeAttempts.reduce((total, attempt) => total + attempt.durationSeconds, 0),
      retriedAttempts: safeAttempts.filter((attempt) => attempt.retryCount > 0).length,
      logIssueAttempts: safeAttempts.filter((attempt) => attempt.hasLogIssues).length,
      connectivityStatuses: countBy(safeAttempts, 'connectivityStatus'),
      failureReasons: countBy(safeAttempts.filter((attempt) => attempt.failureReason), 'failureReason')
    },
    attempts: safeAttempts
  };
}

router.get('/:campaignId/sarvam/status', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId) return res.json({ sarvamCampaign: null });
    const sarvamCampaign = await getCampaignStatus(campaign.sarvamCampaignId);
    return res.json({ sarvamCampaign: safeSarvamCampaign(sarvamCampaign) });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/sarvam/analytics', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId) return res.json({ analytics: { range: null, summary: { totalAttempts: 0, uniqueAttendees: 0, totalDurationSeconds: 0, retriedAttempts: 0, logIssueAttempts: 0, connectivityStatuses: {}, failureReasons: {} }, attempts: [] } });
    return res.json({ analytics: await campaignAnalytics(campaign, req.query) });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/sarvam/analytics/interactions/:interactionId/transcript', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const analytics = await campaignAnalytics(campaign, req.query);
    if (!analytics.attempts.some((attempt) => attempt.interactionId === req.params.interactionId)) return res.status(404).json({ error: 'Interaction was not found for this campaign' });
    const transcript = await getTranscript(req.params.interactionId);
    return res.json({ interactionId: req.params.interactionId, transcript });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/sarvam/execution-status', async (req, res, next) => {
  try {
    let campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    let completion = null;
    if (campaign.state === 'ACTIVE' && campaign.sarvamCampaignId) {
      completion = await completeCampaignWhenSettled(campaign.id).catch((error) => ({ completed: false, reason: 'completion_check_unavailable', details: error.message }));
      if (completion.completed) campaign = { ...campaign, state: 'COMPLETED' };
    }
    const [attendees, callEvents, responses] = await Promise.all([
      prisma.attendee.findMany({ where: { campaignId: campaign.id }, select: { id: true, phone: true, optedIn: true, status: true } }),
      prisma.callEvent.findMany({ where: { campaignId: campaign.id }, orderBy: { occurredAt: 'desc' }, take: 10, include: { attendee: { select: { name: true } } } }),
      prisma.response.findMany({ where: { campaignId: campaign.id }, select: { attendeeId: true, outcome: true } })
    ]);
    const eligible = attendees.filter((attendee) => attendee.optedIn && attendee.status === 'INVITED' && Boolean(attendee.phone));
    const count = (predicate) => attendees.filter(predicate).length;
    const respondedAttendeeIds = new Set(responses.map((response) => response.attendeeId));
    const outcomeCount = (outcome) => responses.filter((response) => response.outcome === outcome).length;
    const hasSarvamSchedule = Boolean(campaign.sarvamCampaignId);
    const now = new Date();
    const schedulerState = !hasSarvamSchedule
      ? campaign.state === 'PAUSED' ? 'paused_before_launch' : 'not_started'
      : campaign.state === 'COMPLETED' ? 'completed'
      : campaign.state === 'PAUSED' ? 'paused'
      : campaign.sarvamScheduleEndsAt && campaign.sarvamScheduleEndsAt < now ? 'schedule_ended'
      : campaign.sarvamScheduleStartsAt && campaign.sarvamScheduleStartsAt > now ? 'scheduled'
      : !campaign.sarvamScheduleStartsAt ? 'schedule_time_unknown'
      : 'calling_window_open';
    return res.json({
      execution: {
        schedulerState,
        hasSarvamSchedule,
        sarvamCampaignId: campaign.sarvamCampaignId,
        schedule: {
          startsAt: campaign.sarvamScheduleStartsAt,
          endsAt: campaign.sarvamScheduleEndsAt
        },
        attendees: {
          total: attendees.length,
          eligible: eligible.length,
          notOptedIn: count((attendee) => !attendee.optedIn),
          waitlistedOrReleased: count((attendee) => ['WAITLISTED', 'RELEASED', 'OFFERED'].includes(attendee.status)),
          missingPhone: count((attendee) => attendee.optedIn && !attendee.phone),
          awaitingCallOrResult: eligible.filter((attendee) => !respondedAttendeeIds.has(attendee.id)).length
        },
        results: {
          total: responses.length,
          confirmed: outcomeCount('CONFIRMED'),
          declined: outcomeCount('DECLINED'),
          uncertain: outcomeCount('UNCERTAIN'),
          unavailable: responses.length - outcomeCount('CONFIRMED') - outcomeCount('DECLINED') - outcomeCount('UNCERTAIN')
        },
        latestActivity: callEvents[0] ? { eventType: callEvents[0].eventType, occurredAt: callEvents[0].occurredAt, attendeeName: callEvents[0].attendee?.name || null } : null,
        completion
      }
    });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/schedule', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.sarvamCampaignId) return res.status(409).json({ error: 'This campaign is already scheduled with Sarvam', sarvamCampaignId: campaign.sarvamCampaignId });
    if (!req.body.startTimestamp || !req.body.endTimestamp) return res.status(400).json({ error: 'startTimestamp and endTimestamp are required' });
    const allowedSchedule = allowedScheduleForLaunch(req.body.allowedSchedule);
    ensureStartIsCallable(req.body.startTimestamp, allowedSchedule);
    const sarvamCampaign = await createScheduledCampaign(campaign, { ...req.body, allowedSchedule });
    const sarvamCampaignId = sarvamCampaign.id || sarvamCampaign.campaign_id;
    if (!sarvamCampaignId) return res.status(502).json({ error: 'Sarvam did not return a campaign ID', sarvamCampaign });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvamCampaignId, sarvamScheduleStartsAt: new Date(req.body.startTimestamp), sarvamScheduleEndsAt: new Date(req.body.endTimestamp) } });
    return res.status(201).json({ sarvamCampaignId, sarvamCampaign });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/cohort', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.sarvamCampaignId) return res.status(409).json({ error: 'Schedule the campaign with Sarvam before uploading a cohort' });
    const { attendees, readiness } = await callableAttendeeReport(campaign.id);
    if (!attendees.length) return noCallableAttendees(res, readiness);
    const sarvamCohort = await uploadCohort(campaign.sarvamCampaignId, campaign, attendees, req.body.name || `${campaign.name} cohort`, req.body.cohortTransformation);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvamCohortUploadedAt: new Date() } });
    return res.status(201).json({ uploadedAttendees: attendees.length, sarvamCohort });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/sarvam/launch', async (req, res, next) => {
  try {
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Validate the imported list before creating anything in Sarvam. This prevents an
    // empty or non-consented spreadsheet from leaving behind a schedule with no cohort.
    const { attendees, readiness } = await callableAttendeeReport(campaign.id);
    if (!attendees.length) return noCallableAttendees(res, readiness);

    let sarvamCampaignId = campaign.sarvamCampaignId;
    let sarvamCampaign = null;
    if (sarvamCampaignId) {
      const existingSarvamCampaign = await getCampaignStatus(sarvamCampaignId);
      if (isTerminalSarvamStatus(existingSarvamCampaign.status)) sarvamCampaignId = null;
    }
    if (!sarvamCampaignId && (!req.body.startTimestamp || !req.body.endTimestamp)) {
      return res.status(400).json({ error: 'startTimestamp and endTimestamp are required to create a new Sarvam call run' });
    }
    if (!sarvamCampaignId) {
      const allowedSchedule = allowedScheduleForLaunch(req.body.allowedSchedule);
      ensureStartIsCallable(req.body.startTimestamp, allowedSchedule);
      sarvamCampaign = await createScheduledCampaign(campaign, { ...req.body, allowedSchedule });
      sarvamCampaignId = sarvamCampaign.id || sarvamCampaign.campaign_id;
      if (!sarvamCampaignId) return res.status(502).json({ error: 'Sarvam did not return a campaign ID', sarvamCampaign });
      await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvamCampaignId, sarvamScheduleStartsAt: new Date(req.body.startTimestamp), sarvamScheduleEndsAt: new Date(req.body.endTimestamp) } });
    }

    const sarvamCohort = await uploadCohort(sarvamCampaignId, campaign, attendees, req.body.cohortName || `${campaign.name} cohort`);
    const launchedCampaign = await prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'ACTIVE', sarvamCohortUploadedAt: new Date() } });
    return res.status(201).json({ campaign: launchedCampaign, sarvamCampaignId, sarvamCampaign, sarvamCohort, uploadedAttendees: attendees.length, attendeeReadiness: readiness });
  } catch (error) { return next(error); }
});

router.put('/:campaignId/sarvam/status', async (req, res, next) => {
  try {
    if (!['pause', 'resume'].includes(req.body.action)) return res.status(400).json({ error: 'action must be pause or resume' });
    const campaign = await campaignForScheduling(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const isScheduled = Boolean(campaign.sarvamCampaignId);
    const existingSarvamCampaign = isScheduled ? await getCampaignStatus(campaign.sarvamCampaignId) : null;
    if (isTerminalSarvamStatus(existingSarvamCampaign?.status)) {
      const updatedCampaign = await prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'COMPLETED' }, include: { event: true } });
      if (req.body.action === 'resume') return res.status(409).json({ error: 'This Sarvam campaign has already ended and cannot be resumed. Launch a new call run to try again.' });
      return res.json({ sarvamStatus: safeSarvamCampaign(existingSarvamCampaign), campaign: updatedCampaign, message: 'Sarvam had already ended this campaign, so Rally marked it completed.' });
    }
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
