const express = require('express');
const multer = require('multer');
const { readXlsxRows } = require('../services/xlsxReader');
const prisma = require('../db/prisma');
const { saveCallResult, validateCallResult } = require('../services/callResults');
const { dispatchWaitlistRecovery } = require('../services/callResults');
const { getCampaignStatus, updateCampaignStatus } = require('../services/sarvamScheduling');
const { reconcileCampaignWaitlist, reserveInitialCampaignSeats } = require('../services/waitlistRecovery');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const attendeeStatuses = new Set(['INVITED', 'CONFIRMED', 'UNCERTAIN', 'DECLINED', 'RELEASED', 'WAITLISTED', 'OFFERED']);
const campaignStates = new Set(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED']);
const isString = (value) => typeof value === 'string' && value.trim();
const campaignInclude = { event: { include: { seats: true } }, _count: { select: { responses: true, followUps: true, seatOffers: true } } };

async function getCampaign(campaignId, userId) {
  return prisma.campaign.findFirst({ where: { id: campaignId, event: { userId } }, include: campaignInclude });
}

router.param('campaignId', async (req, res, next, campaignId) => {
  try {
    const campaign = await getCampaign(campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    req.authorizedCampaign = campaign;
    return next();
  } catch (error) { return next(error); }
});

function attendeeData(attendee, eventId, campaignId) {
  return { eventId, campaignId, name: attendee.name.trim(), phone: attendee.phone || null, optedIn: attendee.optedIn === true, status: attendeeStatuses.has(attendee.status) ? attendee.status : 'INVITED', waitlistRank: Number.isInteger(attendee.waitlistRank) ? attendee.waitlistRank : null };
}

function spreadsheetBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'y', '1'].includes(String(value || '').trim().toLowerCase());
}

function spreadsheetAttendee(row) {
  const rawPhone = String(row.phone || row.phone_number || '').trim();
  return {
    name: String(row.name || row.attendee_name || '').trim(),
    phone: rawPhone ? (/^\d{10,15}$/.test(rawPhone) ? `+${rawPhone}` : rawPhone) : null,
    optedIn: spreadsheetBoolean(row.optedIn ?? row.opted_in),
    status: String(row.status || 'INVITED').trim().toUpperCase(),
    waitlistRank: row.waitlistRank ?? row.waitlist_rank ?? null
  };
}

