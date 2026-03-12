import axios from 'axios';

export default async function handler(req: any, res: any) {
  try {
    const wcsUrl = `https://srsp-ows.jncc.gov.uk/ows`;
    const params = new URLSearchParams();
    params.append('service', 'WCS');
    params.append('version', '2.0.1');
    params.append('request', 'GetCapabilities');

    const response = await axios.get(wcsUrl, { 
      params: params,
      timeout: 15000
    });
    
    res.setHeader('Content-Type', 'application/xml');
    res.status(200).send(response.data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch WCS capabilities' });
  }
}
