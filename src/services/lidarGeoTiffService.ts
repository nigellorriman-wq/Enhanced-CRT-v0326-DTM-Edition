import * as fromGeoTIFF from 'geotiff';
import { get, set, del, keys } from 'idb-keyval';
import proj4 from 'proj4';

// Define British National Grid (BNG) projection with accurate datum transformation
proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs");

export interface OfflineGeoTiff {
  id: string;
  name: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  corners?: [number, number][];
  resolution: number; // e.g. 0.5, 1, 2 (metres)
  blob: Blob;
  addedAt: number;
  saved?: boolean;
}

class LidarGeoTiffService {
  private loadedTiffs: Map<string, { tiff: any; image: any; pool: any; minMax?: { min: number; max: number } }> = new Map();
  private globalAltitudeRange: { min: number; max: number } | null = null;

  setGlobalAltitudeRange(min: number, max: number) {
    this.globalAltitudeRange = { min, max };
    console.log(`[LiDAR] Global altitude range set: ${min.toFixed(1)}m - ${max.toFixed(1)}m`);
  }

  getGlobalAltitudeRange() {
    return this.globalAltitudeRange;
  }

  async getMinMax(id: string): Promise<{ min: number; max: number } | null> {
    let entry = this.loadedTiffs.get(id);
    if (!entry) {
      await this.loadAll();
      entry = this.loadedTiffs.get(id);
    }
    if (!entry) return null;

    if (entry.minMax) return entry.minMax;

    const { image } = entry;
    try {
      const rasters = await image.readRasters();
      if (!rasters || rasters.length === 0) return null;
      const data = rasters[0] as any;

      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        if (val !== -9999 && val !== -3.4028234663852886e+38 && !isNaN(val)) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
      
      if (min !== Infinity) {
        entry.minMax = { min, max };
      }
      
      return min === Infinity ? null : { min, max };
    } catch (e) {
      return null;
    }
  }

