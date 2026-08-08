import axios from 'axios';

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
      console.warn(`[Proxy API] GeoServer returned XML exception: ${text.substring(0, 200)}`);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(502).send(text);
    }

    res.setHeader('Content-Type', contentType || 'image/tiff');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    res.status(200).send(Buffer.from(response.data));
  } catch (error: any) {
    console.warn(`[Proxy API] Failed to fetch remote GeoTIFF (${error.message})`);
    return res.status(502).json({ error: 'Failed to fetch GeoTIFF', details: error.message });
  }
}

