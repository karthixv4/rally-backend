const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const campaignRoutes = require('./routes/campaigns');
const voiceRoutes = require('./routes/voice');
const taskRoutes = require('./routes/tasks');
const sarvamSchedulingRoutes = require('./routes/sarvamScheduling');

const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || 'https://rally-frontend-nine.vercel.app')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const isLocalOrigin = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const corsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header include direct API calls, health checks, and Sarvam webhooks.
    if (!origin || configuredOrigins.includes(origin) || isLocalOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.disable('x-powered-by');
app.use(helmet());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'rally-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.use('/api/campaigns', campaignRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/campaigns', sarvamSchedulingRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err.details ? `${err.stack}\nSarvam response: ${JSON.stringify(err.details, null, 2)}` : err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const details = err.details?.error?.data;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    ...(details ? { details } : {})
  });
});

module.exports = app;
