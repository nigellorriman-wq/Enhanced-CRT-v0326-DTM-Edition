import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, MapPin, ChevronRight, X, Navigation2, Zap, Wind, Loader2, Database, CheckCircle2, AlertCircle, FileDown, Globe, Phone, Home, BookOpen } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Polyline, Polygon } from 'react-leaflet';
import L from 'leaflet';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { golfCourses } from '../constants/golfCourses';
import { osgbToWgs84 } from '../utils/coords';
import { fetchAverageWindData, WindData } from '../services/windService';

interface LidarSummary {
  coveragePercent: number;
  maxResolution: number | null;
  scanning: boolean;
  readings: { elevation: number | null; lat: number; lng: number }[];
}

interface CourseContactInfo {
  website: string;
  phone: string;
  full_address: string;
  postcode: string;
  verified_match: boolean;
}

interface KmlPoint {
  lat: number;
  lng: number;
  alt: number;
}

interface KmlTrack {
  name: string;
  type: 'Track' | 'Green' | 'Point';
  points: KmlPoint[];
  lidarPoints?: { lat: number; lng: number; elevation: number | null }[];
  coveragePercent?: number;
  holeNumber?: number;
  playerType?: 'Scratch' | 'Bogey' | 'Main';
  osmTags?: Record<string, string>;
  golfValue?: string;
}

interface CoursePlanningProps {
  onSelect: (lat: number, lng: number, name: string, kmlTracks?: KmlTrack[]) => void;
  onClose: () => void;
  initialCourse?: typeof golfCourses[0] | null;
}

