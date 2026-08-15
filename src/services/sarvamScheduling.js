const baseUrl = 'https://apps.sarvam.ai/api/scheduling/v1';

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

async function sarvamFetch(url, options = {}) {
  const { apiKey } = config();
  const response = await fetch(url, { ...options, headers: { 'X-API-Key': apiKey, ...options.headers } });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const error = new Error(`Sarvam scheduling API returned ${response.status}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildCohortCsv(campaignId, attendees) {
  const rows = [['attendee_id', 'attendee_name', 'phone_number', 'campaign_id']];
  attendees.forEach((attendee) => rows.push([attendee.id, attendee.name, attendee.phone || '', campaignId]));
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

const defaultCohortTransformation = {
  phone_number: { column_name: 'phone_number' },
  user_identifier: { column_name: 'attendee_id', required: true },
  app_variables: {
    campaign_id: { column_name: 'campaign_id' },
    attendee_id: { column_name: 'attendee_id' }
  }
};

async function createScheduledCampaign(campaign, options) {
  const connectionId = options.connectionId || process.env.SARVAM_CONNECTION_ID;
  const callerNumber = options.callerNumber || process.env.SARVAM_CALLER_NUMBER;
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
    start_timestamp: options.startTimestamp,
    end_timestamp: options.endTimestamp,
    allowed_schedule: options.allowedSchedule || { timezone: 'Asia/Kolkata', allowed_start_time: '09:00', allowed_end_time: '18:00', allowed_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }
  };
  return sarvamFetch(campaignUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function uploadCohort(sarvamCampaignId, campaignId, attendees, name, cohortTransformation = defaultCohortTransformation) {
  const form = new FormData();
  form.append('name', name);
  form.append('cohort_file', new Blob([buildCohortCsv(campaignId, attendees)], { type: 'text/csv' }), 'rally-attendees.csv');
  form.append('cohort_transformation_file', new Blob([JSON.stringify(cohortTransformation)], { type: 'application/json' }), 'transform.json');
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/cohorts/upload`, { method: 'POST', body: form });
}

async function updateCampaignStatus(sarvamCampaignId, action) {
  return sarvamFetch(`${campaignUrl(sarvamCampaignId)}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
}

module.exports = { createScheduledCampaign, updateCampaignStatus, uploadCohort };
