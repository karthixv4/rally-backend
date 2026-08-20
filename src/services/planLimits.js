const FREE_EVENT_LIMIT = 1;
const FREE_CAMPAIGN_LIMIT_PER_EVENT = 2;

function isAdmin(user) {
  return user?.role === 'ADMIN';
}

function planError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

async function lockUserQuota(tx, userId) {
  // Serialise quota checks for a user so two simultaneous browser requests
  // cannot both pass a count-based limit.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}

async function assertCanCreateEvent(tx, user) {
  if (isAdmin(user)) return;
  await lockUserQuota(tx, user.id);
  const eventCount = await tx.event.count({ where: { userId: user.id } });
  if (eventCount >= FREE_EVENT_LIMIT) {
    throw planError('Currently, the free plan supports one event per user. Delete your existing event before creating a new one.');
  }
}

async function assertCanCreateCampaign(tx, eventId, user) {
  if (isAdmin(user)) return;
  await lockUserQuota(tx, user.id);
  const campaignCount = await tx.campaign.count({ where: { eventId } });
  if (campaignCount >= FREE_CAMPAIGN_LIMIT_PER_EVENT) {
    throw planError('Currently, the free plan supports up to two campaigns per event. Delete an existing campaign before creating another one.');
  }
}

module.exports = { assertCanCreateCampaign, assertCanCreateEvent, FREE_CAMPAIGN_LIMIT_PER_EVENT, FREE_EVENT_LIMIT };
