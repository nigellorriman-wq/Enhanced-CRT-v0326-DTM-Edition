import axios from 'axios';

export const fetchLidarElevation = async (lat: number, lng: number): Promise<number | null> => {
  try {
    const response = await axios.get(`https://api.agrimetrics.co.uk/tiles/terrain/v1/elevation/${lat}/${lng}`, {
      params: {
        // Add any necessary params or headers if required by the actual API
      },
      timeout: 5000
    });
    return response.data.elevation;
  } catch (error) {
    // Fallback to a mock or alternative if agrimetrics is not available or requires key
    // For this app, we'll assume the environment provides a proxy or the API is open
    // If it fails, we return null and the app handles it
    console.error('LiDAR fetch failed:', error);
    return null;
  }
};
