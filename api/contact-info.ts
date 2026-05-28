import { GoogleGenAI, Type } from '@google/genai';
import proj4 from 'proj4';

// Define British National Grid (BNG) projection
proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs");

export default async function handler(req: any, res: any) {
  const { site_name, town, easting, northing } = req.query;
  if (!site_name) {
    return res.status(400).json({ error: 'Missing site_name parameter' });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      console.warn("[Contact Info API] GEMINI_API_KEY is not defined in process.env");
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    // Convert Easting & Northing to lat/lng using BNG
    let lat = 0;
    let lng = 0;
    if (easting && northing) {
      const eastingNum = Number(easting);
      const northingNum = Number(northing);
      if (!isNaN(eastingNum) && !isNaN(northingNum)) {
        const coords = proj4("EPSG:27700", "EPSG:4326", [eastingNum, northingNum]);
        lng = coords[0];
        lat = coords[1];
      }
    }

    console.log(`[Contact Info API] Fetching info for "${site_name}" in "${town}"`);
    const ai = new GoogleGenAI({ 
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
    
    const prompt = `Find the official contact information for the golf course: "${site_name}" located in "${town || ''}", Scotland (Approx. Coords: ${lat.toFixed(5)}, ${lng.toFixed(5)}).

STRICT LOCATION VERIFICATION:
1. Identify the exact club at the provided town and coordinates.
2. BEWARE: Avoid confusion with similarly named clubs (e.g., "Musselburgh Golf Club" vs "Royal Musselburgh Golf Club").
3. Verify the found course's postcode area matches the expected area for ${town || ''}.
4. If the closest match is in a different town or has a different postcode area than expected for ${town || ''}, do not confirm the match.

Return ONLY a JSON object with: website (full URL), phone, full_address, postcode, and verified_match (boolean).`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            website: { type: Type.STRING },
            phone: { type: Type.STRING },
            full_address: { type: Type.STRING },
            postcode: { type: Type.STRING },
            verified_match: { type: Type.BOOLEAN }
          },
          required: ["website", "phone", "full_address", "postcode", "verified_match"]
        },
        tools: [{ googleSearch: {} }]
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("Empty response from Gemini API");
    }

    const parsed = JSON.parse(responseText.trim());
    res.status(200).json(parsed);
  } catch (error: any) {
    console.error('[Contact Info API] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch contact info', details: error.message });
  }
}
