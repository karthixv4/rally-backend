const express = require('express');
const prisma = require('../db/prisma');
const { getCampaignStatus, updateCampaignStatus } = require('../services/sarvamScheduling');

const router = express.Router();

function eventInput(body) {
  return {
    name: String(body.name || '').trim(),
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    venue: String(body.venue || '').trim() || null,
    schedule: String(body.schedule || '').trim() || null,
    parkingInstructions: String(body.parkingInstructions || '').trim() || null,
    helpContact: String(body.helpContact || '').trim() || null,
    capacity: Number.isInteger(body.capacity) ? body.capacity : Number(body.capacity) || null
  };
}

router.get('/', async (req, res, next) => {
  try {
    const events = await prisma.event.findMany({
      where: { userId: req.user.id },
      include: { _count: { select: { campaigns: true, attendees: true } } },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ events });
  } catch (error) { return next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const event = eventInput(req.body);
    if (!event.name) return res.status(400).json({ error: 'Event name is required' });
    const created = await prisma.$transaction(async (tx) => {
      const createdEvent = await tx.event.create({ data: { ...event, userId: req.user.id } });
      if (createdEvent.capacity) {
        await tx.seat.createMany({
          data: Array.from({ length: createdEvent.capacity }, (_, index) => ({ eventId: createdEvent.id, seatNumber: index + 1 }))
        });
      }
      return createdEvent;
    });
    return res.status(201).json({ event: created });
  } catch (error) { return next(error); }
});

router.get('/:eventId', async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({ where: { id: req.params.eventId, userId: req.user.id }, include: { campaigns: { orderBy: { createdAt: 'desc' } }, _count: { select: { attendees: true } } } });
    return event ? res.json({ event }) : res.status(404).json({ error: 'Event not found' });
  } catch (error) { return next(error); }
});

router.delete('/:eventId', async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.eventId, userId: req.user.id },
      include: { campaigns: { select: { id: true, name: true, sarvamCampaignId: true } } }
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // External schedules must stop before the local event is removed. Do this
    // before deleting anything so Rally never loses the ability to identify a
    // still-running Sarvam campaign.
    const schedules = { paused: 0, alreadyPaused: 0, alreadyEnded: 0 };
    for (const campaign of event.campaigns) {
      if (!campaign.sarvamCampaignId) continue;
      try {
        const sarvamCampaign = await getCampaignStatus(campaign.sarvamCampaignId);
        const status = String(sarvamCampaign.status || '').trim().toLowerCase();
        if (['ended', 'cancelled'].includes(status)) {
          schedules.alreadyEnded += 1;
        } else if (['paused', 'pause'].includes(status)) {
          schedules.alreadyPaused += 1;
        } else {
          await updateCampaignStatus(campaign.sarvamCampaignId, 'pause');
          schedules.paused += 1;
        }
      } catch (error) {
        return res.status(409).json({
          error: `Event was not deleted because Rally could not pause Sarvam campaign “${campaign.name}”. No Rally data was removed.`,
          details: error.message,
          schedules
        });
      }
    }

    await prisma.event.delete({ where: { id: event.id } });
    return res.json({
      message: 'Event and all associated Rally data were deleted',
      deletedCampaigns: event.campaigns.length,
      sarvamSchedules: schedules
    });
  } catch (error) { return next(error); }
});

module.exports = router;
