# Rally backend

Express.js backend starter for Rally, an Event Readiness Agent. It uses JavaScript, Prisma, and PostgreSQL-compatible Neon.

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
