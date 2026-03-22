import axios from 'axios';

export default async function handler(req: any, res: any) {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing lat/lng' });
  }

  try {
    const wmsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
    
    // Use WMS GetFeatureInfo on the same layers used for the map overlay
    const params = new URLSearchParams();
    params.append('service', 'WMS');
    params.append('version', '1.1.1');
    params.append('request', 'GetFeatureInfo');
    // Query all phases to ensure coverage
    const layers = 'scot_lidar:scot_lidar_ph1_dtm,scot_lidar:scot_lidar_ph2_dtm,scot_lidar:scot_lidar_ph3_dtm,scot_lidar:scot_lidar_ph4_dtm,scot_lidar:scot_lidar_ph5_dtm,scot_lidar:scot_lidar_ph6_dtm,scotland:scotland-lidar-1-dtm,scotland:scotland-lidar-2-dtm,scotland:scotland-lidar-3-dtm,scotland:scotland-lidar-4-dtm,scotland:scotland-lidar-5-dtm,scotland:scotland-lidar-6-dtm';
    params.append('layers', layers);
    params.append('query_layers', layers);
    params.append('x', '50');
    params.append('y', '50');
    params.append('width', '101');
    params.append('height', '101');
    params.append('srs', 'EPSG:4326');
    
    // Slightly larger delta for better reliability at high zoom
    const delta = 0.0005; 
    const lngNum = Number(lng);
    const latNum = Number(lat);
    // EPSG:4326 in WMS 1.1.1 is lon,lat
    params.append('bbox', `${lngNum - delta},${latNum - delta},${lngNum + delta},${latNum + delta}`);
    params.append('info_format', 'application/json');
    params.append('feature_count', '50'); // Check more features to find data across layers

    const response = await axios.get(wmsUrl, { 
      params: params,
      timeout: 10000,
      headers: { 'Accept': 'application/json' }
    });
    
    // Extract elevation from GeoServer JSON response
    let elevation = null;
    if (response.data && response.data.features && response.data.features.length > 0) {
      // Find the first feature that has a valid elevation property
      for (const feature of response.data.features) {
        const props = feature.properties;
        if (!props) continue;
        
        // Check all properties for a numeric value that looks like elevation
        for (const key in props) {
          const val = parseFloat(props[key]);
          // Elevation in Scotland is rarely > 1400m or < -10m (bathymetry aside)
          // -9999 is a common "no data" value
          if (val !== null && val !== undefined && !isNaN(val) && val > -50 && val < 5000) {
            elevation = val;
            break;
          }
        }
        if (elevation !== null) break;
      }
    }

    if (elevation !== null && elevation !== undefined) {
      res.status(200).json({ elevation });
    } else {
      res.status(404).json({ error: 'No elevation data found at this location' });
    }
  } catch (error: any) {
    const status = error.response?.status || 500;
    const data = error.response?.data || error.message;
    res.status(status).json({ 
      error: 'Failed to fetch LiDAR data', 
      details: typeof data === 'object' ? JSON.stringify(data) : data 
    });
  }
}
