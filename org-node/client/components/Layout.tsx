import { Outlet, NavLink, Navigate, useLocation } from 'react-router';
import { isAuthenticated } from '../api.js';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/explore', label: 'Explorer' },
  { to: '/graph', label: 'Graph' },
  { to: '/queue', label: 'Queue' },
  { to: '/perspectives', label: 'Perspectives' },
  { to: '/pipelines', label: 'Pipelines' },
  { to: '/metrics', label: 'Metrics' },
];

export default function Layout() {
  const location = useLocation();
  const isGraphPage = location.pathname === '/graph';

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Sidebar */}
      <nav className="w-56 shrink-0 bg-gray-900 text-gray-300 flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-lg font-bold text-white">Enox</h1>
          <p className="text-xs text-gray-500">Graph Server</p>
        </div>
        <div className="flex-1 py-2">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm ${isActive ? 'bg-gray-800 text-white border-l-2 border-blue-500' : 'hover:bg-gray-800 hover:text-white'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={() => { localStorage.removeItem('enox_token'); window.location.href = '/login'; }}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Main content — no padding for full-bleed pages like Graph */}
      <main className={`flex-1 overflow-auto ${isGraphPage ? '' : 'p-6'}`}>
        <Outlet />
      </main>
    </div>
  );
}