router.get('/', async (req, res, next) => {
  try {
    const [campaigns, attendeeCounts] = await Promise.all([
      prisma.campaign.findMany({ where: { event: { userId: req.user.id } }, include: campaignInclude, orderBy: { createdAt: 'desc' } }),
      prisma.attendee.groupBy({ by: ['campaignId', 'status'], where: { campaign: { event: { userId: req.user.id } } }, _count: { _all: true } })
    ]);
    const attendeeCountsByEvent = new Map();
    for (const row of attendeeCounts) {
      const counts = attendeeCountsByEvent.get(row.campaignId) || {};
      counts[row.status] = row._count._all;
      attendeeCountsByEvent.set(row.campaignId, counts);
    }
    return res.json({
      campaigns: campaigns.map((campaign) => {
        const attendeeCountsForEvent = attendeeCountsByEvent.get(campaign.id) || {};
        return {
          ...campaign,
          dashboardCounts: {
            totalAttendees: Object.values(attendeeCountsForEvent).reduce((total, value) => total + value, 0),
            confirmed: attendeeCountsForEvent.CONFIRMED || 0,
            declined: (attendeeCountsForEvent.DECLINED || 0) + (attendeeCountsForEvent.RELEASED || 0),
            uncertain: attendeeCountsForEvent.UNCERTAIN || 0,
            awaitingResult: attendeeCountsForEvent.INVITED || 0
          }
        };
      })
    });
  } catch (error) { return next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const { event, eventId, campaign, attendees = [] } = req.body;
    if (!campaign || !isString(campaign.name) || (!eventId && (!event || !isString(event.name)))) return res.status(400).json({ error: 'campaign.name and either eventId or event.name are required' });
    if (!Array.isArray(attendees) || attendees.some((attendee) => !isString(attendee.name))) return res.status(400).json({ error: 'attendees must be an array and every attendee needs a name' });
    const result = await prisma.$transaction(async (tx) => {
      const createdEvent = eventId
        ? await tx.event.findFirst({ where: { id: eventId, userId: req.user.id } })
        : await tx.event.create({ data: { name: event.name.trim(), startsAt: event.startsAt ? new Date(event.startsAt) : null, venue: event.venue || null, schedule: event.schedule || null, parkingInstructions: event.parkingInstructions || null, helpContact: event.helpContact || null, capacity: Number.isInteger(event.capacity) ? event.capacity : null, userId: req.user.id } });
      if (!createdEvent) {
        const error = new Error('Event not found');
        error.status = 404;
        throw error;
      }
      const createdCampaign = await tx.campaign.create({ data: { eventId: createdEvent.id, name: campaign.name.trim(), attendanceEnabled: campaign.attendanceEnabled !== false, parkingEnabled: campaign.parkingEnabled === true, foodEnabled: campaign.foodEnabled === true, languages: Array.isArray(campaign.languages) && campaign.languages.length ? campaign.languages : ['en'], tone: campaign.tone || 'helpful', deadline: campaign.deadline ? new Date(campaign.deadline) : null, state: campaignStates.has(campaign.state) ? campaign.state : 'DRAFT', sessionSlotOptions: Array.isArray(campaign.sessionSlotOptions) ? campaign.sessionSlotOptions : [] } });
      const createdAttendees = attendees.length ? await tx.attendee.createManyAndReturn({ data: attendees.map((attendee) => attendeeData(attendee, createdEvent.id, createdCampaign.id)) }) : [];
      if (!eventId && createdEvent.capacity) await tx.seat.createMany({ data: Array.from({ length: createdEvent.capacity }, (_, index) => ({ eventId: createdEvent.id, seatNumber: index + 1 })) });
      const allocation = attendees.length ? await reserveInitialCampaignSeats(tx, createdCampaign.id) : { reserved: 0, movedToWaitlist: 0 };
      return { event: createdEvent, campaign: createdCampaign, attendees: createdAttendees, allocation };
    });
    return res.status(201).json({ message: 'Campaign created', ...result, attendeeCount: result.attendees.length });
  } catch (error) { return next(error); }
});

router.get('/:campaignId', async (req, res, next) => {
  try { const campaign = await getCampaign(req.params.campaignId, req.user.id); return campaign ? res.json({ campaign }) : res.status(404).json({ error: 'Campaign not found' }); } catch (error) { return next(error); }
});

router.patch('/:campaignId', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { event = {}, ...campaignPatch } = req.body;
    if (campaignPatch.state && !campaignStates.has(campaignPatch.state)) return res.status(400).json({ error: 'Invalid campaign state' });
    const updated = await prisma.$transaction(async (tx) => { if (Object.keys(event).length) await tx.event.update({ where: { id: campaign.eventId }, data: event }); return tx.campaign.update({ where: { id: campaign.id }, data: campaignPatch, include: campaignInclude }); });
    return res.json({ campaign: updated });
  } catch (error) { return next(error); }
});

