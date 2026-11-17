import fs from 'node:fs';
import path from 'node:path';

interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

interface WardFeature {
  type: 'Feature';
  properties?: {
    ward_number?: number | string | null;
    ward_name?: string | null;
    wardname?: string | null;
    ulbname?: string | null;
    statename?: string | null;
    districtname?: string | null;
  };
  geometry?: GeoJsonPolygon | GeoJsonMultiPolygon | null;
}

interface WardFeatureCollection {
  type: 'FeatureCollection';
  features: WardFeature[];
}

export interface VerifiedWardMatch {
  wardVerified: boolean;
  ward_number: number | null;
  ward_name: string;
  ulb_name: string | null;
  source: 'belagavi_gis_geojson_pip' | 'boundary_unavailable' | 'outside_verified_boundaries';
}

let cachedFeatures: WardFeature[] | null = null;
let loadAttempted = false;

function loadBelagaviWardFeatures(): WardFeature[] {
  if (loadAttempted) {
    return cachedFeatures || [];
  }
  loadAttempted = true;
  try {
    const filePath = path.resolve(process.cwd(), 'server', 'data', 'belagavi_wards.geojson');
    if (!fs.existsSync(filePath)) {
      cachedFeatures = [];
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as WardFeatureCollection;
    cachedFeatures = Array.isArray(parsed.features) ? parsed.features : [];
    return cachedFeatures;
  } catch {
    cachedFeatures = [];
    return [];
  }
}

/**
 * Ray-casting point-in-ring check.
 * GeoJSON ring coordinates are [longitude, latitude].
 */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonRings(lng: number, lat: number, rings: number[][][]): boolean {
  if (!rings || rings.length === 0) return false;
  // Must be inside outer boundary ring
  if (!pointInRing(lng, lat, rings[0])) return false;
  // Must NOT be inside any inner exclusion hole
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lng, lat, rings[h])) {
      return false;
    }
  }
  return true;
}

function pointInGeometry(lng: number, lat: number, geometry: GeoJsonPolygon | GeoJsonMultiPolygon): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polyRings) => pointInPolygonRings(lng, lat, polyRings));
  }
  return false;
}

/**
 * Identifies the official Belagavi municipal ward using strict point-in-polygon
 * matching against loaded GIS boundary polygons. Never guesses or defaults to any ward.
 */
export function detectBelagaviWardByPointInPolygon(lat: number, lng: number): VerifiedWardMatch {
  const features = loadBelagaviWardFeatures();
  if (features.length === 0) {
    return {
      wardVerified: false,
      ward_number: null,
      ward_name: 'Ward not verified',
      ulb_name: null,
      source: 'boundary_unavailable',
    };
  }

  for (const feature of features) {
    if (!feature.geometry) continue;
    if (pointInGeometry(lng, lat, feature.geometry)) {
      const rawNum = feature.properties?.ward_number;
      const wardNum = rawNum !== undefined && rawNum !== null && Number.isFinite(Number(rawNum))
        ? Number(rawNum)
        : null;
      const rawName = (feature.properties?.ward_name || feature.properties?.wardname || '').trim();
      const wardName = rawName || (wardNum !== null ? `Ward ${wardNum}` : 'Ward not verified');

      return {
        wardVerified: wardNum !== null,
        ward_number: wardNum,
        ward_name: wardName,
        ulb_name: feature.properties?.ulbname || 'City Corporation Belagavi',
        source: 'belagavi_gis_geojson_pip',
      };
    }
  }

  return {
    wardVerified: false,
    ward_number: null,
    ward_name: 'Ward not verified',
    ulb_name: null,
    source: 'outside_verified_boundaries',
  };
}
