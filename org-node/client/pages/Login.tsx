import { useState } from 'react';
import { useNavigate } from 'react-router';
import { getBasePath } from '../api.js';

export default function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token.trim()) {
      // No token = dev mode, just go to dashboard
      localStorage.removeItem('enox_token');
      navigate('/');
      return;
    }

    localStorage.setItem('enox_token', token.trim());

    try {
      // Validate token against auth-protected metrics endpoint (lightweight)
      const res = await fetch(`${getBasePath()}/api/queue/stats`, {
        headers: { 'Authorization': `Bearer ${token.trim()}` },
      });
      if (res.ok) {
        navigate('/');
      } else if (res.status === 401 || res.status === 403) {
        setError('Invalid token');
        localStorage.removeItem('enox_token');
      } else {
        setError('Connection failed');
        localStorage.removeItem('enox_token');
      }
    } catch {
      setError('Cannot connect to server');
      localStorage.removeItem('enox_token');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold mb-1">Enox Graph Server</h1>
        <p className="text-sm text-gray-500 mb-6">Enter your auth token to continue</p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Auth token (empty for dev mode)"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
          <button
            type="submit"
            className="w-full mt-4 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}
