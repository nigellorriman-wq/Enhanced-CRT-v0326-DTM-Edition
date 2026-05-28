import axios from 'axios';

export default async function handler(req: any, res: any) {
  const { data } = req.query;
  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'Missing data query parameter' });
  }
  
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter"
  ];

  let lastError: any = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    console.log(`[Proxy Overpass API] Querying: ${endpoint}`);
    try {
      const response = await axios.post(endpoint, 
        `data=${encodeURIComponent(data)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json, */*',
            'User-Agent': 'ScottishGolfRatingToolkit/3.0 (nigel.lorriman@gmail.com; compliant client)'
          },
          timeout: 25000
        }
      );
      if (response.data) {
        return res.status(200).json(response.data);
      }
    } catch (error: any) {
      console.warn(`[Proxy Overpass API] Failed for ${endpoint}: ${error.message}`);
      lastError = error;
    }
  }

  console.error(`[Proxy Overpass API] All endpoints failed. Last error:`, lastError?.message);
  res.status(lastError?.response?.status || 500).json({
    error: 'Failed to fetch from Overpass API (all mirrors failed)',
    details: lastError?.message
  });
}
