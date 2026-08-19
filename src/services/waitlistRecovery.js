const prisma = require('../db/prisma');

const WAITLIST_CALLABLE = { status: 'WAITLISTED', optedIn: true, phone: { not: null } };
// Several completed calls for the same event can arrive at once. Recovery
// deliberately serialises their seat changes with an advisory lock, so the
// Prisma default five-second interactive-transaction limit is too short when
// another webhook is already reconciling that event.
const WAITLIST_TRANSACTION_TIMEOUT_MS = Math.max(10000, Number(process.env.WAITLIST_TRANSACTION_TIMEOUT_MS || 20000));
const WAITLIST_TRANSACTION_MAX_WAIT_MS = Math.max(5000, Number(process.env.WAITLIST_TRANSACTION_MAX_WAIT_MS || 15000));

function offerExpiry() {
  const minutes = Math.max(5, Number(process.env.WAITLIST_OFFER_EXPIRY_MINUTES || 30));
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function lockEventSeats(tx, eventId) {
  // A single event can have more than one Rally campaign. This inexpensive
  // Postgres transaction lock prevents two simultaneous call-result webhooks
  // from assigning the same physical event seat.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;
}

async function ensureSeatInventory(tx, event) {
  const capacity = Number(event.capacity || 0);
  if (!capacity) return [];

  const existing = await tx.seat.findMany({ where: { eventId: event.id }, select: { seatNumber: true } });
  const occupiedNumbers = new Set(existing.map((seat) => seat.seatNumber));
  const missing = Array.from({ length: capacity }, (_, index) => index + 1)
    .filter((seatNumber) => !occupiedNumbers.has(seatNumber))
    .map((seatNumber) => ({ eventId: event.id, seatNumber }));
  if (missing.length) await tx.seat.createMany({ data: missing, skipDuplicates: true });
  return tx.seat.findMany({ where: { eventId: event.id }, orderBy: { seatNumber: 'asc' } });
}

async function nextWaitlistRank(tx, campaignId) {
  const last = await tx.attendee.findFirst({
    where: { campaignId, waitlistRank: { not: null } },
    orderBy: { waitlistRank: 'desc' },
    select: { waitlistRank: true }
  });
  return (last?.waitlistRank || 0) + 1;
}

/**
 * Reserve the event's initial capacity for the campaign's invited audience.
 * The reservation prevents a 50-person import for a 30-seat event from
 * accidentally putting all 50 into the primary Sarvam call cohort.
 */
async function reserveInitialCampaignSeats(tx, campaignId) {
  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    include: { event: true }
  });
  if (!campaign?.event?.capacity) return { reserved: 0, movedToWaitlist: 0 };

  await lockEventSeats(tx, campaign.eventId);
  const seats = await ensureSeatInventory(tx, campaign.event);
  const invited = await tx.attendee.findMany({
    where: { campaignId, status: 'INVITED', seat: null },
    orderBy: { createdAt: 'asc' }
  });
  const freeSeats = seats.filter((seat) => seat.status === 'AVAILABLE');
  const reservable = invited.slice(0, freeSeats.length);
  const overflow = invited.slice(reservable.length);

  for (let index = 0; index < reservable.length; index += 1) {
    await tx.seat.update({
      where: { id: freeSeats[index].id },
      data: { attendeeId: reservable[index].id, status: 'OFFERED' }
    });
  }

  if (overflow.length) {
    let rank = await nextWaitlistRank(tx, campaignId);
    for (const attendee of overflow) {
      await tx.attendee.update({ where: { id: attendee.id }, data: { status: 'WAITLISTED', waitlistRank: rank } });
      rank += 1;
    }
  }

  return { reserved: reservable.length, movedToWaitlist: overflow.length };
}

async function createOfferForSeat(tx, campaign, seat) {
  const existingPendingOffer = await tx.seatOffer.findFirst({ where: { seatId: seat.id, status: 'PENDING' } });
  if (existingPendingOffer) return null;

  const attendee = await tx.attendee.findFirst({
    where: {
      campaignId: campaign.id,
      ...WAITLIST_CALLABLE,
      NOT: { seatOffers: { some: { status: 'PENDING' } } }
    },
    orderBy: [{ waitlistRank: 'asc' }, { createdAt: 'asc' }]
  });
  if (!attendee) return null;

  const expiresAt = offerExpiry();
  await tx.seat.update({ where: { id: seat.id }, data: { attendeeId: attendee.id, status: 'OFFERED', releasedAt: null } });
  await tx.attendee.update({ where: { id: attendee.id }, data: { status: 'OFFERED' } });
  const offer = await tx.seatOffer.create({
    data: { campaignId: campaign.id, attendeeId: attendee.id, seatId: seat.id, expiresAt },
    include: { attendee: true, seat: true, campaign: { include: { event: true } } }
  });
  await tx.callEvent.create({
    data: {
      eventId: campaign.eventId,
      campaignId: campaign.id,
      attendeeId: attendee.id,
      eventType: 'waitlist_offer_created',
      details: { seatOfferId: offer.id, seatNumber: seat.seatNumber, expiresAt: expiresAt.toISOString() }
    }
  });
  return offer;
}

