import express from 'express';
import { getDatabase } from '../database/init';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// Get player stats
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const userId = req.user.userId;

    const stats = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM player_stats WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!stats) {
      return res.status(404).json({ message: 'Player stats not found' });
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update player position
router.post('/position', authenticateToken, async (req, res) => {
  try {
    const { x, y, z } = req.body;
    const userId = req.user.userId;

    // TODO: Implement position saving logic
    // This will be implemented when we add the position tracking system

    res.json({ message: 'Position updated' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router; 