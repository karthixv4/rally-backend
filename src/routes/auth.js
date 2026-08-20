const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');
const { requireAuth, jwtSecret } = require('../middleware/requireAuth');

const router = express.Router();

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function adminEmails() {
  return new Set(String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => cleanEmail(email))
    .filter(Boolean));
}

function roleForEmail(email) {
  return adminEmails().has(cleanEmail(email)) ? 'ADMIN' : 'USER';
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt };
}

function issueToken(user) {
  return jwt.sign({ email: user.email, name: user.name || undefined, role: user.role }, jwtSecret(), { subject: user.id, expiresIn: '7d' });
}

router.post('/signup', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim() || null;
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: 'An account already exists for this email' });
    const user = await prisma.user.create({ data: { email, name, passwordHash: await bcrypt.hash(password, 12), role: roleForEmail(email), loginCount: 1, lastLoginAt: new Date() } });
    return res.status(201).json({ user: publicUser(user), token: issueToken(user) });
  } catch (error) { return next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { email: cleanEmail(req.body.email) } });
    const valid = user && await bcrypt.compare(String(req.body.password || ''), user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Email or password is incorrect' });
    const authenticatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { role: roleForEmail(user.email), loginCount: { increment: 1 }, lastLoginAt: new Date() }
    });
    return res.json({ user: publicUser(authenticatedUser), token: issueToken(authenticatedUser) });
  } catch (error) { return next(error); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    const assignedRole = roleForEmail(user.email);
    const currentUser = user.role === assignedRole ? user : await prisma.user.update({ where: { id: user.id }, data: { role: assignedRole } });
    return res.json({ user: publicUser(currentUser) });
  } catch (error) { return next(error); }
});

module.exports = router;
