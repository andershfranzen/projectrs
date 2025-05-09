import { Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export default function Layout() {
  const navigate = useNavigate();
  const { isAuthenticated, logout, user } = useAuthStore();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-900">
      {isAuthenticated && (
        <nav className="bg-gray-800 shadow-lg">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center">
                <div className="text-white font-bold text-xl">ProjectRS</div>
              </div>
              <div className="flex items-center">
                <span className="text-gray-300 mr-4">
                  Welcome, {user?.username}
                </span>
                <button
                  onClick={handleLogout}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </nav>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
} 