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

      const coverageId = 'scotland__scotland-lidar-6-dtm';
      const wcsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
      
      // WCS 2.0.1 subsetting for a point
      // We use subsettingCrs=EPSG:4326 so we can use Lat/Long directly
      const params = new URLSearchParams();
      params.append('service', 'WCS');
      params.append('version', '2.0.1');
      params.append('request', 'GetCoverage');
      params.append('coverageId', coverageId);
      params.append('subsettingCrs', 'http://www.opengis.net/def/crs/EPSG/0/4326');
      params.append('subset', `Long(${Number(lng)})`);
      params.append('subset', `Lat(${Number(lat)})`);
      params.append('format', 'text/plain');

      console.log(`[LiDAR API] Fetching from WCS: ${wcsUrl}?${params.toString()}`);

      const response = await axios.get(wcsUrl, { 
        params: params,
        timeout: 10000
      });
      
      console.log(`[LiDAR API] WCS Response received, length: ${response.data?.length}`);
      res.json({ elevation: response.data });
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
