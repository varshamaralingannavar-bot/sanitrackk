import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { db, initDatabase, hashPassword, verifyPassword } from './server/db.ts';
import {
  signToken,
  optionalAuth,
  requireAuth,
  requireRole,
  type AuthedRequest,
  type UserRole,
} from './server/auth.ts';
import { classifyWasteImage, processVoiceAssistant } from './server/ai.ts';
import { detectBelagaviWardByPointInPolygon } from './server/wardBoundary.ts';
import {
  isSupabaseServerEnabled,
  uploadGarbageImageToSupabaseStorage,
  syncGpsLocationToSupabase,
  syncGarbageReportToSupabase,
  syncGarbageImageToSupabase,
  syncComplaintStatusToSupabase,
  syncAiClassificationToSupabase,
  syncVoiceLogToSupabase,
} from './server/supabaseSync.ts';

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

initDatabase();

const app = express();
app.use(express.json({ limit: '15mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWs(event: string, data: unknown): void {
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'connected', data: { message: 'SANITRACK Realtime Connected' } }));
});

function logAudit(userId: string, userRole: string, action: string, targetType: string, targetId: string, details = ''): void {
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, user_role, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, userRole, action, targetType, targetId, details, new Date().toISOString());
}

function createNotification(
  userId: string | null,
  roleTarget: string | null,
  title: string,
  message: string,
  type: string,
  relatedId: string | null = null
): void {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, title, message, type, related_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, userId, roleTarget, title, message, type, relatedId, createdAt);
  broadcastWs('notification:new', { id, userId, roleTarget, title, message, type, relatedId, createdAt });
}

function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

