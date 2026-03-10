import proj4 from 'proj4';

// Define OSGB36 / British National Grid
proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs");

export const osgbToWgs84 = (easting: number, northing: number) => {
  const [lng, lat] = proj4("EPSG:27700", "EPSG:4326", [easting, northing]);
  return { lat, lng };
};
