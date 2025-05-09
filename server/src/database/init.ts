import sqlite3 from 'sqlite3';
import { Database } from 'sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database;

export const initializeDatabase = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const dbDir = path.join(__dirname, '../../database');
    const dbPath = path.join(dbDir, 'game.db');
    
    // Create database directory if it doesn't exist
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Create users table
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME
        )
      `, (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Create player_stats table
        db.run(`
          CREATE TABLE IF NOT EXISTS player_stats (
            user_id INTEGER PRIMARY KEY,
            level INTEGER DEFAULT 1,
            experience INTEGER DEFAULT 0,
            health INTEGER DEFAULT 10,
            max_health INTEGER DEFAULT 10,
            FOREIGN KEY (user_id) REFERENCES users(id)
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    });
  });
};

export const getDatabase = (): Database => {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}; 