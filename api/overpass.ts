import axios from 'axios';

export default async function handler(req: any, res: any) {
  const { data } = req.query;
  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'Missing data query parameter' });
  }
  
  console.log(`[Proxy Overpass API] Querying Overpass API via POST`);
  try {
    const response = await axios.post("https://overpass-api.de/api/interpreter", 
      `data=${encodeURIComponent(data)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json, */*',
          'User-Agent': 'ScottishGolfRatingToolkit/3.0 (nigel.lorriman@gmail.com; compliant client)'
        },
        timeout: 45000
      }
    );
    res.status(200).json(response.data);
  } catch (error: any) {
    console.error(`[Proxy Overpass API] Error querying Overpass:`, error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch from Overpass API',
      details: error.message
    });
  }
}
