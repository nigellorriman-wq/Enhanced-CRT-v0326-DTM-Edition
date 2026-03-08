import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Proxy for LiDAR data to bypass CORS
  app.get('/api/lidar', async (req, res) => {
    try {
      const { lat, lng } = req.query;
      if (!lat || !lng) {
        return res.status(400).json({ error: 'Missing lat/lng' });
      }

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

      const response = await axios.get(identifyUrl, { params });
      res.json(response.data);
    } catch (error: any) {
      console.error('LiDAR Proxy Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch LiDAR data', details: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (req, res) => {
      res.sendFile('index.html', { root: 'dist' });
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
