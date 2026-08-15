const express = require('express');
const prisma = require('../db/prisma');
const requireSarvamSecret = require('../middleware/requireSarvamSecret');
const { saveCallResult, validateCallResult } = require('../services/callResults');

const router = express.Router();

// Temporary demo endpoint: remove after the campaign-backed call-context flow is in use.
router.get('/demo-call-details', requireSarvamSecret, (_req, res) => {
  return res.json({
    // Temporary IDs for the hardcoded demo campaign; replace with dialer variables later.
    campaign_id: 'cmstykcym0002lb7cn995z117',
    attendee_id: 'cmstykd250003lb7coo2nbsqw',
    event_name: 'Rally Community Build Hackathon',
    event_date: 'Saturday, 30 August 2026',
    event_venue: 'The Innovation Hub, Bengaluru',
    attendee_name: 'Ananya Rao',
    session_slot_options: [
      'Morning session: 9:00 AM to 1:00 PM',
      'Afternoon session: 2:00 PM to 6:00 PM'
    ]
  });
});

router.post('/call-results', requireSarvamSecret, async (req, res, next) => {
  try {
    const validationError = validateCallResult(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const response = await saveCallResult(req.body);
    if (!response) {
      return res.status(404).json({ error: 'Campaign or attendee not found' });
    }
    return res.status(201).json({ message: 'Call result saved', response });
  } catch (error) {
    return next(error);
  }
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
