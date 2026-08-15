const express = require('express');
const prisma = require('../db/prisma');

const router = express.Router();

router.patch('/:taskId', async (req, res, next) => {
  try {
    const task = await prisma.followUp.findUnique({ where: { id: req.params.taskId } });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { summary, owner, private: isPrivate, dueAt, status, type } = req.body;
    if (status && !['OPEN', 'COMPLETED'].includes(status)) return res.status(400).json({ error: 'status must be OPEN or COMPLETED' });
    const updated = await prisma.followUp.update({
      where: { id: task.id },
      data: {
        ...(summary ? { summary } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(typeof isPrivate === 'boolean' ? { private: isPrivate } : {}),
        ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status, completedAt: status === 'COMPLETED' ? new Date() : null } : {})
      }
    });
    return res.json({ task: updated });
  } catch (error) { return next(error); }
});

module.exports = router;
