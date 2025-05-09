import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { initializeDatabase } from './database/init';
import authRoutes from './routes/auth';
import gameRoutes from './routes/game';
import { WorldManager } from './game/world/WorldManager';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:5173', // Your client's URL
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize world manager
const worldManager = new WorldManager(io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Initialize database and start server
initializeDatabase().then(() => {
  httpServer.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
}); 