router.delete('/:campaignId', async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.campaignId },
      select: { id: true, eventId: true, sarvamCampaignId: true }
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Do not leave a live external dialer running after its Rally campaign is gone.
    let sarvamSchedulePaused = false;
    let sarvamScheduleAlreadyPaused = false;
    let sarvamScheduleAlreadyEnded = false;
    if (campaign.sarvamCampaignId) {
      try {
        const sarvamCampaign = await getCampaignStatus(campaign.sarvamCampaignId);
        const sarvamStatus = String(sarvamCampaign.status || '').trim().toLowerCase();
        if (['ended', 'cancelled'].includes(sarvamStatus)) {
          sarvamScheduleAlreadyEnded = true;
        } else if (['paused', 'pause'].includes(sarvamStatus)) {
          // Sarvam has already stopped the dialer, so a second pause would be rejected.
          sarvamScheduleAlreadyPaused = true;
        } else {
          await updateCampaignStatus(campaign.sarvamCampaignId, 'pause');
          sarvamSchedulePaused = true;
        }
      } catch (error) {
        return res.status(409).json({
          error: 'Campaign was not deleted because Rally could not pause its Sarvam schedule. No Rally data was removed.',
          details: error.message
        });
      }
    }

    const campaignCountForEvent = await prisma.campaign.count({ where: { eventId: campaign.eventId } });
    await prisma.$transaction(async (tx) => {
      if (campaignCountForEvent === 1) {
        // The normal Rally setup creates one Event per Campaign. Cascades remove every
        // attendee, response, activity record, task, seat, and waitlist offer with it.
        await tx.event.delete({ where: { id: campaign.eventId } });
        return;
      }

      // Preserve a deliberately shared event, but remove every record owned by this campaign.
      // Seat.attendeeId uses ON DELETE SET NULL. Reset the operational seat
      // status as well, otherwise a deleted campaign would leave a ghost seat
      // marked ASSIGNED and silently reduce capacity for the remaining campaigns.
      const campaignAttendees = await tx.attendee.findMany({ where: { campaignId: campaign.id }, select: { id: true } });
      if (campaignAttendees.length) {
        await tx.seat.updateMany({
          where: { eventId: campaign.eventId, attendeeId: { in: campaignAttendees.map((attendee) => attendee.id) } },
          data: { attendeeId: null, status: 'AVAILABLE', releasedAt: null }
        });
      }
      await tx.followUp.deleteMany({ where: { campaignId: campaign.id } });
      await tx.campaign.delete({ where: { id: campaign.id } });
    });

    return res.json({
      message: 'Campaign and all associated Rally data were deleted',
      sarvamSchedulePaused,
      sarvamScheduleAlreadyPaused,
      sarvamScheduleAlreadyEnded
    });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/attendees/import', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); const attendees = req.body.attendees;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!Array.isArray(attendees) || attendees.some((attendee) => !isString(attendee.name))) return res.status(400).json({ error: 'attendees with names are required' });
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.attendee.createManyAndReturn({ data: attendees.map((attendee) => attendeeData(attendee, campaign.eventId, campaign.id)) });
      const allocation = await reserveInitialCampaignSeats(tx, campaign.id);
      const currentAttendees = await tx.attendee.findMany({ where: { id: { in: created.map((attendee) => attendee.id) } }, orderBy: { createdAt: 'asc' } });
      return { created: currentAttendees, allocation };
    });
    return res.status(201).json({ attendees: result.created, imported: result.created.length, allocation: result.allocation });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/attendees/import-excel', upload.single('file'), async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!req.file) return res.status(400).json({ error: 'Attach an .xlsx or .xls file in the multipart field named file' });
    const sheetRows = readXlsxRows(req.file.buffer);
    const headerRowIndex = sheetRows.findIndex((row) => row.map((cell) => String(cell ?? '').trim().toLowerCase()).includes('name') && row.map((cell) => String(cell ?? '').trim().toLowerCase()).some((cell) => ['phone', 'phone_number'].includes(cell)));
    if (headerRowIndex < 0) return res.status(400).json({ error: 'The spreadsheet must contain a header row with name and phone columns' });
    const headers = sheetRows[headerRowIndex].map((header) => String(header).trim());
    const rows = [];
    for (const row of sheetRows.slice(headerRowIndex + 1)) {
      if (row.every((cell) => String(cell ?? '').trim() === '')) break;
      rows.push(Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
    }
    if (!rows.length) return res.status(400).json({ error: 'The spreadsheet has no attendee rows' });
    const attendees = rows.map(spreadsheetAttendee);
    const invalidRows = attendees
      .map((attendee, index) => ({ attendee, row: index + 2 }))
      .filter(({ attendee }) => !attendee.name || !attendeeStatuses.has(attendee.status));
    if (invalidRows.length) {
      return res.status(400).json({ error: 'Invalid attendee spreadsheet rows', invalidRows: invalidRows.map(({ row }) => row) });
    }
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.attendee.createManyAndReturn({ data: attendees.map((attendee) => attendeeData(attendee, campaign.eventId, campaign.id)) });
      const allocation = await reserveInitialCampaignSeats(tx, campaign.id);
      const currentAttendees = await tx.attendee.findMany({ where: { id: { in: created.map((attendee) => attendee.id) } }, orderBy: { createdAt: 'asc' } });
      return { created: currentAttendees, allocation };
    });
    return res.status(201).json({ imported: result.created.length, attendees: result.created, allocation: result.allocation });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/attendees/copy-from/:sourceCampaignId', async (req, res, next) => {
  try {
    const targetCampaign = await getCampaign(req.params.campaignId, req.user.id);
    const sourceCampaign = await getCampaign(req.params.sourceCampaignId, req.user.id);
    if (!targetCampaign || !sourceCampaign) return res.status(404).json({ error: 'Campaign not found' });
    if (targetCampaign.eventId !== sourceCampaign.eventId) return res.status(400).json({ error: 'You can copy an audience only from another campaign in the same event' });
    if (targetCampaign.id === sourceCampaign.id) return res.status(400).json({ error: 'Choose a different source campaign' });
    const existingCount = await prisma.attendee.count({ where: { campaignId: targetCampaign.id } });
    if (existingCount) return res.status(409).json({ error: 'This campaign already has attendees. Start with a new campaign to copy a different audience.' });
    const sourceAttendees = await prisma.attendee.findMany({ where: { campaignId: sourceCampaign.id }, select: { name: true, phone: true, optedIn: true } });
    if (!sourceAttendees.length) return res.status(400).json({ error: 'The selected campaign has no attendees to copy' });
    const result = await prisma.$transaction(async (tx) => {
      const attendees = await tx.attendee.createManyAndReturn({ data: sourceAttendees.map((attendee) => ({ eventId: targetCampaign.eventId, campaignId: targetCampaign.id, name: attendee.name, phone: attendee.phone, optedIn: attendee.optedIn, status: 'INVITED', waitlistRank: null })) });
      const allocation = await reserveInitialCampaignSeats(tx, targetCampaign.id);
      const currentAttendees = await tx.attendee.findMany({ where: { id: { in: attendees.map((attendee) => attendee.id) } }, orderBy: { createdAt: 'asc' } });
      return { attendees: currentAttendees, allocation };
    });
    return res.status(201).json({ imported: result.attendees.length, attendees: result.attendees, allocation: result.allocation, sourceCampaign: { id: sourceCampaign.id, name: sourceCampaign.name }, message: 'Audience copied. Campaign outreach status has been reset to invited.' });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/attendees', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const where = { campaignId: campaign.id, ...(req.query.status ? { status: req.query.status } : {}) };
    return res.json({ attendees: await prisma.attendee.findMany({ where, include: { responses: { where: { campaignId: campaign.id }, take: 1, orderBy: { createdAt: 'desc' } }, seat: true }, orderBy: { createdAt: 'desc' } }) });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/attendees/:attendeeId', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId);
    const attendee = campaign && await prisma.attendee.findFirst({ where: { id: req.params.attendeeId, campaignId: campaign.id }, include: { responses: { where: { campaignId: campaign.id }, orderBy: { createdAt: 'desc' } }, callEvents: { where: { campaignId: campaign.id }, orderBy: { occurredAt: 'desc' } }, seat: true } });
    return attendee ? res.json({ attendee }) : res.status(404).json({ error: 'Attendee not found' });
  } catch (error) { return next(error); }
});

