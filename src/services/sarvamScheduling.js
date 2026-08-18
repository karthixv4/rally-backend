const baseUrl = 'https://apps.sarvam.ai/api/scheduling/v1';
const outboundsBaseUrl = 'https://apps.sarvam.ai/api/outbounds/v1';
const defaultAllowedSchedule = {
  timezone: 'Asia/Kolkata',
  allowed_start_time: '09:00',
  allowed_end_time: '18:00',
  allowed_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
};

function config() {
  const required = ['SARVAM_SCHEDULING_API_KEY', 'SARVAM_ORG_ID', 'SARVAM_WORKSPACE_ID', 'SARVAM_APP_ID', 'SARVAM_CONNECTION_ID', 'SARVAM_CALLER_NUMBER'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing Sarvam scheduling configuration: ${missing.join(', ')}`);
  const { SARVAM_SCHEDULING_API_KEY: apiKey, SARVAM_ORG_ID: orgId, SARVAM_WORKSPACE_ID: workspaceId } = process.env;
  return { apiKey, orgId, workspaceId };
}

function campaignUrl(sarvamCampaignId = '') {
  const { orgId, workspaceId } = config();
  return `${baseUrl}/orgs/${orgId}/workspaces/${workspaceId}/campaigns${sarvamCampaignId ? `/${sarvamCampaignId}` : ''}`;
}

function outboundUrl() {
  const { orgId, workspaceId } = config();
  return `${outboundsBaseUrl}/orgs/${orgId}/workspaces/${workspaceId}/outbounds`;
}

function validateScheduleWindow(startTimestamp, endTimestamp) {
  const start = new Date(startTimestamp);
  const end = new Date(endTimestamp);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const error = new Error('Sarvam schedule timestamps must be valid ISO 8601 dates');
    error.status = 400;
    throw error;
  }
  if (end <= start) {
    const error = new Error('Sarvam schedule endTimestamp must be after startTimestamp');
    error.status = 400;
    throw error;
  }
  const leadMinutes = Number(process.env.SARVAM_MIN_LEAD_TIME_MINUTES || 10);
  const earliestStart = Date.now() + leadMinutes * 60 * 1000;
  if (start.getTime() < earliestStart) {
    const error = new Error(`Sarvam schedules need at least ${leadMinutes} minutes of lead time. Choose a start time after ${new Date(earliestStart).toISOString()}`);
    error.status = 400;
    throw error;
  }
  return { startTimestamp: start.toISOString(), endTimestamp: end.toISOString() };
}

async function sarvamFetch(url, options = {}) {
  const { apiKey } = config();
  const response = await fetch(url, { ...options, headers: { 'X-API-Key': apiKey, ...options.headers } });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const validationDetail = body?.error?.data || body?.detail;
    const detailText = validationDetail ? `: ${JSON.stringify(validationDetail)}` : '';
    const error = new Error(`Sarvam scheduling API returned ${response.status}${detailText}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function sarvamCampaignName(value) {
  // Sarvam accepts only ASCII word characters, spaces, and hyphens, up to 50 chars.
  // Keep the organiser's original name in Rally; this is only its external scheduler label.
  const normalized = String(value || 'Rally campaign')
    .replace(/[^A-Za-z0-9_\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  return normalized || 'Rally campaign';
}

function naturalEventDate(startsAt) {
  if (!startsAt) return 'the event date to be confirmed';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'Asia/Kolkata' }).format(new Date(startsAt));
}

function campaignCallBrief(campaign) {
  const sessionSlotOptions = Array.isArray(campaign.sessionSlotOptions) ? campaign.sessionSlotOptions : [];
  const parkingEnabled = campaign.parkingEnabled === true;
  return {
    event_name: campaign.event?.name || 'the event',
    event_date: naturalEventDate(campaign.event?.startsAt),
    event_venue: campaign.event?.venue || 'the venue to be confirmed',
    attendance_enabled: String(campaign.attendanceEnabled !== false),
    arrival_slot_enabled: String(sessionSlotOptions.length > 0),
    parking_enabled: String(parkingEnabled),
    food_enabled: String(campaign.foodEnabled === true),
    session_slot_options: sessionSlotOptions.join('; '),
    parking_question_rule: parkingEnabled
      ? 'Ask about parking only after confirmed attendance and only for a personal car, two-wheeler, bike, motorcycle, or scooter. Do not ask for metro, bus, train, auto, cab, taxi, ride share, walking, cycling, or another public/shared transport.'
      : 'Parking collection is disabled. Do not ask about parking.'
  };
}

function buildCohortCsv(campaign, attendees) {
  const brief = campaignCallBrief(campaign);
  const rows = [[
    'campaign_id', 'attendee_id', 'attendee_name', 'phone_number',
    'event_name', 'event_date', 'event_venue',
    'attendance_enabled', 'arrival_slot_enabled', 'parking_enabled', 'food_enabled',
    'session_slot_options', 'parking_question_rule',
    'call_type', 'seat_offer_id', 'seat_number', 'seat_offer_expires_at'
  ]];
  attendees.forEach((attendee) => rows.push([
    campaign.id,
    attendee.id,
    attendee.name,
    attendee.phone || '',
    brief.event_name,
    brief.event_date,
    brief.event_venue,
    brief.attendance_enabled,
    brief.arrival_slot_enabled,
    brief.parking_enabled,
    brief.food_enabled,
    brief.session_slot_options,
    brief.parking_question_rule,
    'primary_rsvp',
    '',
    '',
    ''
  ]));
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

const defaultCohortTransformation = {
  phone_number: { column_name: 'phone_number' },
  user_identifier: { column_name: 'attendee_id', required: true },
  // Every call receives one cohort row. These values are static for the campaign,
  // but copied to each row so Sarvam has them before the call starts.
  app_variables: {
    campaign_id: { column_name: 'campaign_id' },
    attendee_id: { column_name: 'attendee_id' },
    attendee_name: { column_name: 'attendee_name' },
    event_name: { column_name: 'event_name' },
    event_date: { column_name: 'event_date' },
    event_venue: { column_name: 'event_venue' },
    attendance_enabled: { column_name: 'attendance_enabled' },
    arrival_slot_enabled: { column_name: 'arrival_slot_enabled' },
    parking_enabled: { column_name: 'parking_enabled' },
    food_enabled: { column_name: 'food_enabled' },
    session_slot_options: { column_name: 'session_slot_options' },
    parking_question_rule: { column_name: 'parking_question_rule' },
    call_type: { column_name: 'call_type' },
    seat_offer_id: { column_name: 'seat_offer_id' },
    seat_number: { column_name: 'seat_number' },
    seat_offer_expires_at: { column_name: 'seat_offer_expires_at' }
  }
};

async function createScheduledCampaign(campaign, options) {
  const connectionId = options.connectionId || process.env.SARVAM_CONNECTION_ID;
  const callerNumber = options.callerNumber || process.env.SARVAM_CALLER_NUMBER;
  const { startTimestamp, endTimestamp } = validateScheduleWindow(options.startTimestamp, options.endTimestamp);
  const payload = {
    name: sarvamCampaignName(options.name || campaign.name),
    app_config: {
      app_id: options.appId || process.env.SARVAM_APP_ID,
      app_version: Number(options.appVersion || process.env.SARVAM_APP_VERSION || 1),
      app_type: 'agent',
      attempts_per_second: options.attemptsPerSecond || 2,
      connection_configs: [{ connection_id: connectionId, phone_numbers: [callerNumber] }],
      retry_config: options.retryConfig || {
        max_retries: 3,
        retry_interval_minutes: 30,
        retry_on: { busy: { enabled: true }, no_answer: { enabled: true }, short_duration: { enabled: true, threshold_seconds: 25 } }
      }
    },
    start_timestamp: startTimestamp,
    end_timestamp: endTimestamp,
    allowed_schedule: options.allowedSchedule || defaultAllowedSchedule
  };
  return sarvamFetch(campaignUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function uploadCohort(sarvamCampaignId, campaign, attendees, name, cohortTransformation = defaultCohortTransformation) {
  const form = new FormData();
  form.append('name', name);
  form.append('cohort_file', new Blob([buildCohortCsv(campaign, attendees)], { type: 'text/csv' }), 'rally-attendees.csv');
  form.append('cohort_transformation_file', new Blob([JSON.stringify(cohortTransformation)], { type: 'application/json' }), 'transform.json');
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/cohorts/upload`, { method: 'POST', body: form });
}

async function updateCampaignStatus(sarvamCampaignId, action) {
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
}

async function getCampaignStatus(sarvamCampaignId) {
  return sarvamFetch(campaignUrl(sarvamCampaignId));
}

function waitlistRecoveryEnabled() {
  return String(process.env.SARVAM_WAITLIST_RECOVERY_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * Waitlist recovery cannot reuse a bulk schedule: a seat becomes available
 * after a result arrives, and Sarvam schedules have a minimum lead time.
 * This uses Sarvam's outbound endpoint for one consented waitlisted attendee.
 */
async function requestWaitlistRecoveryCall(offer) {
  if (!waitlistRecoveryEnabled()) {
    return { queued: true, skipped: true, reason: 'SARVAM_WAITLIST_RECOVERY_ENABLED is not true' };
  }
  const { apiKey } = config();
  const campaign = offer.campaign;
  const brief = campaignCallBrief(campaign);
  const payload = {
    app_config: {
      app_id: process.env.SARVAM_APP_ID,
      app_version: Number(process.env.SARVAM_APP_VERSION || 1),
      app_type: 'agent',
      connection_config: {
        connection_id: process.env.SARVAM_CONNECTION_ID,
        agent_phone_number: process.env.SARVAM_CALLER_NUMBER
      },
      agent_variables: {
        campaign_id: campaign.id,
        attendee_id: offer.attendee.id,
        attendee_name: offer.attendee.name,
        event_name: brief.event_name,
        event_date: brief.event_date,
        event_venue: brief.event_venue,
        attendance_enabled: brief.attendance_enabled,
        arrival_slot_enabled: brief.arrival_slot_enabled,
        parking_enabled: brief.parking_enabled,
        food_enabled: brief.food_enabled,
        session_slot_options: brief.session_slot_options,
        parking_question_rule: brief.parking_question_rule,
        call_type: 'waitlist_recovery',
        seat_offer_id: offer.id,
        seat_number: String(offer.seat.seatNumber),
        seat_offer_expires_at: offer.expiresAt.toISOString()
      }
    },
    user_config: { user_phone_number: offer.attendee.phone }
  };
  const response = await fetch(outboundUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const error = new Error(`Sarvam waitlist outbound API returned ${response.status}${body ? `: ${JSON.stringify(body)}` : ''}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

module.exports = {
  createScheduledCampaign,
  updateCampaignStatus,
  getCampaignStatus,
  uploadCohort,
  requestWaitlistRecoveryCall,
  defaultAllowedSchedule,
  sarvamCampaignName
};
