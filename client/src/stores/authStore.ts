import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import axios from 'axios';

interface User {
  id: number;
  username: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (username: string, password: string) => {
        try {
          const response = await axios.post('/api/auth/login', {
            username,
            password,
          });

          const { token, username: responseUsername } = response.data;

          set({
            user: { id: 0, username: responseUsername }, // TODO: Get actual user ID
            token,
            isAuthenticated: true,
          });

          // Set default authorization header
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        } catch (error) {
          throw new Error('Login failed');
        }
      },

      register: async (username: string, password: string, email: string) => {
        try {
          await axios.post('/api/auth/register', {
            username,
            password,
            email,
          });
        } catch (error) {
          throw new Error('Registration failed');
        }
      },

      logout: () => {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        });
        delete axios.defaults.headers.common['Authorization'];
      },
    }),
    {
      name: 'auth-storage',
    }
  )
); 