function runEscalationJob(): number {
  const slaHours = Number(getSetting('sla_resolution_hours', '24')) || 24;
  const nowIso = new Date().toISOString();
  const terminalStatuses = ['Resolved', 'Awaiting Citizen Verification', 'Closed', 'Rejected'];

  const overdue = db.prepare(`
    SELECT id, complaint_code, ward_number, escalation_level, assigned_inspector_id, sla_deadline
    FROM complaints
    WHERE status NOT IN (${terminalStatuses.map(() => '?').join(',')})
      AND sla_deadline < ?
      AND escalation_level < 3
  `).all(...terminalStatuses, nowIso) as Array<{
    id: string;
    complaint_code: string;
    ward_number: number;
    escalation_level: number;
    assigned_inspector_id: string | null;
    sla_deadline: string;
  }>;

  let escalatedCount = 0;
  for (const cmp of overdue) {
    const nextLevel = Math.min(3, cmp.escalation_level + 1);
    const roleMap: Record<number, string> = {
      1: 'Ward Supervisor',
      2: 'Municipal Officer',
      3: 'Higher Municipal Administration',
    };
    const nextDeadline = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

    db.prepare(`
      UPDATE complaints SET escalation_level = ?, sla_deadline = ?, updated_at = ? WHERE id = ?
    `).run(nextLevel, nextDeadline, nowIso, cmp.id);

    db.prepare(`
      INSERT INTO escalations (id, complaint_id, level, escalated_to_role, reason, sla_hours, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      cmp.id,
      nextLevel,
      roleMap[nextLevel],
      `Automatic SLA deadline (${slaHours}h) exceeded`,
      slaHours,
      nowIso
    );

    createNotification(
      cmp.assigned_inspector_id,
      nextLevel >= 2 ? 'admin' : 'inspector',
      `Escalation Level ${nextLevel}: ${cmp.complaint_code}`,
      `Complaint in Ward ${cmp.ward_number} escalated to ${roleMap[nextLevel]} due to SLA breach.`,
      'warning',
      cmp.id
    );

    broadcastWs('escalation:triggered', {
      complaintId: cmp.id,
      complaintCode: cmp.complaint_code,
      level: nextLevel,
      escalatedTo: roleMap[nextLevel],
    });
    escalatedCount++;
  }
  return escalatedCount;
}

// Background automatic SLA escalation check every 60 seconds
setInterval(() => {
  try {
    runEscalationJob();
  } catch (err) {
    console.error('Escalation job error:', err);
  }
}, 60_000);

// Demo tracking mode simulation state (ONLY active when explicitly enabled)
const demoProgress: Record<string, number> = {
  'veh-demo-01': 0.15,
  'veh-demo-02': 0.35,
  'veh-demo-03': 0.55,
};

function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return Math.round((toDeg(Math.atan2(y, x)) + 360) % 360);
}

function advanceDemoVehicles(): void {
  const routes = db.prepare(`
    SELECT id, vehicle_id, waypoints_json FROM collection_routes WHERE is_demo = 1 AND vehicle_id IS NOT NULL
  `).all() as Array<{ id: string; vehicle_id: string; waypoints_json: string }>;

  const nowIso = new Date().toISOString();
  for (const route of routes) {
    const waypoints = JSON.parse(route.waypoints_json || '[]') as Array<{ lat: number; lng: number }>;
    if (waypoints.length < 2) continue;

    const cur = ((demoProgress[route.vehicle_id] ?? 0) + 0.014) % 1;
    demoProgress[route.vehicle_id] = cur;

    const totalSegs = waypoints.length - 1;
    const scaled = cur * totalSegs;
    const segIdx = Math.min(totalSegs - 1, Math.floor(scaled));
    const t = scaled - segIdx;
    const p1 = waypoints[segIdx];
    const p2 = waypoints[segIdx + 1];

    const lat = Number((p1.lat + (p2.lat - p1.lat) * t).toFixed(6));
    const lng = Number((p1.lng + (p2.lng - p1.lng) * t).toFixed(6));
    const heading = computeBearing(p1.lat, p1.lng, p2.lat, p2.lng);
    const speed = 18 + Math.round((Math.sin(cur * Math.PI * 6) + 1) * 5);

    db.prepare(`
      INSERT INTO vehicle_locations (id, vehicle_id, lat, lng, speed_kmh, heading, source, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, 'demo_simulation', ?)
    `).run(crypto.randomUUID(), route.vehicle_id, lat, lng, speed, heading, nowIso);

    db.prepare(`UPDATE vehicles SET status = 'On Route' WHERE id = ? AND status != 'Under Maintenance'`).run(route.vehicle_id);

    broadcastWs('vehicle:location', {
      vehicle_id: route.vehicle_id,
      lat,
      lng,
      speed_kmh: speed,
      heading,
      source: 'demo_simulation',
      recorded_at: nowIso,
    });
  }
}

setInterval(() => {
  try {
    if (getSetting('demo_tracking_enabled', 'false') !== 'true') return;
    advanceDemoVehicles();
  } catch (err) {
    console.error('Demo tracking tick error:', err);
  }
}, 1000);

// ---------------- PUBLIC CONFIG & REVERSE GEOCODING ----------------
app.get('/api/public-config', (_req, res) => {
  const rawSbUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const supabaseUrl = rawSbUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
  res.json({
    mapsApiKey: process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
    supabaseUrl,
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
    supabaseServerSync: isSupabaseServerEnabled(),
    appName: 'SANITRACK',
  });
});

app.get('/api/geocode/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: 'Valid numeric lat and lng query parameters are required.' });
    return;
  }

  // Strict point-in-polygon ward matching against official City Corporation Belagavi GIS boundaries
  const wardMatch = detectBelagaviWardByPointInPolygon(lat, lng);

  let address = '';
  let areaName = '';
  let provider = 'unavailable';
  const structured: {
    buildingOrStreet: string | null;
    locality: string | null;
    suburb: string | null;
    city: string | null;
    taluk: string | null;
    district: string | null;
    state: string | null;
    pinCode: string | null;
    country: string | null;
  } = {
    buildingOrStreet: null,
    locality: null,
    suburb: null,
    city: null,
    taluk: null,
    district: null,
    state: null,
    pinCode: null,
    country: null,
  };

  // Primary reverse geocoding: OpenStreetMap Nominatim (zoom=18 & addressdetails=1)
  try {
    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}&zoom=18&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'SANITRACK-Belagavi-Civic-Portal/1.0',
          'Accept-Language': 'en',
        },
        signal: AbortSignal.timeout(7000),
      }
    );
    if (nomRes.ok) {
      const nom = (await nomRes.json()) as {
        error?: string;
        display_name?: string;
        name?: string;
        address?: Record<string, string | undefined>;
      };
      if (!nom.error && nom.address) {
        const a = nom.address;
        const buildingPart = a.building || a.amenity || a.shop || a.office || a.leisure || nom.name || '';
        const streetPart = [a.house_number, a.road || a.pedestrian || a.footway || a.residential || a.path].filter(Boolean).join(' ');
        const buildingOrStreet = [buildingPart && buildingPart !== streetPart ? buildingPart : '', streetPart]
          .filter(Boolean)
          .join(', ') || null;

        const locality = a.neighbourhood || a.quarter || a.hamlet || a.residential || a.village || a.isolated_dwelling || null;
        const suburb = a.suburb || a.city_district || a.borough || null;
        const city = a.city || a.town || a.municipality || a.village || null;
        const taluk = a.county || null;
        const district = a.state_district || null;
        const state = a.state || null;
        const pinCode = a.postcode || null;
        const country = a.country || null;

        structured.buildingOrStreet = buildingOrStreet;
        structured.locality = locality;
        structured.suburb = suburb;
        structured.city = city;
        structured.taluk = taluk;
        structured.district = district;
        structured.state = state;
        structured.pinCode = pinCode;
        structured.country = country;

        address = nom.display_name || [buildingOrStreet, locality, suburb, city, taluk, district, state, pinCode, country].filter(Boolean).join(', ');
        areaName = locality || suburb || buildingOrStreet || city || '';
        if (address) {
          provider = 'openstreetmap_nominatim';
        }
      }
    }
  } catch {
    // Nominatim unavailable; try optional Google Geocoding fallback below without fabricating any address
  }

  // Fallback reverse geocoding if Nominatim did not return an address and Google Maps API key is configured
  const gMapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';
  if (!address && gMapsKey && gMapsKey !== 'MY_GOOGLE_MAPS_API_KEY') {
    try {
      const gRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(String(lat))},${encodeURIComponent(String(lng))}&key=${encodeURIComponent(gMapsKey)}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (gRes.ok) {
        const gData = (await gRes.json()) as {
          status?: string;
          results?: Array<{
            formatted_address?: string;
            address_components?: Array<{ long_name: string; types: string[] }>;
          }>;
        };
        if (gData.status === 'OK' && gData.results && gData.results[0]) {
          const top = gData.results[0];
          const comps = top.address_components || [];
          const findComp = (...types: string[]) =>
            comps.find((c) => types.some((t) => c.types.includes(t)))?.long_name || null;

          const premise = findComp('premise', 'subpremise', 'point_of_interest', 'establishment');
          const streetNum = findComp('street_number');
          const route = findComp('route');
          const street = [streetNum, route].filter(Boolean).join(' ');

          structured.buildingOrStreet = [premise, street].filter(Boolean).join(', ') || null;
          structured.locality = findComp('neighborhood', 'sublocality_level_2', 'sublocality_level_3');
          structured.suburb = findComp('sublocality_level_1', 'sublocality');
          structured.city = findComp('locality');
          structured.taluk = findComp('administrative_area_level_3');
          structured.district = findComp('administrative_area_level_2');
          structured.state = findComp('administrative_area_level_1');
          structured.pinCode = findComp('postal_code');
          structured.country = findComp('country');

          address = top.formatted_address || '';
          areaName = structured.locality || structured.suburb || structured.buildingOrStreet || structured.city || '';
          if (address) {
            provider = 'google_geocoding';
          }
        }
      }
    } catch {
      // Never synthesize or guess a fake address
    }
  }

  res.json({
    lat,
    lng,
    addressVerified: Boolean(address),
    address,
    areaName,
    provider,
    structured,
    ward: wardMatch,
  });
});

// ---------------- AUTH ROUTES ----------------
app.get('/api/demo-accounts', (_req, res) => {
  res.json({
    notice: 'DEMO DATA — Sample demonstration accounts for Belagavi Municipal Portal evaluation.',
    accounts: [
      { role: 'citizen', label: 'Citizen (Ward 12)', email: 'citizen@sanitrack.demo', password: 'DemoUser@123' },
      { role: 'worker', label: 'Driver / Sanitation Crew', email: 'driver@sanitrack.demo', password: 'DemoUser@123' },
      { role: 'inspector', label: 'Ward Supervisor / Inspector', email: 'supervisor@sanitrack.demo', password: 'DemoUser@123' },
      { role: 'admin', label: 'Municipal Administrator', email: 'admin@sanitrack.demo', password: 'DemoUser@123' },
    ],
  });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password, ward_number, language_pref } = req.body || {};
  if (!name || !email || !phone || !password) {
    res.status(400).json({ error: 'Name, email, phone, and password are required.' });
    return;
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(normalizedEmail);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const wardNum = Number(ward_number) >= 1 && Number(ward_number) <= 58 ? Number(ward_number) : 1;

  db.prepare(`
    INSERT INTO profiles (id, name, email, phone, password_hash, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, 'citizen', ?, '[]', ?, 1, 0, ?)
  `).run(id, String(name).trim(), normalizedEmail, String(phone).trim(), hashPassword(String(password)), wardNum, language_pref || 'en', nowIso);

  const token = signToken(id, 'citizen');
  res.status(201).json({
    token,
    user: {
      id,
      name: String(name).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      role: 'citizen',
      ward_number: wardNum,
      assigned_wards: [],
      language_pref: language_pref || 'en',
      is_demo: false,
    },
  });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, email, password } = req.body || {};
  const loginKey = String(identifier || email || '').trim().toLowerCase();
  if (!loginKey || !password) {
    res.status(400).json({ error: 'Email/mobile and password are required.' });
    return;
  }
  const row = db.prepare(`
    SELECT id, name, email, phone, password_hash, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo
    FROM profiles WHERE LOWER(email) = ? OR phone = ?
  `).get(loginKey, String(identifier || email || '').trim()) as {
    id: string;
    name: string;
    email: string;
    phone: string;
    password_hash: string;
    role: UserRole;
    ward_number: number | null;
    assigned_wards_json: string;
    language_pref: string;
    is_active: number;
    is_demo: number;
  } | undefined;

  if (!row || !verifyPassword(String(password), row.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials. Please check your email/mobile and password.' });
    return;
  }
  if (row.is_active !== 1) {
    res.status(403).json({ error: 'This account is currently deactivated. Contact Municipal Admin.' });
    return;
  }

  let assigned_wards: number[] = [];
  try {
    assigned_wards = JSON.parse(row.assigned_wards_json || '[]');
  } catch {
    assigned_wards = [];
  }

  const token = signToken(row.id, row.role);
  res.json({
    token,
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      ward_number: row.ward_number,
      assigned_wards,
      language_pref: row.language_pref,
      is_demo: row.is_demo === 1,
    },
  });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

app.patch('/api/auth/language', requireAuth, (req: AuthedRequest, res) => {
  const { language } = req.body || {};
  if (!['en', 'kn', 'hi', 'mr'].includes(language)) {
    res.status(400).json({ error: 'Unsupported language code.' });
    return;
  }
  db.prepare('UPDATE profiles SET language_pref = ? WHERE id = ?').run(language, req.user!.id);
  res.json({ language_pref: language });
});

// ---------------- MUNICIPAL OVERVIEW & SETTINGS ----------------
app.get('/api/municipal/overview', (_req, res) => {
  const settingsRows = db.prepare('SELECT key, value FROM system_settings').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const r of settingsRows) settings[r.key] = r.value;

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('Resolved', 'Closed', 'Awaiting Citizen Verification') THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN status NOT IN ('Resolved', 'Closed', 'Rejected') THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN escalation_level > 0 AND status NOT IN ('Resolved', 'Closed', 'Rejected') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END) as demoCount
    FROM complaints
  `).get() as { total: number; resolved: number; pending: number; overdue: number; demoCount: number };

  const vehStats = db.prepare(`
    SELECT
      COUNT(*) as totalRegistered,
      SUM(CASE WHEN status IN ('Active', 'On Route', 'Collecting Waste') THEN 1 ELSE 0 END) as activeCount
    FROM vehicles
  `).get() as { totalRegistered: number; activeCount: number };

  const fbStats = db.prepare('SELECT AVG(rating) as avgRating, COUNT(*) as ratingCount FROM feedback').get() as {
    avgRating: number | null;
    ratingCount: number;
  };

  const hotspots = db.prepare(`
    SELECT ward_number, COUNT(*) as count FROM complaints
    WHERE status NOT IN ('Closed', 'Rejected')
    GROUP BY ward_number HAVING count >= 1
  `).all() as Array<{ ward_number: number; count: number }>;

  res.json({
    baseline: settings,
    metrics: {
      totalComplaints: counts.total || 0,
      resolvedComplaints: counts.resolved || 0,
      pendingComplaints: counts.pending || 0,
      overdueComplaints: counts.overdue || 0,
      demoComplaints: counts.demoCount || 0,
      activeVehicles: vehStats.activeCount || 0,
      registeredVehicles: vehStats.totalRegistered || 0,
      avgSatisfaction: fbStats.avgRating ? Number(fbStats.avgRating.toFixed(1)) : 4.5,
      feedbackCount: fbStats.ratingCount || 0,
      hotspotWardsCount: hotspots.length,
    },
  });
});

