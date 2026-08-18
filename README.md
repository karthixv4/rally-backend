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

For a GET-based Sarvam tool, use `GET /api/voice/call-context?campaign_id={{campaign_id}}&attendee_id={{attendee_id}}` with the same Bearer token. The `campaign_id` and `attendee_id` inputs come from the scheduled cohort mapping; no hardcoded event, attendee, or phone values are used.

### Sarvam agent configuration

The Sarvam agent needs one **start-of-call HTTP GET tool** named, for example, `get_rally_call_context`:

```text
GET https://<your-rally-backend>/api/voice/call-context?campaign_id={{campaign_id}}&attendee_id={{attendee_id}}
Authorization: Bearer <SARVAM_WEBHOOK_SECRET>
```

Declare `campaign_id` and `attendee_id` as agent input variables. Rally's scheduled cohort upload populates both values for each attendee. In the agent's initial state/instructions, require this tool to run before the greeting and tell the agent to use the returned `event_name`, `event_date`, `event_venue`, `attendee_name`, and `session_slot_options`. Do not use `/api/voice/demo-call-details`; it was a temporary hard-coded endpoint and cannot identify a live campaign.

### Store a Sarvam call result

`POST /api/voice/call-results` stores the normalized values Sarvam returns after a call. It requires the same Bearer token and accepts `campaign_id`, `attendee_id`, `attendance_status`, optional transport/arrival or decline fields, `escalation_flag`, and `call_summary`. A confirmed, declined, or uncertain outcome updates the attendee's operational status too.

Import `postman/Rally Voice Call Results.postman_collection.json` into Postman to test this flow. Before running it, add `DATABASE_URL` and `SARVAM_WEBHOOK_SECRET` to `.env`, run `npm run prisma:migrate -- --name init`, start `npm run dev`, then replace the collection's `sarvamSecret` variable with the same secret.

## Frontend REST API

All campaign endpoints use `:campaignId`. The API provides campaign list/create/read/update; attendee import/list/read/update; response submission and preference summaries; task list/create/update; waitlist offers and seat releases; and call activity list/create.

```text
GET, POST                         /api/campaigns
GET, PATCH                        /api/campaigns/:campaignId
POST                              /api/campaigns/:campaignId/attendees/import
POST                              /api/campaigns/:campaignId/attendees/import-excel
GET                               /api/campaigns/:campaignId/attendees
GET, PATCH                        /api/campaigns/:campaignId/attendees/:attendeeId
POST                              /api/campaigns/:campaignId/responses
GET                               /api/campaigns/:campaignId/preferences-summary
GET, POST                         /api/campaigns/:campaignId/tasks
PATCH                             /api/tasks/:taskId
GET                               /api/campaigns/:campaignId/waitlist
POST                              /api/campaigns/:campaignId/waitlist/:attendeeId/offer
POST                              /api/campaigns/:campaignId/seats/:seatId/release
POST                              /api/campaigns/:campaignId/waitlist/recover
GET                               /api/campaigns/:campaignId/activity
POST                              /api/campaigns/:campaignId/call-events
```

The response endpoints accept the Sarvam call fields in `snake_case`: `attendance_status`, `transport_mode`, `arrival_slot`, `decline_reason`, `seat_release`, `substitute_attendee`, `escalation_flag`, `call_summary`, `food_preference`, `parking_needed`, `dietary_requirements`, `accessibility_needs`, `team_status`, and `transcript`.

## Waitlist recovery

Rally treats event capacity as a shared, physical seat inventory. On import, the first non-waitlisted invitees reserve the available event seats; overflow invitees are safely moved to `WAITLISTED` in import order (or retain their supplied `waitlistRank`). The bulk Sarvam campaign includes only `INVITED` attendees, never waitlisted, offered, confirmed, or released people.

When a primary attendee declines without naming a substitute, Rally releases their reservation, assigns that exact seat to the next opted-in, phone-consented waitlisted attendee, and creates a 30-minute offer. A confirmed recovery call accepts the offer and assigns the seat. A decline or expiry releases it and moves to the next person. Explicit `seat_release: no` and any named substitute prevent automatic release and create an organiser follow-up instead.

Set `SARVAM_WAITLIST_RECOVERY_ENABLED=true` only after publishing the agent variables below. Rally then uses Sarvam's immediate outbound API for the recovery call; a failed outbound is stored as a visible task and can be retried from **Waitlist recovery** using `POST /api/campaigns/:campaignId/waitlist/recover`.

Add these **input variables** to the Sarvam agent and publish a new version before enabling recovery:

```text
call_type
seat_offer_id
seat_number
seat_offer_expires_at
```

The normal cohort provides `call_type=primary_rsvp`. A recovery outbound provides `call_type=waitlist_recovery` plus the offer details. In the agent, branch before the usual RSVP flow:

```text
If call_type is waitlist_recovery:
  Say a place has opened for {{event_name}} and ask whether the attendee wants it.
  Do not run the normal attendance/parking/arrival questionnaire unless they accept.
  On acceptance set attendance_status=confirmed.
  On decline set attendance_status=declined.
  Include campaign_id, attendee_id, and seat_offer_id in the post-call result body.
```

`seat_offer_id` is kept in Rally's audit trail and lets the recovery result be matched to the reserved seat. It should be mapped through the Sarvam post-call HTTP tool just like `campaign_id` and `attendee_id`.

### Demo XLSX attendee import

Upload `demo-assets/Rally_Attendee_Import_Template.xlsx` as multipart form-data to `POST /api/campaigns/:campaignId/attendees/import-excel`, using the field name `file`. The importer accepts the template's `name`, `phone`, `optedIn`, `status`, and `waitlistRank` columns, skips the template title/instructions, and validates every attendee row before saving any of them.

## Sarvam scheduled calling

The backend keeps the Sarvam scheduling key server-side and exposes these Rally endpoints:

```text
POST /api/campaigns/:campaignId/sarvam/schedule
POST /api/campaigns/:campaignId/sarvam/cohort
POST /api/campaigns/:campaignId/sarvam/launch
PUT  /api/campaigns/:campaignId/sarvam/status
```

The schedule request needs `startTimestamp` and `endTimestamp` (ISO 8601); optional fields let the frontend override the Sarvam app, connection, caller number, retry configuration, and allowed schedule. The cohort request generates the CSV and Sarvam transformation mapping automatically. It supplies each row's phone number, `campaign_id`, and `attendee_id` to the agent. Status accepts `{ "action": "pause" }` or `{ "action": "resume" }`.

For the frontend's single **Launch campaign** action, call `POST /api/campaigns/:campaignId/sarvam/launch` with `startTimestamp` and `endTimestamp`. It creates the Sarvam scheduled campaign if needed, uploads eligible attendees, and sets Rally campaign state to `ACTIVE` only after both steps succeed.

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
