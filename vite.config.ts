import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import axios from 'axios';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'lidar-proxy',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith('/api/health')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), source: 'Vite Plugin' }));
            return;
          }
          if (req.url?.startsWith('/api/lidar')) {
            try {
              const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
              const lat = url.searchParams.get('lat');
              const lng = url.searchParams.get('lng');

              if (!lat || !lng) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing lat/lng' }));
                return;
              }

              console.log(`[Vite Proxy] GET /api/lidar - lat: ${lat}, lng: ${lng}`);

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
              
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(response.data));
            } catch (error: any) {
              const status = error.response?.status || 500;
              const data = error.response?.data || error.message;
              console.error(`[Vite Proxy] LiDAR Proxy Error (${status}):`, data);
              res.statusCode = status;
              res.end(JSON.stringify({ 
                error: 'Failed to fetch LiDAR data', 
                details: typeof data === 'object' ? JSON.stringify(data) : data 
              }));
            }
          } else {
            next();
          }
        });
      }
    }
  ],
  base: './',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
});