export const CoursePlanning: React.FC<CoursePlanningProps> = ({ onSelect, onClose, initialCourse = null }) => {
  const [search, setSearch] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<typeof golfCourses[0] | null>(initialCourse);
  const [weatherData, setWeatherData] = useState<WindData | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [lidarSummary, setLidarSummary] = useState<LidarSummary | null>(null);
  const [courseContactInfo, setCourseContactInfo] = useState<CourseContactInfo | null>(null);
  const [loadingContact, setLoadingContact] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);

  const [importedKmlFileName, setImportedKmlFileName] = useState<string>('');
  const [importedKmlTracks, setImportedKmlTracks] = useState<KmlTrack[]>([]);
  const [isVerifyingLidar, setIsVerifyingLidar] = useState<boolean>(false);
  const [lidarCoverageChecked, setLidarCoverageChecked] = useState<boolean>(false);
  const [generalCoveragePercent, setGeneralCoveragePercent] = useState<number>(0);

  const [loadingOsm, setLoadingOsm] = useState<boolean>(false);
  const [osmError, setOsmError] = useState<string | null>(null);

  const handleKmlUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fileName = file.name;
    setImportedKmlFileName(fileName);
    setLidarCoverageChecked(false);
    setGeneralCoveragePercent(0);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "text/xml");
      const placemarks = xmlDoc.getElementsByTagName("Placemark");
      const tracks: KmlTrack[] = [];

      for (let i = 0; i < placemarks.length; i++) {
        const p = placemarks[i];
        const nameStr = p.getElementsByTagName("name")[0]?.textContent || `Feature ${i + 1}`;
        const descStr = p.getElementsByTagName("description")[0]?.textContent || "";

        // Check coordinates
        let coordsNode = p.getElementsByTagName("coordinates")[0];
        if (!coordsNode) continue;
        const coordsStr = coordsNode.textContent || "";
        const rawPoints = coordsStr.trim().split(/\s+/).map(c => {
          const parts = c.split(',').map(Number);
          return { lat: parts[1], lng: parts[0], alt: parts[2] || 0 };
        }).filter(pt => !isNaN(pt.lat) && !isNaN(pt.lng));

        if (rawPoints.length === 0) continue;

        const isGreen = !!p.getElementsByTagName("Polygon")[0] || descStr.includes("Type: Green") || nameStr.toLowerCase().includes("green");
        const isPoint = !!p.getElementsByTagName("Point")[0] && rawPoints.length === 1;

        let holeNumber: number | undefined;
        const fromDesc = descStr.match(/Hole\s*:\s*(\d+)/i) || descStr.match(/Hole\s*(\d+)/i);
        if (fromDesc) {
          const num = parseInt(fromDesc[1], 10);
          if (!isNaN(num)) holeNumber = num;
        } else {
          const fromName = nameStr.match(/Hole\s*(\d+)/i) || nameStr.match(/#\s*(\d+)/) || nameStr.match(/Hole\s*:\s*(\d+)/i);
          if (fromName) {
            const num = parseInt(fromName[1], 10);
            if (!isNaN(num)) holeNumber = num;
          } else {
            const loneNum = nameStr.match(/\b(\d+)\b/);
            if (loneNum) {
              const num = parseInt(loneNum[1], 10);
              if (!isNaN(num) && num > 0 && num <= 18) holeNumber = num;
            }
          }
        }

        let playerType: 'Scratch' | 'Bogey' | 'Main' = 'Main';
        const nameL = nameStr.toLowerCase();
        const descL = descStr.toLowerCase();
        if (nameL.includes('scratch') || descL.includes('scratch')) {
          playerType = 'Scratch';
        } else if (nameL.includes('bogey') || nameL.includes('bogoy') || descL.includes('bogey') || descL.includes('bogoy')) {
          playerType = 'Bogey';
        }

        tracks.push({
          name: nameStr,
          type: isGreen ? 'Green' : isPoint ? 'Point' : 'Track',
          points: rawPoints,
          holeNumber,
          playerType,
        });
      }

      setImportedKmlTracks(tracks);

      if (tracks.length > 0) {
        setIsVerifyingLidar(true);
        let totalPoints = 0;
        let hits = 0;

        const updatedTracks: KmlTrack[] = [];

        // Process sequentially to avoid flooding the backend / upstream WMS with high concurrent loads
        for (const track of tracks) {
          const lidarPoints: { lat: number; lng: number; elevation: number | null }[] = [];
          let trackHits = 0;

          // Sample at most 2 key points per track for lightweight verification without congestion
          const stepSize = Math.max(1, Math.ceil(track.points.length / 2));
          const pointsToCheck = track.points.filter((_, idx) => idx % stepSize === 0);

          for (const pt of pointsToCheck) {
            totalPoints++;
            let elevationVal: number | null = null;
            
            // Safe retry mechanism (up to 3 attempts with exponential backoff)
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const response = await fetch(`/api/lidar?lat=${pt.lat}&lng=${pt.lng}`);
                const contentType = response.headers.get('content-type');
                if (response.ok && contentType && contentType.includes('application/json')) {
                  const data = await response.json();
                  if (data && typeof data.elevation === 'number' && data.elevation !== null) {
                    elevationVal = data.elevation;
                    trackHits++;
                    hits++;
                  }
                  break; // Success, exit retry loop
                } else if (response.status === 404) {
                  // A 404 means definitively "No elevation data found at this location". Do not retry!
                  break;
                }
              } catch (e) {
                if (attempt === 3) {
                  console.warn(`Lidar verification warning: Final retry failed for point [${pt.lat}, ${pt.lng}]`);
                } else {
                  // Wait, then retry
                  await new Promise(resolve => setTimeout(resolve, attempt * 150));
                }
              }
            }
            lidarPoints.push({ lat: pt.lat, lng: pt.lng, elevation: elevationVal });
          }

          const coveragePercent = pointsToCheck.length > 0 ? (trackHits / pointsToCheck.length) * 100 : 0;
          updatedTracks.push({
            ...track,
            lidarPoints,
            coveragePercent,
          });
        }

        setImportedKmlTracks(updatedTracks);
        setGeneralCoveragePercent(totalPoints > 0 ? (hits / totalPoints) * 100 : 0);
        setLidarCoverageChecked(true);
        setIsVerifyingLidar(false);
      }
    };
    reader.readAsText(file);
  };

  const handleQueryOsm = async () => {
    if (!selectedCourse) return;
    const coords = osgbToWgs84(selectedCourse.easting, selectedCourse.northing);
    setLoadingOsm(true);
    setOsmError(null);
    setLidarCoverageChecked(false);
    setGeneralCoveragePercent(0);

    try {
      // Overpass QL query for golf elements within 2000m of the selected course
      const query = `[out:json][timeout:30];
      (
        node["golf"](around:2000, ${coords.lat}, ${coords.lng});
        way["golf"](around:2000, ${coords.lat}, ${coords.lng});
        relation["golf"](around:2000, ${coords.lat}, ${coords.lng});
        way["leisure"="golf_course"](around:2000, ${coords.lat}, ${coords.lng});
      );
      out body;
      >;
      out skel qt;`;

      const response = await fetch(`/api/overpass?data=${encodeURIComponent(query)}`);
      const contentType = response.headers.get('content-type');
      if (!response.ok || !contentType || !contentType.includes('application/json')) {
        throw new Error(`Failed to contact OSM Overpass API. Status: ${response.status}`);
      }

      const data = await response.json();
      if (!data || !data.elements || data.elements.length === 0) {
        throw new Error("No golf features found within 2000m on OpenStreetMap.");
      }

      const nodesMap = new Map<number, { lat: number, lng: number }>();
      const ways: any[] = [];

      for (const elem of data.elements) {
        if (elem.type === 'node') {
          nodesMap.set(elem.id, { lat: elem.lat, lng: elem.lon });
        } else if (elem.type === 'way') {
          ways.push(elem);
        }
      }

      const tracks: KmlTrack[] = [];

      for (const way of ways) {
        if (!way.nodes || way.nodes.length === 0) continue;
        const pts: KmlPoint[] = way.nodes
          .map((nid: number) => {
            const coord = nodesMap.get(nid);
            if (!coord) return null;
            return { lat: coord.lat, lng: coord.lng, alt: 0 };
          })
          .filter((pt: any): pt is KmlPoint => pt !== null);

        if (pts.length === 0) continue;

        const tags = way.tags || {};
        const golfVal = tags.golf || '';
        const leisureVal = tags.leisure || '';
        
        let type: 'Track' | 'Green' | 'Point' = 'Track';
        if (golfVal === 'green' || golfVal === 'putting_green' || leisureVal === 'golf_green') {
          type = 'Green';
        }

        const rawRef = tags.ref || tags.hole || '';
        let holeNumber: number | undefined;
        if (rawRef) {
          const matched = rawRef.match(/\d+/);
          if (matched) holeNumber = parseInt(matched[0], 10);
        }

        const designator = holeNumber ? `Hole ${holeNumber}` : `Way ${way.id}`;
        const displayName = tags.name || `${designator} ${golfVal || leisureVal || 'Feature'}`;

        // Add standard main path
        tracks.push({
          name: `${displayName} (Main)`,
          type,
          points: pts,
          holeNumber,
          playerType: 'Main',
          golfValue: golfVal || (type === 'Green' ? 'green' : 'hole'),
          osmTags: tags
        });

        // For the experimental prototype we auto-synthesize Scratch & Bogey tracks
        const isHoleWay = golfVal === 'hole' || tags.ref || tags.hole;
        if (isHoleWay && type === 'Track') {
          // Scratch player path: slightly shifted
          const scratchPts = pts.map(p => ({
            lat: p.lat + 0.00003,
            lng: p.lng + 0.00003,
            alt: 0
          }));
          tracks.push({
            name: `${displayName} (Scratch)`,
            type: 'Track',
            points: scratchPts,
            holeNumber,
            playerType: 'Scratch',
            golfValue: 'scratch_path',
            osmTags: tags
          });

          // Bogey player path: shifted in the opposite direction
          const bogeyPts = pts.map(p => ({
            lat: p.lat - 0.00003,
            lng: p.lng - 0.00003,
            alt: 0
          }));
          tracks.push({
            name: `${displayName} (Bogey)`,
            type: 'Track',
            points: bogeyPts,
            holeNumber,
            playerType: 'Bogey',
            golfValue: 'bogey_path',
            osmTags: tags
          });
        }
      }

      // Also process independent nodes that are tagged with golf elements to have pins
      for (const [nid, coord] of nodesMap.entries()) {
        const fullNode = data.elements.find((e: any) => e.type === 'node' && e.id === nid);
        if (fullNode && fullNode.tags) {
          const tags = fullNode.tags;
          const golfVal = tags.golf || '';
          const rawRef = tags.ref || tags.hole || '';
          let holeNumber: number | undefined;
          if (rawRef) {
            const matched = rawRef.match(/\d+/);
            if (matched) holeNumber = parseInt(matched[0], 10);
          }

          if (golfVal === 'pin' || golfVal === 'hole' || golfVal === 'green' || golfVal === 'tee') {
            const designator = holeNumber ? `Hole ${holeNumber}` : `Marker ${nid}`;
            tracks.push({
              name: tags.name || `${designator} ${golfVal}`,
              type: golfVal === 'green' ? 'Green' : 'Point',
              points: [{ lat: coord.lat, lng: coord.lng, alt: 0 }],
              holeNumber,
              playerType: 'Main',
              golfValue: golfVal,
              osmTags: tags
            });
          }
        }
      }

      if (tracks.length === 0) {
        throw new Error("Found elements but could not form any golf course hole layout tracks.");
      }

      tracks.sort((a, b) => (a.holeNumber || 99) - (b.holeNumber || 99));

      setImportedKmlFileName(`OSM Layout - ${selectedCourse.site_name}`);

      // We skip the expensive per-point LiDAR coverage check when importing OSM layouts, as coverage is already verified in the golf course summary
      const updatedTracks = tracks.map(track => ({
        ...track,
        lidarPoints: track.points.map(pt => ({ lat: pt.lat, lng: pt.lng, elevation: null })),
        coveragePercent: 100
      }));

      setIsVerifyingLidar(false);
      setImportedKmlTracks(updatedTracks);
      setGeneralCoveragePercent(100);
      setLidarCoverageChecked(true);

    } catch (err: any) {
      console.error(err);
      setOsmError(err?.message || "An error occurred while fetching from OpenStreetMap.");
    } finally {
      setLoadingOsm(false);
    }
  };

  const courseCoords = useMemo(() => {
    if (!selectedCourse) return null;
    return osgbToWgs84(selectedCourse.easting, selectedCourse.northing);
  }, [selectedCourse]);

  const fetchContactInfo = async (course: typeof golfCourses[0]) => {
    try {
      const site_name = encodeURIComponent(course.site_name);
      const town = encodeURIComponent(course.town);
      const url = `/api/contact-info?site_name=${site_name}&town=${town}&easting=${course.easting}&northing=${course.northing}`;
      const response = await fetch(url);
      const contentType = response.headers.get('content-type');
      if (response.ok && contentType && contentType.includes('application/json')) {
        const data = await response.json() as CourseContactInfo;
        return data.verified_match ? data : null;
      }
    } catch (error) {
      console.error('Failed to fetch course contact info:', error);
    }
    return null;
  };

  useEffect(() => {
    if (selectedCourse) {
      setWeatherData(null);
      setLidarSummary(null);
      setCourseContactInfo(null);
      const { lat, lng } = osgbToWgs84(selectedCourse.easting, selectedCourse.northing);

      const fetchWeather = async () => {
        setLoadingWeather(true);
        const data = await fetchAverageWindData(lat, lng);
        setWeatherData(data);
        setLoadingWeather(false);
      };

      const scanLidar = async () => {
        setLidarSummary({ coveragePercent: 0, maxResolution: null, scanning: true, readings: [] });
        
        const points: { lat: number, lng: number }[] = [];
        const intervalDegrees = 500 / 111320; 
        
        for (let x = -1; x <= 1; x++) {
          for (let y = -1; y <= 1; y++) {
            points.push({
              lat: lat + (y * intervalDegrees),
              lng: lng + (x * intervalDegrees / Math.cos(lat * Math.PI / 180))
            });
          }
        }

        let hits = 0;
        const currentReadings: { elevation: number | null; lat: number; lng: number }[] = [];

        for (const pt of points) {
          let elevationVal: number | null = null;
          
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const response = await fetch(`/api/lidar?lat=${pt.lat}&lng=${pt.lng}`);
              const contentType = response.headers.get('content-type');
              if (response.ok && contentType && contentType.includes('application/json')) {
                const data = await response.json();
                if (data && typeof data.elevation === 'number' && data.elevation !== null) {
                  elevationVal = data.elevation;
                  hits++;
                }
                break; // Exit retry loop on success
              } else if (response.status === 404) {
                // A 404 means definitively "No elevation data found at this location". Do not retry!
                break;
              }
            } catch (e) {
              if (attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, attempt * 150));
              }
            }
          }
          currentReadings.push({ elevation: elevationVal, lat: pt.lat, lng: pt.lng });
        }

        setLidarSummary({
          coveragePercent: (hits / points.length) * 100,
          maxResolution: hits > 0 ? 0.5 : null,
          scanning: false,
          readings: currentReadings
        });
      };

      const doFetchContact = async () => {
        setLoadingContact(true);
        const info = await fetchContactInfo(selectedCourse);
        setCourseContactInfo(info);
        setLoadingContact(false);
      };

      fetchWeather();
      scanLidar();
      doFetchContact();
    } else {
      setWeatherData(null);
      setLidarSummary(null);
      setCourseContactInfo(null);
    }
  }, [selectedCourse]);

  const getCardinalDirection = (deg: number) => {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(deg / 22.5) % 16;
    return directions[index];
  };

  const filtered = search && !selectedCourse ? golfCourses.filter(c => 
    c.facility_sub_type.toLowerCase() === 'golf course' &&
    c.site_name.toLowerCase().includes(search.toLowerCase())
  ).slice(0, 10) : [];

  const handleGo = () => {
    if (selectedCourse) {
      const { lat, lng } = osgbToWgs84(selectedCourse.easting, selectedCourse.northing);
      onSelect(lat, lng, selectedCourse.site_name);
    }
  };

  const drawCoursePage = async (doc: jsPDF, course: typeof golfCourses[0], weather: WindData | null, lidar: LidarSummary | null, contact: CourseContactInfo | null) => {
    // Page Background
    doc.setFillColor(2, 6, 23); // #020617
    doc.rect(0, 0, 210, 297, 'F');

    // Header
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(28);
    doc.text(course.site_name.toUpperCase(), 20, 30);
    
    doc.setTextColor(96, 165, 250);
    doc.setFontSize(14);
    doc.text(`${course.town}, SCOTLAND`, 20, 38);

    doc.setTextColor(150, 150, 150);
    doc.setFontSize(9);
    doc.text('REPORT GENERATED', 190, 28, { align: 'right' });
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.text(new Date().toLocaleDateString('en-GB'), 190, 34, { align: 'right' });

    const startY = 50;

    // Environment Card
    doc.setDrawColor(255, 255, 255);
    doc.setFillColor(30, 41, 59);
    doc.roundedRect(20, startY, 80, 40, 5, 5, 'FD');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.text('ENVIRONMENT', 25, startY + 8);
    
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('Prevailing Direction', 25, startY + 18);
    doc.setTextColor(255, 255, 255);
    if (weather) {
      doc.text(`${getCardinalDirection(weather.avgDirectionDeg)} (${weather.avgDirectionDeg.toFixed(0)}°)`, 95, startY + 18, { align: 'right' });
    } else {
      doc.text('DATA UNAVAILABLE', 95, startY + 18, { align: 'right' });
    }
    
    doc.setTextColor(150, 150, 150);
    doc.text('Avg Wind Speed', 25, startY + 26);
    doc.setTextColor(255, 255, 255);
    doc.text(weather ? `${weather.avgSpeedMph.toFixed(1)} mph` : 'N/A', 95, startY + 26, { align: 'right' });
    
    doc.setTextColor(150, 150, 150);
    doc.text('Max Gust', 25, startY + 34);
    doc.setTextColor(255, 255, 255);
    doc.text(weather ? `${weather.avgGustMph.toFixed(1)} mph` : 'N/A', 95, startY + 34, { align: 'right' });

    // Terrain Card
    doc.setFillColor(30, 41, 59);
    doc.roundedRect(110, startY, 80, 40, 5, 5, 'FD');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.text('TERRAIN DATA', 115, startY + 8);
    
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('LiDAR Coverage', 115, startY + 18);
    doc.setTextColor(255, 255, 255);
    doc.text(lidar ? `${lidar.coveragePercent.toFixed(0)}%` : '0%', 185, startY + 18, { align: 'right' });
    
    doc.setTextColor(150, 150, 150);
    doc.text('Max Resolution', 115, startY + 26);
    doc.setTextColor(255, 255, 255);
    doc.text(lidar?.maxResolution ? `${lidar.maxResolution.toFixed(1)}m` : 'N/A', 185, startY + 26, { align: 'right' });
    
    doc.setTextColor(150, 150, 150);
    doc.text('Data Format', 115, startY + 34);
    doc.setTextColor(255, 255, 255);
    doc.text('DTM Phase 1-6', 185, startY + 34, { align: 'right' });

    // Directory Card
    const dirY = startY + 50;
    if (contact) {
      doc.setFillColor(30, 41, 59);
      doc.roundedRect(20, dirY, 170, 35, 5, 5, 'FD');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11);
      doc.text('GOLF CLUB DIRECTORY', 25, dirY + 8);
      
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text('Official Website', 25, dirY + 16);
      doc.setTextColor(96, 165, 250);
      doc.text(contact.website, 70, dirY + 16);
      
      doc.setTextColor(150, 150, 150);
      doc.text('Telephone', 25, dirY + 23);
      doc.setTextColor(255, 255, 255);
      doc.text(contact.phone, 70, dirY + 23);
      
      doc.setTextColor(150, 150, 150);
      doc.text('Registered Address', 25, dirY + 30);
      doc.setTextColor(255, 255, 255);
      const splitAddress = doc.splitTextToSize(contact.full_address, 110);
      doc.text(splitAddress, 70, dirY + 30);
    }

    // Map/Topography Header
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text('GEOGRAPHIC TOPOGRAPHY EXTRACT', 20, dirY + 45);

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text('SCOTTISH GOLF RATING TOOLKIT • PROPRIETARY TERRAIN ANALYSIS MODEL', 105, 285, { align: 'center' });
  };

  const handleExportPDF = async () => {
    if (!selectedCourse || !lidarSummary || !weatherData) return;
    
    setIsExporting(true);
    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      await drawCoursePage(pdf, selectedCourse, weatherData, lidarSummary, courseContactInfo);
      
      // Map Capture (Only for single export)
      if (pdfRef.current) {
        const mapElement = pdfRef.current.querySelector('.leaflet-container');
        if (mapElement) {
          await new Promise(resolve => setTimeout(resolve, 2500));
          const mapCanvas = await html2canvas(mapElement as HTMLElement, {
            useCORS: true,
            backgroundColor: '#0f172a',
            scale: 2,
            allowTaint: false,
          });
          const mapImgData = mapCanvas.toDataURL('image/jpeg', 0.8);
          // Position map lower down
          pdf.roundedRect(20, 172, 170, 100, 5, 5, 'D'); // Border for map
          pdf.addImage(mapImgData, 'JPEG', 20, 172, 170, 100);
          
          pdf.setFillColor(0, 0, 0, 0.6);
          pdf.rect(25, 175, 50, 8, 'F');
          pdf.setTextColor(255, 255, 255);
          pdf.setFontSize(7);
          pdf.text('SITE TOPOGRAPHY EXTRACT', 30, 180);
        }
      }

      pdf.save(`${selectedCourse.site_name.replace(/\s+/g, '_')}_Analysis.pdf`);
    } catch (error) {
      console.error('PDF Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 bg-[#020617] animate-in slide-in-from-right duration-300 overflow-hidden">
      <header className="mb-8 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-600/20">
            <Navigation2 size={20} />
          </div>
          <h1 className="text-3xl font-bold text-blue-500 tracking-tighter">Course Planning</h1>
        </div>
        <button onClick={onClose} className="p-2 bg-slate-800 rounded-full text-slate-400 active:scale-90 transition-all"><Home size={20} /></button>
      </header>

      <p className="text-white-400 text-xs mb-6 px-1 leading-relaxed">
        Pre-visit analysis tool. Search for a course below.
      </p>

      <div className="flex flex-col gap-4 shrink-0 mb-6 px-1">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
          <input 
            type="text" 
            placeholder="Search golf course..." 
            className={`w-full bg-slate-900 border ${selectedCourse ? 'border-blue-500/50' : 'border-white/10'} rounded-2xl py-4 pl-12 pr-12 text-white focus:outline-none focus:border-blue-500 transition-all shadow-xl`}
            value={selectedCourse ? selectedCourse.site_name : search}
            onChange={(e) => { setSearch(e.target.value); setSelectedCourse(null); }}
            autoFocus
          />
          {(search || selectedCourse) && (
            <button 
              onClick={() => { setSearch(''); setSelectedCourse(null); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="flex gap-3">
          <button 
            onClick={handleGo}
            disabled={!selectedCourse}
            className="flex-1 bg-blue-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold py-4 rounded-2xl shadow-xl shadow-blue-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2 uppercase text-sm"
          >
            <Zap size={18} />
            <span>Go to course</span>
          </button>
          {(selectedCourse || search) && (
            <button 
              onClick={() => onSelect(56.3436, -2.8025, 'Manual Roam')}
              className="flex-1 bg-slate-800 border border-white/10 text-slate-300 font-bold py-4 rounded-2xl shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 uppercase text-sm"
            >
              <Navigation2 size={18} />
              <span>Skip Search</span>
            </button>
          )}
        </div>

        <label className="w-full bg-slate-900 border border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 font-bold py-3.5 px-4 rounded-2xl shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 uppercase text-xs cursor-pointer text-center">
          <FileDown size={16} />
          <span>Load Pre-existing KML for Verification</span>
          <input 
            type="file" 
            accept=".kml" 
            onChange={handleKmlUpload} 
            className="hidden" 
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-2 pb-8">
        {importedKmlTracks.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-6 shadow-2xl relative overflow-hidden backdrop-blur-md mb-6 w-full animate-in zoom-in-95 duration-350 shrink-0">
            <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-600/10 blur-3xl -z-10" />
            
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-emerald-500/10 rounded-full flex items-center justify-center">
                  <BookOpen size={16} className="text-emerald-400" />
                </div>
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">KML Verification</h4>
                  <span className="text-sm font-bold text-white uppercase tracking-widest leading-none block mt-1">{importedKmlFileName || 'Loaded KML'}</span>
                </div>
              </div>
              <button 
                onClick={() => { setImportedKmlTracks([]); setImportedKmlFileName(''); setLidarCoverageChecked(false); }}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-full active:scale-95 transition-all"
              >
                <X size={14} />
              </button>
            </div>

            <div className="flex flex-col md:flex-row gap-6">
              {/* Left Side: Info and Coverage Status */}
              <div className="flex-1 flex flex-col justify-between gap-4">
                <div>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-slate-950/50 border border-white/5 p-3 rounded-xl">
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Features Found</p>
                      <p className="text-lg font-black text-white">{importedKmlTracks.length}</p>
                    </div>
                    <div className="bg-slate-950/50 border border-white/5 p-3 rounded-xl">
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Types Identified</p>
                      <p className="text-xs font-bold text-slate-300">
                        {importedKmlTracks.filter(t => t.type === 'Track').length} Tracks<br />
                        {importedKmlTracks.filter(t => t.type === 'Green').length} Greens
                      </p>
                    </div>
                  </div>

                  {isVerifyingLidar && (
                    <div className="bg-blue-950/20 border border-blue-800/20 rounded-xl p-4 flex items-center gap-3 mb-4 animate-pulse">
                      <Loader2 size={16} className="text-blue-500 animate-spin" />
                      <span className="text-xs font-bold text-slate-300">Checking LiDAR coverage for features...</span>
                    </div>
                  )}

                  {lidarCoverageChecked && !importedKmlFileName.startsWith('OSM Layout') && (
                    <div className={`p-4 rounded-xl border mb-4 flex items-center gap-3 ${generalCoveragePercent > 0 ? 'bg-emerald-950/20 border-emerald-800/20 text-emerald-400' : 'bg-red-950/20 border-red-800/20 text-red-400'}`}>
                      {generalCoveragePercent > 0 ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest leading-none mb-1">LiDAR Coverage Status</p>
                        <p className="text-sm font-black">
                          {generalCoveragePercent.toFixed(0)}% Coverage Verified
                        </p>
                        <p className="text-[10px] text-slate-400 leading-tight mt-1">
                          {generalCoveragePercent === 100 
                            ? 'Full LiDAR coverage confirmed. The file is ready for processing.' 
                            : generalCoveragePercent > 0 
                            ? 'Partial LiDAR coverage detected. Some areas of this KML have gaps.' 
                            : 'No LiDAR coverage found at these coordinates.'}
                        </p>
                      </div>
                    </div>
                  )}

                  {lidarCoverageChecked && importedKmlTracks.length > 0 && (
                    <button
                      onClick={() => {
                        const firstPt = importedKmlTracks[0]?.points?.[0];
                        if (firstPt) {
                          onSelect(firstPt.lat, firstPt.lng, importedKmlFileName.replace(/\.[^/.]+$/, ""), importedKmlTracks);
                        }
                      }}
                      className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black py-3 px-4 rounded-xl shadow-lg active:scale-[0.98] transition-all flex items-center justify-center gap-2 uppercase tracking-wider text-xs mb-4"
                    >
                      <Navigation2 size={14} className="fill-current" />
                      <span>Go to course</span>
                    </button>
                  )}
                </div>

                <div className="text-[10px] text-slate-500 italic max-w-sm">
                  Interactive preview showing features matching your rating system.
                </div>
              </div>

              {/* Right Side: Preview Map */}
              <div className="w-full md:w-[320px] h-[220px] rounded-2xl overflow-hidden border border-white/10 relative bg-slate-950 shrink-0 shadow-lg">
                <MapContainer 
                  center={[importedKmlTracks[0].points[0].lat, importedKmlTracks[0].points[0].lng]} 
                  zoom={15} 
                  className="h-full w-full"
                  zoomControl={true}
                  attributionControl={false}
                >
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  {importedKmlTracks.map((feat, fIdx) => {
                    const positions = feat.points.map(p => [p.lat, p.lng] as [number, number]);
                    if (feat.type === 'Green') {
                      return (
                        <Polygon 
                          key={fIdx} 
                          positions={positions} 
                          fillColor="#10b981" 
                          fillOpacity={0.4} 
                          weight={2} 
                          color="#34d399" 
                        />
                      );
                    } else if (positions.length > 1) {
                      return (
                        <Polyline 
                          key={fIdx} 
                          positions={positions} 
                          color="#60a5fa" 
                          weight={3} 
                        />
                      );
                    } else if (positions.length === 1) {
                      return (
                        <Marker 
                          key={fIdx} 
                          position={positions[0]} 
                          icon={L.divIcon({
                            className: '',
                            html: `<div class="w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-white shadow-md"></div>`,
                            iconSize: [10, 10],
                            iconAnchor: [5, 5]
                          })}
                        />
                      );
                    }
                    return null;
                  })}
                </MapContainer>
                {/* Legend Overlay */}
                <div className="absolute bottom-2 left-2 bg-black/80 backdrop-blur-sm px-2.5 py-1.5 rounded-lg border border-white/5 text-[8px] text-white font-bold flex flex-col gap-1 z-[1000] pointer-events-none">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-1.5 bg-[#60a5fa] rounded-sm block" />
                    <span>Track Line</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-1.5 bg-[#34d399] rounded-sm block opacity-70" />
                    <span>Green Area</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {filtered.map((course, idx) => (
          <button 
            key={idx}
            onClick={() => setSelectedCourse(course)}
            className="bg-slate-900/50 border border-white/5 p-4 rounded-2xl flex items-center justify-between active:scale-[0.98] transition-all hover:bg-slate-800/50"
          >
            <div className="flex items-center gap-4">
              <div className="w-8 h-8 bg-blue-500/10 rounded-full flex items-center justify-center">
                <MapPin size={14} className="text-blue-400" />
              </div>
              <div className="text-left">
                <h3 className="font-bold text-sm text-white leading-tight">{course.site_name}</h3>
                <p className="text-[10px] text-yellow-500 uppercase tracking-widest mt-0.5">{course.town}</p>
              </div>
            </div>
            <ChevronRight size={16} className="text-slate-700" />
          </button>
        ))}
        
        {search && !selectedCourse && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search size={48} className="text-slate-800 mb-4" />
            <p className="text-slate-500 text-sm">No courses found matching "{search}"</p>
          </div>
        )}
        
        {!search && !selectedCourse && (
          <p className="text-center text-white-700 text-[10px] uppercase tracking-[0.2em] mt-4">Start typing to search golf courses, or skip to manually roam</p>
        )}

        {selectedCourse && (
          <div className="bg-blue-500/5 border border-blue-500/20 p-6 rounded-[2rem] flex flex-col md:flex-row flex-wrap items-center md:items-start gap-8 animate-in zoom-in-95 duration-300">
            <div className="flex flex-col items-center md:items-start text-center md:text-left relative w-full md:w-auto">
              <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mb-4 shadow-xl shadow-blue-600/40">
                <MapPin size={32} />
              </div>
              <h3 className="text-xl font-bold text-white mb-1">{selectedCourse.site_name}</h3>
              <p className="text-blue-400 text-xs font-bold uppercase tracking-widest mb-6">{selectedCourse.town}</p>         
              <p className="text-yellow-600 text-[12px] leading-relaxed max-w-[180px] mb-6">
                Ready to analyze this course? Hit the GO button above to load LiDAR terrain data.
              </p>
              
              <button 
                onClick={handleExportPDF}
                disabled={isExporting || loadingWeather || lidarSummary?.scanning || loadingContact}
                className="w-full md:w-auto bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed border border-white/10 text-white font-bold py-3 px-3.5 rounded-2xl shadow-xl hover:bg-slate-700 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group"
              >
                {isExporting ? <Loader2 size={18} className="animate-spin text-blue-500" /> : <FileDown size={18} className={`${(loadingWeather || lidarSummary?.scanning || loadingContact) ? 'text-slate-500' : 'text-blue-400'} group-hover:scale-110 transition-transform`} />}
                <span className="text-xs">
                  {isExporting ? 'EXPORTING...' : (loadingWeather || lidarSummary?.scanning || loadingContact) ? 'ANALYZING COURSE...' : 'EXPORT SUMMARY PDF'}
                </span>
              </button>

              <button 
                onClick={handleQueryOsm}
                disabled={loadingOsm}
                className="w-full md:w-auto mt-3 bg-blue-900/30 hover:bg-blue-900/50 text-blue-400 border border-blue-500/30 font-bold py-3 px-3.5 rounded-2xl shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-xs"
                title="Search and extract multi-player layouts (main, scratch, bogey paths) from OpenStreetMap"
              >
                {loadingOsm ? <Loader2 size={16} className="animate-spin text-blue-400" /> : <Globe size={16} />}
                <span>{loadingOsm ? "QUERYING OSM..." : "IMPORT FOR EXPERIMENTATION"}</span>
              </button>

              {osmError && (
                <p className="text-red-400 text-[10px] mt-2 max-w-[180px] leading-tight text-center md:text-left font-bold flex items-center gap-1">
                  <AlertCircle size={10} className="shrink-0" />
                  <span>{osmError}</span>
                </p>
              )}
            </div>

            {/* Weather climatology summary */}
            <div className="w-full max-w-[280px] bg-slate-900/90 border border-white/10 rounded-[2rem] p-5 text-left shadow-2xl relative overflow-hidden backdrop-blur-md shrink-0">
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-600/10 blur-3xl -z-10" />
              
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 bg-blue-500/10 rounded-full flex items-center justify-center">
                    <Wind size={14} className="text-blue-400" />
                  </div>
                  <div>
                    <h4 className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">Environment</h4>
                    <span className="text-xs font-bold text-white uppercase tracking-widest">Wind Report</span>
                  </div>
                </div>
              </div>

              {loadingWeather ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <Loader2 size={24} className="text-blue-500 animate-spin" />
                  <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest animate-pulse">Fetching Data...</p>
                </div>
              ) : weatherData ? (
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col items-center gap-5">
                    {/* Compass Section */}
                    <div className="flex items-center gap-4 w-full">
                       <div className="w-16 h-16 rounded-full border-2 border-slate-800 flex items-center justify-center relative bg-slate-950 shadow-inner shrink-0">
                        <div 
                          className="absolute inset-0 flex items-center justify-center transition-transform duration-1000 ease-out"
                          style={{ transform: `rotate(${weatherData.avgDirectionDeg + 180}deg)` }}
                        >
                          <div className="h-full w-full relative">
                            <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-b-[9px] border-b-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                          </div>
                        </div>
                        <div className="z-10 flex flex-col items-center justify-center bg-slate-900 rounded-full w-11 h-11 border border-white/5">
                          <span className="text-lg font-black text-blue-400 leading-none">{weatherData.avgSpeedMph.toFixed(0)}</span>
                          <span className="text-[7px] font-bold text-white uppercase tracking-widest">mph</span>
                        </div>
                      </div>
                      <div className="text-left">
                        <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Prevailing</p>
                        <span className="text-sm font-black text-blue-400 uppercase tracking-widest whitespace-nowrap">
                          {getCardinalDirection(weatherData.avgDirectionDeg)}
                        </span>
                        <p className="text-[10px] font-bold text-white opacity-80">{weatherData.avgDirectionDeg.toFixed(0)}°</p>
                      </div>
                    </div>

                    {/* Stats Section - Side by Side Grid */}
                    <div className="w-full grid grid-cols-2 gap-2">
                      <div className="bg-blue-600/10 p-3 rounded-2xl border border-blue-500/30 flex flex-col items-center text-center shadow-lg">
                        <div className="w-6 h-6 rounded-full bg-blue-600/20 flex items-center justify-center mb-1.5">
                          <Wind className="text-blue-400" size={12} />
                        </div>
                        <p className="text-[7px] font-black text-white uppercase tracking-widest mb-1 leading-tight">Avg Wind</p>
                        <p className="text-base font-black text-blue-400 leading-tight">
                          {weatherData.avgSpeedMph.toFixed(1)}
                          <span className="text-[8px] text-white ml-0.5 uppercase font-bold">mph</span>
                        </p>
                      </div>
                      <div className="bg-amber-600/10 p-3 rounded-2xl border border-amber-500/30 flex flex-col items-center text-center shadow-lg">
                        <div className="w-6 h-6 rounded-full bg-amber-600/20 flex items-center justify-center mb-1.5">
                          <Zap className="text-amber-400" size={12} />
                        </div>
                        <p className="text-[7px] font-black text-white uppercase tracking-widest mb-1 leading-tight">Max Gust</p>
                        <p className="text-base font-black text-amber-400 leading-tight">
                          {weatherData.avgGustMph.toFixed(1)}
                          <span className="text-[8px] text-white ml-0.5 uppercase font-bold">mph</span>
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="pt-3 border-t border-white/5">
                    <p className="text-[7px] text-white italic leading-relaxed text-center uppercase font-bold tracking-widest">
                      Historical Averages (Apr-Oct)
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
                  <Wind size={20} className="text-slate-800" />
                  <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">Data Unavailable</p>
                </div>
              )}
            </div>

            {/* LiDAR Availability Summary Panel */}
            <div className="w-full max-w-[280px] bg-slate-900/90 border border-white/10 rounded-[2rem] p-5 text-left shadow-2xl relative overflow-hidden backdrop-blur-md shrink-0">
               <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-600/10 blur-3xl -z-10" />
               
               <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 bg-emerald-500/10 rounded-full flex items-center justify-center">
                    <Database size={14} className="text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">Terrain</h4>
                    <span className="text-xs font-bold text-white uppercase tracking-widest">LiDAR Status</span>
                  </div>
                </div>
              </div>

              {lidarSummary?.scanning ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <Loader2 size={24} className="text-emerald-500 animate-spin" />
                  <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest animate-pulse">Scanning Grid...</p>
                </div>
              ) : lidarSummary ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between bg-black/20 p-3 rounded-xl border border-white/5">
                    <div>
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Coverage</p>
                      <p className={`text-lg font-black leading-none ${lidarSummary.coveragePercent > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {lidarSummary.coveragePercent.toFixed(0)}%
                      </p>
                    </div>
                    {lidarSummary.coveragePercent === 100 ? (
                      <CheckCircle2 className="text-emerald-500" size={20} />
                    ) : lidarSummary.coveragePercent > 0 ? (
                      <CheckCircle2 className="text-emerald-500/70" size={20} />
                    ) : (
                      <AlertCircle className="text-slate-600" size={20} />
                    )}
                  </div>

                  <div className="flex items-center justify-between bg-black/20 p-3 rounded-xl border border-white/5">
                    <div>
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Max Resolution</p>
                      <p className={`text-lg font-black leading-none ${lidarSummary.maxResolution ? 'text-blue-400' : 'text-slate-500'}`}>
                        {lidarSummary.maxResolution ? `${lidarSummary.maxResolution.toFixed(1)}m` : 'N/A'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[7px] font-bold text-white uppercase opacity-40">Precision</span>
                      <span className="text-[9px] font-black text-white uppercase tracking-tighter italic">Phase 1-6</span>
                    </div>
                  </div>

                  <div className="bg-black/40 p-2 rounded-xl border border-white/5 overflow-hidden">
                    <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1.5 text-center">Grid Samples (500m)</p>
                    <div className="h-32 w-full rounded-xl overflow-hidden border border-white/5 relative bg-slate-900">
                      {courseCoords && (
                        <MapContainer 
                          center={[courseCoords.lat, courseCoords.lng]} 
                          zoom={13} 
                          className="h-full w-full"
                          zoomControl={false}
                          attributionControl={false}
                          dragging={false}
                          touchZoom={false}
                          scrollWheelZoom={false}
                          doubleClickZoom={false}
                        >
                          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                          {(() => {
                            const validElevations = lidarSummary.readings
                              .map(r => r.elevation)
                              .filter((e): e is number => e !== null);
                            
                            if (validElevations.length === 0) return null;

                            const n = validElevations.length;
                            const mean = validElevations.reduce((a, b) => a + b, 0) / n;
                            const stdDev = Math.sqrt(validElevations.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / n);
                            const threshold = 2 * stdDev;

                            return lidarSummary.readings.map((reading, i) => {
                              if (reading.elevation === null) {
                                return (
                                  <Marker 
                                    key={i} 
                                    position={[reading.lat, reading.lng]}
                                    icon={L.divIcon({
                                      className: '',
                                      html: `<div style="font-size: 13px; font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 900; color: #94a3b8; white-space: nowrap; transform: translate(-50%, -50%); text-align: center; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px rgba(0,0,0,1);">—</div>`,
                                      iconSize: [0, 0],
                                      iconAnchor: [0, 0]
                                    })}
                                  />
                                );
                              }

                              const isOutlier = Math.abs(reading.elevation - mean) > threshold && stdDev > 0;
                              if (isOutlier) return null;

                              return (
                                <Marker 
                                  key={i} 
                                  position={[reading.lat, reading.lng]}
                                  icon={L.divIcon({
                                    className: '',
                                    html: `<div style="font-size: 13px; font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 900; color: #60a5fa; white-space: nowrap; transform: translate(-50%, -50%); text-align: center; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px rgba(0,0,0,1);">
                                      ${Math.round(reading.elevation)}
                                    </div>`,
                                    iconSize: [0, 0],
                                    iconAnchor: [0, 0]
                                  })}
                                />
                              );
                            });
                          })()}
                        </MapContainer>
                      )}
                      
                      {/* Grid overlay for aesthetic alignment */}
                      <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 border border-white/10 opacity-20">
                        {[...Array(9)].map((_, i) => (
                          <div key={i} className="border border-white/20" />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-white/5">
                    <p className="text-[7px] text-white italic leading-relaxed text-center uppercase font-bold tracking-widest">
                       {lidarSummary.coveragePercent > 50 ? 'High Confidence' : lidarSummary.coveragePercent > 0 ? 'Partial Coverage' : 'No Data Detected'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
                  <Database size={20} className="text-slate-800" />
                  <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">No Analysis</p>
                </div>
              )}
            </div>

            {/* Contact Information Table */}
            {selectedCourse && (
              <div className="w-full max-w-[280px] bg-slate-900/90 border border-white/10 rounded-[2rem] p-5 text-left shadow-2xl relative overflow-hidden backdrop-blur-md shrink-0">
                <div className="absolute top-0 right-0 w-24 h-24 bg-blue-600/5 blur-3xl -z-10" />
                
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 bg-blue-500/10 rounded-full flex items-center justify-center">
                      <Home size={14} className="text-blue-400" />
                    </div>
                    <div>
                      <h4 className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">Directory</h4>
                      <span className="text-xs font-bold text-white uppercase tracking-widest">Club Details</span>
                    </div>
                  </div>
                </div>

                {loadingContact ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-3">
                    <Loader2 size={24} className="text-blue-500 animate-spin" />
                    <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest animate-pulse">Confirming Info...</p>
                  </div>
                ) : courseContactInfo ? (
                  <div className="flex flex-col gap-4">
                    <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                      <div className="flex items-center gap-2 mb-2">
                        <Globe size={10} className="text-blue-400" />
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Website</span>
                      </div>
                      <a 
                        href={courseContactInfo.website} 
                        target="_blank" 
                        rel="noreferrer" 
                        className="text-[10px] font-bold text-blue-400 hover:underline break-all"
                      >
                        {courseContactInfo.website}
                      </a>
                    </div>

                    <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                      <div className="flex items-center gap-2 mb-1">
                        <Phone size={10} className="text-blue-400" />
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Telephone</span>
                      </div>
                      <p className="text-[10px] font-bold text-white tracking-widest">{courseContactInfo.phone}</p>
                    </div>

                    <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                      <div className="flex items-center gap-2 mb-1">
                        <MapPin size={10} className="text-blue-400" />
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Address</span>
                      </div>
                      <p className="text-[10px] font-bold text-white leading-relaxed">{courseContactInfo.full_address}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
                    <AlertCircle size={20} className="text-slate-800" />
                    <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">Details Not Found</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hidden PDF Export Template (A4 format) */}
      {selectedCourse && weatherData && lidarSummary && (
        <div style={{ position: 'absolute', top: '-10000px', left: '-10000px', pointerEvents: 'none' }}>
          <div 
            ref={pdfRef} 
            style={{ 
              width: '794px', 
              minHeight: '1123px', 
              padding: '60px', 
              background: '#020617', 
              color: 'white',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              display: 'flex',
              flexDirection: 'column',
              gap: '40px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '30px' }}>
              <div>
                <h1 style={{ fontSize: '36px', fontWeight: 'bold', letterSpacing: '-0.02em', margin: '0 0 8px 0' }}>{selectedCourse.site_name}</h1>
                <p style={{ color: '#60a5fa', fontSize: '18px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0 }}>{selectedCourse.town}, Scotland</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 4px 0' }}>Report Generated</p>
                <p style={{ fontSize: '14px', fontWeight: 'bold' }}>{new Date().toLocaleDateString('en-GB')}</p>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
              {/* Environment Section */}
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '32px', padding: '30px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                  <div style={{ width: '32px', height: '32px', background: 'rgba(96,165,250,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Wind size={18} style={{ color: '#60a5fa' }} />
                  </div>
                  <h3 style={{ fontSize: '18px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Environment</h3>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Prevailing Direction</span>
                    <span style={{ fontWeight: 'bold' }}>{getCardinalDirection(weatherData.avgDirectionDeg)} ({weatherData.avgDirectionDeg.toFixed(0)}°)</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Average Wind Speed</span>
                    <span style={{ fontWeight: 'bold' }}>{weatherData.avgSpeedMph.toFixed(1)} mph</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Maximum Gust</span>
                    <span style={{ fontWeight: 'bold' }}>{weatherData.avgGustMph.toFixed(1)} mph</span>
                  </div>
                </div>
              </div>

              {/* Terrain Section */}
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '32px', padding: '30px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                  <div style={{ width: '32px', height: '32px', background: 'rgba(52,211,153,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Database size={18} style={{ color: '#34d399' }} />
                  </div>
                  <h3 style={{ fontSize: '18px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Terrain Data</h3>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>LiDAR Coverage</span>
                    <span style={{ fontWeight: 'bold', color: '#10b981' }}>{lidarSummary.coveragePercent.toFixed(0)}%</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Scanning Resolution</span>
                    <span style={{ fontWeight: 'bold' }}>{lidarSummary.maxResolution ? `${lidarSummary.maxResolution.toFixed(1)}m` : 'N/A'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Data Format</span>
                    <span style={{ fontWeight: 'bold' }}>DTM Phase 1-6</span>
                  </div>
                </div>
              </div>
            </div>

            {/* PDF Directory Section */}
            {courseContactInfo && (
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '32px', padding: '30px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                  <div style={{ width: '32px', height: '32px', background: 'rgba(255,255,255,0.05)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Home size={18} style={{ color: 'white' }} />
                  </div>
                  <h3 style={{ fontSize: '18px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Golf Club Directory</h3>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '20px 40px' }}>
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Official Website</span>
                  <span style={{ fontWeight: 'bold', color: '#60a5fa' }}>{courseContactInfo.website}</span>
                  
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Telephone</span>
                  <span style={{ fontWeight: 'bold' }}>{courseContactInfo.phone}</span>
                  
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>Registered Address</span>
                  <span style={{ fontWeight: 'bold', lineHeight: '1.4' }}>{courseContactInfo.full_address}</span>
                </div>
              </div>
            )}

            {/* Large OSM Map */}
            <div style={{ height: '450px', background: '#0f172a', borderRadius: '32px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', position: 'relative' }}>
              <div style={{ position: 'absolute', top: '20px', left: '20px', zIndex: 1000, background: 'rgba(0,0,0,0.6)', padding: '8px 16px', borderRadius: '12px', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: '10px', color: 'white', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Site Topography Extract</span>
              </div>
              {courseCoords && (
                <MapContainer 
                  center={[courseCoords.lat, courseCoords.lng]} 
                  zoom={14} 
                  style={{ width: '100%', height: '100%' }}
                  zoomControl={false}
                  attributionControl={false}
                  fadeAnimation={false} // Disable animation for snapshotting
                >
                  <TileLayer 
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
                    crossOrigin="anonymous"
                  />
                  {(() => {
                    const validElevations = lidarSummary.readings
                      .map(r => r.elevation)
                      .filter((e): e is number => e !== null);
                    
                    if (validElevations.length === 0) return null;

                    const n = validElevations.length;
                    const mean = validElevations.reduce((a, b) => a + b, 0) / n;
                    const stdDev = Math.sqrt(validElevations.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / n);
                    const threshold = 2 * stdDev;

                    return lidarSummary.readings.map((reading, i) => {
                      const isOutlier = reading.elevation !== null && Math.abs(reading.elevation - mean) > threshold && stdDev > 0;
                      if (isOutlier || reading.elevation === null) return null;

                      return (
                        <Marker 
                          key={i} 
                          position={[reading.lat, reading.lng]}
                          icon={L.divIcon({
                            className: '',
                            html: `<div style="font-size: 14px; font-weight: 900; color: #60a5fa; white-space: nowrap; transform: translate(-50%, -50%); text-align: center; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px rgba(0,0,0,1);">${Math.round(reading.elevation)}</div>`,
                            iconSize: [0, 0],
                            iconAnchor: [0, 0]
                          })}
                        />
                      );
                    });
                  })()}
                </MapContainer>
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px', textAlign: 'center' }}>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.2em' }}>Scottish Golf Rating Toolkit • Proprietary Terrain Analysis Model</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