async function expirePendingOffers(tx, campaign) {
  const expiredOffers = await tx.seatOffer.findMany({
    where: { campaignId: campaign.id, status: 'PENDING', expiresAt: { lte: new Date() } },
    include: { seat: true, attendee: true }
  });
  for (const offer of expiredOffers) {
    await tx.seatOffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED', respondedAt: new Date() } });
    await tx.attendee.update({ where: { id: offer.attendeeId }, data: { status: 'WAITLISTED' } });
    await tx.seat.update({ where: { id: offer.seatId }, data: { attendeeId: null, status: 'RELEASED', releasedAt: new Date() } });
    await tx.callEvent.create({
      data: {
        eventId: campaign.eventId,
        campaignId: campaign.id,
        attendeeId: offer.attendeeId,
        eventType: 'waitlist_offer_expired',
        details: { seatOfferId: offer.id, seatNumber: offer.seat.seatNumber }
      }
    });
  }
  return expiredOffers;
}

async function reconcileCampaignWaitlist(campaignId) {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, include: { event: true } });
    if (!campaign) return { offers: [], expiredOffers: [] };
    await lockEventSeats(tx, campaign.eventId);
    await ensureSeatInventory(tx, campaign.event);
    const expiredOffers = await expirePendingOffers(tx, campaign);
    const availableSeats = await tx.seat.findMany({
      where: { eventId: campaign.eventId, status: { in: ['AVAILABLE', 'RELEASED'] } },
      orderBy: { seatNumber: 'asc' }
    });
    const offers = [];
    for (const seat of availableSeats) {
      const offer = await createOfferForSeat(tx, campaign, seat);
      if (!offer) break;
      offers.push(offer);
    }
    return { offers, expiredOffers };
  }, {
    maxWait: WAITLIST_TRANSACTION_MAX_WAIT_MS,
    timeout: WAITLIST_TRANSACTION_TIMEOUT_MS
  });
}

async function applySeatDecision(tx, { campaign, attendee, outcome, payload }) {
  await lockEventSeats(tx, campaign.eventId);
  const activeOffer = await tx.seatOffer.findFirst({
    where: { campaignId: campaign.id, attendeeId: attendee.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    include: { seat: true }
  });
  const assignedSeat = await tx.seat.findUnique({ where: { attendeeId: attendee.id } });
  const substitute = String(payload.substitute_attendee || '').trim();

  if (outcome === 'confirmed') {
    const seat = activeOffer?.seat || assignedSeat || await tx.seat.findFirst({
      where: { eventId: campaign.eventId, status: { in: ['AVAILABLE', 'RELEASED'] } },
      orderBy: { seatNumber: 'asc' }
    });
    if (!seat) {
      await tx.followUp.create({
        data: {
          eventId: campaign.eventId,
          campaignId: campaign.id,
          attendeeId: attendee.id,
          type: 'capacity_conflict',
          summary: `${attendee.name} confirmed, but no event seat is available. Review capacity before confirming their allocation.`
        }
      });
      return { attendeeStatus: 'UNCERTAIN', capacityConflict: true, releasedSeat: false };
    }
    await tx.seat.update({ where: { id: seat.id }, data: { attendeeId: attendee.id, status: 'ASSIGNED', releasedAt: null } });
    if (activeOffer) await tx.seatOffer.update({ where: { id: activeOffer.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
    return { attendeeStatus: 'CONFIRMED', capacityConflict: false, releasedSeat: false };
  }

  if (outcome !== 'declined') return { attendeeStatus: outcome === 'uncertain' ? 'UNCERTAIN' : null, releasedSeat: false };

  if (activeOffer) {
    await tx.seatOffer.update({ where: { id: activeOffer.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    await tx.seat.update({ where: { id: activeOffer.seatId }, data: { attendeeId: null, status: 'RELEASED', releasedAt: new Date() } });
    return { attendeeStatus: 'WAITLISTED', releasedSeat: true, waitlistOfferDeclined: true };
  }

  // A substitute keeps the original allocation for organiser verification. If
  // the caller explicitly refuses a release we respect that too; otherwise a
  // decline with no substitute immediately returns the seat to the waitlist.
  const shouldRelease = !substitute && payload.seat_release !== 'no';
  if (shouldRelease && assignedSeat) {
    await tx.seat.update({ where: { id: assignedSeat.id }, data: { attendeeId: null, status: 'RELEASED', releasedAt: new Date() } });
  }
  if (substitute) {
    await tx.followUp.create({
      data: {
        eventId: campaign.eventId,
        campaignId: campaign.id,
        attendeeId: attendee.id,
        type: 'substitute_review',
        summary: `${attendee.name} declined and nominated ${substitute}. Verify the substitute before changing the roster.`
      }
    });
  }
  return { attendeeStatus: shouldRelease && assignedSeat ? 'RELEASED' : 'DECLINED', releasedSeat: Boolean(shouldRelease && assignedSeat), substitute: Boolean(substitute) };
}

async function listRecoveryDispatches(campaignId) {
  return prisma.seatOffer.findMany({
    where: { campaignId, status: 'PENDING', callRequestedAt: null },
    include: { attendee: true, seat: true, campaign: { include: { event: true } } },
    orderBy: { createdAt: 'asc' }
  });
}

module.exports = {
  applySeatDecision,
  ensureSeatInventory,
  listRecoveryDispatches,
  reconcileCampaignWaitlist,
  reserveInitialCampaignSeats
};
