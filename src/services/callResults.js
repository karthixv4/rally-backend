const prisma = require('../db/prisma');

const callOutcomes = new Set([
  'confirmed', 'declined', 'uncertain', 'wrong_number', 'voicemail', 'call_disconnected'
]);
const seatReleaseValues = new Set(['yes', 'no', 'not_asked']);

function toPrismaEnum(value) {
  return value.toUpperCase();
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
    where: { id: payload.attendee_id, eventId: campaign?.eventId }
  });
  if (!campaign || !attendee) return null;

  const outcome = payload.attendance_status;
  // A decline is still a valid completed call when the agent did not reach the
  // optional seat-release question. Preserve a supplied answer, otherwise make
  // the missing answer explicit rather than rejecting the entire call result.
  const seatRelease = outcome === 'declined' ? (payload.seat_release || 'not_asked') : payload.seat_release;
  const statusByOutcome = {
    confirmed: 'CONFIRMED',
    declined: seatRelease === 'yes' ? 'RELEASED' : 'DECLINED',
    uncertain: 'UNCERTAIN'
  };
  const attendance = outcome === 'confirmed' ? true : outcome === 'declined' ? false : null;

  return prisma.$transaction(async (tx) => {
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
        parking: typeof payload.parking_needed === 'boolean' ? payload.parking_needed : null,
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
        details: { callSummary: payload.call_summary || null, escalationFlag: payload.escalation_flag === true }
      }
    });

    if (statusByOutcome[outcome]) {
      await tx.attendee.update({
        where: { id: attendee.id },
        data: { status: statusByOutcome[outcome] }
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

    return response;
  });
}

module.exports = { saveCallResult, validateCallResult };
