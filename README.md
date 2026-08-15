# Rally backend

Express.js backend starter for Rally, an Event Readiness Agent. It uses JavaScript, Prisma, and PostgreSQL-compatible Neon.

The API accepts browser requests from `https://rally-frontend-nine.vercel.app` and any localhost port by default. Add other production origins as comma-separated values in `CORS_ORIGINS`.

## Run locally

1. Copy `.env.example` to `.env` and replace `DATABASE_URL` with your Neon pooled connection string.
2. Install dependencies: `npm install`
3. Create the database schema: `npx prisma migrate dev --name init`
4. Start the API: `npm run dev`

Check the service at `GET http://localhost:3000/health`.

## Core APIs

### Create a campaign

`POST /api/campaigns` persists the event, its campaign configuration, and optional attendees in one transaction.

```json
{
  "event": {
    "name": "Codex Community Build Hackathon",
    "startsAt": "2026-08-30T09:00:00.000Z",
    "venue": "Bengaluru",
    "parkingInstructions": "Use Gate 2",
    "helpContact": "+91 90000 00000",
    "capacity": 100
  },
  "campaign": {
    "name": "Final confirmation",
    "attendanceEnabled": true,
    "parkingEnabled": true,
    "foodEnabled": true,
    "languages": ["en", "hi", "kn"],
    "tone": "helpful"
  },
  "attendees": [
    { "name": "Ananya Rao", "phone": "+919000000000", "optedIn": true }
  ]
}
```

### Fetch voice call context

`POST /api/voice/call-context` is for the voice integration immediately before a call. It requires `Authorization: Bearer <SARVAM_WEBHOOK_SECRET>` and returns only the eligible attendee's safe, call-specific context.

```json
{ "campaignId": "campaign-id", "attendeeId": "attendee-id" }
```

Set `SARVAM_WEBHOOK_SECRET` in your environment. The Sarvam-side connector or your own voice worker must send it as a Bearer token; never expose it in the frontend.

### Temporary hardcoded Sarvam demo details

`GET /api/voice/demo-call-details` returns placeholder event and attendee values for a quick voice-agent demo. It uses the same Bearer-token protection and is intentionally marked for removal once `call-context` is used in production.

It also returns temporary `campaign_id` and `attendee_id` values. Configure Sarvam to retain those as call variables and include them in its later `POST /api/voice/call-results` payload.

### Store a Sarvam call result

`POST /api/voice/call-results` stores the normalized values Sarvam returns after a call. It requires the same Bearer token and accepts `campaign_id`, `attendee_id`, `attendance_status`, optional transport/arrival or decline fields, `escalation_flag`, and `call_summary`. A confirmed, declined, or uncertain outcome updates the attendee's operational status too.

Import `postman/Rally Voice Call Results.postman_collection.json` into Postman to test this flow. Before running it, add `DATABASE_URL` and `SARVAM_WEBHOOK_SECRET` to `.env`, run `npm run prisma:migrate -- --name init`, start `npm run dev`, then replace the collection's `sarvamSecret` variable with the same secret.

## Frontend REST API

All campaign endpoints use `:campaignId`. The API provides campaign list/create/read/update; attendee import/list/read/update; response submission and preference summaries; task list/create/update; waitlist offers and seat releases; and call activity list/create.

```text
GET, POST                         /api/campaigns
GET, PATCH                        /api/campaigns/:campaignId
POST                              /api/campaigns/:campaignId/attendees/import
GET                               /api/campaigns/:campaignId/attendees
GET, PATCH                        /api/campaigns/:campaignId/attendees/:attendeeId
POST                              /api/campaigns/:campaignId/responses
GET                               /api/campaigns/:campaignId/preferences-summary
GET, POST                         /api/campaigns/:campaignId/tasks
PATCH                             /api/tasks/:taskId
GET                               /api/campaigns/:campaignId/waitlist
POST                              /api/campaigns/:campaignId/waitlist/:attendeeId/offer
POST                              /api/campaigns/:campaignId/seats/:seatId/release
GET                               /api/campaigns/:campaignId/activity
POST                              /api/campaigns/:campaignId/call-events
```

The response endpoints accept the Sarvam call fields in `snake_case`: `attendance_status`, `transport_mode`, `arrival_slot`, `decline_reason`, `seat_release`, `substitute_attendee`, `escalation_flag`, `call_summary`, `food_preference`, `parking_needed`, `dietary_requirements`, `accessibility_needs`, `team_status`, and `transcript`.

## Sarvam scheduled calling

The backend keeps the Sarvam scheduling key server-side and exposes these Rally endpoints:

```text
POST /api/campaigns/:campaignId/sarvam/schedule
POST /api/campaigns/:campaignId/sarvam/cohort
PUT  /api/campaigns/:campaignId/sarvam/status
```

The schedule request needs `startTimestamp` and `endTimestamp` (ISO 8601); optional fields let the frontend override the Sarvam app, connection, caller number, retry configuration, and allowed schedule. The cohort request generates the CSV and Sarvam transformation mapping automatically. It supplies each row's phone number, `campaign_id`, and `attendee_id` to the agent. Status accepts `{ "action": "pause" }` or `{ "action": "resume" }`.

For the current demo, set `SARVAM_FORCE_DEMO_RECIPIENT=true` and `SARVAM_DEMO_RECIPIENT_PHONE=+918123011069`. Every uploaded cohort row will call that number rather than attendee phone numbers. Set the flag to `false` or remove both variables to restore normal attendee calling.

Example response:

```json
{
  "status": "ok",
  "service": "rally-backend",
  "timestamp": "2026-08-15T00:00:00.000Z",
  "uptimeSeconds": 1
}
```

## Initial data model

The Prisma schema includes events, configurable campaigns, opted-in attendees, normalized campaign responses, and private follow-ups. It supports the MVP flow from the brief: a configured readiness campaign records attendance, parking, and food answers, while declined attendees can be released for waitlist recovery.
