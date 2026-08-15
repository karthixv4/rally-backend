function requireSarvamSecret(req, res, next) {
  const configuredSecret = process.env.SARVAM_WEBHOOK_SECRET;
  const authorization = req.get('authorization');
  const token = authorization && authorization.replace(/^Bearer\s+/i, '');

  if (!configuredSecret) {
    return res.status(503).json({ error: 'Voice integration is not configured' });
  }

  if (token !== configuredSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = requireSarvamSecret;