app.put('/api/admin/settings', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const updates = req.body as Record<string, string | number | boolean>;
  const allowedKeys = [
    'city_name',
    'approx_population',
    'approx_area_sq_km',
    'total_wards',
    'primary_vehicles_baseline',
    'secondary_vehicles_baseline',
    'sanitation_inspectors_baseline',
    'crew_configuration',
    'sla_resolution_hours',
    'demo_tracking_enabled',
  ];
  const nowIso = new Date().toISOString();
  const stmt = db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) {
      stmt.run(key, String(updates[key]), nowIso);
    }
  }
  logAudit(req.user!.id, req.user!.role, 'UPDATE_MUNICIPAL_SETTINGS', 'system_settings', 'baseline', JSON.stringify(updates));
  broadcastWs('settings:updated', updates);
  res.json({ ok: true });
});

// ---------------- WARDS ----------------
app.get('/api/wards', (_req, res) => {
  const wards = db.prepare(`
    SELECT w.*, p.name as inspector_name,
      (SELECT COUNT(*) FROM complaints c WHERE c.ward_number = w.ward_number) as complaint_count,
      (SELECT COUNT(*) FROM complaints c WHERE c.ward_number = w.ward_number AND c.status NOT IN ('Resolved', 'Closed', 'Rejected')) as pending_count
    FROM wards w
    LEFT JOIN profiles p ON w.inspector_id = p.id
    ORDER BY w.ward_number ASC
  `).all();
  res.json({ wards });
});

app.put('/api/admin/wards/:wardNumber', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const wardNum = Number(req.params.wardNumber);
  const { name, zone, population_est, inspector_id, cleanliness_score } = req.body || {};
  db.prepare(`
    UPDATE wards SET
      name = COALESCE(?, name),
      zone = COALESCE(?, zone),
      population_est = COALESCE(?, population_est),
      inspector_id = ?,
      cleanliness_score = COALESCE(?, cleanliness_score)
    WHERE ward_number = ?
  `).run(name || null, zone || null, population_est ? Number(population_est) : null, inspector_id || null, cleanliness_score ? Number(cleanliness_score) : null, wardNum);

  logAudit(req.user!.id, req.user!.role, 'UPDATE_WARD', 'ward', String(wardNum), JSON.stringify({ name, zone, inspector_id }));
  res.json({ ok: true });
});

