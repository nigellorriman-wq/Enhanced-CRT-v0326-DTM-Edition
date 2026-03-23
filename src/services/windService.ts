
export interface WindData {
  avgSpeedMph: number;
  avgDirectionDeg: number;
  avgGustMph: number;
}

/**
 * Service to fetch historical wind data from Open-Meteo.
 * Open-Meteo provides free access to historical weather data.
 */
export const fetchAverageWindData = async (lat: number, lng: number): Promise<WindData | null> => {
  try {
    // We fetch data for the last 3 full years to get a representative average
    // for the months of April to October.
    const years = [2022, 2023, 2024];
    let totalSpeed = 0;
    let totalGust = 0;
    let totalCount = 0;
    
    // For circular average of directions
    let sinSum = 0;
    let cosSum = 0;

    for (const year of years) {
      const start = `${year}-04-01`;
      const end = `${year}-10-31`;
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${start}&end_date=${end}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=GMT`;
      
      const response = await fetch(url);
      if (!response.ok) continue;
      
      const data = await response.json();
      const times = data.hourly?.time;
      const speeds = data.hourly?.wind_speed_10m;
      const directions = data.hourly?.wind_direction_10m;
      const gusts = data.hourly?.wind_gusts_10m;
      
      if (times && speeds && directions && gusts && speeds.length > 0) {
        for (let i = 0; i < times.length; i++) {
          // Filter for daytime hours (08:00 to 20:00)
          const hour = new Date(times[i]).getUTCHours();
          if (hour >= 8 && hour <= 20) {
            totalSpeed += speeds[i];
            totalGust += gusts[i];
            totalCount++;
            
            const rad = (directions[i] * Math.PI) / 180;
            sinSum += Math.sin(rad);
            cosSum += Math.cos(rad);
          }
        }
      }
    }
    
    if (totalCount === 0) return null;
    
    const avgKmH = totalSpeed / totalCount;
    const avgGustKmH = totalGust / totalCount;
    
    // Convert km/h to mph: 1 km/h = 0.621371 mph
    const avgMph = avgKmH * 0.621371;
    const avgGustMph = avgGustKmH * 0.621371;
    
    // Calculate circular mean direction
    let avgDirRad = Math.atan2(sinSum / totalCount, cosSum / totalCount);
    let avgDirDeg = (avgDirRad * 180) / Math.PI;
    if (avgDirDeg < 0) avgDirDeg += 360;
    
    return {
      avgSpeedMph: avgMph,
      avgDirectionDeg: avgDirDeg,
      avgGustMph: avgGustMph
    };
  } catch (error) {
    console.error('Error fetching wind data:', error);
    return null;
  }
};
