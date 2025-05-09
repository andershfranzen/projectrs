import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import Login from './components/auth/Login';
import Register from './components/auth/Register';
import Game from './components/game/Game';
import Layout from './components/layout/Layout';
import { GameComponent } from './components/Game';

function App() {
  const { isAuthenticated } = useAuthStore();

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route
            index
            element={
              isAuthenticated ? (
                <Navigate to="/game" replace />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="login"
            element={
              isAuthenticated ? <Navigate to="/game" replace /> : <Login />
            }
          />
          <Route
            path="register"
            element={
              isAuthenticated ? <Navigate to="/game" replace /> : <Register />
            }
          />
          <Route
            path="game"
            element={
              isAuthenticated ? <GameComponent /> : <Navigate to="/login" replace />
            }
          />
        </Route>
      </Routes>
    </Router>
  );
}

export default App; 