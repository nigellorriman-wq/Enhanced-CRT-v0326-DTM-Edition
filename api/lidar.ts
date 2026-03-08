import axios from 'axios';

export default async function handler(req: any, res: any) {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing lat/lng' });
  }

  try {
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
    
    // WCS GetCoverage with format=text/plain returns the value directly
    res.status(200).json({ elevation: response.data });
  } catch (error: any) {
    const status = error.response?.status || 500;
    const data = error.response?.data || error.message;
    res.status(status).json({ 
      error: 'Failed to fetch LiDAR data', 
      details: typeof data === 'object' ? JSON.stringify(data) : data 
    });
  }
}
