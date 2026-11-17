import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let serverSupabase: SupabaseClient | null = null;

function normalizeSupabaseUrl(raw: string): string {
  return raw.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

function getServerSupabase(): SupabaseClient | null {
  const url = normalizeSupabaseUrl(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    return null;
  }
  if (!serverSupabase) {
    serverSupabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serverSupabase;
}

export function isSupabaseServerEnabled(): boolean {
  return Boolean(
    (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL) &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function uploadGarbageImageToSupabaseStorage(
  reportId: string,
  photoId: string,
  base64DataUrl: string
): Promise<{ storagePath: string | null; storageUrl: string | null }> {
  const sb = getServerSupabase();
  if (!sb || !base64DataUrl) {
    return { storagePath: null, storageUrl: null };
  }

  try {
    const match = base64DataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    const mimeType = match ? match[1] : 'image/jpeg';
    const rawBase64 = match ? match[2] : base64DataUrl;
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filePath = `reports/${reportId}/${photoId}.${ext}`;
    const buffer = Buffer.from(rawBase64, 'base64');

    const { error } = await sb.storage.from('garbage-images').upload(filePath, buffer, {
      contentType: mimeType,
      upsert: true,
    });
    if (error) {
      return { storagePath: null, storageUrl: null };
    }

    const { data: pubData } = sb.storage.from('garbage-images').getPublicUrl(filePath);
    return {
      storagePath: filePath,
      storageUrl: pubData?.publicUrl || null,
    };
  } catch {
    return { storagePath: null, storageUrl: null };
  }
}

export async function syncVehicleToSupabase(vehicle: {
  id: string;
  vehicle_code: string;
  registration_number: string;
  vehicle_type: string;
  assigned_ward: number | null;
  driver_id: string | null;
  helper_names: string;
  status: string;
  is_demo: boolean;
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    await sb.from('collection_vehicles').upsert(vehicle, { onConflict: 'id' });
  } catch {
    // Non-blocking sync
  }
}

export async function syncGpsLocationToSupabase(loc: {
  vehicle_id?: string | null;
  report_id?: string | null;
  user_id?: string | null;
  lat: number;
  lng: number;
  accuracy_meters?: number | null;
  speed_kmh?: number;
  heading?: number;
  source: 'live_gps' | 'demo_simulation' | 'citizen_camera_gps' | 'map_pin';
  captured_at?: string;
  recorded_at: string;
}): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;
  try {
    const { error } = await sb.from('gps_locations').insert({
      vehicle_id: loc.vehicle_id || null,
      report_id: loc.report_id || null,
      user_id: loc.user_id || null,
      lat: loc.lat,
      lng: loc.lng,
      accuracy_meters: loc.accuracy_meters ?? null,
      speed_kmh: loc.speed_kmh ?? 0,
      heading: loc.heading ?? 0,
      source: loc.source,
      captured_at: loc.captured_at || loc.recorded_at,
      recorded_at: loc.recorded_at,
    });

    if (loc.vehicle_id && (loc.source === 'live_gps' || loc.source === 'demo_simulation')) {
      await sb.from('vehicle_locations').insert({
        vehicle_id: loc.vehicle_id,
        lat: loc.lat,
        lng: loc.lng,
        speed_kmh: loc.speed_kmh ?? 0,
        heading: loc.heading ?? 0,
        source: loc.source,
        recorded_at: loc.recorded_at,
      });
    }
    return !error;
  } catch {
    return false;
  }
}

export async function syncGarbageReportToSupabase(report: {
  id: string;
  complaint_code: string;
  citizen_id: string;
  ward_number: number;
  category: string;
  description: string;
  area_name: string;
  address: string;
  lat: number;
  lng: number;
  gps_accuracy?: number | null;
  capture_timestamp?: string | null;
  priority: string;
  status: string;
  assigned_inspector_id?: string | null;
  assigned_worker_id?: string | null;
  assigned_vehicle_id?: string | null;
  escalation_level: number;
  sla_deadline: string;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;
  try {
    const { error } = await sb.from('garbage_reports').upsert(report, { onConflict: 'id' });
    return !error;
  } catch {
    return false;
  }
}

export async function syncGarbageImageToSupabase(image: {
  id: string;
  report_id: string;
  photo_type: string;
  storage_path: string | null;
  storage_url: string | null;
  mime_type: string;
  lat?: number | null;
  lng?: number | null;
  gps_accuracy?: number | null;
  captured_at?: string | null;
  uploaded_by: string;
  created_at: string;
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    await sb.from('garbage_images').upsert(image, { onConflict: 'id' });
  } catch {
    // Non-blocking sync
  }
}

export async function syncComplaintStatusToSupabase(entry: {
  id: string;
  report_id: string;
  status: string;
  changed_by: string;
  changed_by_role: string;
  remarks: string;
  created_at: string;
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    await sb.from('complaint_status').insert(entry);
  } catch {
    // Non-blocking sync
  }
}

export async function syncAiClassificationToSupabase(record: {
  id: string;
  report_id?: string | null;
  user_id?: string | null;
  can_classify: boolean;
  predicted_category: string;
  corrected_category?: string | null;
  confidence: number;
  detected_objects_json: unknown;
  category_distribution_json: unknown;
  disposal_method: string;
  segregation_tip: string;
  created_at: string;
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    await sb.from('ai_waste_classifications').upsert(record, { onConflict: 'id' });
  } catch {
    // Non-blocking sync
  }
}

export async function syncVoiceLogToSupabase(log: {
  user_id?: string | null;
  language: string;
  transcript: string;
  intent: string;
  reply_text: string;
  lat?: number | null;
  lng?: number | null;
  created_at: string;
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    await sb.from('voice_assistant_logs').insert(log);
  } catch {
    // Non-blocking sync
  }
}