  /**
   * Downloads a GeoTIFF from a URL and stores it in IndexedDB
   */
  async downloadAndStore(url: string, name: string): Promise<void> {
    const proxyUrl = `/api/proxy-geotiff?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const details = errorData.details || response.statusText;
      const error = errorData.error || 'Download failed';
      throw new Error(`${error}: ${details}`);
    }
    
    const blob = await response.blob();
    
    // Check if the response is actually an XML error (just in case proxy didn't catch it)
    if (blob.type.includes('xml') || blob.type.includes('text/html')) {
      const text = await blob.text();
      console.error(`[LiDAR] Server returned non-image response for ${url}:`, text.substring(0, 500));
      throw new Error(`LiDAR server error: The requested tile might not be available in this resolution or area. (Server said: ${text.substring(0, 200)})`);
    }

    const tiff = await fromGeoTIFF.fromBlob(blob);
    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    
    // Convert all 4 BNG corners back to WGS84 for the tile bounds metadata
    // This ensures we use the full envelope to eliminate gaps between tiles
    const [p1Lng, p1Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, minY]);
    const [p2Lng, p2Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, minY]);
    const [p3Lng, p3Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, maxY]);
    const [p4Lng, p4Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, maxY]);
    
    const minLat = Math.min(p1Lat, p2Lat, p3Lat, p4Lat);
    const maxLat = Math.max(p1Lat, p2Lat, p3Lat, p4Lat);
    const minLng = Math.min(p1Lng, p2Lng, p3Lng, p4Lng);
    const maxLng = Math.max(p1Lng, p2Lng, p3Lng, p4Lng);
    
    const resolution = image.getResolution()[0];

    const offlineData: OfflineGeoTiff = {
      id: url,
      name,
      bounds: { minLat, maxLat, minLng, maxLng },
      corners: [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]],
      resolution,
      blob,
      addedAt: Date.now()
    };

    await set(`geotiff_${url}`, offlineData);
    
    // Also load into memory immediately
    const pool = new fromGeoTIFF.Pool();
    this.loadedTiffs.set(url, { tiff, image, pool });
  }

  /**
   * Stores a GeoTIFF blob directly in IndexedDB
   */
  async storeBlob(blob: Blob, name: string, id?: string): Promise<string> {
    const tiffId = id || `imported_${Date.now()}_${name.replace(/[^a-z0-9]/gi, '_')}`;
    const tiff = await fromGeoTIFF.fromBlob(blob);
    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    
    // Convert all 4 BNG corners back to WGS84 for the tile bounds metadata
    const [p1Lng, p1Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, minY]);
    const [p2Lng, p2Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, minY]);
    const [p3Lng, p3Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, maxY]);
    const [p4Lng, p4Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, maxY]);
    
    const minLat = Math.min(p1Lat, p2Lat, p3Lat, p4Lat);
    const maxLat = Math.max(p1Lat, p2Lat, p3Lat, p4Lat);
    const minLng = Math.min(p1Lng, p2Lng, p3Lng, p4Lng);
    const maxLng = Math.max(p1Lng, p2Lng, p3Lng, p4Lng);
    
    const resolution = image.getResolution()[0];

    const offlineData: OfflineGeoTiff = {
      id: tiffId,
      name,
      bounds: { minLat, maxLat, minLng, maxLng },
      corners: [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]],
      resolution,
      blob,
      addedAt: Date.now()
    };

    await set(`geotiff_${tiffId}`, offlineData);
    
    // Also load into memory immediately
    const pool = new fromGeoTIFF.Pool();
    this.loadedTiffs.set(tiffId, { tiff, image, pool });
    return tiffId;
  }

  /**
   * Exports a stored GeoTIFF as a file download
   */
  async exportStoredTiff(id: string): Promise<void> {
    const data = await get<OfflineGeoTiff>(`geotiff_${id}`);
    if (!data) {
      // Try without prefix if it's already the full key
      const directData = await get<OfflineGeoTiff>(id);
      if (!directData) throw new Error('GeoTIFF not found in storage');
      
      // Mark as saved
      directData.saved = true;
      await set(id, directData);

      const url = URL.createObjectURL(directData.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${directData.name.replace(/[^a-z0-9]/gi, '_')}.tif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    // Mark as saved
    data.saved = true;
    await set(`geotiff_${id}`, data);

    const url = URL.createObjectURL(data.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.name.replace(/[^a-z0-9]/gi, '_')}.tif`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Loads all stored GeoTIFFs from IndexedDB into memory
   */
  async loadAll(): Promise<OfflineGeoTiff[]> {
    const allKeys = await keys();
    const tiffKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('geotiff_'));
    
    const tiffs: OfflineGeoTiff[] = [];
    for (const key of tiffKeys) {
      const data = await get<OfflineGeoTiff>(key);
      if (data) {
        tiffs.push(data);
        // Pre-initialize the GeoTIFF object for fast querying
        if (!this.loadedTiffs.has(data.id)) {
          const tiff = await fromGeoTIFF.fromBlob(data.blob);
          const image = await tiff.getImage();
          const pool = new fromGeoTIFF.Pool();
          this.loadedTiffs.set(data.id, { tiff, image, pool });
        }
      }
    }
    return tiffs;
  }

  /**
   * Queries elevation from loaded GeoTIFFs for a given lat/lng
   */
  async getElevation(lat: number, lng: number): Promise<number | null> {
    if (this.loadedTiffs.size === 0) {
      await this.loadAll();
    }

    if (this.loadedTiffs.size === 0) return null;

    // Sort by resolution (highest first)
    const sortedTiffs = Array.from(this.loadedTiffs.entries()).sort((a, b) => {
      const resA = a[1].image.getResolution()[0];
      const resB = b[1].image.getResolution()[0];
      return resA - resB;
    });

    for (const [id, { image }] of sortedTiffs) {
      const [minX, minY, maxX, maxY] = image.getBoundingBox();
      
      // Convert input WGS84 lat/lng to BNG for lookup
      const [e, n] = proj4("EPSG:4326", "EPSG:27700", [lng, lat]);
      
      // Check if point is within bounds (in BNG)
      if (e >= minX && e <= maxX && n >= minY && n <= maxY) {
        // Convert BNG to pixel coordinates
        const width = image.getWidth();
        const height = image.getHeight();
        const res = image.getResolution();
        const origin = image.getOrigin();

        // Standard GeoTIFF mapping: x = (e - originX) / resX, y = (originY - n) / abs(resY)
        const x = Math.floor((e - origin[0]) / res[0]);
        const y = Math.floor((origin[1] - n) / Math.abs(res[1]));

        console.log(`[LiDAR] Tile ${id} match. BNG: ${e.toFixed(0)}, ${n.toFixed(0)}. Origin: ${origin[0]}, ${origin[1]}. Res: ${res[0]}, ${res[1]}. Calc Pixel: x=${x}, y=${y}`);

        if (x >= 0 && x < width && y >= 0 && y < height) {
          try {
            const window = [x, y, x + 1, y + 1];
            const data = await image.readRasters({ window });
            if (data && data.length > 0 && data[0].length > 0) {
              const elevation = data[0][0];
              
              // Check for NoData values (common in GeoTIFFs)
              if (elevation !== -9999 && elevation !== -3.4028234663852886e+38 && !isNaN(elevation)) {
                console.log(`[LiDAR] SUCCESS: Offline elevation for ${lat.toFixed(6)}, ${lng.toFixed(6)} is ${elevation.toFixed(2)}m (Source: ${id})`);
                return elevation;
              } else {
                console.log(`[LiDAR] NoData value (${elevation}) at ${lat}, ${lng} in tile ${id}`);
              }
            }
          } catch (e) {
            console.error('[LiDAR] Error reading raster for elevation', e);
          }
        } else {
          console.log(`[LiDAR] Pixel out of range for ${lat}, ${lng} in tile ${id}: x=${x}/${width}, y=${y}/${height}`);
        }
      }
    }

    console.log(`[LiDAR] No offline tile found covering ${lat}, ${lng}`);
    return null;
  }

