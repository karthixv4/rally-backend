const prisma = require('../db/prisma');
const { getCampaignStatus, updateCampaignStatus } = require('./sarvamScheduling');
const { listAttempts } = require('./sarvamAnalytics');

const terminalSarvamStatuses = new Set(['ended', 'cancelled']);

function retryIsPending(attempt) {
  const value = String(attempt.next_action_status || '').trim().toLowerCase();
  // Sarvam can use slightly different labels across delivery modes. Any
  // explicit retry/requeue state means Rally must leave the schedule running.
  return /retry|reschedul|queue|pending/.test(value);
}

function isAttemptForCampaign(attempt, campaign) {
  const variables = attempt.agent_variables || {};
  return variables.campaign_id === campaign.id || attempt.campaign_id === campaign.sarvamCampaignId;
}

function attemptedAt(attempt) {
  const date = new Date(attempt.attempted_at || attempt.start_datetime || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * Finish a bulk call run as soon as it is genuinely settled. This deliberately
 * relies on Sarvam analytics rather than only Rally webhooks: a webhook can be
 * delayed or lost, while an attempt that Sarvam plans to retry must keep the
 * scheduler alive. It never throws for a non-terminal situation.
 */
async function completeCampaignWhenSettled(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      state: true,
      sarvamCampaignId: true,
      sarvamScheduleStartsAt: true,
      autoCallWaitlist: true
    }
  });

  if (!campaign?.sarvamCampaignId || campaign.state === 'COMPLETED') return { completed: campaign?.state === 'COMPLETED', reason: 'not_active' };
  if (campaign.state === 'PAUSED') return { completed: false, reason: 'paused' };
  if (campaign.sarvamScheduleStartsAt && campaign.sarvamScheduleStartsAt > new Date()) return { completed: false, reason: 'not_started' };

  const [attendees, responses, pendingOffers] = await Promise.all([
    prisma.attendee.findMany({
      where: { campaignId, status: { notIn: ['WAITLISTED', 'OFFERED'] } },
      select: { id: true, phone: true, optedIn: true }
    }),
    prisma.response.findMany({ where: { campaignId }, select: { attendeeId: true } }),
    prisma.seatOffer.count({ where: { campaignId, status: 'PENDING' } })
  ]);

  // Automatic recovery is part of the same operational run. Do not close its
  // bulk campaign while an offered waitlist seat can still result in an outbound.
  if (campaign.autoCallWaitlist && pendingOffers > 0) return { completed: false, reason: 'waitlist_recovery_pending', pendingOffers };

  const callable = attendees.filter((attendee) => attendee.optedIn && attendee.phone);
  if (!callable.length) return { completed: false, reason: 'no_callable_attendees' };

  const responseIds = new Set(responses.map((response) => response.attendeeId));
  let attempts;
  try {
    const start = (campaign.sarvamScheduleStartsAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)).toISOString();
    attempts = (await listAttempts({ startDatetime: start, endDatetime: new Date().toISOString() }))
      .filter((attempt) => isAttemptForCampaign(attempt, campaign));
  } catch (error) {
    // An analytics outage is not permission to stop a live schedule.
    return { completed: false, reason: 'analytics_unavailable', details: error.message };
  }

  const latestAttemptByAttendee = new Map();
  for (const attempt of attempts) {
    const attendeeId = attempt.agent_variables?.attendee_id || attempt.user_identifier;
    if (!attendeeId) continue;
    const previous = latestAttemptByAttendee.get(attendeeId);
    if (!previous || attemptedAt(attempt) > attemptedAt(previous)) latestAttemptByAttendee.set(attendeeId, attempt);
  }

  const retryPending = [...latestAttemptByAttendee.entries()]
    .filter(([, attempt]) => retryIsPending(attempt))
    .map(([attendeeId]) => attendeeId);
  if (retryPending.length) return { completed: false, reason: 'retry_pending', retryPendingAttendeeIds: retryPending };

  // A stored result is terminal. If an agent could not collect output, a
  // completed Sarvam attempt is also terminal as long as it has no retry queued.
  const outstanding = callable.filter((attendee) => {
    if (responseIds.has(attendee.id)) return false;
    const latest = latestAttemptByAttendee.get(attendee.id);
    return !latest?.end_datetime;
  });
  if (outstanding.length) return { completed: false, reason: 'calls_pending', pendingAttendeeIds: outstanding.map((attendee) => attendee.id) };

  const sarvamCampaign = await getCampaignStatus(campaign.sarvamCampaignId);
  const sarvamStatus = String(sarvamCampaign?.status || '').toLowerCase();
  if (!terminalSarvamStatuses.has(sarvamStatus)) {
    try {
      await updateCampaignStatus(campaign.sarvamCampaignId, 'pause');
    } catch (error) {
      // It may have ended in the short time between the read and the pause.
      const current = await getCampaignStatus(campaign.sarvamCampaignId).catch(() => null);
      if (!terminalSarvamStatuses.has(String(current?.status || '').toLowerCase())) {
        return { completed: false, reason: 'could_not_stop_schedule', details: error.message };
      }
    }
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { state: 'COMPLETED' } });
  return { completed: true, reason: 'all_calls_settled', completedEarly: !terminalSarvamStatuses.has(sarvamStatus) };
}

module.exports = { completeCampaignWhenSettled };
