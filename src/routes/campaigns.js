const express = require('express');
const prisma = require('../db/prisma');

const router = express.Router();

function isString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

router.post('/', async (req, res, next) => {
  try {
    const { event, campaign, attendees = [] } = req.body;

    if (!event || !campaign || !isString(event.name) || !isString(campaign.name)) {
      return res.status(400).json({
        error: 'event.name and campaign.name are required'
      });
    }

    if (!Array.isArray(attendees) || attendees.some((attendee) => !isString(attendee.name))) {
      return res.status(400).json({
        error: 'attendees must be an array, and every attendee needs a name'
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const createdEvent = await tx.event.create({
        data: {
          name: event.name.trim(),
          startsAt: event.startsAt ? new Date(event.startsAt) : null,
          venue: event.venue || null,
          schedule: event.schedule || null,
          parkingInstructions: event.parkingInstructions || null,
          helpContact: event.helpContact || null,
          capacity: Number.isInteger(event.capacity) ? event.capacity : null
        }
      });

      const createdCampaign = await tx.campaign.create({
        data: {
          eventId: createdEvent.id,
          name: campaign.name.trim(),
          attendanceEnabled: campaign.attendanceEnabled !== false,
          parkingEnabled: campaign.parkingEnabled === true,
          foodEnabled: campaign.foodEnabled === true,
          languages: Array.isArray(campaign.languages) && campaign.languages.length
            ? campaign.languages
            : ['en'],
          tone: campaign.tone || 'helpful',
          deadline: campaign.deadline ? new Date(campaign.deadline) : null
        }
      });

      if (attendees.length) {
        await tx.attendee.createMany({
          data: attendees.map((attendee) => ({
            eventId: createdEvent.id,
            name: attendee.name.trim(),
            phone: attendee.phone || null,
            optedIn: attendee.optedIn === true,
            status: attendee.status || 'INVITED',
            waitlistRank: Number.isInteger(attendee.waitlistRank)
              ? attendee.waitlistRank
              : null
          }))
        });
      }

      return { event: createdEvent, campaign: createdCampaign };
    });

    return res.status(201).json({
      message: 'Campaign created',
      event: result.event,
      campaign: result.campaign,
      attendeeCount: attendees.length
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
