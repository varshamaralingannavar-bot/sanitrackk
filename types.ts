export type UserRole = 'citizen' | 'worker' | 'inspector' | 'admin';

export type LanguageCode = 'en' | 'kn' | 'hi' | 'mr';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  ward_number: number | null;
  assigned_wards: number[];
  language_pref: LanguageCode;
  is_demo: boolean;
}

export interface Ward {
  ward_number: number;
  id: string;
  name: string;
  zone: string;
  population_est: number;
  inspector_id: string | null;
  inspector_name?: string | null;
  lat: number;
  lng: number;
  cleanliness_score: number;
  complaint_count?: number;
  pending_count?: number;
  is_demo: number;
}

export interface ComplaintPhoto {
  id: string;
  photo_type: 'before' | 'after' | 'evidence';
  image_data: string;
  storage_url?: string | null;
  created_at: string;
}

export interface ComplaintHistoryItem {
  id: string;
  status: string;
  changed_by: string;
  changed_by_role: string;
  remarks: string;
  created_at: string;
}

export interface DetectedWasteObject {
  label: string;
  category: string;
  confidence: number | null;
  /** Normalized bounding box [ymin, xmin, ymax, xmax] in 0..1000 scale */
  box2d: [number, number, number, number];
}

export interface WasteCategoryShare {
  category: string;
  percentage: number;
}

export interface CategoryDisposalTip {
  category: string;
  recommendation: string;
}

export interface WasteClassificationResponse {
  id: string;
  canClassify: boolean;
  unableToClassify: boolean;
  predictedCategory: string;
  confidence: number | null;
  disposalMethod: string;
  segregationRecommendation: string;
  suggestedComplaintCategory: string;
  detectedObjects: DetectedWasteObject[];
  categoryDistribution: WasteCategoryShare[];
  distributionMethod?: string;
  categoryRecommendations: CategoryDisposalTip[];
  reason?: string;
}

export interface Complaint {
  id: string;
  complaint_code: string;
  citizen_id?: string;
  citizen_name?: string;
  citizen_phone?: string;
  ward_number: number;
  category: string;
  description?: string;
  area_name: string;
  address?: string;
  lat: number;
  lng: number;
  gps_accuracy?: number | null;
  capture_timestamp?: string | null;
  ai_classification?: WasteClassificationResponse | null;
  priority: 'Low' | 'Medium' | 'High' | 'Emergency';
  status: string;
  assigned_inspector_id?: string | null;
  inspector_name?: string | null;
  assigned_worker_id?: string | null;
  worker_name?: string | null;
  assigned_vehicle_id?: string | null;
  vehicle_reg?: string | null;
  escalation_level: number;
  sla_deadline?: string;
  citizen_confirmed?: number;
  obstacle_note?: string;
  feedback_rating?: number | null;
  feedback_comment?: string | null;
  is_demo: number;
  created_at: string;
  updated_at?: string;
  photos?: ComplaintPhoto[];
  history?: ComplaintHistoryItem[];
}

export interface VehicleLocation {
  lat: number;
  lng: number;
  speed_kmh: number;
  heading: number;
  source: 'live_gps' | 'demo_simulation';
  recorded_at: string;
}

export interface Vehicle {
  id: string;
  vehicle_code: string;
  registration_number: string;
  vehicle_type: 'primary' | 'secondary';
  assigned_ward: number | null;
  driver_id: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  helper_names: string;
  status: 'Active' | 'On Route' | 'Collecting Waste' | 'Idle' | 'Under Maintenance' | 'Offline';
  route_id?: string | null;
  route_name?: string | null;
  start_point_name?: string | null;
  end_point_name?: string | null;
  waypoints?: Array<{ lat: number; lng: number; name?: string }>;
  location: VehicleLocation | null;
  trail: Array<{ lat: number; lng: number; source: string; recorded_at: string }>;
  is_demo: number;
}

export interface RouteStop {
  id: string;
  route_id: string;
  stop_order: number;
  stop_name: string;
  lat: number;
  lng: number;
  status: 'Pending' | 'Completed' | 'Missed';
  notes: string;
  updated_at: string;
}

export interface CollectionRoute {
  id: string;
  route_name: string;
  ward_number: number;
  vehicle_id: string | null;
  vehicle_reg?: string | null;
  vehicle_status?: string | null;
  driver_name?: string | null;
  start_point_name: string;
  end_point_name: string;
  waypoints: Array<{ lat: number; lng: number; name: string }>;
  stops: RouteStop[];
  status: string;
  is_demo: number;
}

export interface MunicipalOverview {
  baseline: Record<string, string>;
  metrics: {
    totalComplaints: number;
    resolvedComplaints: number;
    pendingComplaints: number;
    overdueComplaints: number;
    demoComplaints: number;
    activeVehicles: number;
    registeredVehicles: number;
    avgSatisfaction: number;
    feedbackCount: number;
    hotspotWardsCount: number;
  };
}

export interface NotificationItem {
  id: string;
  user_id: string | null;
  role_target: string | null;
  title: string;
  message: string;
  type: string;
  related_id: string | null;
  is_read: number;
  created_at: string;
}

export interface VoiceMatchedComplaint {
  complaint_code: string;
  status: string;
  ward_number: number;
  area_name: string;
  category: string;
  vehicle_reg?: string | null;
  updated_at: string;
}

export interface VoiceNearbyVehicle {
  registration_number: string;
  status: string;
  assigned_ward: number | null;
  lat: number;
  lng: number;
  source: 'live_gps' | 'demo_simulation';
  distance_km?: number | null;
}

export interface VoiceNearbyStop {
  stop_name: string;
  route_name: string;
  ward_number: number;
  status: string;
  lat: number;
  lng: number;
  distance_km?: number | null;
}

export interface VoiceAssistantApiResponse {
  replyText: string;
  intent:
    | 'report_complaint'
    | 'track_complaint'
    | 'find_vehicles'
    | 'find_collection_point'
    | 'find_hotspots'
    | 'segregation_help'
    | 'navigate'
    | 'general';
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  suggestedRoute?: string;
  extractedWard?: number;
  extractedCategory?: string;
  extractedComplaintCode?: string;
  matchedComplaints?: VoiceMatchedComplaint[];
  nearbyVehicles?: VoiceNearbyVehicle[];
  nearbyStops?: VoiceNearbyStop[];
}

export interface StructuredReverseAddress {
  buildingOrStreet: string | null;
  locality: string | null;
  suburb: string | null;
  city: string | null;
  taluk: string | null;
  district: string | null;
  state: string | null;
  pinCode: string | null;
  country: string | null;
}

export interface ReverseGeocodeResponse {
  lat: number;
  lng: number;
  addressVerified: boolean;
  address: string;
  areaName: string;
  provider: string;
  structured: StructuredReverseAddress;
  ward: {
    wardVerified: boolean;
    ward_number: number | null;
    ward_name: string;
    ulb_name: string | null;
    source: string;
  };
}