  /**
   * Checks if a given point is covered by any downloaded GeoTIFF
   */
  isAreaDownloaded(lat: number, lng: number): boolean {
    if (this.loadedTiffs.size === 0) return false;
    
    // Convert WGS84 to BNG for lookup
    const [e, n] = proj4("EPSG:4326", "EPSG:27700", [lng, lat]);
    
    for (const entry of this.loadedTiffs.values()) {
      const [minX, minY, maxX, maxY] = entry.image.getBoundingBox();
      if (e >= minX && e <= maxX && n >= minY && n <= maxY) {
        return true;
      }
    }
    return false;
  }

  /**
   * Deletes all GeoTIFFs that haven't been explicitly saved
   */
  async clearUnsaved(): Promise<void> {
    const allKeys = await keys();
    const tiffKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('geotiff_'));
    for (const key of tiffKeys) {
      const data = await get<OfflineGeoTiff>(key);
      if (data && !data.saved) {
        await del(key);
        this.loadedTiffs.delete(data.id);
      }
    }
  }

  /**
   * Deletes a stored GeoTIFF
   */
  async delete(id: string): Promise<void> {
    await del(`geotiff_${id}`);
    this.loadedTiffs.delete(id);
  }

  /**
   * Generates a color-mapped overlay for a GeoTIFF
   */
  async generateOverlay(id: string): Promise<{ dataUrl: string; bounds: [[number, number], [number, number]]; corners?: [number, number][]; timestamp?: number } | null> {
    let entry = this.loadedTiffs.get(id);
    if (!entry) {
      await this.loadAll();
      entry = this.loadedTiffs.get(id);
    }
    if (!entry) return null;

    const { image } = entry;
    const width = image.getWidth();
    const height = image.getHeight();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    
    // Convert all 4 BNG corners back to WGS84 for Leaflet overlay
    // This ensures we use the full envelope to eliminate gaps between tiles
    const [p1Lng, p1Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, minY]);
    const [p2Lng, p2Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, minY]);
    const [p3Lng, p3Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, maxY]);
    const [p4Lng, p4Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, maxY]);
    
    const minLat = Math.min(p1Lat, p2Lat, p3Lat, p4Lat);
    const maxLat = Math.max(p1Lat, p2Lat, p3Lat, p4Lat);
    const minLng = Math.min(p1Lng, p2Lng, p3Lng, p4Lng);
    const maxLng = Math.max(p1Lng, p2Lng, p3Lng, p4Lng);

    // Read all rasters
    let rasters;
    try {
      rasters = await image.readRasters();
    } catch (e) {
      console.error('Failed to read rasters for overlay', e);
      return null;
    }
    
    if (!rasters || rasters.length === 0) return null;
    const data = rasters[0] as any;

    // Find min/max for normalization
    let localMin = Infinity;
    let localMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (val !== -9999 && val !== -3.4028234663852886e+38 && !isNaN(val)) {
        if (val < localMin) localMin = val;
        if (val > localMax) localMax = val;
      }
    }

    if (localMin === Infinity) {
      return null;
    }

    // Use global range if available, otherwise use local min/max
    const min = this.globalAltitudeRange?.min ?? localMin;
    const max = this.globalAltitudeRange?.max ?? localMax;

    if (min === max) {
      return null; // Avoid division by zero
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;

    const imageData = ctx.createImageData(width, height);
    const d = imageData.data;

    console.log(`[LiDAR] Generating overlay for ${id}. Local range: ${localMin.toFixed(1)}m - ${localMax.toFixed(1)}m. Using range: ${min.toFixed(1)}m - ${max.toFixed(1)}m`);

    // Pre-calculate color lookup table (256 levels) for performance
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const color = this.getColorForHeight(i / 255);
      lut[i * 3] = color.r;
      lut[i * 3 + 1] = color.g;
      lut[i * 3 + 2] = color.b;
    }

    // Calculate BNG coordinates for the canvas corners (the envelope)
    // to allow for fast affine interpolation of BNG coordinates across the canvas.
    const [e_nw, n_nw] = proj4("EPSG:4326", "EPSG:27700", [minLng, maxLat]);
    const [e_ne, n_ne] = proj4("EPSG:4326", "EPSG:27700", [maxLng, maxLat]);
    const [e_sw, n_sw] = proj4("EPSG:4326", "EPSG:27700", [minLng, minLat]);
    
    const de_col = (e_ne - e_nw) / width;
    const dn_col = (n_ne - n_nw) / width;
    const de_row = (e_sw - e_nw) / height;
    const dn_row = (n_sw - n_nw) / height;

    const res = image.getResolution();
    const resX = res[0];
    const resY = Math.abs(res[1]);

    for (let r = 0; r < height; r++) {
      let curr_e = e_nw + r * de_row;
      let curr_n = n_nw + r * dn_row;
      for (let c = 0; c < width; c++) {
        const x = Math.floor((curr_e - minX) / resX);
        const y = Math.floor((maxY - curr_n) / resY);
        const canvasIdx = (r * width + c) * 4;
        
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const tiffIdx = y * width + x;
          const val = data[tiffIdx];
          
          if (val === -9999 || val === -3.4028234663852886e+38 || isNaN(val)) {
            d[canvasIdx + 3] = 0;
          } else {
            const normalized = Math.max(0, Math.min(1, (val - min) / (max - min)));
            const lutIdx = Math.floor(normalized * 255) * 3;
            d[canvasIdx] = lut[lutIdx];
            d[canvasIdx + 1] = lut[lutIdx + 1];
            d[canvasIdx + 2] = lut[lutIdx + 2];
            d[canvasIdx + 3] = 255;
          }
        } else {
          d[canvasIdx + 3] = 0; // Transparent (outside BNG tile bounds)
        }
        
        curr_e += de_col;
        curr_n += dn_col;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    
    return {
      dataUrl,
      bounds: [[minLat, minLng], [maxLat, maxLng]],
      corners: [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]],
      timestamp: Date.now()
    };
  }

  public getColorForHeight(t: number) {
    // Refined color ramp for golf course terrain (more stops in lower range for detail)
    const stops = [
      { t: 0.00, r: 0, g: 68, b: 27 },      // Deep Forest Green
      { t: 0.05, r: 0, g: 109, b: 44 },     // Dark Green
      { t: 0.10, r: 35, g: 139, b: 69 },    // Forest Green
      { t: 0.15, r: 65, g: 171, b: 93 },    // Grass Green
      { t: 0.20, r: 116, g: 196, b: 118 },  // Light Grass Green
      { t: 0.30, r: 161, g: 217, b: 155 },  // Pale Green
      { t: 0.45, r: 199, g: 233, b: 192 },  // Very Pale Green
      { t: 0.60, r: 255, g: 255, b: 178 },  // Pale Yellow
      { t: 0.75, r: 254, g: 204, b: 92 },   // Soft Orange/Yellow
      { t: 0.85, r: 253, g: 141, b: 60 },   // Orange
      { t: 0.95, r: 189, g: 0, b: 38 },     // Reddish Brown
      { t: 1.00, r: 255, g: 255, b: 255 }   // White (Peak)
    ];

    // Clamp t just in case
    const val = Math.max(0, Math.min(1, t));
    
    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i];
      const s2 = stops[i + 1];
      if (val >= s1.t && val <= s2.t) {
        const f = (val - s1.t) / (s2.t - s1.t);
        return {
          r: Math.round(s1.r + (s2.r - s1.r) * f),
          g: Math.round(s1.g + (s2.g - s1.g) * f),
          b: Math.round(s1.b + (s2.b - s1.b) * f)
        };
      }
    }
    return { r: 255, g: 255, b: 255 };
  }
}

export const lidarGeoTiffService = new LidarGeoTiffService();
// Start loading immediately on module import
lidarGeoTiffService.loadAll().catch(console.error);
