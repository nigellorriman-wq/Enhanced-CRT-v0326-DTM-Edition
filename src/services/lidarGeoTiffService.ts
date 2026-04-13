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
  phase?: number; // e.g. 1, 2, 3
  blob: Blob;
  addedAt: number;
  saved?: boolean;
}

class LidarGeoTiffService {
  private loadedTiffs: Map<string, { tiff: any; image: any; pool: any; minMax?: { min: number; max: number }; noData?: number | null }> = new Map();
  private globalAltitudeRange: { min: number; max: number } | null = null;

  private isValidElevation(val: number, noData?: number | null): boolean {
    if (val === null || val === undefined || isNaN(val)) return false;
    
    // Exact match for common NoData values
    if (val === -9999 || val === -3.4028234663852886e+38) return false;
    
    // Match against metadata NoData value
    if (noData !== undefined && noData !== null) {
      // Use a small epsilon for float comparison
      if (Math.abs(val - noData) < 0.0001) return false;
    }
    
    // Extreme values that are physically impossible for Scottish terrain
    // (Lowest point is sea level, highest is 1344m)
    // We allow a bit of range for bathymetry or slight errors, but -10000m is definitely NoData
    if (val < -10000 || val > 10000) return false;
    
    return true;
  }

  setGlobalAltitudeRange(min: number, max: number) {
    this.globalAltitudeRange = { min, max };
    console.log(`[LiDAR] Global altitude range set: ${min.toFixed(1)}m - ${max.toFixed(1)}m`);
  }

  getGlobalAltitudeRange() {
    return this.globalAltitudeRange;
  }

  clearGlobalAltitudeRange() {
    this.globalAltitudeRange = null;
    console.log('[LiDAR] Global altitude range cleared');
  }

