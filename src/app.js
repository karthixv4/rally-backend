const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const campaignRoutes = require('./routes/campaigns');
const voiceRoutes = require('./routes/voice');
const taskRoutes = require('./routes/tasks');

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
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

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