router.patch('/:campaignId/attendees/:attendeeId', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); const attendee = campaign && await prisma.attendee.findFirst({ where: { id: req.params.attendeeId, campaignId: campaign.id } });
    if (!attendee) return res.status(404).json({ error: 'Attendee not found' });
    const { name, phone, optedIn, status, waitlistRank } = req.body;
    if (status && !attendeeStatuses.has(status)) return res.status(400).json({ error: 'Invalid attendee status' });
    const updated = await prisma.attendee.update({ where: { id: attendee.id }, data: { ...(name ? { name } : {}), ...(phone !== undefined ? { phone } : {}), ...(typeof optedIn === 'boolean' ? { optedIn } : {}), ...(status ? { status } : {}), ...(Number.isInteger(waitlistRank) ? { waitlistRank } : {}) } });
    return res.json({ attendee: updated });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/responses', async (req, res, next) => {
  try { const payload = { ...req.body, campaign_id: req.params.campaignId }; const validationError = validateCallResult(payload); if (validationError) return res.status(400).json({ error: validationError }); const response = await saveCallResult(payload); return response ? res.status(201).json({ message: 'Response saved', response }) : res.status(404).json({ error: 'Campaign or attendee not found' }); } catch (error) { return next(error); }
});

router.get('/:campaignId/preferences-summary', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const responses = await prisma.response.findMany({ where: { campaignId: campaign.id } }); const count = (field) => responses.reduce((acc, item) => { const key = item[field] || 'not_provided'; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    return res.json({ totalResponses: responses.length, attendance: count('outcome'), transportModes: count('transportMode'), arrivalSlots: count('arrivalSlot'), foodPreferences: count('foodPreference'), escalations: responses.filter((item) => item.escalationFlag).length, accessibilityRequests: responses.filter((item) => item.accessibilityNeeds).length });
  } catch (error) { return next(error); }
});