  async getMinMax(id: string): Promise<{ min: number; max: number } | null> {
    let entry = this.loadedTiffs.get(id);
    if (!entry) {
      await this.loadAll();
      entry = this.loadedTiffs.get(id);
    }
    if (!entry) return null;

    if (entry.minMax) return entry.minMax;

    const { image, noData } = entry;
    try {
      const rasters = await image.readRasters();
      if (!rasters) return null;
      
      const numBands = Array.isArray(rasters) ? rasters.length : 1;
      let min = Infinity;
      let max = -Infinity;
      
      for (let b = 0; b < numBands; b++) {
        const data = Array.isArray(rasters) ? rasters[b] : rasters;
        let validCount = 0;
        
        for (let i = 0; i < data.length; i++) {
          const val = data[i];
          if (this.isValidElevation(val, noData)) {
            if (val < min) min = val;
            if (val > max) max = val;
            validCount++;
          }
        }
        
        console.log(`[LiDAR] Stats for ${id} (Band ${b}): Valid pixels: ${validCount}/${data.length}, Min: ${min}, Max: ${max}, NoData: ${noData}`);
        
        if (validCount > 0) break; // Found data in this band, stop looking
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
  async downloadAndStore(url: string, name: string): Promise<OfflineGeoTiff> {
    const proxyUrl = `/api/proxy-geotiff?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) {
      let details = response.statusText;
      try {
        const errorData = await response.json();
        details = errorData.details || errorData.error || details;
      } catch (e) {
        // Not JSON, try to get text
        try {
          const text = await response.text();
          if (text) {
            // Check for specific JNCC/GeoServer error messages
            if (text.includes('outside of the coverage area')) {
              details = 'The requested area is outside the coverage of this LiDAR phase.';
            } else if (text.includes('No raster data found')) {
              details = 'No LiDAR data is available for this specific 1km square in this phase.';
            } else {
              details = text.substring(0, 200);
            }
          }
        } catch (te) {
          // Ignore text error
        }
      }
      throw new Error(`Download failed: ${details}`);
    }
    
    const blob = await response.blob();
    
    // Check if the response is actually an XML error (just in case proxy didn't catch it)
    if (blob.type.includes('xml') || blob.type.includes('text/html')) {
      const text = await blob.text();
      console.error(`[LiDAR] Server returned non-image response for ${url}:`, text.substring(0, 500));
      
      let friendlyMessage = 'The requested tile is not available.';
      if (text.includes('outside of the coverage area')) {
        friendlyMessage = 'The requested area is outside the coverage of this LiDAR phase.';
      } else if (text.includes('No raster data found')) {
        friendlyMessage = 'No LiDAR data is available for this specific 1km square in this phase.';
      }
      
      throw new Error(`LiDAR server error: ${friendlyMessage}`);
    }

    try {
      const tiff = await fromGeoTIFF.fromBlob(blob);
      const image = await tiff.getImage();
      const noData = image.getGDALNoData();
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

      try {
        await set(`geotiff_${url}`, offlineData);
      } catch (storageErr: any) {
        console.error('[LiDAR] Storage error:', storageErr);
        if (storageErr.name === 'QuotaExceededError' || storageErr.message?.includes('quota')) {
          throw new Error('Storage quota exceeded. Please delete some existing tiles or free up space on your device.');
        }
        throw new Error(`Failed to save to device storage: ${storageErr.message || 'Unknown storage error'}`);
      }
      
      // Also load into memory immediately
      const pool = new fromGeoTIFF.Pool();
      this.loadedTiffs.set(url, { tiff, image, pool, noData });
      
      return offlineData;
    } catch (parseErr: any) {
      console.error('[LiDAR] Parse error:', parseErr);
      throw new Error(`Failed to parse GeoTIFF: ${parseErr.message}`);
    }
  }

  /**
   * Stores a GeoTIFF blob directly in IndexedDB
   */
  async storeBlob(blob: Blob, name: string, id?: string): Promise<string> {
    const tiffId = id || `imported_${Date.now()}_${name.replace(/[^a-z0-9]/gi, '_')}`;
    const tiff = await fromGeoTIFF.fromBlob(blob);
    const image = await tiff.getImage();
    const noData = image.getGDALNoData();
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
    
    // Extract phase from name if possible (e.g. "LiDAR Ph2 1m - NJ1842")
    const phaseMatch = name.match(/Ph(\d+)/i);
    const phase = phaseMatch ? parseInt(phaseMatch[1]) : 1;

    const offlineData: OfflineGeoTiff = {
      id: tiffId,
      name,
      bounds: { minLat, maxLat, minLng, maxLng },
      corners: [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]],
      resolution,
      phase,
      blob,
      addedAt: Date.now()
    };

    await set(`geotiff_${tiffId}`, offlineData);
    
    // Also load into memory immediately
    const pool = new fromGeoTIFF.Pool();
    this.loadedTiffs.set(tiffId, { tiff, image, pool, noData });
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
        // Pre-initialize the GeoTIFF object for fast querying
        if (!this.loadedTiffs.has(data.id)) {
          const tiff = await fromGeoTIFF.fromBlob(data.blob);
          const image = await tiff.getImage();
          const noData = image.getGDALNoData();
          const pool = new fromGeoTIFF.Pool();
          this.loadedTiffs.set(data.id, { tiff, image, pool, noData });
          
          // Fallback for missing corners in older stored data
          if (!data.corners) {
            const [minX, minY, maxX, maxY] = image.getBoundingBox();
            const [p1Lng, p1Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, minY]);
            const [p2Lng, p2Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, minY]);
            const [p3Lng, p3Lat] = proj4("EPSG:27700", "EPSG:4326", [maxX, maxY]);
            const [p4Lng, p4Lat] = proj4("EPSG:27700", "EPSG:4326", [minX, maxY]);
            data.corners = [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]];
          }
        }
        tiffs.push(data);
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

    // Sort by resolution (highest first), then phase (latest first)
    const sortedTiffs = Array.from(this.loadedTiffs.entries()).sort((a, b) => {
      const resA = a[1].image.getResolution()[0];
      const resB = b[1].image.getResolution()[0];
      if (resA !== resB) return resA - resB;
      
      // Secondary sort by phase (latest first)
      // We can extract phase from the ID or name if it's not in metadata
      const phaseA = parseInt(a[0].match(/ph(\d+)/i)?.[1] || '1');
      const phaseB = parseInt(b[0].match(/ph(\d+)/i)?.[1] || '1');
      return phaseB - phaseA;
    });

    for (const [id, entry] of sortedTiffs) {
      const { image, noData } = entry;
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

        if (x >= 0 && x < width && y >= 0 && y < height) {
          try {
            const window = [x, y, x + 1, y + 1];
            const rasters = await image.readRasters({ window });
            if (rasters) {
              const numBands = Array.isArray(rasters) ? rasters.length : 1;
              
              // Try each band until we find a valid elevation
              for (let b = 0; b < numBands; b++) {
                const data = Array.isArray(rasters) ? rasters[b] : rasters;
                if (data.length > 0) {
                  const elevation = data[0];
                  console.log(`[LiDAR] Raw elevation at ${lat}, ${lng} in tile ${id} (Band ${b}): ${elevation} (NoData: ${noData})`);
                  
                  if (this.isValidElevation(elevation, noData)) {
                    console.log(`[LiDAR] SUCCESS: Offline elevation for ${lat.toFixed(6)}, ${lng.toFixed(6)} is ${elevation.toFixed(2)}m (Source: ${id}, Band: ${b})`);
                    return elevation;
                  }
                }
              }
              
              console.log(`[LiDAR] No valid elevation found in any of the ${numBands} bands at ${lat}, ${lng} in tile ${id}`);
            }
          } catch (e) {
            console.error('[LiDAR] Error reading raster for elevation', e);
          }
        } else {
          console.log(`[LiDAR] Pixel out of range for ${lat}, ${lng} in tile ${id}: x=${x}/${width}, y=${y}/${height}`);
        }
      }
    }

    if (this.loadedTiffs.size > 0) {
      // Check if we actually found any tile covering this area (even if it had NoData)
      const [e, n] = proj4("EPSG:4326", "EPSG:27700", [lng, lat]);
      let tileFound = false;
      for (const entry of this.loadedTiffs.values()) {
        const [minX, minY, maxX, maxY] = entry.image.getBoundingBox();
        if (e >= minX && e <= maxX && n >= minY && n <= maxY) {
          tileFound = true;
          break;
        }
      }
      
      if (tileFound) {
        console.log(`[LiDAR] No valid elevation found in any offline tile covering ${lat}, ${lng}`);
      } else {
        console.log(`[LiDAR] No offline tile found covering ${lat}, ${lng}`);
      }
    }
    
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
   * Returns the best available resolution for a given point
   */
  getBestResolution(lat: number, lng: number): number | null {
    if (this.loadedTiffs.size === 0) return null;
    
    const [e, n] = proj4("EPSG:4326", "EPSG:27700", [lng, lat]);
    let bestRes = Infinity;
    let found = false;
    
    for (const entry of this.loadedTiffs.values()) {
      const [minX, minY, maxX, maxY] = entry.image.getBoundingBox();
      if (e >= minX && e <= maxX && n >= minY && n <= maxY) {
        const res = entry.image.getResolution()[0];
        if (res < bestRes) {
          bestRes = res;
          found = true;
        }
      }
    }
    
    return found ? bestRes : null;
  }

  /**
   * Deletes all GeoTIFFs that haven't been explicitly saved
   */
  async clearUnsaved(): Promise<void> {
    this.clearGlobalAltitudeRange();
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

    const { image, noData } = entry;
    let width = image.getWidth();
    let height = image.getHeight();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    
    // Downsample if too large for canvas (max 4096 for performance and compatibility)
    const MAX_CANVAS_SIZE = 4096;
    let sampleScale = 1;
    if (width > MAX_CANVAS_SIZE || height > MAX_CANVAS_SIZE) {
      sampleScale = Math.max(width / MAX_CANVAS_SIZE, height / MAX_CANVAS_SIZE);
      width = Math.floor(width / sampleScale);
      height = Math.floor(height / sampleScale);
      console.log(`[LiDAR] Downsampling overlay for ${id} from original size to ${width}x${height} (scale: ${sampleScale.toFixed(2)})`);
    }
    
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
      console.log(`[LiDAR] Reading rasters for ${id} (${width}x${height})...`);
      rasters = await image.readRasters({ width, height });
      
      if (!rasters) {
        console.error(`[LiDAR] No rasters found for ${id}`);
        return null;
      }

      const numBands = Array.isArray(rasters) ? rasters.length : 1;
      let data = Array.isArray(rasters) ? rasters[0] : rasters;
      let localMin = Infinity;
      let localMax = -Infinity;
      let validCount = 0;
      let activeBand = 0;

      // Try each band until we find one with valid data
      for (let b = 0; b < numBands; b++) {
        const bandData = Array.isArray(rasters) ? rasters[b] : rasters;
        let bandMin = Infinity;
        let bandMax = -Infinity;
        let bandValidCount = 0;

        for (let i = 0; i < bandData.length; i++) {
          const val = bandData[i];
          if (this.isValidElevation(val, noData)) {
            if (val < bandMin) bandMin = val;
            if (val > bandMax) bandMax = val;
            bandValidCount++;
          }
        }

        console.log(`[LiDAR] Band ${b} stats for ${id}: Valid pixels: ${bandValidCount}/${bandData.length}, Min: ${bandMin}, Max: ${bandMax}, NoData: ${noData}`);

        if (bandValidCount > 0) {
          data = bandData;
          localMin = bandMin;
          localMax = bandMax;
          validCount = bandValidCount;
          activeBand = b;
          break; // Use this band
        }
      }

      if (validCount === 0) {
        const firstFew = Array.from(data.slice(0, 10));
        console.warn(`[LiDAR] No valid elevation data found in any of the ${numBands} bands for ${id} (all pixels are NoData). First 10 values: ${JSON.stringify(firstFew)}`);
        return null;
      }

      // Use global range if available, otherwise use local min/max
      let min = this.globalAltitudeRange?.min ?? localMin;
      let max = this.globalAltitudeRange?.max ?? localMax;

      if (min === max) {
        console.log(`[LiDAR] Min and Max are equal (${min}), using small offset for visualization`);
        max = min + 1;
      }

      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) {
        console.error(`[LiDAR] Failed to get 2D context for canvas`);
        return null;
      }

      const imageData = ctx.createImageData(width, height);
      const d = imageData.data;

      console.log(`[LiDAR] Generating overlay for ${id} (Band ${activeBand}). Local range: ${localMin.toFixed(1)}m - ${localMax.toFixed(1)}m. Using range: ${min.toFixed(1)}m - ${max.toFixed(1)}m`);

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

    const resX = (maxX - minX) / width;
    const resY = (maxY - minY) / height;

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
          
          if (!this.isValidElevation(val, noData)) {
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
      
      // Try to find corners from the original data if possible
      let finalCorners = [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]] as [number, number][];
      try {
        const allKeys = await keys();
        const key = allKeys.find(k => typeof k === 'string' && k.endsWith(id));
        if (key) {
          const data = await get<OfflineGeoTiff>(key);
          if (data?.corners) finalCorners = data.corners;
        }
      } catch (e) {
        // Fallback to calculated corners
      }
      
      return {
        dataUrl,
        bounds: [[minLat, minLng], [maxLat, maxLng]],
        corners: finalCorners,
        timestamp: Date.now()
      };
    } catch (e) {
      console.error(`[LiDAR] Failed to generate overlay for ${id}:`, e);
      return null;
    }
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
