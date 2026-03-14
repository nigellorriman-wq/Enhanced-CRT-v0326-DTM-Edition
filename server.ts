import express from "express";
import { createServer as createViteServer } from "vite";
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('Starting Express server...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

      const wmsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
      
      // Use WMS GetFeatureInfo on the same layers used for the map overlay
      const params = new URLSearchParams();
      params.append('service', 'WMS');
      params.append('version', '1.1.1');
      params.append('request', 'GetFeatureInfo');
      // Query all phases to ensure coverage
      const layers = 'scotland:scotland-lidar-1-dtm,scotland:scotland-lidar-2-dtm,scotland:scotland-lidar-3-dtm,scotland:scotland-lidar-4-dtm,scotland:scotland-lidar-5-dtm,scotland:scotland-lidar-6-dtm';
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

      console.log(`[LiDAR API] Fetching from WMS GetFeatureInfo: ${wmsUrl}?${params.toString()}`);

      const response = await axios.get(wmsUrl, { 
        params: params,
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      });
      
      console.log(`[LiDAR API] Response received, features: ${response.data?.features?.length}`);
      
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
        res.json({ elevation });
      } else {
        res.status(404).json({ error: 'No elevation data found at this location' });
      }
    } catch (error: any) {
      console.error('[LiDAR API] Error:', error.message);
      if (error.response) {
        console.error('[LiDAR API] WCS Error Response:', error.response.status, error.response.data);
      }
      const status = error.response?.status || 500;
      const data = error.response?.data || error.message;
      res.status(status).json({ 
        error: 'Failed to fetch LiDAR data', 
        details: typeof data === 'object' ? JSON.stringify(data) : data 
      });
    }
  });

  // API route for bulk LiDAR data
  app.get("/api/lidar-bulk", async (req, res) => {
    const { swLat, swLng, neLat, neLng, resolution, rows, cols } = req.query;
    console.log(`[LiDAR Bulk API] Request received: swLat=${swLat}, swLng=${swLng}, neLat=${neLat}, neLng=${neLng}, res=${resolution}, rows=${rows}, cols=${cols}`);

    if (!swLat || !swLng || !neLat || !neLng || !resolution) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
      const swLatNum = Number(swLat);
      const swLngNum = Number(swLng);
      const neLatNum = Number(neLat);
      const neLngNum = Number(neLng);
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

      // Process in larger batches and use a more efficient concurrent approach
      const CONCURRENCY = 10; 
      const batchSize = 20;
      
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