router.get('/:campaignId/tasks', async (req, res, next) => { try { res.json({ tasks: await prisma.followUp.findMany({ where: { campaignId: req.params.campaignId }, include: { attendee: true }, orderBy: { createdAt: 'desc' } }) }); } catch (error) { next(error); } });
router.post('/:campaignId/tasks', async (req, res, next) => {
  try { const campaign = await getCampaign(req.params.campaignId); if (!campaign) return res.status(404).json({ error: 'Campaign not found' }); if (!isString(req.body.summary)) return res.status(400).json({ error: 'summary is required' }); const task = await prisma.followUp.create({ data: { eventId: campaign.eventId, campaignId: campaign.id, attendeeId: req.body.attendeeId || null, summary: req.body.summary, owner: req.body.owner || null, type: req.body.type || 'follow_up', private: req.body.private === true, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null } }); return res.status(201).json({ task }); } catch (error) { return next(error); }
});

router.get('/:campaignId/waitlist', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const [waitlist, offers, seats] = await Promise.all([
      prisma.attendee.findMany({ where: { campaignId: campaign.id, status: { in: ['WAITLISTED', 'OFFERED'] } }, orderBy: [{ waitlistRank: 'asc' }, { createdAt: 'asc' }] }),
      prisma.seatOffer.findMany({ where: { campaignId: campaign.id }, include: { attendee: true, seat: true }, orderBy: { createdAt: 'desc' } }),
      prisma.seat.findMany({ where: { eventId: campaign.eventId }, orderBy: { seatNumber: 'asc' } })
    ]);
    const pendingOffers = offers.filter((offer) => offer.status === 'PENDING');
    const summary = {
      capacity: campaign.event.capacity || seats.length,
      assigned: seats.filter((seat) => seat.status === 'ASSIGNED').length,
      reserved: seats.filter((seat) => seat.status === 'OFFERED').length,
      available: seats.filter((seat) => ['AVAILABLE', 'RELEASED'].includes(seat.status)).length,
      released: seats.filter((seat) => seat.status === 'RELEASED').length,
      queued: waitlist.filter((attendee) => attendee.status === 'WAITLISTED').length,
      pendingOffers: pendingOffers.length,
      callsRequested: pendingOffers.filter((offer) => offer.callRequestedAt).length,
      deliveryFailures: pendingOffers.filter((offer) => offer.callFailureReason).length
    };
    return res.json({ waitlist, offers, releasedSeats: seats.filter((seat) => seat.status === 'RELEASED'), summary });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/waitlist/recover', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const recovery = await reconcileCampaignWaitlist(campaign.id);
    await dispatchWaitlistRecovery(campaign.id);
    return res.json({
      message: recovery.offers.length ? `${recovery.offers.length} waitlist offer${recovery.offers.length === 1 ? '' : 's'} created and queued for Sarvam.` : 'Waitlist recovery is up to date. No unallocated seat and callable waitlisted attendee pair is available.',
      createdOffers: recovery.offers.length,
      expiredOffers: recovery.expiredOffers.length
    });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/waitlist/:attendeeId/offer', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.campaignId); const attendee = campaign && await prisma.attendee.findFirst({ where: { id: req.params.attendeeId, campaignId: campaign.id, status: { in: ['WAITLISTED', 'OFFERED'] } } });
    if (!campaign || !attendee) return res.status(404).json({ error: 'Eligible waitlisted attendee not found' });
    const seat = await prisma.seat.findFirst({ where: { eventId: campaign.eventId, status: { in: ['RELEASED', 'AVAILABLE'] } }, orderBy: { seatNumber: 'asc' } }); if (!seat) return res.status(409).json({ error: 'No released or available seat exists' });
    const offer = await prisma.$transaction(async (tx) => { const created = await tx.seatOffer.create({ data: { campaignId: campaign.id, attendeeId: attendee.id, seatId: seat.id, expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : new Date(Date.now() + 30 * 60 * 1000) }, include: { attendee: true, seat: true } }); await tx.seat.update({ where: { id: seat.id }, data: { attendeeId: attendee.id, status: 'OFFERED', releasedAt: null } }); await tx.attendee.update({ where: { id: attendee.id }, data: { status: 'OFFERED' } }); return created; });
    await dispatchWaitlistRecovery(campaign.id);
    return res.status(201).json({ offer });
  } catch (error) { return next(error); }
});

