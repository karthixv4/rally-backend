const express = require('express');
const prisma = require('../db/prisma');
const requireSarvamSecret = require('../middleware/requireSarvamSecret');
const { saveCallResult, validateCallResult } = require('../services/callResults');

const router = express.Router();

function webhookTraceId() {
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function resultPayloadDebug(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  return {
    fields: Object.keys(body).sort(),
    nestedObjects: Object.entries(body)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => ({ key, fields: Object.keys(value).slice(0, 20).sort() })),
    campaignId: body.campaign_id ?? null,
    attendeeId: body.attendee_id ?? null,
    attendanceStatus: body.attendance_status ?? null,
    seatRelease: body.seat_release ?? null,
    escalationFlagType: body.escalation_flag === undefined ? 'missing' : typeof body.escalation_flag,
    escalationFlagValue: typeof body.escalation_flag === 'string' ? body.escalation_flag.slice(0, 40) : body.escalation_flag ?? null
  };
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0', ''].includes(normalized)) return false;
  // An escalation is opt-in. A non-standard string should not block a completed call result.
  console.warn('[Rally voice result unknown escalation flag]', JSON.stringify({ value: value.slice(0, 40) }));
  return false;
}

function normalizeResultPayload(payload) {
  const body = payload || {};
  const normalizeChoice = (value) => typeof value === 'string' ? value.trim().toLowerCase() : value;
  const seatRelease = normalizeChoice(body.seat_release);
  return {
    ...body,
    attendance_status: normalizeChoice(body.attendance_status),
    // Some Sarvam post-call tool invocations serialise an unset output variable
    // as an empty string. Treat that as not supplied, not as an invalid answer.
    seat_release: seatRelease || undefined,
    escalation_flag: toBoolean(body.escalation_flag)
  };
}

router.post('/call-results', requireSarvamSecret, async (req, res, next) => {
  const traceId = webhookTraceId();
  res.set('X-Rally-Webhook-Trace', traceId);
  try {
    const resultPayload = normalizeResultPayload(req.body);
    const validationError = validateCallResult(resultPayload);
    if (validationError) {
      console.warn('[Rally voice result rejected]', JSON.stringify({ traceId, reason: validationError, received: resultPayloadDebug(resultPayload) }));
      return res.status(400).json({
        error: validationError,
        code: 'INVALID_CALL_RESULT',
        traceId,
        required: ['campaign_id', 'attendee_id', 'attendance_status'],
        note: 'attendance_status must be confirmed, declined, uncertain, wrong_number, voicemail, or call_disconnected'
      });
    }
    const response = await saveCallResult(resultPayload);
    if (!response) {
      console.warn('[Rally voice result not matched]', JSON.stringify({ traceId, received: resultPayloadDebug(resultPayload) }));
      return res.status(404).json({ error: 'Campaign or attendee not found', code: 'CALL_RESULT_NOT_MATCHED', traceId });
    }
    console.info('[Rally voice result saved]', JSON.stringify({ traceId, campaignId: resultPayload.campaign_id, attendeeId: resultPayload.attendee_id, attendanceStatus: resultPayload.attendance_status }));
    return res.status(201).json({ message: 'Call result saved', response });
  } catch (error) {
    console.error('[Rally voice result failed]', JSON.stringify({ traceId, message: error.message, received: resultPayloadDebug(req.body) }));
    return next(error);
  }
});

router.get('/call-context', requireSarvamSecret, async (req, res, next) => {
  try {
    const campaignId = req.query.campaign_id;
    const attendeeId = req.query.attendee_id;
    if (!campaignId || !attendeeId) return res.status(400).json({ error: 'campaign_id and attendee_id are required' });
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { event: true } });
    const attendee = await prisma.attendee.findFirst({ where: { id: attendeeId, eventId: campaign?.eventId } });
    if (!campaign || !attendee) return res.status(404).json({ error: 'Campaign or attendee not found' });
    if (!attendee.optedIn) return res.status(403).json({ error: 'Attendee has not opted in to voice outreach' });
    return res.json({
      campaign_id: campaign.id,
      attendee_id: attendee.id,
      event_name: campaign.event.name,
      event_date: campaign.event.startsAt ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'Asia/Kolkata' }).format(campaign.event.startsAt) : 'the event date to be confirmed',
      event_venue: campaign.event.venue || 'the venue to be confirmed',
      attendee_name: attendee.name,
      session_slot_options: campaign.sessionSlotOptions
    });
  } catch (error) { return next(error); }
});

router.post('/call-context', requireSarvamSecret, async (req, res, next) => {
  try {
    const { campaignId, attendeeId } = req.body;
    if (!campaignId || !attendeeId) {
      return res.status(400).json({ error: 'campaignId and attendeeId are required' });
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { event: true }
    });
    const attendee = await prisma.attendee.findFirst({
      where: { id: attendeeId, eventId: campaign?.eventId }
    });

    if (!campaign || !attendee) {
      return res.status(404).json({ error: 'Campaign or attendee not found' });
    }
    if (!attendee.optedIn) {
      return res.status(403).json({ error: 'Attendee has not opted in to voice outreach' });
    }

    const enabledQuestions = {
      attendance: campaign.attendanceEnabled,
      parking: campaign.parkingEnabled,
      foodPreference: campaign.foodEnabled
    };

    return res.json({
      callContext: {
        campaignId: campaign.id,
        attendeeId: attendee.id,
        event: {
          name: campaign.event.name,
          startsAt: campaign.event.startsAt,
          venue: campaign.event.venue,
          schedule: campaign.event.schedule,
          parkingInstructions: campaign.parkingEnabled
            ? campaign.event.parkingInstructions
            : undefined,
          helpContact: campaign.event.helpContact
        },
        attendee: {
          firstName: attendee.name.split(/\s+/)[0],
          status: attendee.status
        },
        enabledQuestions,
        languages: campaign.languages,
        tone: campaign.tone,
        systemInstructions: [
          `You are Rally, the automated event assistant for ${campaign.event.name}.`,
          'Disclose that you are automated and ask whether this is a good time for a short call.',
          'Ask only the enabled questions.',
          'Offer an immediate opt-out. Do not request payment, identity documents, or unrelated sensitive data.',
          'For a decline, ask permission before releasing a seat.'
        ]
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
