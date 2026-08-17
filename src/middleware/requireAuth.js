const jwt = require('jsonwebtoken');

function jwtSecret() {
  if (!process.env.JWT_SECRET) {
    const error = new Error('JWT_SECRET is not configured');
    error.status = 500;
    throw error;
  }
  return process.env.JWT_SECRET;
}

function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      const error = new Error('Authentication is required');
      error.status = 401;
      throw error;
    }
    const payload = jwt.verify(token, jwtSecret());
    if (!payload?.sub) {
      const error = new Error('Invalid authentication token');
      error.status = 401;
      throw error;
    }
    req.user = { id: payload.sub, email: payload.email, name: payload.name || null };
    return next();
  } catch (error) {
    if (!error.status) error.status = 401;
    return next(error);
  }
}

module.exports = { requireAuth, jwtSecret };
