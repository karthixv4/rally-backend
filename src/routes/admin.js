const express = require('express');
const prisma = require('../db/prisma');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// This endpoint intentionally returns user-level operational counts only. It
// never includes event, campaign, attendee, transcript, or call-result detail.
router.get('/overview', requireAdmin, async (_req, res, next) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        loginCount: true,
        events: {
          select: {
            id: true,
            campaigns: { select: { _count: { select: { responses: true } } } }
          }
        }
      },
      orderBy: [{ lastLoginAt: 'desc' }, { createdAt: 'desc' }]
    });

    const activity = users.map((user) => {
      const campaigns = user.events.reduce((total, event) => total + event.campaigns.length, 0);
      const capturedResults = user.events.reduce((total, event) => total + event.campaigns.reduce((count, campaign) => count + campaign._count.responses, 0), 0);
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        loginCount: user.loginCount,
        eventCount: user.events.length,
        campaignCount: campaigns,
        capturedResultCount: capturedResults
      };
    });

    const summary = {
      totalUsers: activity.length,
      activeUsersLast7Days: activity.filter((user) => user.lastLoginAt && user.lastLoginAt >= sevenDaysAgo).length,
      totalLogins: activity.reduce((total, user) => total + user.loginCount, 0),
      newUsersLast7Days: activity.filter((user) => user.createdAt >= sevenDaysAgo).length,
      totalEvents: activity.reduce((total, user) => total + user.eventCount, 0),
      totalCampaigns: activity.reduce((total, user) => total + user.campaignCount, 0),
      capturedResults: activity.reduce((total, user) => total + user.capturedResultCount, 0)
    };

    return res.json({ summary, users: activity });
  } catch (error) { return next(error); }
});

module.exports = router;
