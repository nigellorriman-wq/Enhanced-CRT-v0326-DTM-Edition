import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // LiDAR Proxy API
  app.get("/api/lidar", async (req, res) => {
    try {
      const { lat, lng } = req.query;

      if (!lat || !lng) {
        return res.status(400).json({ error: "Missing lat/lng" });
      }

      console.log(`[Server Proxy] GET /api/lidar - lat: ${lat}, lng: ${lng}`);

      const identifyUrl = `https://spatialdata.gov.scot/arcgis/rest/services/Public/Lidar_DTM_1m/MapServer/identify`;
      const params = {
        f: 'json',
        geometryType: 'esriGeometryPoint',
        geometry: JSON.stringify({ x: Number(lng), y: Number(lat), spatialReference: { wkid: 4326 } }),
        tolerance: '5',
        mapExtent: `${Number(lng) - 0.005},${Number(lat) - 0.005},${Number(lng) + 0.005},${Number(lat) + 0.005}`,
        imageDisplay: '100,100,96',
        layers: '0',
        returnGeometry: 'false',
        sr: '4326'
      };

      const response = await axios.get(identifyUrl, { 
        params,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://spatialdata.gov.scot/',
          'Origin': 'https://spatialdata.gov.scot'
        },
        timeout: 10000
      });
      
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const data = error.response?.data || error.message;
      console.error(`[Server Proxy] LiDAR Proxy Error (${status}):`, data);
      res.status(status).json({ 
        error: 'Failed to fetch LiDAR data', 
        details: typeof data === 'object' ? JSON.stringify(data) : data 
      });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), source: "Express Server" });
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
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
