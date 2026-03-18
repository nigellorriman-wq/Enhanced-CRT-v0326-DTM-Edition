import * as fromGeoTIFF from 'geotiff';
import { get, set, del, keys } from 'idb-keyval';

export interface OfflineGeoTiff {
  id: string;
  name: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  resolution: number; // e.g. 0.5, 1, 2 (metres)
  blob: Blob;
  addedAt: number;
}

class LidarGeoTiffService {
  private loadedTiffs: Map<string, { tiff: any; image: any; pool: any }> = new Map();

  /**
   * Downloads a GeoTIFF from a URL and stores it in IndexedDB
   */
  async downloadAndStore(url: string, name: string): Promise<void> {
    const proxyUrl = `/api/proxy-geotiff?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to download GeoTIFF: ${errorData.details || response.statusText}`);
    }
    
    const blob = await response.blob();
    
    // Check if the response is actually an XML error (common with GeoServer)
    if (blob.type.includes('xml') || blob.type.includes('text/html')) {
      const text = await blob.text();
      if (text.includes('ServiceException') || text.includes('ExceptionReport')) {
        throw new Error('LiDAR server error: The requested tile might not be available in this resolution or area.');
      }
    }

    const tiff = await fromGeoTIFF.fromBlob(blob);
    const image = await tiff.getImage();
    const [minLng, minLat, maxLng, maxLat] = image.getBoundingBox();
    const resolution = image.getResolution()[0];

    const offlineData: OfflineGeoTiff = {
      id: url,
      name,
      bounds: { minLat, maxLat, minLng, maxLng },
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
      const [minLng, minLat, maxLng, maxLat] = image.getBoundingBox();
      
      // Check if point is within bounds
      if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
        // Convert lat/lng to pixel coordinates
        const width = image.getWidth();
        const height = image.getHeight();
        const res = image.getResolution();
        const origin = image.getOrigin();

        // Standard GeoTIFF mapping: x = (lng - originX) / resX, y = (originY - lat) / abs(resY)
        const x = Math.floor((lng - origin[0]) / res[0]);
        const y = Math.floor((origin[1] - lat) / Math.abs(res[1]));

        console.log(`[LiDAR] Tile ${id} match. Origin: ${origin[0]}, ${origin[1]}. Res: ${res[0]}, ${res[1]}. Calc Pixel: x=${x}, y=${y}`);

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
    for (const entry of this.loadedTiffs.values()) {
      const [minLng, minLat, maxLng, maxLat] = entry.image.getBoundingBox();
      if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
        return true;
      }
    }
    return false;
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
  async generateOverlay(id: string): Promise<{ dataUrl: string; bounds: [[number, number], [number, number]] } | null> {
    let entry = this.loadedTiffs.get(id);
    if (!entry) {
      await this.loadAll();
      entry = this.loadedTiffs.get(id);
    }
    if (!entry) return null;

    const { image } = entry;
    const width = image.getWidth();
    const height = image.getHeight();
    const [minLng, minLat, maxLng, maxLat] = image.getBoundingBox();

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
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (val !== -9999 && val !== -3.4028234663852886e+38 && !isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }

    if (min === Infinity) {
      return null;
    }

    if (min === max) {
      max = min + 1;
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;

    const imageData = ctx.createImageData(width, height);
    const d = imageData.data;

    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      const idx = i * 4;
      if (val === -9999 || val === -3.4028234663852886e+38 || isNaN(val)) {
        d[idx] = 0;
        d[idx + 1] = 0;
        d[idx + 2] = 0;
        d[idx + 3] = 0; // Transparent
      } else {
        const normalized = (val - min) / (max - min);
        const color = this.getColorForHeight(normalized);
        d[idx] = color.r;
        d[idx + 1] = color.g;
        d[idx + 2] = color.b;
        d[idx + 3] = 220; // High opacity for visibility
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    console.log(`[LiDAR] Generated overlay for ${id}, size: ${width}x${height}, range: ${min.toFixed(1)}m - ${max.toFixed(1)}m`);
    
    return {
      dataUrl,
      bounds: [[minLat, minLng], [maxLat, maxLng]]
    };
  }

  public getColorForHeight(t: number) {
    // Terrain color map (Blue -> Green -> Yellow -> Brown -> White)
    if (t < 0.25) {
      const f = t / 0.25;
      return { r: 0, g: 128 * f, b: 255 };
    } else if (t < 0.5) {
      const f = (t - 0.25) / 0.25;
      return { r: 0, g: 128 + 127 * f, b: 255 * (1 - f) };
    } else if (t < 0.75) {
      const f = (t - 0.5) / 0.25;
      return { r: 255 * f, g: 255, b: 0 };
    } else {
      const f = (t - 0.75) / 0.25;
      return { r: 255, g: 255 * (1 - f * 0.5), b: 255 * f };
    }
  }
}

export const lidarGeoTiffService = new LidarGeoTiffService();
// Start loading immediately on module import
lidarGeoTiffService.loadAll().catch(console.error);