router.post('/:campaignId/seats/:seatId/release', async (req, res, next) => { try { const campaign = await getCampaign(req.params.campaignId); const seat = campaign && await prisma.seat.findFirst({ where: { id: req.params.seatId, eventId: campaign.eventId } }); if (!seat) return res.status(404).json({ error: 'Seat not found' }); const released = await prisma.seat.update({ where: { id: seat.id }, data: { status: 'RELEASED', attendeeId: null, releasedAt: new Date() } }); await dispatchWaitlistRecovery(campaign.id); return res.json({ seat: released }); } catch (error) { return next(error); } });

router.get('/:campaignId/activity', async (req, res, next) => { try { res.json({ activity: await prisma.callEvent.findMany({ where: { campaignId: req.params.campaignId }, include: { attendee: true }, orderBy: { occurredAt: 'desc' } }) }); } catch (error) { next(error); } });
router.post('/:campaignId/call-events', async (req, res, next) => { try { const campaign = await getCampaign(req.params.campaignId); const attendee = campaign && await prisma.attendee.findFirst({ where: { id: req.body.attendeeId, campaignId: campaign.id } }); if (!campaign || !attendee || !isString(req.body.eventType)) return res.status(400).json({ error: 'Valid attendeeId and eventType are required' }); const activity = await prisma.callEvent.create({ data: { eventId: campaign.eventId, campaignId: campaign.id, attendeeId: attendee.id, eventType: req.body.eventType, transcript: req.body.transcript || null, details: req.body.details || undefined } }); return res.status(201).json({ activity }); } catch (error) { return next(error); } });

module.exports = router;