// ---------------- COMPLAINTS ----------------
app.get('/api/complaints', optionalAuth, (req: AuthedRequest, res) => {
  const { ward, status, category, priority, search } = req.query;
  const user = req.user;

  let whereClauses: string[] = [];
  const params: unknown[] = [];

  if (user) {
    if (user.role === 'citizen') {
      // Citizens see their own full complaints; public hotspots are served by /api/hotspots
      whereClauses.push('c.citizen_id = ?');
      params.push(user.id);
    } else if (user.role === 'worker') {
      whereClauses.push('c.assigned_worker_id = ?');
      params.push(user.id);
    } else if (user.role === 'inspector' && user.assigned_wards.length > 0) {
      whereClauses.push(`c.ward_number IN (${user.assigned_wards.map(() => '?').join(',')})`);
      params.push(...user.assigned_wards);
    }
  } else {
    // Public map mode returns sanitized records without citizen PII
    const rows = db.prepare(`
      SELECT id, complaint_code, ward_number, category, area_name, lat, lng, priority, status, escalation_level, is_demo, created_at
      FROM complaints ORDER BY created_at DESC LIMIT 200
    `).all();
    res.json({ complaints: rows, sanitized: true });
    return;
  }

  if (ward && ward !== 'all') {
    whereClauses.push('c.ward_number = ?');
    params.push(Number(ward));
  }
  if (status && status !== 'all') {
    whereClauses.push('c.status = ?');
    params.push(String(status));
  }
  if (category && category !== 'all') {
    whereClauses.push('c.category = ?');
    params.push(String(category));
  }
  if (priority && priority !== 'all') {
    whereClauses.push('c.priority = ?');
    params.push(String(priority));
  }
  if (search) {
    whereClauses.push('(c.complaint_code LIKE ? OR c.area_name LIKE ? OR c.description LIKE ?)');
    const q = `%${String(search)}%`;
    params.push(q, q, q);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const complaints = db.prepare(`
    SELECT c.*,
      cit.name as citizen_name, cit.phone as citizen_phone,
      insp.name as inspector_name,
      wrk.name as worker_name,
      v.registration_number as vehicle_reg,
      f.rating as feedback_rating, f.comment as feedback_comment
    FROM complaints c
    LEFT JOIN profiles cit ON c.citizen_id = cit.id
    LEFT JOIN profiles insp ON c.assigned_inspector_id = insp.id
    LEFT JOIN profiles wrk ON c.assigned_worker_id = wrk.id
    LEFT JOIN vehicles v ON c.assigned_vehicle_id = v.id
    LEFT JOIN feedback f ON f.complaint_id = c.id
    ${whereSql}
    ORDER BY c.created_at DESC
  `).all(...params) as Array<Record<string, unknown>>;

  const photoStmt = db.prepare('SELECT id, photo_type, image_data, storage_url, created_at FROM complaint_photos WHERE complaint_id = ?');
  const histStmt = db.prepare('SELECT id, status, changed_by, changed_by_role, remarks, created_at FROM complaint_status_history WHERE complaint_id = ? ORDER BY created_at ASC');

  const enriched = complaints.map((c) => {
    let aiParsed = null;
    if (typeof c.ai_classification_json === 'string' && c.ai_classification_json) {
      try {
        aiParsed = JSON.parse(c.ai_classification_json);
      } catch {
        aiParsed = null;
      }
    }
    return {
      ...c,
      ai_classification: aiParsed,
      photos: photoStmt.all(c.id as string),
      history: histStmt.all(c.id as string),
    };
  });

  res.json({ complaints: enriched });
});

// Public / Ward Hotspots endpoint (anonymized, safe for Live Map)
app.get('/api/hotspots', (req, res) => {
  const { ward, status, category } = req.query;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (ward && ward !== 'all') {
    clauses.push('ward_number = ?');
    params.push(Number(ward));
  }
  if (status && status !== 'all') {
    clauses.push('status = ?');
    params.push(String(status));
  }
  if (category && category !== 'all') {
    clauses.push('category = ?');
    params.push(String(category));
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = db.prepare(`
    SELECT id, complaint_code, ward_number, category, area_name, address, lat, lng, priority, status, escalation_level, is_demo, created_at
    FROM complaints ${whereSql} ORDER BY created_at DESC
  `).all(...params);
  res.json({ hotspots: items });
});

app.get('/api/complaints/track/:code', (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const c = db.prepare(`
    SELECT c.id, c.complaint_code, c.ward_number, c.category, c.description, c.area_name, c.address,
      c.lat, c.lng, c.gps_accuracy, c.capture_timestamp, c.ai_classification_json,
      c.priority, c.status, c.escalation_level, c.sla_deadline, c.citizen_confirmed,
      c.obstacle_note, c.is_demo, c.created_at, c.updated_at,
      insp.name as inspector_name, wrk.name as worker_name, v.registration_number as vehicle_reg,
      f.rating as feedback_rating, f.comment as feedback_comment
    FROM complaints c
    LEFT JOIN profiles insp ON c.assigned_inspector_id = insp.id
    LEFT JOIN profiles wrk ON c.assigned_worker_id = wrk.id
    LEFT JOIN vehicles v ON c.assigned_vehicle_id = v.id
    LEFT JOIN feedback f ON f.complaint_id = c.id
    WHERE UPPER(c.complaint_code) = ?
  `).get(code) as Record<string, unknown> | undefined;

  if (!c) {
    res.status(404).json({ error: `Complaint ${code} not found.` });
    return;
  }

  let ai_classification = null;
  if (typeof c.ai_classification_json === 'string' && c.ai_classification_json) {
    try {
      ai_classification = JSON.parse(c.ai_classification_json);
    } catch {
      ai_classification = null;
    }
  }

  const photos = db.prepare('SELECT id, photo_type, image_data, storage_url, created_at FROM complaint_photos WHERE complaint_id = ?').all(c.id as string);
  const history = db.prepare('SELECT id, status, changed_by, changed_by_role, remarks, created_at FROM complaint_status_history WHERE complaint_id = ? ORDER BY created_at ASC').all(c.id as string);
  const escalations = db.prepare('SELECT id, level, escalated_to_role, reason, created_at FROM escalations WHERE complaint_id = ? ORDER BY created_at ASC').all(c.id as string);

  res.json({ complaint: { ...c, ai_classification, photos, history, escalations } });
});

app.post('/api/complaints', requireAuth, async (req: AuthedRequest, res) => {
  const {
    ward_number,
    category,
    description,
    area_name,
    address,
    lat,
    lng,
    gps_accuracy,
    capture_timestamp,
    gps_source,
    ai_classification_id,
    ai_classification,
    priority,
    photo_base64,
  } = req.body || {};

  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!category || !description || !Number.isFinite(numLat) || !Number.isFinite(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
    res.status(400).json({ error: 'Category, description, and valid GPS coordinates are required.' });
    return;
  }

  const id = crypto.randomUUID();
  const countRow = db.prepare('SELECT COUNT(*) as c FROM complaints').get() as { c: number };
  const seq = String(countRow.c + 1).padStart(4, '0');
  const code = `ST-BGM-2026-${seq}`;
  const slaHours = Number(getSetting('sla_resolution_hours', '24')) || 24;
  const now = new Date();
  const nowIso = now.toISOString();
  const capTimestamp = typeof capture_timestamp === 'string' && capture_timestamp ? capture_timestamp : nowIso;
  const accuracyNum = gps_accuracy !== undefined && gps_accuracy !== null && Number.isFinite(Number(gps_accuracy))
    ? Number(gps_accuracy)
    : null;
  const slaDeadline = new Date(now.getTime() + slaHours * 3600 * 1000).toISOString();

  // Verify ward using strict GIS point-in-polygon if omitted/0; 0 indicates "Ward not verified"
  const parsedWard = Number(ward_number);
  let wardNum = Number.isFinite(parsedWard) && parsedWard >= 1 && parsedWard <= 58 ? Math.trunc(parsedWard) : 0;
  if (wardNum === 0) {
    const pipWard = detectBelagaviWardByPointInPolygon(numLat, numLng);
    if (pipWard.wardVerified && pipWard.ward_number !== null) {
      wardNum = pipWard.ward_number;
    }
  }

  const cleanAreaName = typeof area_name === 'string' && area_name.trim()
    ? area_name.trim()
    : `${numLat.toFixed(5)}, ${numLng.toFixed(5)}`;
  const cleanAddress = typeof address === 'string' && address.trim()
    ? address.trim()
    : 'Address unavailable';

  const wardRow = wardNum > 0
    ? (db.prepare('SELECT inspector_id FROM wards WHERE ward_number = ?').get(wardNum) as { inspector_id: string | null } | undefined)
    : undefined;
  const assignedInspector = wardRow?.inspector_id || 'user-inspector-demo';

  // Auto-link assigned municipal collection vehicle for this ward if available
  const wardVehicle = wardNum > 0
    ? (db.prepare(`
        SELECT id, registration_number, status FROM vehicles
        WHERE assigned_ward = ?
        ORDER BY CASE WHEN status IN ('On Route', 'Collecting Waste', 'Active') THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      `).get(wardNum) as { id: string; registration_number: string; status: string } | undefined)
    : undefined;

  const validPriority = ['Low', 'Medium', 'High', 'Emergency'].includes(priority) ? priority : 'Medium';
  const aiJsonStr = ai_classification ? JSON.stringify(ai_classification) : null;

  db.prepare(`
    INSERT INTO complaints (
      id, complaint_code, citizen_id, ward_number, category, description, area_name, address,
      lat, lng, gps_accuracy, capture_timestamp, ai_classification_json,
      priority, status, assigned_inspector_id, assigned_vehicle_id, escalation_level, sla_deadline,
      citizen_confirmed, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, 0, ?, 0, 0, ?, ?)
  `).run(
    id, code, req.user!.id, wardNum, String(category), String(description),
    cleanAreaName, cleanAddress, numLat, numLng,
    accuracyNum, capTimestamp, aiJsonStr,
    validPriority, assignedInspector, wardVehicle?.id || null, slaDeadline, nowIso, nowIso
  );

  // Record GPS snapshot in gps_locations
  const locSource = gps_source === 'map_pin' ? 'map_pin' : 'citizen_camera_gps';
  db.prepare(`
    INSERT INTO gps_locations (id, vehicle_id, report_id, user_id, lat, lng, accuracy_meters, speed_kmh, heading, source, captured_at, recorded_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
  `).run(crypto.randomUUID(), id, req.user!.id, numLat, numLng, accuracyNum, locSource, capTimestamp, nowIso);

  if (ai_classification_id && typeof ai_classification_id === 'string') {
    db.prepare('UPDATE waste_classifications SET complaint_id = ? WHERE id = ?').run(id, ai_classification_id);
  }

  let uploadedStorageUrl: string | null = null;
  if (photo_base64 && typeof photo_base64 === 'string') {
    const photoId = crypto.randomUUID();
    const { storagePath, storageUrl } = await uploadGarbageImageToSupabaseStorage(id, photoId, photo_base64);
    uploadedStorageUrl = storageUrl;

    db.prepare(`
      INSERT INTO complaint_photos (id, complaint_id, photo_type, image_data, storage_url, gps_accuracy, captured_at, uploaded_by, created_at)
      VALUES (?, ?, 'before', ?, ?, ?, ?, ?, ?)
    `).run(photoId, id, photo_base64, storageUrl, accuracyNum, capTimestamp, req.user!.id, nowIso);

    void syncGarbageImageToSupabase({
      id: photoId,
      report_id: id,
      photo_type: 'before',
      storage_path: storagePath,
      storage_url: storageUrl,
      mime_type: 'image/jpeg',
      lat: numLat,
      lng: numLng,
      gps_accuracy: accuracyNum,
      captured_at: capTimestamp,
      uploaded_by: req.user!.id,
      created_at: nowIso,
    });
  }

  const histId = crypto.randomUUID();
  const histRemark = `Complaint registered with GPS (${numLat.toFixed(5)}, ${numLng.toFixed(5)}${accuracyNum !== null ? `, ±${Math.round(accuracyNum)}m` : ''})`;
  db.prepare(`
    INSERT INTO complaint_status_history (id, complaint_id, status, changed_by, changed_by_role, remarks, created_at)
    VALUES (?, ?, 'Submitted', ?, ?, ?, ?)
  `).run(histId, id, req.user!.name, req.user!.role, histRemark, nowIso);

  // Sync report, GPS, and initial status history to Supabase if configured & ward is valid
  const supabaseSynced = wardNum >= 1 && wardNum <= 58
    ? await syncGarbageReportToSupabase({
        id,
        complaint_code: code,
        citizen_id: req.user!.id,
        ward_number: wardNum,
        category: String(category),
        description: String(description),
        area_name: cleanAreaName,
        address: cleanAddress,
        lat: numLat,
        lng: numLng,
        gps_accuracy: accuracyNum,
        capture_timestamp: capTimestamp,
        priority: validPriority,
        status: 'Submitted',
        assigned_inspector_id: assignedInspector,
        assigned_vehicle_id: wardVehicle?.id || null,
        escalation_level: 0,
        sla_deadline: slaDeadline,
        is_demo: false,
        created_at: nowIso,
        updated_at: nowIso,
      })
    : false;

  void syncGpsLocationToSupabase({
    report_id: id,
    user_id: req.user!.id,
    lat: numLat,
    lng: numLng,
    accuracy_meters: accuracyNum,
    source: locSource,
    captured_at: capTimestamp,
    recorded_at: nowIso,
  });

  void syncComplaintStatusToSupabase({
    id: histId,
    report_id: id,
    status: 'Submitted',
    changed_by: req.user!.name,
    changed_by_role: req.user!.role,
    remarks: histRemark,
    created_at: nowIso,
  });

  const wardLabel = wardNum > 0 ? `Ward ${wardNum}` : 'Ward not verified';
  createNotification(
    assignedInspector,
    'inspector',
    `New Complaint ${code} (${wardLabel})`,
    `${category} reported at ${cleanAreaName}.`,
    'info',
    id
  );
  broadcastWs('complaint:updated', {
    id,
    complaint_code: code,
    status: 'Submitted',
    ward_number: wardNum,
    assigned_vehicle_reg: wardVehicle?.registration_number || null,
  });

  res.status(201).json({
    id,
    complaint_code: code,
    status: 'Submitted',
    sla_deadline: slaDeadline,
    storage_url: uploadedStorageUrl,
    supabaseSynced,
    assigned_vehicle: wardVehicle || null,
  });
});

app.patch('/api/complaints/:id/assign', requireAuth, requireRole('inspector', 'admin'), (req: AuthedRequest, res) => {
  const { worker_id, vehicle_id, priority, notes } = req.body || {};
  const cmp = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!cmp) {
    res.status(404).json({ error: 'Complaint not found.' });
    return;
  }

  if (req.user!.role === 'inspector' && req.user!.assigned_wards.length > 0 && !req.user!.assigned_wards.includes(Number(cmp.ward_number))) {
    res.status(403).json({ error: 'You are not authorized for this ward.' });
    return;
  }

  const nowIso = new Date().toISOString();
  const nextPriority = ['Low', 'Medium', 'High', 'Emergency'].includes(priority) ? priority : cmp.priority;
  const nextStatus = worker_id ? 'Assigned' : 'Under Review';

  db.prepare(`
    UPDATE complaints SET
      assigned_worker_id = COALESCE(?, assigned_worker_id),
      assigned_vehicle_id = COALESCE(?, assigned_vehicle_id),
      assigned_inspector_id = COALESCE(assigned_inspector_id, ?),
      priority = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `).run(worker_id || null, vehicle_id || null, req.user!.id, nextPriority, nextStatus, nowIso, cmp.id);

  db.prepare(`
    INSERT INTO complaint_assignments (id, complaint_id, inspector_id, worker_id, vehicle_id, notes, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), cmp.id, req.user!.id, worker_id || null, vehicle_id || null, notes || '', nowIso);

  db.prepare(`
    INSERT INTO complaint_status_history (id, complaint_id, status, changed_by, changed_by_role, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), cmp.id, nextStatus, req.user!.name, req.user!.role, notes || `Assigned to crew`, nowIso);

  if (worker_id) {
    createNotification(worker_id, 'worker', `New Task Assigned: ${cmp.complaint_code}`, `Ward ${cmp.ward_number} — ${cmp.area_name}`, 'info', cmp.id as string);
  }
  createNotification(cmp.citizen_id as string, 'citizen', `Complaint ${cmp.complaint_code} Assigned`, `Your report has been assigned to a sanitation crew.`, 'info', cmp.id as string);
  logAudit(req.user!.id, req.user!.role, 'ASSIGN_COMPLAINT', 'complaint', cmp.id as string, JSON.stringify({ worker_id, vehicle_id, nextPriority }));
  broadcastWs('complaint:updated', { id: cmp.id, complaint_code: cmp.complaint_code, status: nextStatus });

  res.json({ ok: true, status: nextStatus });
});

app.patch('/api/complaints/:id/status', requireAuth, requireRole('worker', 'inspector', 'admin'), (req: AuthedRequest, res) => {
  const { status, remarks, after_photo_base64, obstacle_note } = req.body || {};
  const cmp = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!cmp) {
    res.status(404).json({ error: 'Complaint not found.' });
    return;
  }

  if (req.user!.role === 'worker' && cmp.assigned_worker_id !== req.user!.id) {
    res.status(403).json({ error: 'Workers can only update tasks assigned to them.' });
    return;
  }

  if (req.user!.role === 'inspector' && req.user!.assigned_wards.length > 0 && !req.user!.assigned_wards.includes(Number(cmp.ward_number))) {
    res.status(403).json({ error: 'Inspectors can only update complaints in assigned wards.' });
    return;
  }

  const allowedStatuses = [
    'Submitted', 'Under Review', 'Assigned', 'Accepted', 'In Progress',
    'Pending Verification', 'Resolved', 'Awaiting Citizen Verification',
    'Reopened', 'Rejected', 'Closed'
  ];
  if (!allowedStatuses.includes(status)) {
    res.status(400).json({ error: 'Invalid complaint status.' });
    return;
  }

  const nowIso = new Date().toISOString();
  const finalStatus = status === 'Resolved' && req.user!.role !== 'worker' ? 'Awaiting Citizen Verification' : status;

  db.prepare(`
    UPDATE complaints SET status = ?, obstacle_note = COALESCE(?, obstacle_note), updated_at = ? WHERE id = ?
  `).run(finalStatus, obstacle_note || null, nowIso, cmp.id);

  if (after_photo_base64 && typeof after_photo_base64 === 'string') {
    db.prepare(`
      INSERT INTO complaint_photos (id, complaint_id, photo_type, image_data, uploaded_by, created_at)
      VALUES (?, ?, 'after', ?, ?, ?)
    `).run(crypto.randomUUID(), cmp.id, after_photo_base64, req.user!.id, nowIso);
  }

  db.prepare(`
    INSERT INTO complaint_status_history (id, complaint_id, status, changed_by, changed_by_role, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), cmp.id, finalStatus, req.user!.name, req.user!.role, remarks || obstacle_note || `Updated to ${finalStatus}`, nowIso);

  createNotification(
    cmp.citizen_id as string,
    'citizen',
    `Complaint ${cmp.complaint_code}: ${finalStatus}`,
    remarks || `Status updated to ${finalStatus}.`,
    finalStatus === 'Awaiting Citizen Verification' ? 'success' : 'info',
    cmp.id as string
  );

  if (finalStatus === 'Pending Verification' && cmp.assigned_inspector_id) {
    createNotification(cmp.assigned_inspector_id as string, 'inspector', `Verification Needed: ${cmp.complaint_code}`, 'Worker uploaded after-cleaning photo for review.', 'info', cmp.id as string);
  }

  logAudit(req.user!.id, req.user!.role, 'UPDATE_COMPLAINT_STATUS', 'complaint', cmp.id as string, `${finalStatus}: ${remarks || ''}`);
  broadcastWs('complaint:updated', { id: cmp.id, complaint_code: cmp.complaint_code, status: finalStatus });
  res.json({ ok: true, status: finalStatus });
});

app.post('/api/complaints/:id/verify-citizen', requireAuth, (req: AuthedRequest, res) => {
  const { confirmed, remarks } = req.body || {};
  const cmp = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!cmp) {
    res.status(404).json({ error: 'Complaint not found.' });
    return;
  }
  if (cmp.citizen_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Only the reporting citizen can verify cleaning.' });
    return;
  }

  const nowIso = new Date().toISOString();
  const nextStatus = confirmed ? 'Closed' : 'Reopened';
  db.prepare(`UPDATE complaints SET status = ?, citizen_confirmed = ?, updated_at = ? WHERE id = ?`).run(
    nextStatus, confirmed ? 1 : 0, nowIso, cmp.id
  );
  db.prepare(`
    INSERT INTO complaint_status_history (id, complaint_id, status, changed_by, changed_by_role, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), cmp.id, nextStatus, req.user!.name, req.user!.role, remarks || (confirmed ? 'Citizen confirmed area is clean' : 'Citizen reopened issue'), nowIso);

  broadcastWs('complaint:updated', { id: cmp.id, complaint_code: cmp.complaint_code, status: nextStatus });
  res.json({ ok: true, status: nextStatus });
});

