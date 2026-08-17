const express = require('express');
const prisma = require('../db/prisma');

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
    return res.status(201).json({ event: await prisma.event.create({ data: { ...event, userId: req.user.id } }) });
  } catch (error) { return next(error); }
});

router.get('/:eventId', async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({ where: { id: req.params.eventId, userId: req.user.id }, include: { campaigns: { orderBy: { createdAt: 'desc' } }, _count: { select: { attendees: true } } } });
    return event ? res.json({ event }) : res.status(404).json({ error: 'Event not found' });
  } catch (error) { return next(error); }
});

module.exports = router;
