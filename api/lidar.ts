import axios from 'axios';

function extractElevationFromWmsResponse(data: any): number | null {
  if (!data || !data.features || !Array.isArray(data.features) || data.features.length === 0) {
    return null;
  }
  
  for (const feature of data.features) {
    const props = feature.properties;
    if (!props) continue;
    
    for (const key in props) {
      const val = parseFloat(props[key]);
      // Valid elevation range for Scotland (-50 to 5000m)
      // Exclude common "no data" values like -9999
      if (!isNaN(val) && val > -50 && val < 5000 && val !== -9999) {
        return val;
      }
    }
  }
  return null;
}

export default async function handler(req: any, res: any) {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing lat/lng' });
  }

  const latNum = Number(lat);
  const lngNum = Number(lng);

  // Scotland approximate bounding box
  const isOutsideScotland = latNum < 54.5 || latNum > 61.0 || lngNum < -9.0 || lngNum > -0.5;
  if (isOutsideScotland) {
    return res.status(400).json({ 
      error: 'Location outside Scotland', 
      details: 'This toolkit currently only supports LiDAR data for Scotland. The coordinates provided appear to be in another region (e.g. Wales or England).' 
    });
  }

  try {
    const wmsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
    const layers = [
      'scotland:scotland-lidar-1-dtm', 
      'scotland:scotland-lidar-2-dtm', 
      'scotland:scotland-lidar-3-dtm', 
      'scotland:scotland-lidar-4-dtm', 
      'scotland:scotland-lidar-5-dtm', 
      'scotland:scotland-lidar-6-dtm'
    ];
    
    let elevation = null;
    const delta = 0.0005; 

    // Try combined first (efficiency)
    const combinedLayers = layers.join(',');
    const params = new URLSearchParams({
      service: 'WMS',
      version: '1.1.1',
      request: 'GetFeatureInfo',
      layers: combinedLayers,
      query_layers: combinedLayers,
      info_format: 'application/json',
      x: '50',
      y: '50',
      width: '101',
      height: '101',
      srs: 'EPSG:4326',
      bbox: `${lngNum - delta},${latNum - delta},${lngNum + delta},${latNum + delta}`,
      feature_count: '50'
    });

    try {
      const response = await axios.get(wmsUrl, { params, timeout: 5000 });
      elevation = extractElevationFromWmsResponse(response.data);
    } catch (e: any) {
      // Log error internally if needed
    }

    // If combined failed, try individual layers
    if (elevation === null) {
      for (const layer of layers) {
        try {
          const individualParams = new URLSearchParams(params);
          individualParams.set('layers', layer);
          individualParams.set('query_layers', layer);
          
          const response = await axios.get(wmsUrl, { params: individualParams, timeout: 3000 });
          elevation = extractElevationFromWmsResponse(response.data);
          if (elevation !== null) {
            break;
          }
        } catch (e: any) {
          // Continue to next layer
        }
      }
    }

    if (elevation !== null && elevation !== undefined) {
      res.status(200).json({ elevation });
    } else {
      res.status(404).json({ error: 'No elevation data found at this location' });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch LiDAR data', details: error.message });
  }
}
