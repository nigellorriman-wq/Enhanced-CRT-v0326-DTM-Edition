/**
 * Service to discover Scottish Government LiDAR GeoTIFF tiles
 */
export interface LidarTile {
  id: string;
  name: string;
  url: string;
  resolution: number;
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
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

    const tiles: LidarTile[] = [];
    const phases = [1, 2];
    
    // We'll generate mock tiles based on the OS Grid squares (1km tiles)
    const startLat = Math.floor(bounds.minLat * 100) / 100;
    const endLat = Math.ceil(bounds.maxLat * 100) / 100;
    const startLng = Math.floor(bounds.minLng * 100) / 100;
    const endLng = Math.ceil(bounds.maxLng * 100) / 100;

    for (let lat = startLat; lat < endLat; lat += 0.01) {
      for (let lng = startLng; lng < endLng; lng += 0.01) {
        const gridRef = this.getMockGridRef(lat, lng);
        
        // For each grid square, offer tiles from all available phases
        // In a real app, we'd know which phase covers which area
        for (const phase of phases) {
          const coverageId = `scotland:scotland-lidar-${phase}-dtm`;
          
          tiles.push({
            id: `scot_lidar_ph${phase}_05m_${gridRef}`,
            name: `LiDAR Ph${phase} 0.5m - ${gridRef}`,
            url: `https://srsp-ows.jncc.gov.uk/ows?service=WCS&version=1.0.0&request=GetCoverage&coverage=${coverageId}&format=GeoTIFF&bbox=${lng.toFixed(6)},${lat.toFixed(6)},${(lng + 0.01).toFixed(6)},${(lat + 0.01).toFixed(6)}&width=1000&height=1000&crs=EPSG:4326`,
            resolution: 0.5,
            bounds: {
              minLat: lat,
              maxLat: lat + 0.01,
              minLng: lng,
              maxLng: lng + 0.01
            }
          });
        }
      }
    }

    return tiles;
  }

  private getMockGridRef(lat: number, lng: number): string {
    // Very simplified OS Grid Reference generator for mock purposes
    // Real logic would involve complex projection math
    const latPart = Math.floor((lat - 55) * 100).toString().padStart(2, '0');
    const lngPart = Math.floor((lng + 4) * 100).toString().padStart(2, '0');
    return `NT${lngPart}${latPart}`;
  }
}

export const lidarCatalogService = new LidarCatalogService();