app.post('/api/complaints/:id/feedback', requireAuth, (req: AuthedRequest, res) => {
  const { rating, comment, photo_data } = req.body || {};
  const numRating = Number(rating);
  if (!numRating || numRating < 1 || numRating > 5) {
    res.status(400).json({ error: 'Rating between 1 and 5 is required.' });
    return;
  }
  const cmp = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!cmp) {
    res.status(404).json({ error: 'Complaint not found.' });
    return;
  }
  if (cmp.citizen_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({ error: 'You can only rate your own complaints.' });
    return;
  }
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO feedback (id, complaint_id, citizen_id, ward_number, rating, comment, photo_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), cmp.id, req.user!.id, cmp.ward_number, numRating, String(comment || ''), String(photo_data || ''), nowIso);

  res.status(201).json({ ok: true });
});

app.get('/api/feedback', (_req, res) => {
  const items = db.prepare(`
    SELECT f.*, c.complaint_code, c.area_name, p.name as citizen_name
    FROM feedback f
    LEFT JOIN complaints c ON f.complaint_id = c.id
    LEFT JOIN profiles p ON f.citizen_id = p.id
    ORDER BY f.created_at DESC
  `).all();
  res.json({ feedback: items });
});

// ---------------- VEHICLES, GPS & ROUTES ----------------
app.get('/api/vehicles', (_req, res) => {
  const vehicles = db.prepare(`
    SELECT v.*, p.name as driver_name, p.phone as driver_phone,
      r.id as route_id, r.route_name, r.start_point_name, r.end_point_name, r.waypoints_json
    FROM vehicles v
    LEFT JOIN profiles p ON v.driver_id = p.id
    LEFT JOIN collection_routes r ON r.vehicle_id = v.id
    ORDER BY v.vehicle_code ASC
  `).all() as Array<Record<string, unknown>>;

  const locStmt = db.prepare(`
    SELECT lat, lng, speed_kmh, heading, source, recorded_at
    FROM vehicle_locations WHERE vehicle_id = ? ORDER BY recorded_at DESC LIMIT 1
  `);

  const trailStmt = db.prepare(`
    SELECT lat, lng, source, recorded_at
    FROM vehicle_locations WHERE vehicle_id = ? ORDER BY recorded_at DESC LIMIT 40
  `);

  const enriched = vehicles.map((v) => {
    const latest = locStmt.get(v.id as string) as Record<string, unknown> | undefined;
    const trail = (trailStmt.all(v.id as string) as Array<Record<string, unknown>>).reverse();
    return {
      ...v,
      waypoints: v.waypoints_json ? JSON.parse(v.waypoints_json as string) : [],
      location: latest || null,
      trail,
    };
  });

  const demoTrackingEnabled = getSetting('demo_tracking_enabled', 'false') === 'true';
  res.json({ vehicles: enriched, demoTrackingEnabled });
});

