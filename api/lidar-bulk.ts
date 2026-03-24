import axios from 'axios';

export default async function handler(req: any, res: any) {
  const { swLat, swLng, neLat, neLng, resolution, rows, cols } = req.query;

  if (!swLat || !swLng || !neLat || !neLng || !resolution) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const swLatNum = Number(swLat);
  const swLngNum = Number(swLng);
  const neLatNum = Number(neLat);
  const neLngNum = Number(neLng);

  // Scotland approximate bounding box check
  const isOutsideScotland = swLatNum < 54.5 || neLatNum > 61.0 || swLngNum < -9.0 || neLngNum > -0.5;
  if (isOutsideScotland) {
    return res.status(400).json({ 
      error: 'Area outside Scotland', 
      details: 'This toolkit currently only supports LiDAR data for Scotland. The requested area appears to be in another region (e.g. Wales or England).' 
    });
  }

  try {
    const resNum = Number(resolution);

    const latStep = (resNum / 111320);
    const lngStep = (resNum / (111320 * Math.cos(swLatNum * Math.PI / 180)));

    const rowsNum = rows ? Number(rows) : Math.ceil((neLatNum - swLatNum) / latStep);
    const colsNum = cols ? Number(cols) : Math.ceil((neLngNum - swLngNum) / lngStep);
    const total = rowsNum * colsNum;

    if (total > 150000) {
      return res.status(400).json({ error: 'Area too large for bulk request (>150k points)' });
    }

    const grid = new Float32Array(total).fill(NaN);
    const wmsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
    const layers = 'scotland:scotland-lidar-1-dtm,scotland:scotland-lidar-2-dtm,scotland:scotland-lidar-3-dtm,scotland:scotland-lidar-4-dtm,scotland:scotland-lidar-5-dtm,scotland:scotland-lidar-6-dtm';

    const CONCURRENCY = 15; 
    const batchSize = 10;
    
    for (let i = 0; i < total; i += (CONCURRENCY * batchSize)) {
      const tasks = [];
      for (let c = 0; c < CONCURRENCY; c++) {
        const start = i + (c * batchSize);
        if (start >= total) break;
        
        tasks.push((async (startIndex: number) => {
          for (let j = startIndex; j < Math.min(startIndex + batchSize, total); j++) {
            const r = Math.floor(j / colsNum);
            const c = j % colsNum;
            const lat = neLatNum - (r * latStep);
            const lng = swLngNum + (c * lngStep);

            try {
              const params = new URLSearchParams();
              params.append('service', 'WMS');
              params.append('version', '1.1.1');
              params.append('request', 'GetFeatureInfo');
              params.append('layers', layers);
              params.append('query_layers', layers);
              params.append('x', '50');
              params.append('y', '50');
              params.append('width', '101');
              params.append('height', '101');
              params.append('srs', 'EPSG:4326');
              const delta = 0.0001;
              params.append('bbox', `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`);
              params.append('info_format', 'application/json');
              params.append('feature_count', '5');

              const response = await axios.get(wmsUrl, { params, timeout: 3000 });
              
              let elevation = NaN;
              if (response.data && response.data.features) {
                for (const feature of response.data.features) {
                  const props = feature.properties;
                  if (!props) continue;
                  for (const key in props) {
                    const val = parseFloat(props[key]);
                    if (!isNaN(val) && val > -50 && val < 5000) {
                      elevation = val;
                      break;
                    }
                  }
                  if (!isNaN(elevation)) break;
                }
              }
              grid[j] = elevation;
            } catch (e) {
              grid[j] = NaN;
            }
          }
        })(start));
      }
      
      await Promise.all(tasks);
    }

    const finalBuffer = Buffer.from(grid.buffer);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', finalBuffer.length.toString());
    res.status(200).send(finalBuffer);

  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch bulk LiDAR data' });
  }
}
