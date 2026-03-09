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
      
      // Use WMS GetFeatureInfo which is more robust for aggregate layers
      const params = new URLSearchParams();
      params.append('service', 'WMS');
      params.append('version', '1.1.1');
      params.append('request', 'GetFeatureInfo');
      params.append('layers', 'scotland:lidar-aggregate');
      params.append('query_layers', 'scotland:lidar-aggregate');
      params.append('x', '50');
      params.append('y', '50');
      params.append('width', '101');
      params.append('height', '101');
      params.append('srs', 'EPSG:4326');
      
      const delta = 0.0001;
      const lngNum = Number(lng);
      const latNum = Number(lat);
      params.append('bbox', `${lngNum - delta},${latNum - delta},${lngNum + delta},${latNum + delta}`);
      params.append('info_format', 'application/json');
      params.append('feature_count', '1');

      console.log(`[LiDAR API] Fetching from WMS GetFeatureInfo: ${wmsUrl}?${params.toString()}`);

      const response = await axios.get(wmsUrl, { 
        params: params,
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      });
      
      console.log(`[LiDAR API] Response received`);
      
      // Extract elevation from GeoServer JSON response
      let elevation = null;
      if (response.data && response.data.features && response.data.features.length > 0) {
        const props = response.data.features[0].properties;
        // Look for common elevation property names
        elevation = props.GRAY_INDEX ?? props.value ?? props.Value ?? props.elevation ?? props.ELEVATION;
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
