import { Routes, Route, Navigate } from 'react-router';
import Layout from './components/Layout.js';
import Dashboard from './pages/Dashboard.js';
import Timeline from './pages/Timeline.js';
import Explorer from './pages/Explorer.js';
import Queue from './pages/Queue.js';
import Perspectives from './pages/Perspectives.js';
import Pipelines from './pages/Pipelines.js';
import Metrics from './pages/Metrics.js';
import Login from './pages/Login.js';
import Graph from './pages/Graph.js';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="/explore" element={<Explorer />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/perspectives" element={<Perspectives />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/metrics" element={<Metrics />} />
        <Route path="/graph" element={<Graph />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
