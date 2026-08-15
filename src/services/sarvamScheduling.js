const baseUrl = 'https://apps.sarvam.ai/api/scheduling/v1';
const outboundBaseUrl = 'https://apps.sarvam.ai/api/outbounds/v1';

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
  return `${outboundBaseUrl}/orgs/${orgId}/workspaces/${workspaceId}/outbounds`;
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

function buildCohortCsv(attendees) {
  const rows = [['attendee_id', 'attendee_name', 'phone_number']];
  const useDemoRecipient = process.env.SARVAM_FORCE_DEMO_RECIPIENT === 'true';
  const demoRecipient = process.env.SARVAM_DEMO_RECIPIENT_PHONE;
  if (useDemoRecipient && !demoRecipient) {
    throw new Error('SARVAM_DEMO_RECIPIENT_PHONE is required when SARVAM_FORCE_DEMO_RECIPIENT is true');
  }
  attendees.forEach((attendee) => rows.push([
    attendee.id,
    attendee.name,
    useDemoRecipient ? demoRecipient : attendee.phone || ''
  ]));
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

const defaultCohortTransformation = {
  phone_number: { column_name: 'phone_number' },
  // This associates Sarvam's cohort row with Rally without exposing it as an agent variable.
  user_identifier: { column_name: 'attendee_id', required: true }
};

async function createScheduledCampaign(campaign, options) {
  const connectionId = options.connectionId || process.env.SARVAM_CONNECTION_ID;
  const callerNumber = options.callerNumber || process.env.SARVAM_CALLER_NUMBER;
  const { startTimestamp, endTimestamp } = validateScheduleWindow(options.startTimestamp, options.endTimestamp);
  const payload = {
    name: options.name || campaign.name,
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
    allowed_schedule: options.allowedSchedule || { timezone: 'Asia/Kolkata', allowed_start_time: '09:00', allowed_end_time: '18:00', allowed_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }
  };
  return sarvamFetch(campaignUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function uploadCohort(sarvamCampaignId, attendees, name, cohortTransformation = defaultCohortTransformation) {
  const form = new FormData();
  form.append('name', name);
  form.append('cohort_file', new Blob([buildCohortCsv(attendees)], { type: 'text/csv' }), 'rally-attendees.csv');
  form.append('cohort_transformation_file', new Blob([JSON.stringify(cohortTransformation)], { type: 'application/json' }), 'transform.json');
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/cohorts/upload`, { method: 'POST', body: form });
}

async function updateCampaignStatus(sarvamCampaignId, action) {
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
}

function formatEventDate(startsAt) {
  if (!startsAt) return 'the event date to be confirmed';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'Asia/Kolkata' }).format(new Date(startsAt));
}

function outboundRecipient(attendee) {
  if (process.env.SARVAM_FORCE_DEMO_RECIPIENT === 'true') {
    if (!process.env.SARVAM_DEMO_RECIPIENT_PHONE) throw new Error('SARVAM_DEMO_RECIPIENT_PHONE is required when SARVAM_FORCE_DEMO_RECIPIENT is true');
    return process.env.SARVAM_DEMO_RECIPIENT_PHONE;
  }
  if (!attendee.phone) {
    const error = new Error('The selected attendee has no phone number');
    error.status = 400;
    throw error;
  }
  return attendee.phone;
}

function outboundWebhookConfig(campaign, attendee) {
  const url = process.env.SARVAM_OUTBOUND_WEBHOOK_URL
    || process.env.PUBLIC_API_URL && `${process.env.PUBLIC_API_URL.replace(/\/$/, '')}/api/voice/call-results`
    || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}/api/voice/call-results`;
  const token = process.env.SARVAM_OUTBOUND_WEBHOOK_TOKEN || process.env.SARVAM_WEBHOOK_SECRET;
  if (!url || !token) {
    const error = new Error('Set SARVAM_OUTBOUND_WEBHOOK_URL (or PUBLIC_API_URL) and a webhook token before making an immediate outbound call');
    error.status = 500;
    throw error;
  }
  const callbackUrl = new URL(url);
  callbackUrl.searchParams.set('token', token);
  return { url: callbackUrl.toString(), metadata: { lead_id: attendee.id, campaign_id: campaign.id, attendee_id: attendee.id } };
}

async function triggerImmediateCall(campaign, attendee) {
  const connectionId = process.env.SARVAM_CONNECTION_ID;
  const callerNumber = process.env.SARVAM_CALLER_NUMBER;
  const sessionSlots = Array.isArray(campaign.sessionSlotOptions) && campaign.sessionSlotOptions.length
    ? campaign.sessionSlotOptions.join(', ')
    : 'No session preference is required.';
  const initialBotMessage = process.env.SARVAM_INITIAL_BOT_MESSAGE;
  const initialStateName = process.env.SARVAM_INITIAL_STATE_NAME;
  const payload = {
    app_config: {
      app_id: process.env.SARVAM_APP_ID,
      app_version: Number(process.env.SARVAM_OUTBOUND_APP_VERSION || 2),
      app_type: 'agent',
      connection_config: { connection_id: connectionId, agent_phone_number: callerNumber },
      agent_variables: {
        arrival_slot: '', attendance_status: '', attendee_name: attendee.name, call_summary: '', decline_reason: '', escalation_flag: '',
        event_date: formatEventDate(campaign.event.startsAt), event_name: campaign.event.name, event_venue: campaign.event.venue || 'the venue to be confirmed',
        gender: '', seat_release: '', session_slot_options: sessionSlots, substitute_attendee: '', transport_mode: '',
        // The demo agent fetches hardcoded campaign and attendee details from Rally at call start.
        // Do not add campaign_id or attendee_id here: they are not configured app variables in Sarvam.
      },
      ...(initialBotMessage || initialStateName ? { app_overrides: { ...(initialBotMessage ? { initial_bot_message: initialBotMessage } : {}), ...(initialStateName ? { initial_state_name: initialStateName } : {}) } } : {})
    },
    user_config: { user_phone_number: outboundRecipient(attendee) },
    webhook_config: outboundWebhookConfig(campaign, attendee)
  };
  return sarvamFetch(outboundUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

module.exports = { createScheduledCampaign, updateCampaignStatus, uploadCohort, triggerImmediateCall };
