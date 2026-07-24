import axios from 'axios';
import { generateFallbackGeoTIFF } from '../src/utils/geoTiffEncoder';

export default async function handler(req: any, res: any) {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing URL' });
  }

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'Accept': 'image/tiff, application/xml, text/xml, */*'
      }
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('xml') || contentType.includes('html')) {
      const text = Buffer.from(response.data).toString('utf8');
      console.warn(`[Proxy API] GeoServer returned XML exception, serving synthesized GeoTIFF tile: ${text.substring(0, 200)}`);
      
      const fallbackBuffer = generateFallbackGeoTIFF(url);
      res.setHeader('Content-Type', 'image/tiff');
      res.setHeader('Content-Length', fallbackBuffer.length);
      return res.status(200).send(fallbackBuffer);
    }

    res.setHeader('Content-Type', contentType || 'image/tiff');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    res.status(200).send(Buffer.from(response.data));
  } catch (error: any) {
    console.warn(`[Proxy API] Failed to fetch remote GeoTIFF (${error.message}), serving synthesized GeoTIFF tile`);
    const fallbackBuffer = generateFallbackGeoTIFF(url);
    res.setHeader('Content-Type', 'image/tiff');
    res.setHeader('Content-Length', fallbackBuffer.length);
    return res.status(200).send(fallbackBuffer);
  }
}

