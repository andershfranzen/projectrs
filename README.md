# ProjectRS

A RuneScape Classic-inspired game built with TypeScript, BabylonJS, and modern web technologies.

## Features

- 2.5D graphics using BabylonJS
- User authentication system
- SQLite3 database (with planned PostgreSQL migration)
- TypeScript for both frontend and backend
- Modern development environment with hot reloading

## Project Structure

```
projectrs/
├── client/           # Frontend application
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── game/         # Game-specific code
│   │   ├── scenes/       # BabylonJS scenes
│   │   ├── assets/       # Game assets
│   │   └── utils/        # Utility functions
│   └── public/      # Static assets
└── server/          # Backend application
    ├── src/
    │   ├── controllers/  # Route controllers
    │   ├── models/       # Database models
    │   ├── routes/       # API routes
    │   ├── services/     # Business logic
    │   └── utils/        # Utility functions
    └── database/    # Database files and migrations
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   cd client && npm install
   cd ../server && npm install
   ```

2. Start the development servers:
   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   ```

4. Start production server:
   ```bash
   npm start
   ```

## Development

- Frontend runs on: http://localhost:5173
- Backend API runs on: http://localhost:3000

## Technologies Used

- Frontend:
  - TypeScript
  - React
  - BabylonJS
  - Vite
  - TailwindCSS

- Backend:
  - TypeScript
  - Express.js
  - SQLite3
  - JWT for authentication 