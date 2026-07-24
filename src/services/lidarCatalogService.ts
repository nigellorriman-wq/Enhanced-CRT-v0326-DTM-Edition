import proj4 from 'proj4';

// Define British National Grid (BNG) projection with accurate datum transformation
proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs");

/**
 * Service to discover Scottish Government LiDAR GeoTIFF tiles
 */
export interface LidarTile {
  id: string;
  name: string;
  url: string;
  resolution: number;
  phase: number;
  gridRef: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  corners: [number, number][];
}

class LidarCatalogService {
  /**
   * Finds available LiDAR tiles for a given bounding box
   * In a real app, this would query the Scottish Government WFS or a metadata catalog.
   * For this prototype, we simulate the discovery based on the OS Grid.
   */
  async findTiles(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }): Promise<LidarTile[]> {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 800));

    const tilesMap = new Map<string, LidarTile[]>();
    
    // Real bounding boxes for Scottish LiDAR phases from JNCC WCS DescribeCoverage
    const phaseMetadata = [
      { phase: 1, res: 1.0, minE: 170000, maxE: 415000, minN: 542000, maxN: 1031000 },
      { phase: 2, res: 1.0, minE: 138733, maxE: 449726, minN: 619227, maxN: 1147864 },
      { phase: 3, res: 0.5, minE: 195000, maxE: 415000, minN: 525000, maxN: 700000 },
      { phase: 4, res: 0.5, minE: 205000, maxE: 397000, minN: 575000, maxN: 736000 },
      { phase: 5, res: 0.5, minE: 233000, maxE: 367000, minN: 645000, maxN: 731000 },
      { phase: 6, res: 0.5, minE: 210000, maxE: 265000, minN: 630000, maxN: 680000 }
    ];

    const MAX_TILES_PER_PHASE = 36;
    
    // Convert WGS84 bounds to BNG (EPSG:27700)
    const [minE, minN] = proj4("EPSG:4326", "EPSG:27700", [bounds.minLng, bounds.minLat]);
    const [maxE, maxN] = proj4("EPSG:4326", "EPSG:27700", [bounds.maxLng, bounds.maxLat]);

    // Align to 1km grid squares (standard for Scottish LiDAR tiles)
    const startE = Math.floor(minE / 1000) * 1000;
    const endE = Math.ceil(maxE / 1000) * 1000;
    const startN = Math.floor(minN / 1000) * 1000;
    const endN = Math.ceil(maxN / 1000) * 1000;

    let tileCount = 0;
    for (let e = startE; e < endE; e += 1000) {
      for (let n = startN; n < endN; n += 1000) {
        if (tileCount >= MAX_TILES_PER_PHASE) break;

        const gridRef = this.getBNGGridRef(e, n);
        tileCount++;
        
        for (const meta of phaseMetadata) {
          // Check if the 1km square intersects with the phase's bounding box
          // We use a small buffer to ensure we don't miss edge tiles
          const buffer = 10;
          if (e + 1000 < meta.minE - buffer || e > meta.maxE + buffer || 
              n + 1000 < meta.minN - buffer || n > meta.maxN + buffer) {
            continue;
          }

          const phase = meta.phase;
          const res = meta.res;
          
          // Use the correct coverage ID format found in JNCC GetCapabilities
          const coverageId = `scotland:scotland-lidar-${phase}-dtm`;
          const resStr = res === 0.5 ? '05m' : `${res}m`;
          const id = `scotland_lidar_ph${phase}_${resStr}_${gridRef}`;
          
          // Calculate pixel dimensions for 1km tile at requested resolution
          const size = Math.round(1000 / res);

          // Convert all 4 BNG corners back to WGS84 for the tile bounds metadata
          // This ensures we use the full envelope to eliminate gaps between tiles
          const [p1Lng, p1Lat] = proj4("EPSG:27700", "EPSG:4326", [e, n]);
          const [p2Lng, p2Lat] = proj4("EPSG:27700", "EPSG:4326", [e + 1000, n]);
          const [p3Lng, p3Lat] = proj4("EPSG:27700", "EPSG:4326", [e + 1000, n + 1000]);
          const [p4Lng, p4Lat] = proj4("EPSG:27700", "EPSG:4326", [e, n + 1000]);
          
          const minLat = Math.min(p1Lat, p2Lat, p3Lat, p4Lat);
          const maxLat = Math.max(p1Lat, p2Lat, p3Lat, p4Lat);
          const minLng = Math.min(p1Lng, p2Lng, p3Lng, p4Lng);
          const maxLng = Math.max(p1Lng, p2Lng, p3Lng, p4Lng);

          const tile: LidarTile = {
            id,
            name: `LiDAR Ph${phase} ${res}m - ${gridRef}`,
            // Use BNG coordinates in the WCS request for perfect alignment
            // Using the specific WCS endpoint and correct coverage ID
            url: `https://ows.remotesensing.data.gov.scot/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=${coverageId}&styles=&bbox=${e},${n},${e + 1000},${n + 1000}&width=${size}&height=${size}&srs=EPSG:27700&format=image/geotiff`,
            resolution: res,
            phase: phase,
            gridRef,
            bounds: {
              minLat,
              maxLat,
              minLng,
              maxLng
            },
            corners: [[p1Lat, p1Lng], [p2Lat, p2Lng], [p3Lat, p3Lng], [p4Lat, p4Lng]]
          };

          const existing = tilesMap.get(gridRef) || [];
          tilesMap.set(gridRef, [...existing, tile]);
        }
      }
    }

    const allTiles: LidarTile[] = [];
    tilesMap.forEach(tiles => allTiles.push(...tiles));
    return allTiles;
  }

  private getBNGGridRef(easting: number, northing: number): string {
    const e100 = Math.floor(easting / 100000);
    const n100 = Math.floor(northing / 100000);
    
    if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return `BNG_${Math.floor(easting/1000)}_${Math.floor(northing/1000)}`;

    const e500 = Math.floor(e100 / 5);
    const n500 = Math.floor(n100 / 5);
    
    let l1 = "S";
    if (e500 === 0 && n500 === 1) l1 = "N";
    else if (e500 === 0 && n500 === 2) l1 = "H";
    else if (e500 === 1 && n500 === 0) l1 = "T";
    else if (e500 === 1 && n500 === 1) l1 = "O";

    const remE = ((e100 % 5) + 5) % 5;
    const remN = ((n100 % 5) + 5) % 5;
    
    const letters = [
      ["A", "B", "C", "D", "E"],
      ["F", "G", "H", "J", "K"],
      ["L", "M", "N", "O", "P"],
      ["Q", "R", "S", "T", "U"],
      ["V", "W", "X", "Y", "Z"]
    ];
    
    const prefix = l1 + letters[4 - remN][remE];
    
    const eKm = Math.floor((easting % 100000) / 1000).toString().padStart(2, '0');
    const nKm = Math.floor((northing % 100000) / 1000).toString().padStart(2, '0');
    
    return `${prefix}${eKm}${nKm}`;
  }
}

export const lidarCatalogService = new LidarCatalogService();
