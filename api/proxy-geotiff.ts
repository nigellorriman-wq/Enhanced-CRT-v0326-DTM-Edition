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

    res.setHeader('Content-Type', contentType || 'image/tiff');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    res.status(200).send(Buffer.from(response.data));
  } catch (error: any) {
    let status = 500;
    let details = error.message;
    
    if (error.response) {
      status = error.response.status;
      const contentType = error.response.headers['content-type'] || '';
      if (contentType.includes('xml') || contentType.includes('text')) {
        const text = Buffer.from(error.response.data).toString('utf8');
        
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
}
