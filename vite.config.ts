import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import axios from 'axios';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'lidar-proxy',
      configureServer(server) {
        server.middlewares.use('/api/lidar', async (req, res) => {
          try {
            const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
            const lat = url.searchParams.get('lat');
            const lng = url.searchParams.get('lng');

            if (!lat || !lng) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Missing lat/lng' }));
              return;
            }

            const coverageId = 'scotland:lidar-aggregate';
            const wcsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
            const params = {
              service: 'WCS',
              version: '2.0.1',
              request: 'GetCoverage',
              coverageId: coverageId,
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
            
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ elevation: response.data }));
          } catch (error: any) {
            const status = error.response?.status || 500;
            const data = error.response?.data || error.message;
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ 
              error: 'Failed to fetch LiDAR data', 
              details: typeof data === 'object' ? JSON.stringify(data) : data 
            }));
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
