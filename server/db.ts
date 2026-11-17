import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'sanitrack.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, key] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('citizen', 'worker', 'inspector', 'admin')),
      ward_number INTEGER,
      assigned_wards_json TEXT DEFAULT '[]',
      language_pref TEXT DEFAULT 'en',
      is_active INTEGER DEFAULT 1,
      is_demo INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wards (
      ward_number INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      zone TEXT NOT NULL,
      population_est INTEGER DEFAULT 12000,
      inspector_id TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      cleanliness_score REAL DEFAULT 84.0,
      is_demo INTEGER DEFAULT 1,
      FOREIGN KEY (inspector_id) REFERENCES profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      vehicle_code TEXT UNIQUE NOT NULL,
      registration_number TEXT NOT NULL,
      vehicle_type TEXT NOT NULL CHECK(vehicle_type IN ('primary', 'secondary')),
      assigned_ward INTEGER,
      driver_id TEXT,
      helper_names TEXT DEFAULT 'Helper 1, Helper 2',
      status TEXT NOT NULL DEFAULT 'Idle' CHECK(status IN ('Active', 'On Route', 'Collecting Waste', 'Idle', 'Under Maintenance', 'Offline')),
      is_demo INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (driver_id) REFERENCES profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      license_number TEXT NOT NULL,
      vehicle_id TEXT,
      duty_status TEXT DEFAULT 'Off Duty',
      on_duty_since TEXT,
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS collection_routes (
      id TEXT PRIMARY KEY,
      route_name TEXT NOT NULL,
      ward_number INTEGER NOT NULL,
      vehicle_id TEXT,
      start_point_name TEXT NOT NULL,
      end_point_name TEXT NOT NULL,
      waypoints_json TEXT NOT NULL,
      status TEXT DEFAULT 'Scheduled',
      is_demo INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS route_stops (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      stop_order INTEGER NOT NULL,
      stop_name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Completed', 'Missed')),
      notes TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (route_id) REFERENCES collection_routes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vehicle_locations (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      speed_kmh REAL DEFAULT 0,
      heading REAL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'live_gps' CHECK(source IN ('live_gps', 'demo_simulation')),
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      complaint_code TEXT UNIQUE NOT NULL,
      citizen_id TEXT NOT NULL,
      ward_number INTEGER NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      area_name TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Medium' CHECK(priority IN ('Low', 'Medium', 'High', 'Emergency')),
      status TEXT NOT NULL DEFAULT 'Submitted',
      assigned_inspector_id TEXT,
      assigned_worker_id TEXT,
      assigned_vehicle_id TEXT,
      escalation_level INTEGER DEFAULT 0,
      sla_deadline TEXT NOT NULL,
      citizen_confirmed INTEGER DEFAULT 0,
      obstacle_note TEXT DEFAULT '',
      is_demo INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (citizen_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_inspector_id) REFERENCES profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_worker_id) REFERENCES profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS complaint_photos (
      id TEXT PRIMARY KEY,
      complaint_id TEXT NOT NULL,
      photo_type TEXT NOT NULL CHECK(photo_type IN ('before', 'after', 'evidence')),
      image_data TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS complaint_assignments (
      id TEXT PRIMARY KEY,
      complaint_id TEXT NOT NULL,
      inspector_id TEXT,
      worker_id TEXT,
      vehicle_id TEXT,
      notes TEXT DEFAULT '',
      assigned_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS complaint_status_history (
      id TEXT PRIMARY KEY,
      complaint_id TEXT NOT NULL,
      status TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_role TEXT NOT NULL,
      remarks TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      complaint_id TEXT UNIQUE NOT NULL,
      citizen_id TEXT NOT NULL,
      ward_number INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT DEFAULT '',
      photo_data TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
      FOREIGN KEY (citizen_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS waste_classifications (
      id TEXT PRIMARY KEY,
      complaint_id TEXT,
      user_id TEXT,
      predicted_category TEXT NOT NULL,
      corrected_category TEXT,
      confidence REAL DEFAULT 0,
      disposal_method TEXT NOT NULL,
      segregation_tip TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      role_target TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      related_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      complaint_id TEXT NOT NULL,
      level INTEGER NOT NULL CHECK(level IN (1, 2, 3)),
      escalated_to_role TEXT NOT NULL,
      reason TEXT NOT NULL,
      sla_hours INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      ward_number INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_inquiries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gps_locations (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT,
      report_id TEXT,
      user_id TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_meters REAL,
      speed_kmh REAL DEFAULT 0,
      heading REAL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'citizen_camera_gps',
      captured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_assistant_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      transcript TEXT NOT NULL,
      intent TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      lat REAL,
      lng REAL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_complaints_ward ON complaints(ward_number);
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
    CREATE INDEX IF NOT EXISTS idx_complaints_worker ON complaints(assigned_worker_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_citizen ON complaints(citizen_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at);
    CREATE INDEX IF NOT EXISTS idx_vehicle_locations_vid ON vehicle_locations(vehicle_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_report ON gps_locations(report_id);
    CREATE INDEX IF NOT EXISTS idx_voice_logs_user ON voice_assistant_logs(user_id, created_at);
  `);

  upgradeExtendedColumns();
  seedInitialData();
  upgradeDemoRoadWaypoints();
}

function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function upgradeExtendedColumns(): void {
  ensureColumn('complaints', 'gps_accuracy', 'REAL');
  ensureColumn('complaints', 'capture_timestamp', 'TEXT');
  ensureColumn('complaints', 'ai_classification_json', 'TEXT');
  ensureColumn('complaint_photos', 'storage_url', 'TEXT');
  ensureColumn('complaint_photos', 'gps_accuracy', 'REAL');
  ensureColumn('complaint_photos', 'captured_at', 'TEXT');
  ensureColumn('waste_classifications', 'can_classify', 'INTEGER DEFAULT 1');
  ensureColumn('waste_classifications', 'detected_objects_json', "TEXT DEFAULT '[]'");
  ensureColumn('waste_classifications', 'category_distribution_json', "TEXT DEFAULT '[]'");
  ensureColumn('waste_classifications', 'category_recommendations_json', "TEXT DEFAULT '[]'");
}

const BELAGAVI_ROAD_ROUTE_1 = [
  { lat: 15.8622, lng: 74.5131, name: 'Sadashiv Nagar Main Rd (Start)' },
  { lat: 15.8594, lng: 74.5112, name: 'Dr. Ambedkar Rd Cross' },
  { lat: 15.8576, lng: 74.5082, name: 'JNMC Gate Junction' },
  { lat: 15.8558, lng: 74.5051, name: 'Nehru Nagar / Club Rd' },
  { lat: 15.8531, lng: 74.5021, name: 'Rani Channamma Circle' },
  { lat: 15.8505, lng: 74.5030, name: 'College Road North' },
  { lat: 15.8477, lng: 74.5042, name: 'College Road Cross' },
  { lat: 15.8448, lng: 74.5058, name: 'Bogarves Circle' },
  { lat: 15.8423, lng: 74.5084, name: 'Tilakwadi 1st Gate' },
  { lat: 15.8403, lng: 74.5113, name: 'Tilakwadi Congress Rd' },
  { lat: 15.8386, lng: 74.5142, name: 'RPD Cross Transfer Point (End)' },
];

const BELAGAVI_ROAD_ROUTE_2 = [
  { lat: 15.8634, lng: 74.4892, name: 'Hanuman Nagar Staging Yard (Start)' },
  { lat: 15.8602, lng: 74.4921, name: 'Hindalga Camp Link Rd' },
  { lat: 15.8576, lng: 74.4951, name: 'Camp Market Road' },
  { lat: 15.8546, lng: 74.4968, name: 'Camp Parade Ground Rd' },
  { lat: 15.8518, lng: 74.4981, name: 'Fort Road Junction' },
  { lat: 15.8490, lng: 74.4974, name: 'Ganpat Galli / Maruti Galli' },
  { lat: 15.8462, lng: 74.4963, name: 'Khade Bazar Main' },
  { lat: 15.8433, lng: 74.4978, name: 'Basaveshwar Circle' },
  { lat: 15.8402, lng: 74.5001, name: 'Shahapur Cross (End)' },
];

const BELAGAVI_ROAD_ROUTE_3 = [
  { lat: 15.8371, lng: 74.5059, name: 'Tilakwadi 2nd Gate (Start)' },
  { lat: 15.8352, lng: 74.5026, name: 'Vaccine Depot Road' },
  { lat: 15.8331, lng: 74.4989, name: 'Angol Main Road' },
  { lat: 15.8315, lng: 74.4954, name: 'Bhagyanagar Cross' },
  { lat: 15.8342, lng: 74.4926, name: 'Khasbag Main Road' },
  { lat: 15.8378, lng: 74.4945, name: 'Vadgaon Cross (End)' },
];

function upgradeDemoRoadWaypoints(): void {
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE collection_routes SET waypoints_json = ? WHERE id = 'route-demo-01'`).run(
    JSON.stringify(BELAGAVI_ROAD_ROUTE_1)
  );
  db.prepare(`UPDATE collection_routes SET waypoints_json = ? WHERE id = 'route-demo-02'`).run(
    JSON.stringify(BELAGAVI_ROAD_ROUTE_2)
  );

  const hasRoute3 = db.prepare(`SELECT id FROM collection_routes WHERE id = 'route-demo-03'`).get();
  if (!hasRoute3) {
    const hasVeh3 = db.prepare(`SELECT id FROM vehicles WHERE id = 'veh-demo-03'`).get();
    if (hasVeh3) {
      db.prepare(`
        INSERT INTO collection_routes (id, route_name, ward_number, vehicle_id, start_point_name, end_point_name, waypoints_json, status, is_demo, created_at)
        VALUES ('route-demo-03', 'Tilakwadi & Angol Corridor (Demo)', 1, 'veh-demo-03', ?, ?, ?, 'Active', 1, ?)
      `).run(
        BELAGAVI_ROAD_ROUTE_3[0].name,
        BELAGAVI_ROAD_ROUTE_3[BELAGAVI_ROAD_ROUTE_3.length - 1].name,
        JSON.stringify(BELAGAVI_ROAD_ROUTE_3),
        nowIso
      );
      const insertStop = db.prepare(`
        INSERT OR IGNORE INTO route_stops (id, route_id, stop_order, stop_name, lat, lng, status, notes, updated_at)
        VALUES (?, 'route-demo-03', ?, ?, ?, ?, ?, '', ?)
      `);
      BELAGAVI_ROAD_ROUTE_3.forEach((wp, idx) => {
        insertStop.run(`stop-r3-${idx + 1}`, idx + 1, wp.name, wp.lat, wp.lng, idx === 0 ? 'Completed' : 'Pending', nowIso);
      });
    }
  } else {
    db.prepare(`UPDATE collection_routes SET waypoints_json = ? WHERE id = 'route-demo-03'`).run(
      JSON.stringify(BELAGAVI_ROAD_ROUTE_3)
    );
  }
}

function seedInitialData(): void {
  const existingUsers = db.prepare('SELECT COUNT(*) as c FROM profiles').get() as { c: number };
  if (existingUsers.c > 0) return;

  const now = new Date();
  const isoNow = now.toISOString();

  // Municipal baseline configuration (Editable in Admin Dashboard)
  const settings = [
    ['city_name', 'Belagavi (Belgaum)'],
    ['state_name', 'Karnataka'],
    ['country_name', 'India'],
    ['approx_population', '700000'],
    ['approx_area_sq_km', '94.03'],
    ['total_wards', '58'],
    ['primary_vehicles_baseline', '110'],
    ['secondary_vehicles_baseline', '67'],
    ['sanitation_inspectors_baseline', '15'],
    ['crew_configuration', '1 Driver + 2 Helpers'],
    ['sla_resolution_hours', '24'],
    ['demo_tracking_enabled', 'false'],
  ];
  const insertSetting = db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of settings) {
    insertSetting.run(k, v, isoNow);
  }

  // Demo users for all 4 roles (clearly labeled DEMO DATA)
  const demoUsers = [
    {
      id: 'user-citizen-demo',
      name: 'Aarav Kulkarni (Demo Citizen)',
      email: 'citizen@sanitrack.demo',
      phone: '+91 98450 00001',
      password: 'DemoUser@123',
      role: 'citizen',
      ward_number: 12,
      assigned_wards_json: '[]',
    },
    {
      id: 'user-worker-demo',
      name: 'Ramesh Naik (Demo Driver / Crew)',
      email: 'driver@sanitrack.demo',
      phone: '+91 98450 00002',
      password: 'DemoUser@123',
      role: 'worker',
      ward_number: 12,
      assigned_wards_json: '[11, 12, 13, 14]',
    },
    {
      id: 'user-worker-demo-2',
      name: 'Suresh Patil (Demo Crew 2)',
      email: 'worker2@sanitrack.demo',
      phone: '+91 98450 00005',
      password: 'DemoUser@123',
      role: 'worker',
      ward_number: 24,
      assigned_wards_json: '[21, 22, 23, 24]',
    },
    {
      id: 'user-inspector-demo',
      name: 'Deepa Deshpande (Demo Ward Supervisor)',
      email: 'supervisor@sanitrack.demo',
      phone: '+91 98450 00003',
      password: 'DemoUser@123',
      role: 'inspector',
      ward_number: 12,
      assigned_wards_json: JSON.stringify([1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 22, 24]),
    },
    {
      id: 'user-admin-demo',
      name: 'Rajeshwari Hiremath (Demo Municipal Admin)',
      email: 'admin@sanitrack.demo',
      phone: '+91 98450 00004',
      password: 'DemoUser@123',
      role: 'admin',
      ward_number: null,
      assigned_wards_json: '[]',
    },
  ];

  const insertUser = db.prepare(`
    INSERT INTO profiles (id, name, email, phone, password_hash, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en', 1, 1, ?)
  `);

  for (const u of demoUsers) {
    insertUser.run(u.id, u.name, u.email, u.phone, hashPassword(u.password), u.role, u.ward_number, u.assigned_wards_json, isoNow);
  }

  // 58 Wards of Belagavi (Ward 1 to Ward 58 — sample locality names around Belagavi center 15.8497, 74.4977)
  const belagaviLocalities = [
    'Tilakwadi North', 'Tilakwadi South', 'Shahapur Bazar', 'Shahapur Khadebazar', 'Vadgaon East',
    'Vadgaon West', 'Khasbag', 'Angol Main', 'Angol Extension', 'Hindwadi',
    'Bhagyanagar', 'Sadashiv Nagar', 'Hanuman Nagar', 'Nehru Nagar', 'Mahantesh Nagar',
    'Ramteerth Nagar', 'Auto Nagar', 'Kanbargi', 'Rukmini Nagar', 'Vaibhav Nagar',
    'Azam Nagar', 'Shahu Nagar', 'Shivbasav Nagar', 'Camp Area', 'Fort Road',
    'Ganpat Galli', 'Maruti Galli', 'Khade Bazar', 'Raviwar Peth', 'Bogarves',
    'Channamma Circle', 'College Road', 'Club Road', 'Vishweshwarayya Nagar', 'Udyambag North',
    'Udyambag Industrial', 'Majgaon', 'Peeranwadi', 'Machhe', 'Hindalga',
    'Kangrali KH', 'Kangrali BK', 'Kakati', 'Yamanapur', 'Sambra Road',
    'Gandhi Nagar', 'Subhash Nagar', 'Malmaruti Extension', 'Vijayanagar', 'Jadhav Nagar',
    'Anjaneya Nagar', 'Srinagar', 'Kumaraswamy Layout', 'Kuvempu Nagar', 'Belgaum Cantonment',
    'Bauxite Road', 'Gokul Nagar', 'Kallehol Sector'
  ];

  const zones = ['North Zone', 'South Zone', 'Central Zone', 'East Zone'];
  const insertWard = db.prepare(`
    INSERT INTO wards (ward_number, id, name, zone, population_est, inspector_id, lat, lng, cleanliness_score, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  for (let i = 1; i <= 58; i++) {
    const angle = (i * 137.5 * Math.PI) / 180;
    const radius = 0.008 + ((i % 7) * 0.0045);
    const lat = Number((15.8497 + Math.sin(angle) * radius).toFixed(6));
    const lng = Number((74.4977 + Math.cos(angle) * radius).toFixed(6));
    const zone = zones[(i - 1) % zones.length];
    const inspId = [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 22, 24].includes(i) ? 'user-inspector-demo' : null;
    const score = Number((76 + ((i * 7) % 21)).toFixed(1));
    insertWard.run(i, `ward-${i}`, `Ward ${i} — ${belagaviLocalities[i - 1]}`, zone, 11500 + (i * 120), inspId, lat, lng, score);
  }

  // Demo vehicles (clearly marked DEMO DATA — admin enters real registration numbers in production)
  const demoVehicles = [
    {
      id: 'veh-demo-01',
      code: 'DEMO-PRI-01',
      reg: 'KA-22-DEMO-101',
      type: 'primary',
      ward: 12,
      driver: 'user-worker-demo',
      helpers: 'Mohan Rao, Kiran Kamble (Demo)',
      status: 'On Route',
    },
    {
      id: 'veh-demo-02',
      code: 'DEMO-PRI-02',
      reg: 'KA-22-DEMO-102',
      type: 'primary',
      ward: 24,
      driver: 'user-worker-demo-2',
      helpers: 'Vikram Pawar, Arun Joshi (Demo)',
      status: 'Collecting Waste',
    },
    {
      id: 'veh-demo-03',
      code: 'DEMO-SEC-01',
      reg: 'KA-22-DEMO-201',
      type: 'secondary',
      ward: 1,
      driver: null,
      helpers: 'Sanitation Compactor Crew (Demo)',
      status: 'Idle',
    },
    {
      id: 'veh-demo-04',
      code: 'DEMO-SEC-02',
      reg: 'KA-22-DEMO-202',
      type: 'secondary',
      ward: 15,
      driver: null,
      helpers: 'Transfer Compactor Crew (Demo)',
      status: 'Offline',
    },
  ];

  const insertVeh = db.prepare(`
    INSERT INTO vehicles (id, vehicle_code, registration_number, vehicle_type, assigned_ward, driver_id, helper_names, status, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const v of demoVehicles) {
    insertVeh.run(v.id, v.code, v.reg, v.type, v.ward, v.driver, v.helpers, v.status, isoNow);
  }

  db.prepare(`
    INSERT INTO drivers (id, user_id, license_number, vehicle_id, duty_status, on_duty_since)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('drv-demo-01', 'user-worker-demo', 'KA22-DEMO-LIC-001', 'veh-demo-01', 'On Duty', isoNow);

  db.prepare(`
    INSERT INTO drivers (id, user_id, license_number, vehicle_id, duty_status, on_duty_since)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('drv-demo-02', 'user-worker-demo-2', 'KA22-DEMO-LIC-002', 'veh-demo-02', 'On Duty', isoNow);

  // Demo routes across real Belagavi road coordinates (marked DEMO DATA)
  const route1Waypoints = [
    { lat: 15.8592, lng: 74.5132, name: 'Sadashiv Nagar Depot (Start)' },
    { lat: 15.8565, lng: 74.5068, name: 'JNMC Gate Junction' },
    { lat: 15.8529, lng: 74.5015, name: 'Channamma Circle' },
    { lat: 15.8471, lng: 74.5042, name: 'College Road Cross' },
    { lat: 15.8425, lng: 74.5085, name: 'Tilakwadi 1st Gate' },
    { lat: 15.8388, lng: 74.5141, name: 'RPD Cross Transfer Point (End)' },
  ];

  const route2Waypoints = [
    { lat: 15.8625, lng: 74.4910, name: 'Hanuman Nagar Staging Yard (Start)' },
    { lat: 15.8581, lng: 74.4955, name: 'Camp Market Road' },
    { lat: 15.8518, lng: 74.4979, name: 'Fort Road Junction' },
    { lat: 15.8460, lng: 74.4962, name: 'Khade Bazar Main' },
    { lat: 15.8404, lng: 74.4998, name: 'Shahapur Cross (End)' },
  ];

  db.prepare(`
    INSERT INTO collection_routes (id, route_name, ward_number, vehicle_id, start_point_name, end_point_name, waypoints_json, status, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 1, ?)
  `).run('route-demo-01', 'Ward 12 Central Loop (Demo)', 12, 'veh-demo-01', route1Waypoints[0].name, route1Waypoints[route1Waypoints.length - 1].name, JSON.stringify(route1Waypoints), isoNow);

  db.prepare(`
    INSERT INTO collection_routes (id, route_name, ward_number, vehicle_id, start_point_name, end_point_name, waypoints_json, status, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 1, ?)
  `).run('route-demo-02', 'Camp & Khade Bazar Corridor (Demo)', 24, 'veh-demo-02', route2Waypoints[0].name, route2Waypoints[route2Waypoints.length - 1].name, JSON.stringify(route2Waypoints), isoNow);

  const insertStop = db.prepare(`
    INSERT INTO route_stops (id, route_id, stop_order, stop_name, lat, lng, status, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  route1Waypoints.forEach((wp, idx) => {
    const st = idx < 2 ? 'Completed' : 'Pending';
    insertStop.run(`stop-r1-${idx + 1}`, 'route-demo-01', idx + 1, wp.name, wp.lat, wp.lng, st, idx < 2 ? 'Cleared on schedule (Demo)' : '', isoNow);
  });
  route2Waypoints.forEach((wp, idx) => {
    const st = idx === 0 ? 'Completed' : idx === 1 ? 'Missed' : 'Pending';
    insertStop.run(`stop-r2-${idx + 1}`, 'route-demo-02', idx + 1, wp.name, wp.lat, wp.lng, st, idx === 1 ? 'Access blocked by road work (Demo)' : '', isoNow);
  });

  // Initial vehicle locations (marked demo_simulation — live GPS takes over when driver streams)
  const insertVehLoc = db.prepare(`
    INSERT INTO vehicle_locations (id, vehicle_id, lat, lng, speed_kmh, heading, source, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, 'demo_simulation', ?)
  `);
  insertVehLoc.run(crypto.randomUUID(), 'veh-demo-01', 15.8548, 74.5042, 22.4, 215, isoNow);
  insertVehLoc.run(crypto.randomUUID(), 'veh-demo-02', 15.8581, 74.4955, 16.8, 165, isoNow);
  insertVehLoc.run(crypto.randomUUID(), 'veh-demo-03', 15.8425, 74.5085, 0, 0, isoNow);

  // Sample Belagavi complaints across lifecycle states (clearly tagged is_demo = 1)
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h: number) => new Date(now.getTime() + h * 3600 * 1000).toISOString();

  const demoComplaints = [
    {
      id: 'cmp-demo-01',
      code: 'ST-BGM-2026-0001',
      ward: 12,
      category: 'Overflowing dustbin',
      desc: 'Community twin-bin near Sadashiv Nagar 3rd Cross overflowing since morning (Demo Sample).',
      area: 'Sadashiv Nagar',
      addr: '3rd Cross, Near Ganesh Temple, Belagavi',
      lat: 15.8576,
      lng: 74.5088,
      priority: 'High',
      status: 'In Progress',
      insp: 'user-inspector-demo',
      worker: 'user-worker-demo',
      veh: 'veh-demo-01',
      esc: 0,
      sla: hoursAhead(14),
      created: hoursAgo(10),
    },
    {
      id: 'cmp-demo-02',
      code: 'ST-BGM-2026-0002',
      ward: 1,
      category: 'Roadside garbage',
      desc: 'Unsegregated market waste pile along RPD Cross footpath (Demo Sample).',
      area: 'Tilakwadi',
      addr: 'RPD Cross Road, Tilakwadi, Belagavi',
      lat: 15.8396,
      lng: 74.5122,
      priority: 'Emergency',
      status: 'Submitted',
      insp: 'user-inspector-demo',
      worker: null,
      veh: null,
      esc: 1,
      sla: hoursAgo(4),
      created: hoursAgo(28),
    },
    {
      id: 'cmp-demo-03',
      code: 'ST-BGM-2026-0003',
      ward: 24,
      category: 'Drainage waste',
      desc: 'Plastic bottles blocking stormwater drain near Camp Market corner (Demo Sample).',
      area: 'Camp Area',
      addr: 'Camp Market Road, Belagavi',
      lat: 15.8534,
      lng: 74.4964,
      priority: 'High',
      status: 'Assigned',
      insp: 'user-inspector-demo',
      worker: 'user-worker-demo-2',
      veh: 'veh-demo-02',
      esc: 0,
      sla: hoursAhead(18),
      created: hoursAgo(6),
    },
    {
      id: 'cmp-demo-04',
      code: 'ST-BGM-2026-0004',
      ward: 12,
      category: 'Uncollected garbage',
      desc: 'Door-to-door dry waste bags awaiting pickup at College Road Lane 2 (Demo Sample).',
      area: 'College Road',
      addr: 'College Road, Near Lingaraj College, Belagavi',
      lat: 15.8482,
      lng: 74.5034,
      priority: 'Medium',
      status: 'Awaiting Citizen Verification',
      insp: 'user-inspector-demo',
      worker: 'user-worker-demo',
      veh: 'veh-demo-01',
      esc: 0,
      sla: hoursAhead(8),
      created: hoursAgo(16),
    },
    {
      id: 'cmp-demo-05',
      code: 'ST-BGM-2026-0005',
      ward: 3,
      category: 'Public place sanitation',
      desc: 'Market organic litter near Shahapur corner cleared and sanitized (Demo Sample).',
      area: 'Shahapur',
      addr: 'Khade Bazar, Shahapur, Belagavi',
      lat: 15.8415,
      lng: 74.5011,
      priority: 'Medium',
      status: 'Closed',
      insp: 'user-inspector-demo',
      worker: 'user-worker-demo',
      veh: 'veh-demo-01',
      esc: 0,
      sla: hoursAhead(20),
      created: hoursAgo(42),
    },
    {
      id: 'cmp-demo-06',
      code: 'ST-BGM-2026-0006',
      ward: 13,
      category: 'Waste burning',
      desc: 'Dry leaf and plastic burning reported near Hanuman Nagar park edge (Demo Sample).',
      area: 'Hanuman Nagar',
      addr: 'Stage 2 Park Lane, Hanuman Nagar, Belagavi',
      lat: 15.8628,
      lng: 74.4922,
      priority: 'High',
      status: 'Under Review',
      insp: 'user-inspector-demo',
      worker: null,
      veh: null,
      esc: 2,
      sla: hoursAgo(12),
      created: hoursAgo(36),
    },
  ];

  const insertCmp = db.prepare(`
    INSERT INTO complaints (
      id, complaint_code, citizen_id, ward_number, category, description, area_name, address,
      lat, lng, priority, status, assigned_inspector_id, assigned_worker_id, assigned_vehicle_id,
      escalation_level, sla_deadline, citizen_confirmed, is_demo, created_at, updated_at
    ) VALUES (?, ?, 'user-citizen-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  const insertHist = db.prepare(`
    INSERT INTO complaint_status_history (id, complaint_id, status, changed_by, changed_by_role, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of demoComplaints) {
    insertCmp.run(
      c.id, c.code, c.ward, c.category, c.desc, c.area, c.addr,
      c.lat, c.lng, c.priority, c.status, c.insp, c.worker, c.veh,
      c.esc, c.sla, c.status === 'Closed' ? 1 : 0, c.created, isoNow
    );
    insertHist.run(crypto.randomUUID(), c.id, 'Submitted', 'Aarav Kulkarni (Demo Citizen)', 'citizen', 'Geo-tagged complaint logged (Demo Data)', c.created);
    if (c.status !== 'Submitted') {
      insertHist.run(crypto.randomUUID(), c.id, c.status, 'Deepa Deshpande (Demo Ward Supervisor)', 'inspector', `Status progressed to ${c.status}`, isoNow);
    }
  }

  // Sample feedback for closed complaint
  db.prepare(`
    INSERT INTO feedback (id, complaint_id, citizen_id, ward_number, rating, comment, created_at)
    VALUES (?, 'cmp-demo-05', 'user-citizen-demo', 3, 5, 'Area was cleared promptly and disinfected (Demo Feedback).', ?)
  `).run(crypto.randomUUID(), isoNow);

  // Sample escalation records for overdue demo complaints
  db.prepare(`
    INSERT INTO escalations (id, complaint_id, level, escalated_to_role, reason, sla_hours, created_at)
    VALUES (?, 'cmp-demo-02', 1, 'Ward Supervisor', 'SLA 24h resolution window exceeded (Demo Escalation)', 24, ?)
  `).run(crypto.randomUUID(), isoNow);

  db.prepare(`
    INSERT INTO escalations (id, complaint_id, level, escalated_to_role, reason, sla_hours, created_at)
    VALUES (?, 'cmp-demo-06', 2, 'Municipal Officer', 'Unassigned past 36h threshold (Demo Escalation)', 24, ?)
  `).run(crypto.randomUUID(), isoNow);

  // Sample announcements
  db.prepare(`
    INSERT INTO announcements (id, title, body, ward_number, created_by, created_at)
    VALUES (?, ?, ?, NULL, 'Municipal Administration (Demo)', ?)
  `).run(
    crypto.randomUUID(),
    'Source Segregation Drive Across Belagavi Wards 1–58',
    'Please hand over wet organic waste in green bins and dry recyclable waste in blue bins during morning door-to-door collection.',
    isoNow
  );

  db.prepare(`
    INSERT INTO announcements (id, title, body, ward_number, created_by, created_at)
    VALUES (?, ?, ?, 12, 'Ward 12 Sanitation Office (Demo)', ?)
  `).run(
    crypto.randomUUID(),
    'Morning Route Schedule Update — Ward 12',
    'Primary tipper vehicle operates between 7:00 AM and 11:00 AM across Sadashiv Nagar and College Road.',
    isoNow
  );

  // Sample notifications
  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, title, message, type, related_id, is_read, created_at)
    VALUES (?, 'user-citizen-demo', 'citizen', 'Cleaning Completed — Awaiting Confirmation', 'Complaint ST-BGM-2026-0004 is marked resolved. Please verify and rate.', 'success', 'cmp-demo-04', 0, ?)
  `).run(crypto.randomUUID(), isoNow);

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, title, message, type, related_id, is_read, created_at)
    VALUES (?, 'user-inspector-demo', 'inspector', 'SLA Escalation Alert', 'Complaint ST-BGM-2026-0002 in Ward 1 exceeded 24h SLA.', 'warning', 'cmp-demo-02', 0, ?)
  `).run(crypto.randomUUID(), isoNow);
}
