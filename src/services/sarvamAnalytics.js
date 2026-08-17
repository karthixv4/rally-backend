const analyticsBaseUrl = 'https://apps.sarvam.ai/api/analytics/v1';

function config() {
  const required = ['SARVAM_SCHEDULING_API_KEY', 'SARVAM_ORG_ID', 'SARVAM_WORKSPACE_ID', 'SARVAM_APP_ID'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing Sarvam analytics configuration: ${missing.join(', ')}`);
  return {
    apiKey: process.env.SARVAM_SCHEDULING_API_KEY,
    orgId: process.env.SARVAM_ORG_ID,
    workspaceId: process.env.SARVAM_WORKSPACE_ID,
    appId: process.env.SARVAM_APP_ID
  };
}

function analyticsUrl(path = '') {
  const { orgId, workspaceId, appId } = config();
  return `${analyticsBaseUrl}/${orgId}/${workspaceId}/${appId}${path}`;
}

async function analyticsFetch(url) {
  const { apiKey } = config();
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const error = new Error(`Sarvam analytics API returned ${response.status}${body ? `: ${JSON.stringify(body)}` : ''}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function validDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${name} must be a valid ISO 8601 datetime`);
    error.status = 400;
    throw error;
  }
  return date;
}

async function listAttempts({ startDatetime, endDatetime, maxPages = 5 }) {
  const start = validDate(startDatetime, 'startDatetime');
  const end = validDate(endDatetime, 'endDatetime');
  if (end <= start) {
    const error = new Error('endDatetime must be after startDatetime');
    error.status = 400;
    throw error;
  }

  const attempts = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(analyticsUrl('/attempts'));
    url.searchParams.set('start_datetime', start.toISOString());
    url.searchParams.set('end_datetime', end.toISOString());
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    const payload = await analyticsFetch(url);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    attempts.push(...items);
    if (!payload?.next_page_uri || !items.length) break;
    offset += items.length;
  }
  return attempts;
}

async function getTranscript(interactionId) {
  if (!interactionId) {
    const error = new Error('interactionId is required');
    error.status = 400;
    throw error;
  }
  return analyticsFetch(analyticsUrl(`/transcripts/${encodeURIComponent(interactionId)}`));
}

module.exports = { getTranscript, listAttempts };
