import express from "express";
import { createServer as createViteServer } from "vite";
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import proj4 from 'proj4';

// Define British National Grid (BNG) projection
proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs");

console.log('Starting Express server...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractElevationFromWmsResponse(data: any): number | null {
  if (!data) return null;

  // Known elevation property names in order of preference
  const elevationKeys = ['GRAY_INDEX', 'elevation', 'dtm', 'altitude', 'grid_code', 'band1', 'height', 'pixel_value'];
  // Known metadata keys to ignore - heavily expanded to catch phase IDs and GIS property noise
  const metadataKeys = [
    'id', 'fid', 'objectid', 'layer_id', 'phase', 'resolution', 'year', 'ogc_fid', 'tile_id', 'site_id', 
    'shape_length', 'shape_area', 'point_x', 'point_y', 'label', 'class', 'index', 'priority', 'value',
    'numbermatched', 'numberreturned', 'timestamp', 'totalfeatures',
    'scotland_lidar_composite_dtm', 'scotland_lidar_1_dtm', 'scotland_lidar_2_dtm', 
    'scotland_lidar_3_dtm', 'scotland_lidar_4_dtm', 'scotland_lidar_5_dtm', 'scotland_lidar_6_dtm'
  ];

  const findValue = (obj: any): number | null => {
    if (!obj || typeof obj !== 'object') return null;

    // Case 1: If it's a feature, check its properties
    if (obj.properties) {
      // 1a. Try known elevation keys - prioritizing GRAY_INDEX and dtm
      for (const key of elevationKeys) {
        if (obj.properties[key] !== undefined && obj.properties[key] !== null) {
          const val = parseFloat(obj.properties[key]);
          
          // Technical Filter: In Scottish LiDAR, many layers include a 'value' or 'index' 
          // that matches the phase number (1-6). Real elevations are almost never exactly 
          // 1.0, 2.0, etc. across multiple points unless metadata is being leaked.
          if (!isNaN(val) && val > -50 && val < 2000 && val !== 0 && Math.abs(val + 9999) > 1) {
            // Precision check: Real LiDAR DTM values are usually floating point.
            // If the value is a small integer 1-6, it's highly likely to be a Phase ID.
            const isSmallInteger = Number.isInteger(val) && val >= 1 && val <= 6;
            if (isSmallInteger) {
              console.log(`[LiDAR API] Skipping potential Phase ID (${val}) from property: ${key}`);
              continue;
            }

            console.log(`[LiDAR API] Extracted elevation ${val} from property: ${key}`);
            return val;
          }
        }
      }
      
      // 1b. Fallback to any numeric property that isn't metadata
      for (const key in obj.properties) {
        const lowerKey = key.toLowerCase();
        if (metadataKeys.includes(lowerKey) || elevationKeys.includes(key)) continue;
        if (/name|code|ref|type|grid|ph|res|date|link|id|fid|oid|obj|layer|feat|site|tile|poly|point|geom|class|index|priority|total|count|return/i.test(lowerKey)) continue;
        
        const val = parseFloat(obj.properties[key]);
        if (!isNaN(val) && val > -50 && val < 2000 && val !== 0 && Math.abs(val + 9999) > 1 && Math.abs(val) < 1e+10) {
          // Reject small integers in the phase range for fallback extraction too
          if (Number.isInteger(val) && val >= 1 && val <= 6) continue;
          
          console.log(`[LiDAR API] Extracted potential elevation ${val} from unknown property: ${key}`);
          return val;
        }
      }
    }

    // Case 2: Deep search in other objects (recurse)
    // First check features array if present
    if (Array.isArray(obj.features)) {
      for (const feature of obj.features) {
        const res = findValue(feature);
        if (res !== null) return res;
      }
    }

    // Then check all other keys
    for (const key in obj) {
      if (key === 'features' || key === 'properties') continue;
      if (obj[key] && typeof obj[key] === 'object') {
        const res = findValue(obj[key]);
        if (res !== null) return res;
      }
      
      // Strict direct numeric check for flat objects
      // Only extract if the key looks like an elevation key (e.g. z, gray_index)
      // and NOT if it looks like metadata count (e.g. numberReturned)
      const lowerKey = key.toLowerCase();
      const isLikelyElevationKey = elevationKeys.some(ek => lowerKey === ek.toLowerCase());
      
      if (typeof obj[key] !== 'object' && isLikelyElevationKey && !metadataKeys.includes(lowerKey)) {
        const val = parseFloat(obj[key]);
        if (!isNaN(val) && val > -50 && val < 2000 && val !== 0 && Math.abs(val + 9999) > 1) {
          // Apply phase-ID guard here too
          if (Number.isInteger(val) && val >= 1 && val <= 6) continue;

          console.log(`[LiDAR API] Extracted elevation ${val} from flat object key: ${key}`);
          return val;
        }
      }
    }

    return null;
  };

  return findValue(data);
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
        'scotland:lidar-aggregate',
        'scotland:scotland-lidar-1-dtm', 
        'scotland:scotland-lidar-2-dtm', 
        'scotland:scotland-lidar-3-dtm', 
        'scotland:scotland-lidar-4-dtm', 
        'scotland:scotland-lidar-5-dtm', 
        'scotland:scotland-lidar-6-dtm'
      ];
      
      let elevation = null;
      let primaryRequestSuccess = false;

      // Convert to BNG for more reliable querying against JNCC Scottish data
      const [e, n] = proj4("EPSG:4326", "EPSG:27700", [lngNum, latNum]);
      const delta = 5; // 5 metre bbox to ensure we hit data points in lower-res layers

      // Try the aggregate layer first (most efficient "Combined" path)
      const primaryLayer = 'scotland:lidar-aggregate';
      const params = new URLSearchParams({
        service: 'WMS',
        version: '1.1.1',
        request: 'GetFeatureInfo',
        layers: primaryLayer,
        query_layers: primaryLayer,
        info_format: 'application/json',
        x: '50',
        y: '50',
        width: '101',
        height: '101',
        srs: 'EPSG:27700',
        bbox: `${e - delta},${n - delta},${e + delta},${n + delta}`,
        feature_count: '10'
      });

      console.log(`[LiDAR API] Polling terrain data source: lat=${latNum.toFixed(4)}, lng=${lngNum.toFixed(4)}`);

      try {
        const response = await axios.get(wmsUrl, { params, timeout: 15000 });
        primaryRequestSuccess = true;
        elevation = extractElevationFromWmsResponse(response.data);
        if (elevation !== null) {
          console.log(`[LiDAR API] SUCCESS: Found topographic data (${elevation}m)`);
        }
      } catch (e: any) {
        // Just log the failure reason quietly
        console.log(`[LiDAR API] Composite layer poll paused (Server status: ${e.message})`);
      }

      // Fallback: if the primary request found no data, or if it failed, try individual phase layers.
      if (elevation === null) {
        console.log(`[LiDAR API] Initializing diagnostic scan for phase layers...`);
        const phaseLayers = layers.filter(l => l !== primaryLayer);
        for (const layer of phaseLayers) {
          try {
            const individualParams = new URLSearchParams(params);
            individualParams.set('layers', layer);
            individualParams.set('query_layers', layer);
            
            const response = await axios.get(wmsUrl, { params: individualParams, timeout: 4000 });
            elevation = extractElevationFromWmsResponse(response.data);
            if (elevation !== null) {
              console.log(`[LiDAR API] RECOVERY SUCCESS: Found elevation ${elevation} in layer ${layer}`);
              break;
            }
          } catch (e: any) {
            // Silently continue individual scan
          }
        }
      }

      // Final fallback: Try WGS84 only if everything else failed
      if (elevation === null) {
        console.log(`[LiDAR API] BNG projection miss, attempting final WGS84 coordinate scan...`);
        const deltaWGS = 0.0005;
        const wgsParams = new URLSearchParams(params);
        wgsParams.set('srs', 'EPSG:4326');
        wgsParams.set('bbox', `${lngNum - deltaWGS},${latNum - deltaWGS},${lngNum + deltaWGS},${latNum + deltaWGS}`);
        
        for (const layer of layers) {
          try {
            wgsParams.set('layers', layer);
            wgsParams.set('query_layers', layer);
            const response = await axios.get(wmsUrl, { params: wgsParams, timeout: 4000 });
            elevation = extractElevationFromWmsResponse(response.data);
            if (elevation !== null) {
              console.log(`[LiDAR API] RECOVERY SUCCESS: Elevation ${elevation} found via WGS84 fallback`);
              break;
            }
          } catch (e) {
            // Final silence
          }
        }
      }

      if (elevation !== null && elevation !== undefined) {
        res.json({ elevation });
      } else {
        // Log "No coverage" as an expected result, not a failure
        console.log(`[LiDAR API] Coverage Scan: No topographic data found for lat=${latNum.toFixed(4)}, lng=${lngNum.toFixed(4)}`);
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
