require('dotenv').config();

const app = require('./app');

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`Rally backend listening on port ${port}`);
});

const shutdown = (signal) => {
  console.log(`${signal} received; shutting down gracefully.`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