app.post('/api/admin/vehicles', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { vehicle_code, registration_number, vehicle_type, assigned_ward, driver_id, helper_names, status } = req.body || {};
  if (!vehicle_code || !registration_number) {
    res.status(400).json({ error: 'Vehicle code and registration number are required.' });
    return;
  }
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO vehicles (id, vehicle_code, registration_number, vehicle_type, assigned_ward, driver_id, helper_names, status, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    id,
    String(vehicle_code).trim(),
    String(registration_number).trim().toUpperCase(),
    vehicle_type === 'secondary' ? 'secondary' : 'primary',
    assigned_ward ? Number(assigned_ward) : null,
    driver_id || null,
    helper_names || 'Helper 1, Helper 2',
    status || 'Idle',
    nowIso
  );
  logAudit(req.user!.id, req.user!.role, 'CREATE_VEHICLE', 'vehicle', id, registration_number);
  res.status(201).json({ id });
});

app.patch('/api/vehicles/:id/status', requireAuth, requireRole('worker', 'inspector', 'admin'), (req: AuthedRequest, res) => {
  const { status } = req.body || {};
  const valid = ['Active', 'On Route', 'Collecting Waste', 'Idle', 'Under Maintenance', 'Offline'];
  if (!valid.includes(status)) {
    res.status(400).json({ error: 'Invalid vehicle status.' });
    return;
  }
  db.prepare('UPDATE vehicles SET status = ? WHERE id = ?').run(status, req.params.id);
  broadcastWs('vehicle:status', { vehicle_id: req.params.id, status });
  res.json({ ok: true });
});

app.post('/api/driver/gps', requireAuth, requireRole('worker', 'admin'), (req: AuthedRequest, res) => {
  const { vehicle_id, lat, lng, speed_kmh, heading, source } = req.body || {};
  if (!vehicle_id || lat === undefined || lng === undefined) {
    res.status(400).json({ error: 'vehicle_id, lat, and lng are required.' });
    return;
  }
  const veh = db.prepare('SELECT id, driver_id FROM vehicles WHERE id = ?').get(vehicle_id) as { id: string; driver_id: string | null } | undefined;
  if (!veh) {
    res.status(404).json({ error: 'Vehicle not found.' });
    return;
  }
  if (req.user!.role === 'worker' && veh.driver_id && veh.driver_id !== req.user!.id) {
    res.status(403).json({ error: 'Drivers can only update GPS for their assigned vehicle.' });
    return;
  }
  const nowIso = new Date().toISOString();
  const locSource = source === 'demo_simulation' ? 'demo_simulation' : 'live_gps';
  const numLat = Number(lat);
  const numLng = Number(lng);
  const numSpeed = Number(speed_kmh || 0);
  const numHeading = Number(heading || 0);

  db.prepare(`
    INSERT INTO vehicle_locations (id, vehicle_id, lat, lng, speed_kmh, heading, source, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), vehicle_id, numLat, numLng, numSpeed, numHeading, locSource, nowIso);

  db.prepare(`
    INSERT INTO gps_locations (id, vehicle_id, user_id, lat, lng, speed_kmh, heading, source, captured_at, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), vehicle_id, req.user!.id, numLat, numLng, numSpeed, numHeading, locSource, nowIso, nowIso);

  db.prepare(`UPDATE vehicles SET status = 'On Route' WHERE id = ?`).run(vehicle_id);

  void syncGpsLocationToSupabase({
    vehicle_id,
    user_id: req.user!.id,
    lat: numLat,
    lng: numLng,
    speed_kmh: numSpeed,
    heading: numHeading,
    source: locSource,
    captured_at: nowIso,
    recorded_at: nowIso,
  });

  broadcastWs('vehicle:location', {
    vehicle_id,
    lat: numLat,
    lng: numLng,
    speed_kmh: numSpeed,
    heading: numHeading,
    source: locSource,
    recorded_at: nowIso,
  });

  res.json({ ok: true, recorded_at: nowIso });
});

app.post('/api/gps/readings', requireAuth, async (req: AuthedRequest, res) => {
  const { lat, lng, accuracy_meters, speed_kmh, heading, captured_at, report_id, source } = req.body || {};
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (
    !Number.isFinite(numLat) ||
    !Number.isFinite(numLng) ||
    numLat < -90 ||
    numLat > 90 ||
    numLng < -180 ||
    numLng > 180 ||
    (numLat === 0 && numLng === 0)
  ) {
    res.status(400).json({ error: 'Valid live GPS latitude and longitude are required.' });
    return;
  }

  // Only store genuine device GPS readings in the live GPS telemetry log
  if (source && source !== 'live_gps' && source !== 'citizen_camera_gps') {
    res.status(400).json({ error: 'Only genuine device GPS readings may be stored in live GPS telemetry.' });
    return;
  }

  const accNum =
    accuracy_meters !== undefined && accuracy_meters !== null && Number.isFinite(Number(accuracy_meters))
      ? Number(accuracy_meters)
      : null;
  if (accNum === null || accNum < 0) {
    res.status(400).json({ error: 'Genuine GPS accuracy in meters is required.' });
    return;
  }

  const nowIso = new Date().toISOString();
  const capturedIso = typeof captured_at === 'string' && captured_at ? captured_at : nowIso;
  const numSpeed = Number.isFinite(Number(speed_kmh)) ? Number(speed_kmh) : 0;
  const numHeading = Number.isFinite(Number(heading)) ? Number(heading) : 0;
  const readingSource = source === 'citizen_camera_gps' ? 'citizen_camera_gps' : 'live_gps';
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO gps_locations (id, vehicle_id, report_id, user_id, lat, lng, accuracy_meters, speed_kmh, heading, source, captured_at, recorded_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, report_id || null, req.user!.id, numLat, numLng, accNum, numSpeed, numHeading, readingSource, capturedIso, nowIso);

  const supabaseSynced = await syncGpsLocationToSupabase({
    report_id: report_id || null,
    user_id: req.user!.id,
    lat: numLat,
    lng: numLng,
    accuracy_meters: accNum,
    speed_kmh: numSpeed,
    heading: numHeading,
    source: readingSource,
    captured_at: capturedIso,
    recorded_at: nowIso,
  });

  res.status(201).json({
    id,
    user_id: req.user!.id,
    report_id: report_id || null,
    lat: numLat,
    lng: numLng,
    accuracy_meters: accNum,
    captured_at: capturedIso,
    recorded_at: nowIso,
    supabaseSynced,
  });
});

app.post('/api/demo-tracking/toggle', optionalAuth, (req: AuthedRequest, res) => {
  const { enabled } = req.body || {};
  const val = enabled ? 'true' : 'false';
  db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'demo_tracking_enabled', val, new Date().toISOString()
  );
  broadcastWs('demo_tracking:state', { enabled: Boolean(enabled) });
  if (enabled) {
    advanceDemoVehicles();
  }
  res.json({ demoTrackingEnabled: Boolean(enabled) });
});

app.get('/api/routes', (_req, res) => {
  const routes = db.prepare(`
    SELECT r.*, v.registration_number as vehicle_reg, v.status as vehicle_status, p.name as driver_name
    FROM collection_routes r
    LEFT JOIN vehicles v ON r.vehicle_id = v.id
    LEFT JOIN profiles p ON v.driver_id = p.id
    ORDER BY r.ward_number ASC
  `).all() as Array<Record<string, unknown>>;

  const stopsStmt = db.prepare('SELECT * FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC');
  const enriched = routes.map((r) => ({
    ...r,
    waypoints: JSON.parse((r.waypoints_json as string) || '[]'),
    stops: stopsStmt.all(r.id as string),
  }));
  res.json({ routes: enriched });
});

