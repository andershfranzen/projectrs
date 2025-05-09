import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getDatabase } from '../database/init';

const router = express.Router();

// Validation schemas
const registerSchema = z.object({
  username: z.string().min(3).max(20),
  password: z.string().min(6),
  email: z.string().email(),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { username, password, email } = registerSchema.parse(req.body);
    const db = getDatabase();

    // Check if user already exists
    const existingUser = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existingUser) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert new user
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)',
        [username, passwordHash, email],
        function(err) {
          if (err) reject(err);
          else {
            // Create initial player stats
            db.run(
              'INSERT INTO player_stats (user_id) VALUES (?)',
              [this.lastID],
              (err) => {
                if (err) reject(err);
                else resolve(this.lastID);
              }
            );
          }
        }
      );
    });

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid input', errors: error.errors });
    }
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const db = getDatabase();

    // Get user
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Update last login
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id], (err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({ token, username: user.username });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid input', errors: error.errors });
    }
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router; 