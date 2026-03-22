import express from "express";
import { createServer as createViteServer } from "vite";
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('Starting Express server...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractElevationFromWmsResponse(data: any): number | null {
  if (!data || !data.features || !Array.isArray(data.features) || data.features.length === 0) {
    return null;
  }
  
  for (const feature of data.features) {
    const props = feature.properties;
    if (!props) continue;
    
    // Log properties for debugging if we're having trouble finding elevation
    // console.log('[LiDAR API] Feature properties:', JSON.stringify(props));
    
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Health check route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", version: "3.1" });
  });

  // API route for LiDAR data
  app.get("/api/lidar", async (req, res) => {
    console.log(`[LiDAR API] Request received: lat=${req.query.lat}, lng=${req.query.lng}`);
    try {
      const { lat, lng } = req.query;

      if (!lat || !lng) {
        console.error('[LiDAR API] Missing lat/lng');
        return res.status(400).json({ error: 'Missing lat/lng' });
      }

      const latNum = Number(lat);
      const lngNum = Number(lng);

      // Scotland approximate bounding box
      const isOutsideScotland = latNum < 54.5 || latNum > 61.0 || lngNum < -9.0 || lngNum > -0.5;
      if (isOutsideScotland) {
        console.log(`[LiDAR API] Location outside Scotland: lat=${lat}, lng=${lng}`);
        return res.status(400).json({ 
          error: 'Location outside Scotland', 
          details: 'This toolkit currently only supports LiDAR data for Scotland. The coordinates provided appear to be in another region (e.g. Wales or England).' 
        });
      }

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

      console.log(`[LiDAR API] Fetching from WMS GetFeatureInfo (Combined): ${wmsUrl}?${params.toString()}`);

      try {
        const response = await axios.get(wmsUrl, { params, timeout: 5000 });
        elevation = extractElevationFromWmsResponse(response.data);
      } catch (e: any) {
        console.log(`[LiDAR API] Combined request failed or timed out: ${e.message}`);
      }

      // If combined failed, try individual layers (some GeoServers are picky)
      if (elevation === null) {
        console.log(`[LiDAR API] Combined failed, trying layers individually...`);
        for (const layer of layers) {
          try {
            const individualParams = new URLSearchParams(params);
            individualParams.set('layers', layer);
            individualParams.set('query_layers', layer);
            
            console.log(`[LiDAR API] Trying layer: ${layer}`);
            const response = await axios.get(wmsUrl, { params: individualParams, timeout: 3000 });
            elevation = extractElevationFromWmsResponse(response.data);
            if (elevation !== null) {
              console.log(`[LiDAR API] SUCCESS: Found elevation ${elevation} in layer ${layer}`);
              break;
            }
          } catch (e: any) {
            console.log(`[LiDAR API] Layer ${layer} failed: ${e.message}`);
          }
        }
      }

      if (elevation !== null && elevation !== undefined) {
        res.json({ elevation });
      } else {
        console.log(`[LiDAR API] FAILED: No elevation found for lat=${lat}, lng=${lng} after checking all layers.`);
        res.status(404).json({ error: 'No elevation data found at this location' });
      }
    } catch (error: any) {
      console.error('[LiDAR API] Global Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch LiDAR data', details: error.message });
    }
  });

  // API route for bulk LiDAR data
  app.get("/api/lidar-bulk", async (req, res) => {
    const { swLat, swLng, neLat, neLng, resolution, rows, cols } = req.query;
    console.log(`[LiDAR Bulk API] Request received: swLat=${swLat}, swLng=${swLng}, neLat=${neLat}, neLng=${neLng}, res=${resolution}, rows=${rows}, cols=${cols}`);

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
      console.log(`[LiDAR Bulk API] Area outside Scotland: swLat=${swLat}, swLng=${swLng}, neLat=${neLat}, neLng=${neLng}`);
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

      console.log(`[LiDAR Bulk API] Processing ${total} points (${rowsNum}x${colsNum})`);

      const grid = new Float32Array(total).fill(NaN);
      const wmsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
      const layers = 'scotland:scotland-lidar-1-dtm,scotland:scotland-lidar-2-dtm,scotland:scotland-lidar-3-dtm,scotland:scotland-lidar-4-dtm,scotland:scotland-lidar-5-dtm,scotland:scotland-lidar-6-dtm';

      // Optimization: Try to use WCS GetCoverage if the area is small enough,
      // otherwise fall back to the (still slow but slightly better) WMS approach.
      // For now, let's stick to a more robust WMS GetFeatureInfo but with better batching.
      
      // Process in larger batches and use a more efficient concurrent approach
      const CONCURRENCY = 15; 
      const batchSize = 10;
      
      for (let i = 0; i < total; i += (CONCURRENCY * batchSize)) {
        const tasks = [];
        for (let c = 0; c < CONCURRENCY; c++) {
          const start = i + (c * batchSize);
          if (start >= total) break;
          
          tasks.push((async (startIndex: number) => {
            for (let j = startIndex; j < Math.min(startIndex + batchSize, total); j++) {
              const r = Math.floor(j / cols);
              const c = j % cols;
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
        if (i % 200 === 0) {
          console.log(`[LiDAR Bulk API] Progress: ${Math.round((i / total) * 100)}%`);
        }
      }

      // Ensure the buffer is exactly the right size and aligned
      const finalBuffer = Buffer.from(grid.buffer);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', finalBuffer.length.toString());
      res.send(finalBuffer);

    } catch (error: any) {
      console.error('[LiDAR Bulk API] Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch bulk LiDAR data' });
    }
  });

  // API route for WCS capabilities
  app.get("/api/wcs-capabilities", async (req, res) => {
    console.log(`[WCS API] GetCapabilities request received`);
    try {
      const wcsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
      const params = new URLSearchParams();
      params.append('service', 'WCS');
      params.append('version', '2.0.1');
      params.append('request', 'GetCapabilities');

      const response = await axios.get(wcsUrl, { 
        params: params,
        timeout: 15000
      });
      
      res.set('Content-Type', 'application/xml');
      res.send(response.data);
    } catch (error: any) {
      console.error('[WCS API] Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch WCS capabilities' });
    }
  });

  // Proxy for GeoTIFF downloads to bypass CORS
  app.get("/api/proxy-geotiff", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing URL' });
    }

    console.log(`[Proxy API] Fetching GeoTIFF: ${url}`);
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'Accept': 'image/tiff, application/xml, text/xml, */*'
        }
      });

      console.log(`[Proxy API] Success: ${url} (Status: ${response.status}, Content-Type: ${response.headers['content-type']})`);
      
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('xml') || contentType.includes('html')) {
        const text = Buffer.from(response.data).toString('utf8');
        console.warn(`[Proxy API] WARNING: Received XML/HTML instead of TIFF:`, text.substring(0, 500));
        
        // Try to extract a useful error message from the XML
        let errorMsg = 'The LiDAR server returned an error instead of a tile.';
        if (text.includes('ServiceException')) {
          const match = text.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/);
          if (match && match[1]) {
            errorMsg = match[1].trim();
          }
        } else if (text.includes('ExceptionText')) {
          const match = text.match(/<ExceptionText>([\s\S]*?)<\/ExceptionText>/);
          if (match && match[1]) {
            errorMsg = match[1].trim();
          }
        }
        
        return res.status(404).json({ 
          error: 'LiDAR Tile Not Available', 
          details: errorMsg,
          serverRawResponse: text.substring(0, 1000) 
        });
      }

      res.set('Content-Type', contentType || 'image/tiff');
      if (response.headers['content-length']) {
        res.set('Content-Length', response.headers['content-length']);
      }
      res.send(response.data);
    } catch (error: any) {
      const url = req.query.url as string;
      console.error(`[Proxy API] Error fetching ${url}:`, error.message);
      let status = 500;
      let details = error.message;
      
      if (error.response) {
        status = error.response.status;
        const contentType = error.response.headers['content-type'] || '';
        if (contentType.includes('xml') || contentType.includes('text')) {
          const text = Buffer.from(error.response.data).toString('utf8');
          console.error(`[Proxy API] Server Error Response (${status}):`, text.substring(0, 500));
          
          // Try to extract a clean error message
          let errorMsg = text;
          const match = text.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/) || 
                        text.match(/<ExceptionText>([\s\S]*?)<\/ExceptionText>/);
          if (match && match[1]) {
            errorMsg = match[1].trim();
          }
          details = errorMsg;
        }
      }
      
      res.status(status).json({ 
        error: 'Failed to proxy GeoTIFF download', 
        details: details 
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
