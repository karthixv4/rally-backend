const prisma = require('../db/prisma');
const { applySeatDecision, listRecoveryDispatches, reconcileCampaignWaitlist } = require('./waitlistRecovery');
const { requestWaitlistRecoveryCall } = require('./sarvamScheduling');

const callOutcomes = new Set([
  'confirmed', 'declined', 'uncertain', 'wrong_number', 'voicemail', 'call_disconnected'
]);
const seatReleaseValues = new Set(['yes', 'no', 'not_asked']);

function toPrismaEnum(value) {
  return value.toUpperCase();
}

function optionalBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', '1', 'required'].includes(normalized)) return true;
  if (['false', 'no', '0', 'not_required', 'not required'].includes(normalized)) return false;
  return null;
}

function validateCallResult(payload) {
  const { campaign_id: campaignId, attendee_id: attendeeId, attendance_status: attendanceStatus } = payload;
  if (!campaignId || !attendeeId || !callOutcomes.has(attendanceStatus)) {
    return 'campaign_id, attendee_id, and a valid attendance_status are required';
  }
  if (payload.seat_release !== undefined && !seatReleaseValues.has(payload.seat_release)) {
    return 'seat_release must be yes, no, or not_asked';
  }
  if (payload.escalation_flag !== undefined && typeof payload.escalation_flag !== 'boolean') {
    return 'escalation_flag must be a boolean';
  }
  return null;
}

async function saveCallResult(payload) {
  const campaign = await prisma.campaign.findUnique({ where: { id: payload.campaign_id } });
  const attendee = await prisma.attendee.findFirst({
    where: { id: payload.attendee_id, campaignId: campaign?.id }
  });
  if (!campaign || !attendee) return null;

  const outcome = payload.attendance_status;
  // A decline is still a valid completed call when the agent did not reach the
  // optional seat-release question. Preserve a supplied answer, otherwise make
  // the missing answer explicit rather than rejecting the entire call result.
  const hasSubstitute = Boolean(String(payload.substitute_attendee || '').trim());
  // A decline without a named substitute returns the reserved seat to the
  // event pool unless the caller expressly says not to release it. Store the
  // derived decision as YES so the organiser has an auditable explanation.
  const automaticRelease = outcome === 'declined' && !hasSubstitute && payload.seat_release !== 'no';
  const seatRelease = outcome === 'declined'
    ? (automaticRelease ? 'yes' : (payload.seat_release || 'not_asked'))
    : payload.seat_release;
  const attendance = outcome === 'confirmed' ? true : outcome === 'declined' ? false : null;

  const saved = await prisma.$transaction(async (tx) => {
    const seatDecision = await applySeatDecision(tx, { campaign, attendee, outcome, payload });
    const response = await tx.response.create({
      data: {
        campaignId: campaign.id,
        attendeeId: attendee.id,
        outcome: toPrismaEnum(outcome),
        attendance,
        transportMode: payload.transport_mode || null,
        arrivalSlot: payload.arrival_slot || null,
        declineReason: payload.decline_reason || null,
        seatRelease: seatRelease ? toPrismaEnum(seatRelease) : null,
        substituteAttendee: payload.substitute_attendee || null,
        escalationFlag: payload.escalation_flag === true,
        callSummary: payload.call_summary || null,
        transcript: payload.transcript || null,
        parking: optionalBoolean(payload.parking_needed),
        foodPreference: payload.food_preference || null,
        dietaryRequirements: payload.dietary_requirements || null,
        accessibilityNeeds: payload.accessibility_needs || null,
        teamStatus: payload.team_status || null
      }
    });

    await tx.callEvent.create({
      data: {
        eventId: campaign.eventId,
        campaignId: campaign.id,
        attendeeId: attendee.id,
        eventType: 'call_completed',
        outcome: toPrismaEnum(outcome),
        transcript: payload.transcript || null,
        details: {
          callSummary: payload.call_summary || null,
          escalationFlag: payload.escalation_flag === true,
          seatReleased: seatDecision.releasedSeat === true,
          capacityConflict: seatDecision.capacityConflict === true
        }
      }
    });

    if (seatDecision.attendeeStatus) {
      await tx.attendee.update({
        where: { id: attendee.id },
        data: { status: seatDecision.attendeeStatus }
      });
    }

    if (payload.escalation_flag === true) {
      await tx.followUp.create({
        data: {
          eventId: campaign.eventId,
          campaignId: campaign.id,
          attendeeId: attendee.id,
          summary: payload.call_summary || `Review ${attendee.name}'s call outcome.`,
          private: Boolean(payload.dietary_requirements || payload.accessibility_needs),
          type: 'escalation'
        }
      });
    }

    return { response, reconcileWaitlist: outcome === 'declined' || seatDecision.releasedSeat === true };
  });

  if (saved.reconcileWaitlist) {
    // The RSVP has committed before any outbound request is made. A Sarvam
    // outage therefore never loses a valid decline or causes an overbooking.
    try {
      await dispatchWaitlistRecovery(campaign.id);
    } catch (error) {
      console.error('[Rally waitlist recovery deferred]', JSON.stringify({ campaignId: campaign.id, message: error.message }));
    }
  }
  return saved.response;
}

async function dispatchWaitlistRecovery(campaignId) {
  await reconcileCampaignWaitlist(campaignId);
  const offers = await listRecoveryDispatches(campaignId);
  for (const offer of offers) {
    try {
      const result = await requestWaitlistRecoveryCall(offer);
      if (result.skipped) continue;
      const outboundId = result?.id || result?.outbound_id || result?.request_id || null;
      const updated = await prisma.seatOffer.updateMany({
        where: { id: offer.id, status: 'PENDING', callRequestedAt: null },
        data: { callRequestedAt: new Date(), sarvamOutboundId: outboundId, callFailureReason: null }
      });
      if (updated.count) {
        await prisma.callEvent.create({
          data: {
            eventId: offer.campaign.eventId,
            campaignId: offer.campaignId,
            attendeeId: offer.attendeeId,
            eventType: 'waitlist_call_requested',
            details: { seatOfferId: offer.id, seatNumber: offer.seat.seatNumber, sarvamOutboundId: outboundId }
          }
        });
      }
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        await tx.seatOffer.updateMany({
          where: { id: offer.id, status: 'PENDING', callRequestedAt: null },
          data: { callFailureReason: error.message.slice(0, 1000) }
        });
        await tx.callEvent.create({
          data: {
            eventId: offer.campaign.eventId,
            campaignId: offer.campaignId,
            attendeeId: offer.attendeeId,
            eventType: 'waitlist_call_failed',
            details: { seatOfferId: offer.id, seatNumber: offer.seat.seatNumber, error: error.message.slice(0, 1000) }
          }
        });
        await tx.followUp.create({
          data: {
            eventId: offer.campaign.eventId,
            campaignId: offer.campaignId,
            attendeeId: offer.attendeeId,
            type: 'waitlist_delivery_failed',
            summary: `Waitlist seat ${offer.seat.seatNumber} could not be called for ${offer.attendee.name}. Retry the recovery call after checking Sarvam.`
          }
        });
      });
    }
  }
}

module.exports = { dispatchWaitlistRecovery, saveCallResult, validateCallResult };