app.post('/api/admin/routes', requireAuth, requireRole('admin', 'inspector'), (req: AuthedRequest, res) => {
  const { route_name, ward_number, vehicle_id, stops } = req.body || {};
  if (!route_name || !ward_number || !Array.isArray(stops) || stops.length < 2) {
    res.status(400).json({ error: 'Route name, ward number, and at least 2 stops are required.' });
    return;
  }
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO collection_routes (id, route_name, ward_number, vehicle_id, start_point_name, end_point_name, waypoints_json, status, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 0, ?)
  `).run(
    id, String(route_name), Number(ward_number), vehicle_id || null,
    stops[0].name, stops[stops.length - 1].name, JSON.stringify(stops), nowIso
  );

  const insertStop = db.prepare(`
    INSERT INTO route_stops (id, route_id, stop_order, stop_name, lat, lng, status, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Pending', '', ?)
  `);
  stops.forEach((st: { name: string; lat: number; lng: number }, i: number) => {
    insertStop.run(crypto.randomUUID(), id, i + 1, st.name, Number(st.lat), Number(st.lng), nowIso);
  });

  res.status(201).json({ id });
});

app.patch('/api/route-stops/:id', requireAuth, requireRole('worker', 'inspector', 'admin'), (req: AuthedRequest, res) => {
  const { status, notes } = req.body || {};
  if (!['Pending', 'Completed', 'Missed'].includes(status)) {
    res.status(400).json({ error: 'Invalid stop status.' });
    return;
  }
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE route_stops SET status = ?, notes = ?, updated_at = ? WHERE id = ?').run(
    status, String(notes || ''), nowIso, req.params.id
  );
  broadcastWs('route:stop_updated', { stopId: req.params.id, status, notes: notes || '' });
  res.json({ ok: true });
});

// ---------------- ESCALATIONS & NOTIFICATIONS ----------------
app.get('/api/escalations', requireAuth, requireRole('inspector', 'admin'), (_req, res) => {
  const rows = db.prepare(`
    SELECT e.*, c.complaint_code, c.ward_number, c.area_name, c.status as complaint_status
    FROM escalations e
    JOIN complaints c ON e.complaint_id = c.id
    ORDER BY e.created_at DESC
  `).all();
  res.json({ escalations: rows });
});

app.post('/api/escalations/run', requireAuth, requireRole('inspector', 'admin'), (req: AuthedRequest, res) => {
  const count = runEscalationJob();
  logAudit(req.user!.id, req.user!.role, 'RUN_ESCALATION_CHECK', 'escalations', 'manual', `Escalated ${count} complaints`);
  res.json({ escalatedCount: count });
});

app.get('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? OR role_target = ?
    ORDER BY created_at DESC LIMIT 40
  `).all(req.user!.id, req.user!.role);
  res.json({ notifications: rows });
});

