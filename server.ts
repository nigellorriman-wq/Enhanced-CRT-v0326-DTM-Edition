import express from "express";
import { createServer as createViteServer } from "vite";
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

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
    try {
      const { lat, lng } = req.query;

      if (!lat || !lng) {
        return res.status(400).json({ error: 'Missing lat/lng' });
      }

      const coverageId = 'scotland__scotland-lidar-6-dtm';
      const wcsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
      const params = {
        service: 'WCS',
        version: '2.0.1',
        request: 'GetCoverage',
        coverageId: coverageId,
        subsettingCrs: 'http://www.opengis.net/def/crs/EPSG/0/4326',
        subset: [
          `Long(${Number(lng)})`,
          `Lat(${Number(lat)})`
        ],
        format: 'text/plain'
      };

      const response = await axios.get(wcsUrl, { 
        params,
        timeout: 10000
      });
      
      res.json({ elevation: response.data });
    } catch (error: any) {
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