app.patch('/api/notifications/:id/read', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------- ANNOUNCEMENTS & CONTACT ----------------
app.get('/api/announcements', (_req, res) => {
  const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20').all();
  res.json({ announcements: rows });
});

app.post('/api/admin/announcements', requireAuth, requireRole('admin', 'inspector'), (req: AuthedRequest, res) => {
  const { title, body, ward_number } = req.body || {};
  if (!title || !body) {
    res.status(400).json({ error: 'Title and body are required.' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO announcements (id, title, body, ward_number, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(title), String(body), ward_number ? Number(ward_number) : null, req.user!.name, new Date().toISOString());
  res.status(201).json({ id });
});

app.post('/api/contact', (req, res) => {
  const { name, email, subject, message } = req.body || {};
  if (!name || !email || !message) {
    res.status(400).json({ error: 'Name, email, and message are required.' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO contact_inquiries (id, name, email, subject, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(name), String(email), String(subject || 'General Inquiry'), String(message), new Date().toISOString());
  res.status(201).json({ id, message: 'Inquiry submitted successfully.' });
});

// ---------------- ADMIN USERS & AUDIT LOGS ----------------
app.get('/api/admin/users', requireAuth, requireRole('admin', 'inspector'), (req: AuthedRequest, res) => {
  if (req.user!.role === 'inspector') {
    const workers = db.prepare(`
      SELECT id, name, email, phone, role, ward_number, assigned_wards_json, is_active, is_demo, created_at
      FROM profiles WHERE role = 'worker' ORDER BY created_at DESC
    `).all();
    res.json({ users: workers });
    return;
  }
  const users = db.prepare(`
    SELECT id, name, email, phone, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo, created_at
    FROM profiles ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { name, email, phone, password, role, ward_number, assigned_wards } = req.body || {};
  if (!name || !email || !phone || !password || !['citizen', 'worker', 'inspector', 'admin'].includes(role)) {
    res.status(400).json({ error: 'Valid name, email, phone, password, and role are required.' });
    return;
  }
  const normEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM profiles WHERE email = ?').get(normEmail);
  if (exists) {
    res.status(409).json({ error: 'Email already registered.' });
    return;
  }
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO profiles (id, name, email, phone, password_hash, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en', 1, 0, ?)
  `).run(
    id, String(name), normEmail, String(phone), hashPassword(String(password)),
    role, ward_number ? Number(ward_number) : null, JSON.stringify(assigned_wards || []), nowIso
  );
  logAudit(req.user!.id, req.user!.role, 'CREATE_USER', 'user', id, `${role}: ${normEmail}`);
  res.status(201).json({ id });
});

app.patch('/api/admin/users/:id', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { is_active, role, assigned_wards, ward_number } = req.body || {};
  db.prepare(`
    UPDATE profiles SET
      is_active = COALESCE(?, is_active),
      role = COALESCE(?, role),
      assigned_wards_json = COALESCE(?, assigned_wards_json),
      ward_number = COALESCE(?, ward_number)
    WHERE id = ?
  `).run(
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    ['citizen', 'worker', 'inspector', 'admin'].includes(role) ? role : null,
    Array.isArray(assigned_wards) ? JSON.stringify(assigned_wards) : null,
    ward_number !== undefined ? Number(ward_number) : null,
    req.params.id
  );
  logAudit(req.user!.id, req.user!.role, 'UPDATE_USER', 'user', req.params.id, JSON.stringify({ is_active, role }));
  res.json({ ok: true });
});

app.get('/api/admin/audit-logs', requireAuth, requireRole('admin'), (_req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all();
  res.json({ logs });
});

// ---------------- ANALYTICS ----------------
app.get('/api/analytics', (_req, res) => {
  const byCategory = db.prepare('SELECT category as name, COUNT(*) as value FROM complaints GROUP BY category').all();
  const byStatus = db.prepare('SELECT status as name, COUNT(*) as value FROM complaints GROUP BY status').all();
  const byWard = db.prepare(`
    SELECT c.ward_number as ward, COALESCE(w.name, 'Ward not verified') as wardName,
      COUNT(*) as total,
      SUM(CASE WHEN c.status IN ('Resolved', 'Closed', 'Awaiting Citizen Verification') THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN c.status NOT IN ('Resolved', 'Closed', 'Rejected') THEN 1 ELSE 0 END) as pending
    FROM complaints c
    LEFT JOIN wards w ON c.ward_number = w.ward_number
    GROUP BY c.ward_number ORDER BY total DESC LIMIT 12
  `).all();

  const dailyTrend = db.prepare(`
    SELECT substr(created_at, 1, 10) as date,
      COUNT(*) as submitted,
      SUM(CASE WHEN status IN ('Resolved', 'Closed', 'Awaiting Citizen Verification') THEN 1 ELSE 0 END) as resolved
    FROM complaints GROUP BY substr(created_at, 1, 10) ORDER BY date ASC
  `).all();

  const vehicleSummary = db.prepare('SELECT status as name, COUNT(*) as value FROM vehicles GROUP BY status').all();
  const wardSatisfaction = db.prepare(`
    SELECT ward_number as ward, ROUND(AVG(rating), 1) as avgRating, COUNT(*) as count
    FROM feedback GROUP BY ward_number ORDER BY ward_number ASC
  `).all();

  res.json({ byCategory, byStatus, byWard, dailyTrend, vehicleSummary, wardSatisfaction });
});

// ---------------- AI ENDPOINTS (SERVER-SIDE GEMINI) ----------------
app.post('/api/ai/classify-waste', optionalAuth, async (req: AuthedRequest, res) => {
  const { imageBase64, mimeType, complaintId } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'Image payload (imageBase64) is required.' });
    return;
  }
  try {
    const result = await classifyWasteImage(imageBase64, mimeType || 'image/jpeg');
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO waste_classifications (
        id, complaint_id, user_id, can_classify, predicted_category, confidence,
        detected_objects_json, category_distribution_json, category_recommendations_json,
        disposal_method, segregation_tip, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      complaintId || null,
      req.user?.id || null,
      result.canClassify ? 1 : 0,
      result.predictedCategory,
      result.confidence ?? 0,
      JSON.stringify(result.detectedObjects),
      JSON.stringify(result.categoryDistribution),
      JSON.stringify(result.categoryRecommendations),
      result.disposalMethod,
      result.segregationRecommendation,
      nowIso
    );

    void syncAiClassificationToSupabase({
      id,
      report_id: complaintId || null,
      user_id: req.user?.id || null,
      can_classify: result.canClassify,
      predicted_category: result.predictedCategory,
      confidence: result.confidence ?? 0,
      detected_objects_json: result.detectedObjects,
      category_distribution_json: result.categoryDistribution,
      disposal_method: result.disposalMethod,
      segregation_tip: result.segregationRecommendation,
      created_at: nowIso,
    });

    res.json({ id, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI classification failed.';
    res.status(500).json({ error: msg });
  }
});

app.patch('/api/ai/classify-waste/:id', (req, res) => {
  const { correctedCategory } = req.body || {};
  if (!correctedCategory) {
    res.status(400).json({ error: 'correctedCategory is required.' });
    return;
  }
  db.prepare('UPDATE waste_classifications SET corrected_category = ? WHERE id = ?').run(String(correctedCategory), req.params.id);
  res.json({ ok: true });
});

app.post('/api/ai/voice-assistant', optionalAuth, async (req: AuthedRequest, res) => {
  const { transcript, language, currentPath, lat, lng } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    res.status(400).json({ error: 'Voice or text query transcript is required.' });
    return;
  }
  const supportedLangs = ['en', 'kn', 'hi', 'mr', 'ta', 'te'];
  const lang = supportedLangs.includes(String(language)) ? String(language) : 'en';

  const userLat = lat !== undefined && Number.isFinite(Number(lat)) ? Number(lat) : null;
  const userLng = lng !== undefined && Number.isFinite(Number(lng)) ? Number(lng) : null;

  // 1. Query matching complaint by explicit code (e.g. ST-BGM-2026-0001) or user's own complaints
  const codeMatch = transcript.toUpperCase().match(/ST-BGM-\d{4}-\d{4}/);
  let matchedComplaints: Array<{
    complaint_code: string;
    status: string;
    ward_number: number;
    area_name: string;
    category: string;
    vehicle_reg: string | null;
    updated_at: string;
  }> = [];

  if (codeMatch) {
    matchedComplaints = db.prepare(`
      SELECT c.complaint_code, c.status, c.ward_number, c.area_name, c.category, v.registration_number as vehicle_reg, c.updated_at
      FROM complaints c
      LEFT JOIN vehicles v ON c.assigned_vehicle_id = v.id
      WHERE UPPER(c.complaint_code) = ?
    `).all(codeMatch[0]) as typeof matchedComplaints;
  } else if (req.user) {
    matchedComplaints = db.prepare(`
      SELECT c.complaint_code, c.status, c.ward_number, c.area_name, c.category, v.registration_number as vehicle_reg, c.updated_at
      FROM complaints c
      LEFT JOIN vehicles v ON c.assigned_vehicle_id = v.id
      WHERE c.citizen_id = ? OR c.assigned_worker_id = ? OR c.assigned_inspector_id = ?
      ORDER BY c.updated_at DESC LIMIT 5
    `).all(req.user.id, req.user.id, req.user.id) as typeof matchedComplaints;
  } else {
    matchedComplaints = db.prepare(`
      SELECT c.complaint_code, c.status, c.ward_number, c.area_name, c.category, v.registration_number as vehicle_reg, c.updated_at
      FROM complaints c
      LEFT JOIN vehicles v ON c.assigned_vehicle_id = v.id
      ORDER BY c.updated_at DESC LIMIT 3
    `).all() as typeof matchedComplaints;
  }

  // 2. Query real vehicles + latest GPS telemetry (distinguishing live_gps vs demo_simulation)
  const rawVehicles = db.prepare(`
    SELECT v.id, v.registration_number, v.status, v.assigned_ward
    FROM vehicles v ORDER BY v.vehicle_code ASC
  `).all() as Array<{ id: string; registration_number: string; status: string; assigned_ward: number | null }>;

  const locStmt = db.prepare(`
    SELECT lat, lng, source, recorded_at FROM vehicle_locations WHERE vehicle_id = ? ORDER BY recorded_at DESC LIMIT 1
  `);

  const nearbyVehicles = rawVehicles
    .map((v) => {
      const loc = locStmt.get(v.id) as { lat: number; lng: number; source: 'live_gps' | 'demo_simulation'; recorded_at: string } | undefined;
      if (!loc) return null;
      const dist = userLat !== null && userLng !== null ? Number(haversineKm(userLat, userLng, loc.lat, loc.lng).toFixed(2)) : null;
      return {
        registration_number: v.registration_number,
        status: v.status,
        assigned_ward: v.assigned_ward,
        lat: loc.lat,
        lng: loc.lng,
        source: loc.source,
        distance_km: dist,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999))
    .slice(0, 4);

  // 3. Query nearest garbage collection stops from collection_routes / route_stops
  const rawStops = db.prepare(`
    SELECT rs.stop_name, rs.status, rs.lat, rs.lng, cr.route_name, cr.ward_number
    FROM route_stops rs
    JOIN collection_routes cr ON rs.route_id = cr.id
  `).all() as Array<{
    stop_name: string;
    status: string;
    lat: number;
    lng: number;
    route_name: string;
    ward_number: number;
  }>;

  const nearbyStops = rawStops
    .map((s) => ({
      ...s,
      distance_km: userLat !== null && userLng !== null ? Number(haversineKm(userLat, userLng, s.lat, s.lng).toFixed(2)) : null,
    }))
    .sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999))
    .slice(0, 4);

  const complaintSummary = matchedComplaints.length
    ? matchedComplaints
        .map(
          (c) =>
            `${c.complaint_code} (Ward ${c.ward_number}, ${c.area_name}, ${c.category}) -> Status: ${c.status}${
              c.vehicle_reg ? `, Vehicle: ${c.vehicle_reg}` : ''
            }`
        )
        .join(' | ')
    : 'No matching complaints found in database.';

  const vehicleSummary = nearbyVehicles.length
    ? nearbyVehicles
        .map(
          (v) =>
            `${v.registration_number} [${v.status}, ${v.source === 'live_gps' ? 'ACTUAL LIVE GPS' : 'DEMO SIMULATION'}, Ward ${
              v.assigned_ward ?? '-'
            }] at (${v.lat.toFixed(4)}, ${v.lng.toFixed(4)})${v.distance_km !== null ? ` (${v.distance_km} km away)` : ''}`
        )
        .join(' | ')
    : 'No active GPS vehicle telemetry recorded yet.';

  const stopSummary = nearbyStops.length
    ? nearbyStops
        .map(
          (s) =>
            `${s.stop_name} (Ward ${s.ward_number}, Route: ${s.route_name}, Status: ${s.status})${
              s.distance_km !== null ? ` - ${s.distance_km} km away` : ''
            }`
        )
        .join(' | ')
    : 'No collection stops configured.';

  const liveContextSummary = [
    `User role: ${req.user?.role || 'guest'} (${req.user?.name || 'Visitor'}). Current page: ${currentPath || '/'}.`,
    userLat !== null && userLng !== null
      ? `User current live GPS: ${userLat.toFixed(5)}, ${userLng.toFixed(5)}.`
      : 'User live GPS not shared yet.',
    `REAL COMPLAINTS IN DB: ${complaintSummary}`,
    `COLLECTION VEHICLES IN DB: ${vehicleSummary}`,
    `COLLECTION POINTS / ROUTE STOPS IN DB: ${stopSummary}`,
  ].join('\n');

  try {
    const reply = await processVoiceAssistant(transcript, lang, liveContextSummary);
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO voice_assistant_logs (id, user_id, language, transcript, intent, reply_text, lat, lng, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), req.user?.id || null, lang, transcript, reply.intent, reply.replyText, userLat, userLng, nowIso);

    void syncVoiceLogToSupabase({
      user_id: req.user?.id || null,
      language: lang,
      transcript,
      intent: reply.intent,
      reply_text: reply.replyText,
      lat: userLat,
      lng: userLng,
      created_at: nowIso,
    });

    res.json({
      ...reply,
      matchedComplaints,
      nearbyVehicles,
      nearbyStops,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Voice assistant request failed.';
    res.status(500).json({ error: msg });
  }
});

// ---------------- VITE / STATIC SERVING ----------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SANITRACK server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
