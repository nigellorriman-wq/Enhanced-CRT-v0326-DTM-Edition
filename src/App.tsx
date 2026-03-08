import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, WMSTileLayer, CircleMarker, Polyline, Circle, useMap, Polygon, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { 
  ChevronLeft,
  Navigation2,
  Layers,
  Target,
  Trash2,
  Ruler,
  Zap,
  BookOpen,
  Info,
  MapPin,
  RotateCcw,
  Download,
  Upload,
  HelpCircle,
  X,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Eye,
  Diameter,
  Plus,
  Minus,
  CaseSensitive,
  Gauge,
  ChevronUp,
  ChevronDown,
  Circle as CircleIcon,
  CircleOff,
  CircleDot,
  Crosshair,
  Route,
  Waypoints,
  Home,
  FileText,
  Printer,
  ChevronRight,
  Settings
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

/** --- TYPES --- **/
// Fix: Renamed View to AppView to resolve "Cannot find name 'AppView'" errors on lines 839 and 1069
type AppView = 'landing' | 'track' | 'green' | 'manual' | 'stimp' | 'report' | 'dataset' | 'settings';
type UnitSystem = 'Yards' | 'Metres';
type FontSize = 'small' | 'medium' | 'large';
type RatingGender = 'Men' | 'Women'; 
type TrackProfileView = 'Rater\'s Walk' | 'Scratch' | 'Bogey'; 
type OvalMode = 'off' | 'scratch' | 'bogey';

interface GeoPoint {
  lat: number;
  lng: number;
  alt: number | null;
  accuracy: number;
  altAccuracy: number | null;
  timestamp: number;
  type?: 'green' | 'bunker';
  source?: 'GPS' | 'LiDAR';
}

interface PivotRecord {
  point: GeoPoint;
  type: 'common' | 'scratch_cut' | 'bogoy_round';
}

interface SavedRecord {
  id: string;
  type: 'Track' | 'Green';
  date: number;
  primaryValue: string; 
  secondaryValue?: string; 
  egdValue?: string; 
  points: GeoPoint[]; 
  pivots?: GeoPoint[]; 
  holeNumber?: number;
  raterPathPoints?: GeoPoint[]; 
  pivotPoints?: PivotRecord[]; 
  genderRated?: RatingGender; 
  effectivePaths?: { 
    scratch: GeoPoint[];
    bogey: GeoPoint[];
  };
  effectiveDistances?: { 
    scratch: number;
    bogey: number;
  };
  effectiveElevations?: { 
    scratch: number; 
    bogey: number; 
  };
}

/** --- SHOT TARGETS (Yards) --- **/
const SHOT_TARGETS = {
  Men: {
    Scratch: { first: { c: 230, t: 250 }, subseq: { c: 200, t: 220 } },
    Bogey: { first: { c: 180, t: 200 }, subseq: { c: 150, t: 170 } }
  },
  Women: {
    Scratch: { first: { c: 190, t: 210 }, subseq: { c: 170, t: 190 } },
    Bogey: { first: { c: 130, t: 150 }, subseq: { c: 110, t: 130 } }
  }
};

/** --- ACCURACY TABLES (Yards) --- **/
const ACCURACY_DATA = {
  Men: [
    { dist: 90, sw: 11, sd: 14, bw: 16, bd: 19 },
    { dist: 110, sw: 12, sd: 15, bw: 17, bd: 21 },
    { dist: 130, sw: 13, sd: 15, bw: 18, bd: 23 },
    { dist: 150, sw: 15, sd: 16, bw: 20, bd: 25 },
    { dist: 170, sw: 18, sd: 17, bw: 24, bd: 28 },
    { dist: 190, sw: 23, sd: 18, bw: 29, bd: 34 },
    { dist: 210, sw: 29, sd: 19, bw: null, bd: null },
    { dist: 230, sw: 35, sd: 20, bw: null, bd: null },
    { dist: 250, sw: 41, sd: 21, bw: null, bd: null },
  ],
  Women: [
    { dist: 90, sw: 12, sd: 15, bw: 17, bd: 22 },
    { dist: 110, sw: 14, sd: 16, bw: 19, bd: 24 },
    { dist: 130, sw: 17, sd: 17, bw: 21, bd: 27 },
    { dist: 150, sw: 20, sd: 18, bw: 24, bd: 30 },
    { dist: 170, sw: 26, sd: 20, bw: null, bd: null },
    { dist: 190, sw: 30, sd: 24, bw: null, bd: null },
    { dist: 210, sw: 34, sd: 28, bw: null, bd: null },
  ]
};

const interpolateSpread = (distYards: number, gender: RatingGender) => {
  const table = ACCURACY_DATA[gender];
  
  // Fix 1: Linear scaling for distances below the first table entry (90 yards)
  if (distYards < table[0].dist) {
    const t = Math.max(0, distYards) / table[0].dist;
    return {
      sw: table[0].sw * t,
      sd: table[0].sd * t,
      bw: table[0].bw !== null ? table[0].bw * t : null,
      bd: table[0].bd !== null ? table[0].bd * t : null
    };
  }

  const effectiveDist = distYards;

  let sw: number | null = null, sd: number | null = null;
  let bw: number | null = null, bd: number | null = null;

  const lastS = table[table.length - 1];
  if (effectiveDist <= lastS.dist) {
    for (let i = 0; i < table.length - 1; i++) {
      const s = table[i], e = table[i + 1];
      if (effectiveDist >= s.dist && effectiveDist <= e.dist) {
        const t = (effectiveDist - s.dist) / (e.dist - s.dist);
        sw = s.sw + (e.sw - s.sw) * t;
        sd = s.sd + (e.sd - s.sd) * t;
        break;
      }
    }
  } else {
    sw = lastS.sw; sd = lastS.sd;
  }

  const bogeyRows = table.filter(r => r.bw !== null);
  const lastB = bogeyRows[bogeyRows.length - 1];
  if (effectiveDist <= lastB.dist) {
    for (let i = 0; i < bogeyRows.length - 1; i++) {
      const s = bogeyRows[i], e = bogeyRows[i + 1];
      if (effectiveDist >= s.dist && effectiveDist <= e.dist) {
        const t = (effectiveDist - s.dist) / (e.dist - s.dist);
        bw = s.bw + (e.bw - s.bw) * t;
        bd = s.bd + (e.bd - s.bd) * t;
        break;
      }
    }
  } else {
    // Clamp to max bogey values for long distances
    bw = lastB.bw; bd = lastB.bd;
  }

  return { sw, sd, bw, bd };
};

/** --- DOCUMENTATION CONTENT --- **/
const USER_MANUAL = [
  {
    title: "Introduction",
    color: "text-white",
    icon: <BookOpen className="text-white" />,
    content: (
      <>
        Scottish Golf <span className="text-blue-500 font-black">Course Rating Toolkit</span> is designed to provide an alternative to roadwheels and barometers when rating a course. Ensure 'High Accuracy' location is enabled on your device. For best results, keep the App active and in-hand while walking. The App is web-based, so an internet connection is required to launch. A trick is to open the App where you have Internet, open the 'Distance Tracker' section and zoom out so you see the whole of the course you are working on. This should cache the images or maps locally, so you can still see them when Internet is lost. But if you lose connection the App still works, though you may not see the background mapping.
      </>
    )
  },
  {
    title: "Location services",
    color: "text-rose-500",
    icon: <MapPin className="text-rose-500" />,
    content: (
      <>
        If your location isn't showing when you're trying to track a distance or map a green, try the following help sources 1) <a href="https://support.google.com/nexus/topic/6143651" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">Android devices</a>  2) <a href="https://support.apple.com/en-gb/102647" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline">iOS (Apple) devices</a>
      </>
    )
  },
  {
    title: "Distance Tracker",
    color: "text-blue-400",
    icon: <Navigation2 className="text-blue-400" />,
    content: (
      <>
<p>This menu calculates distances and altitude change from tee to each landing zone for Scratch and Bogey players. In addition, it displays the effective playing length of dogleg holes.</p>
<p>On the home screen you can select whether you will be rating for Men or Women. This selection has no impact on the results, but will mark the generated hole track files for archiving and re-loading and display the shot accuracy (see below).</p>
<p>Stand on the tee you are using to measure from and Tap 'Start Track' when you are ready to start tracking the distance.</p>
<p>Horizontal and vertical distances are displayed in real-time. If you made a mistake and began at the wrong place, select “Stop Track” to start over.</p>
<p>Two distances are shown S: for scratch and B: for bogey. The two will only differ if the line that each takes on a hole are different. On dogleg holes, a scratch golfer may be able to cut the corner, so their pivot point will be different to the bogey player.</p>
<p>When you reach the first pivot, select ‘pivot’ and choose which (or both) players it refers to. If it does not apply to both, then from this point you will see two track lines and distances – one through the pivot and the other in a straight line from the tee. As you progress down the hole you can select pivots for each player.</p>
<p>Both players’ tracks will end at the front of the green when you hit “Stop Track” and you can note down the two distances and the level difference between tee and green.</p>
<p>As soon as you press “Stop Track” no more lines will be drawn, the location pin will continue to follow you and the track record for that hole will appear at the bottom of the Home screen for export or review.</p>
<p>Notes: You can create a maximum of 3 pivots for each player on each hole. Total distance and elevation change are calculated from the start through all pivots to your current position. GNSS (GPS) is really only accurate to 2m at best, so keep an eye on the Horiz. value and the indicative coloured circle around the current location. It shows you the absolute positioning accuracy of the GPS, however, don't confuse this with the accuracy of distance measurements. They will always be better than this as they are relative to each other.</p>
<p>If your device does not have a barometer sensor (see the elevation method displayed below the elevation value), then you may still need to use a barometer. Refer to section on “Sensor Diagnostics”, below for details.</p>
      </>
    ) 
  },
  {
    title: "Pivots and tracks",
    color: "text-rose-700",
 icon: (
    <div className="flex gap-0.5">
      <Route size={18} className="text-rose-500" />
      <Waypoints size={18} className="text-emerald-500" />
    </div>
  ),
    content: (
      <>
The App is able to toggle the display between the actual route through all of the pivot points, or draw separate lines for both Scratch and Bogey players, through their respective pivots. Click the waypoint button to switch between the two displays and toggle between the route through all pivots, or individual Scratch and Bogey routes.
      </>
    )
  },
  {
    title: "Follow-Me",
    color: "text-emerald-400",
    icon: <Crosshair className="text-emerald-400" />,
    content: (
      <>
When using either Distance Tracker or Green Mapper, the display will follow the current location, panning and zooming as the location changes. If you click and drag or zoom manually, this follow-me function will turn itself off until you hit the button to turn it back on. When it is activated, the button pulses green and when it is deactivated it will be grey.
      </>
    )
  },
  {
    title: "Accuracy Pattern",
    color: "text-orange-400",
    icon: <CircleOff className="text-orange-400" />,
    content: (
      <>
The App is able to display the 'Accuracy Pattern' in real-time for Scratch and Bogey players. This display is toggled with the button to the right of the home button and cycles between 'Off' (default), <span className="text-emerald-500 font-black">Scratch</span> or <span className="text--500 font-black">Bogey.</span> This function allows the Rater to see on the background satellite imagery the proximity of obstacles around the target. To use this facility properly, mark every shot as a pivot, so that the next shot length is used.
      </>
    )
  },
  {
    title: "Green Mapper",
    color: "text-emerald-400",
    icon: <Target className="text-emerald-400" />,
    content: "Start at any point on the edge of the green. Walk the perimeter. The app automatically 'Closes' the loop when you return to within 1m of your start point, or you can force it to close by hitting the button. Results show total Area and Perimeter length."
  },
  {
    title: "Recording Bunkers",
    color: "text-orange-400",
    icon: <AlertCircle className="text-orange-400" />,
    content: "While walking the green edge, tap the 'Bunker' button when passing a greenside bunker segment and tap it again when you get to the end. This marks those points as sand. The panel will show what percentage of the green's perimeter is guarded by sand."
  },
  {
    title: "Effective Green Diameter",
    color: "text-emerald-400",
    icon: <Diameter className="text-emerald-400" />,
    content: "Effective Green Diameter (EGD) is required when measuring a green. When a green is mapped and closed the EGD will automatically be displayed, together with the raw data and dashed lines showing the dimensions used. Oddly-shaped greens are more tricky, but by using a \"concave hull check\" it should at least recognise an L-shaped green. In these circumstances, EGD should show the raw dimension data to allow the rater to make their weighting adjustments - as per Course Rating System Manual (Jan 2024 Section 13D [two portions]). In those cases when a green cannot be automatically identified by the App, it will draw a curved line right up the centre of the green with perpendicular widths at 0.25, 0.50 and 0.75 of the green depth. The raw data will be shown for manual analysis."
  },
    {
    title: "Green Report Tool",
    color: "text-rose-700",
    icon: <FileText className="text-rose-700" />,
    content: "The Green Report Tool will take an exported KML file (from the Green Mapper toolkit), produce a full report on every green and export it as a PDF file. Each green will occupy a single A4 page and the final page will show satellite imagery of the entire course, with each green drawn in its correct location."
  },
  {
    title: "Stimping sloped greens",
    color: "text-lime-400",
    icon: <Gauge className="text-lime-400" />,
    content: "While the best procedure is to find a flat area on the green on which to stimp, when it is not possible to find a flat area to measure, refer to 'Course Rating Manual 9.Green Surface'. Find the most uniform area. Roll balls down and then up. Enter the averaged values into the App and it will calculate the corrected speed and contour category based on those values. Refer to the 'Green Surface Rating Table' to determine the rating."
  },
  {
    title: "Sensor Diagnostics",
    color: "text-rose-700",
    icon: <Cpu className="text-rose-700" />,
    content: (
      <>
        GPS alone isn't accurate enough for determining altitude changes, but if your mobile device contains a barometer sensor this App should use it by default. If it does exist it will indicate its use as follows... <span className="text-blue-500 font-black">Blue Light</span> (Barometric): Highest precision elevation using your phone's pressure sensor (if it has one). <span className="text-emerald-500 font-black">Emerald Light</span> (GNSS 3D): Standard GPS altitude. <span className="text-amber-500 font-black">Amber Light</span>: Searching for vertical lock.
      </>
    )
  },
  {
    title: "Data import/export",
    color: "text--400",
    icon: <BookOpen className="text--400" />,
    content: "Whenever you save a track or green area, the data appears at the bottom of the homescreen. Select a result and it will show you the results again. Hitting the bin icon will delete an individual record. You can also save all results to a KML file, which will be stored in your downloads folder. The filename will be the current date and time. KML files can be opened in GIS packages, such as Google Earth or Google Maps for analysis and archiving purposes. If you already have a KML file from a previous rating, or have digitised greens in Google Earth and wish to import them for EGD processing, you can do this using 'Import KML'"
  },
  {
    title: "Help and suggestions",
    color: "text-red-400",
    icon: <Eye className="text-red-400" />,
    content: "This App is under development. If you require assistance or have any suggestions, please email me at nigel.lorriman@gmail.com  Version - Jan 2026"
  }
];

/** --- UTILITIES --- **/
const calculateDistance = (p1: {lat: number, lng: number}, p2: {lat: number, lng: number}): number => {
  const R = 6371e3;
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
  const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const calculatePathDistanceAndElevation = (path: GeoPoint[], distMult: number, elevMult: number) => {
  let distance = 0;
  let netElevation = 0;

  if (path.length > 1) {
    for (let k = 0; k < path.length - 1; k++) {
      const p1 = path[k];
      const p2 = path[k+1];
      distance += calculateDistance(p1, p2);
    }
    const startAlt = path[0]?.alt || 0;
    const endAlt = path[path.length - 1]?.alt || 0;
    netElevation = (endAlt - startAlt);
  }
  return {
    distance: distance * distMult,
    elevation: netElevation * elevMult,
  };
};

const calculateArea = (points: GeoPoint[]): number => {
  if (points.length < 3) return 0;
  const R = 6371e3;
  const lat0 = points[0].lat * Math.PI / 180;
  const coords = points.map(p => ({
    x: p.lng * Math.PI / 180 * R * Math.cos(lat0),
    y: p.lat * Math.PI / 180 * R
  }));
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    area += coords[i].x * coords[j].y - coords[j].x * coords[i].y;
  }
  return Math.abs(area) / 2;
};

const getConvexHull = (points: GeoPoint[]): GeoPoint[] => {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.lng !== b.lng ? a.lng - b.lng : a.lat - b.lat);
  const cp = (a: GeoPoint, b: GeoPoint, c: GeoPoint) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cp(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && upper.length >= 2 && cp(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
};

const getWidthAtAxisPoint = (midX: number, midY: number, nx: number, ny: number, polyPoints: any[], toX: any, toY: any) => {
  const intersections: number[] = [];
  for (let i = 0; i < polyPoints.length - 1; i++) {
    const x1 = toX(polyPoints[i]), y1 = toY(polyPoints[i]);
    const x2 = toX(polyPoints[i+1]), y2 = toY(polyPoints[i+1]);
    const sx = x2 - x1, sy = y2 - y1;
    const det = -sx * ny + sy * nx;
    if (Math.abs(det) < 1e-10) continue; 
    const u = (-(midX - x1) * ny + (midY - y1) * nx) / det;
    const t = (sx * (midY - y1) - sy * (midX - x1)) / det;
    if (u >= 0 && u <= 1) intersections.push(t);
  }
  if (intersections.length < 2) return null;
  return { minT: Math.min(...intersections), maxT: Math.max(...intersections) };
};

const isPointInPolygon = (p: {x: number, y: number}, polygon: {x: number, y: number}[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

const getAccuracyColor = (accuracy: number): string => {
  if (accuracy < 2) return 'rgba(34, 197, 94, 0.4)'; 
  if (accuracy <= 5) return 'rgba(234, 179, 8, 0.4)'; 
  return 'rgba(239, 68, 68, 0.4)'; 
};

const getAccuracyTextColor = (accuracy: number): string => {
  if (accuracy < 2) return 'text-emerald-500';
  if (accuracy <= 5) return 'text-amber-500';
  return 'text-rose-500';
};

const getVerticalMethod = (accuracy: number | null, alt: number | null): string => {
  if (accuracy === 0.2) return 'LiDAR DTM';
  if (accuracy !== null && accuracy < 1.0) return 'Barometric'; 
  else if (alt !== null) return 'GNSS 3D'; 
  return 'Vertical (Searching)'; 
};

const getBunkerPercentageColor = (bunkerPct: number | undefined): string => {
  if (bunkerPct === undefined) return 'text-white/40';
  if (bunkerPct <= 25) return 'text-emerald-400';
  if (bunkerPct > 25 && bunkerPct <= 50) return 'text--400';
  if (bunkerPct > 50 && bunkerPct <= 75) return 'text-orange-400';
  return 'text-white';
};

const getEGDAnalysis = (points: GeoPoint[], forceSimpleAverage: boolean = false) => {
  if (points.length < 3) return null;
  const R = 6371e3;
  let maxD = 0;
  let pA = points[0], pB = points[0];
  
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = calculateDistance(points[i], points[j]);
      if (d > maxD) { maxD = d; pA = points[i]; pB = points[j]; }
    }
  }

  const latRef = pA.lat * Math.PI / 180;
  const toX = (p: {lat: number, lng: number}) => p.lng * Math.PI / 180 * R * Math.cos(latRef);
  const toY = (p: {lat: number, lng: number}) => p.lat * Math.PI / 180 * R;
  const fromXY = (x: number, y: number): GeoPoint => ({
    lat: (y / R) * (180 / Math.PI),
    lng: (x / (R * Math.cos(latRef))) * (180 / Math.PI),
    alt: null, accuracy: 0, altAccuracy: 0, timestamp: 0
  });

  const xA = toX(pA), yA = toY(pA);
  const xB = toX(pB), yB = toY(pB);
  const dx = xB - xA, dy = yB - yA;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) return null;

  const nx = -dy / mag;
  const ny = dx / mag;
  const polyPoints = [...points, points[0]];

  const midX = (xA + xB) / 2;
  const midY = (yA + yB) / 2;
  const midW = getWidthAtAxisPoint(midX, midY, nx, ny, polyPoints, toX, toY);
  const widthMeters = midW ? (midW.maxT - midW.minT) : 0;

  const q1X = xA + (xB - xA) * 0.25;
  const q1Y = yA + (yB - yA) * 0.25;
  const q3X = xA + (xB - xA) * 0.75;
  const q3Y = yA + (yB - yA) * 0.75;
  const w1 = getWidthAtAxisPoint(q1X, q1Y, nx, ny, polyPoints, toX, toY);
  const w3 = getWidthAtAxisPoint(q3X, q3Y, nx, ny, polyPoints, toX, toY);

  const L_yds = maxD * 1.09361;
  const W_yds = widthMeters * 1.09361;
  const ratio = W_yds === 0 ? 0 : L_yds / W_yds;

  let egd_yds = 0;
  let method = "Average (L+W)/2";
  let isInconsistent = false;
  let w1_yds = 0, w3_yds = 0;
  let pC1, pD1, pC3, pD3;

  if (forceSimpleAverage) {
    egd_yds = (L_yds + W_yds) / 2;
    method = "Average (L+W)/2";
  } else {
    if (w1 && w3) {
      w1_yds = (w1.maxT - w1.minT) * 1.09361;
      w3_yds = (w3.maxT - w3.minT) * 1.09361;
      if (Math.abs(w1_yds - w3_yds) / Math.max(w1_yds, w3_yds) > 0.25) {
        isInconsistent = true;
        method = "One dimension not consistent";
        const avgShort = (w1_yds + w3_yds) / 2;
        egd_yds = (L_yds + avgShort) / 2;
        pC1 = fromXY(q1X + nx * w1.maxT, q1Y + ny * w1.maxT);
        pD1 = fromXY(q1X + nx * w1.minT, q1Y + ny * w1.minT);
        pC3 = fromXY(q3X + nx * w3.maxT, q3Y + ny * w3.maxT);
        pD3 = fromXY(q3X + nx * w3.minT, q3Y + ny * w3.minT);
      }
    }

    if (!isInconsistent) {
      if (ratio >= 3) {
        egd_yds = (3 * W_yds + L_yds) / 4;
        method = "One dimension three times the other";
      } else if (ratio >= 2) {
        egd_yds = (2 * W_yds + L_yds) / 3;
        method = "One dimension twice the other";
      } else {
        egd_yds = (L_yds + W_yds) / 2;
      }
    }
  }
  
  const pC = fromXY(midX + nx * (midW?.maxT || 0), midY + ny * (midW?.maxT || 0));
  const pD = fromXY(midX + nx * (midW?.minT || 0), midY + ny * (midW?.minT || 0));

  return { 
    egd: Math.round(egd_yds * 10) / 10, 
    L: L_yds, 
    W: W_yds, 
    ratio, pA, pB, pC, pD, method,
    isInconsistent, w1_yds, w3_yds, pC1, pD1, pC3, pD3
  };
};

const performAnomalousAnalysis = (points: GeoPoint[], pA: GeoPoint, pB: GeoPoint) => {
  const R = 6371e3;
  const latRef = pA.lat * Math.PI / 180;
  const toX = (p: {lat: number, lng: number}) => p.lng * Math.PI / 180 * R * Math.cos(latRef);
  const toY = (p: {lat: number, lng: number}) => p.lat * Math.PI / 180 * R;
  const fromXY = (x: number, y: number): GeoPoint => ({
    lat: (y / R) * (180 / Math.PI),
    lng: (x / (R * Math.cos(latRef))) * (180 / Math.PI),
    alt: null, accuracy: 0, altAccuracy: 0, timestamp: 0
  });

  const xA = toX(pA), yA = toY(pA);
  const xB = toX(pB), yB = toY(pB);
  const dx = xB - xA, dy = yB - yA;
  const straightDist = Math.sqrt(dx * dx + dy * dy);
  const mag = straightDist;
  
  if (mag === 0) return null;

  const nx = -dy / mag;
  const ny = dx / mag;
  const polyPoints = [...points, points[0]];

  const steps = 15;
  const spinePoints: GeoPoint[] = [];
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const curX = xA + dx * t;
    const curY = yA + dy * t;
    const res = getWidthAtAxisPoint(curX, curY, nx, ny, polyPoints, toX, toY);
    if (res) {
      const midT = (res.minT + res.maxT) / 2;
      spinePoints.push(fromXY(curX + nx * midT, curY + ny * midT));
    }
  }

  let curvedLen = 0;
  for (let i = 0; i < spinePoints.length - 1; i++) {
    curvedLen += calculateDistance(spinePoints[i], spinePoints[i + 1]);
  }

  const milestones = [0.25, 0.5, 0.75];
  const milestoneColors = ["#fb923c", "#facc15", "#f472b6"];
  const sampledWidths: { w: number, p1: GeoPoint, p2: GeoPoint, label: string, color: string }[] = [];
  
  milestones.forEach((m, idx) => {
    const t = m;
    const curX = xA + dx * t;
    const curY = yA + dy * t;
    const res = getWidthAtAxisPoint(curX, curY, nx, ny, polyPoints, toX, toY);
    if (res) {
      sampledWidths.push({
        w: (res.maxT - res.minT) * 1.09361,
        p1: fromXY(curX + nx * res.maxT, curY + ny * res.maxT),
        p2: fromXY(curX + nx * res.minT, curY + ny * res.minT),
        label: `W${idx + 1}`,
        color: milestoneColors[idx]
      });
    }
  });

  const curvedLenYds = curvedLen * 1.09361;
  const straightLenYds = mag * 1.09361;
  const isSignificantlyCurved = curvedLenYds > straightLenYds * 1.15;

  return {
    method: "Inconsistent Shape",
    isAnomalous: true,
    isManualReq: isSignificantlyCurved,
    curvedLength: curvedLenYds,
    straightLength: straightLenYds,
    spine: spinePoints,
    widths: sampledWidths
  };
};

const analyzeGreenShape = (points: GeoPoint[], concavityThreshold: number = 0.82) => {
  if (points.length < 3) return null;
  const basic = getEGDAnalysis(points);
  if (!basic) return null;

  const polyArea = calculateArea(points);
  const hullArea = calculateArea(getConvexHull(points));
  const concavity = hullArea > 0 ? polyArea / hullArea : 1;
  
  const R = 6371e3;
  const latRef = points[0].lat * Math.PI / 180;
  const toX = (p: {lat: number, lng: number}) => p.lng * Math.PI / 180 * R * Math.cos(latRef);
  const toY = (p: {lat: number, lng: number}) => p.lat * Math.PI / 180 * R;
  const polyCoords = points.map(p => ({ x: toX(p), y: toY(p) }));
  
  const midX = (toX(basic.pA) + toX(basic.pB)) / 2;
  const midY = (toY(basic.pA) + toY(basic.pB)) / 2;
  const midpointIsOutside = !isPointInPolygon({ x: midX, y: midY }, polyCoords);

  const isLShape = midpointIsOutside || concavity < concavityThreshold || basic.ratio > 3.6;

  if (isLShape) {
    let elbowIdx = 0;
    let maxElbowDist = -1;
    const xA = toX(basic.pA), yA = toY(basic.pA);
    const xB = toX(basic.pB), yB = toY(basic.pB);
    const dx = xB - xA, dy = yB - yA;
    const mag = Math.sqrt(dx * dx + dy * dy);

    points.forEach((p, idx) => {
      const px = toX(p), py = toY(p);
      const dist = Math.abs((xB - xA) * (yA - py) - (xA - px) * (yB - yA)) / mag;
      if (dist > maxElbowDist) {
        maxElbowDist = dist;
        elbowIdx = idx;
      }
    });

    const s1 = getEGDAnalysis(points.slice(0, elbowIdx + 1), true);
    const s2 = getEGDAnalysis(points.slice(elbowIdx), true);

    let hasAnomaly = false;
    if (s1 && s1.pA && s1.pB) {
      const s1MidX = (toX(s1.pA) + toX(s1.pB)) / 2;
      const s1MidY = (toY(s1.pA) + toY(s1.pB)) / 2;
      if (!isPointInPolygon({ x: s1MidX, y: s1MidY }, polyCoords)) hasAnomaly = true;
    }
    if (!hasAnomaly && s2 && s2.pA && s2.pB) {
      const s2MidX = (toX(s2.pA) + toX(s2.pB)) / 2;
      const s2MidY = (toY(s2.pA) + toY(s2.pB)) / 2;
      if (!isPointInPolygon({ x: s2MidX, y: s2MidY }, polyCoords)) hasAnomaly = true;
    }

    let anomalousResult = null;
    if (hasAnomaly) {
      anomalousResult = performAnomalousAnalysis(points, basic.pA, basic.pB);
    }

    return { 
      ...basic, 
      isLShape: true, 
      method: anomalousResult ? anomalousResult.method : "Two portions",
      hasAnomaly,
      anomalousResult,
      isAnomalous: !!anomalousResult,
      s1, 
      s2 
    };
  }

  return { ...basic, isLShape: false, hasAnomaly: false, isAnomalous: false, s1: null, s2: null };
};

const getInterpolatedLine = (p1: GeoPoint, p2: GeoPoint, numSegments: number = 5): GeoPoint[] => {
  const points: GeoPoint[] = [p1];
  if (p1.timestamp === p2.timestamp) return points;

  for (let i = 1; i < numSegments; i++) {
    const t = i / numSegments;
    points.push({
      lat: p1.lat + (p2.lat - p1.lat) * t,
      lng: p1.lng + (p2.lng - p1.lng) * t,
      alt: p1.alt !== null && p2.alt !== null ? p1.alt + (p2.alt - p1.alt) * t : null,
      accuracy: (p1.accuracy + p2.accuracy) / 2,
      altAccuracy: p1.altAccuracy !== null && p2.altAccuracy !== null ? (p1.altAccuracy + p2.altAccuracy) / 2 : null,
      timestamp: p1.timestamp + (p2.timestamp - p1.timestamp) * t
    });
  }
  points.push(p2);
  return points;
};

const calculateEffectivePathsAndMetrics = (
  raterPathPoints: GeoPoint[],
  pivotRecords: PivotRecord[],
  distMult: number,
  elevMult: number
) => {
  if (raterPathPoints.length < 2) {
    return {
      effectivePaths: { scratch: [], bogey: [] },
      effectiveDistances: { scratch: 0, bogey: 0 },
      effectiveElevations: { scratch: 0, bogey: 0 },
    };
  }

  const sortedPivots = [...pivotRecords].sort((a, b) => a.point.timestamp - b.point.timestamp);
  const startPoint = raterPathPoints[0];
  const endPoint = raterPathPoints[raterPathPoints.length - 1];

  const getAnchors = (forScratch: boolean): GeoPoint[] => {
    let anchors: GeoPoint[] = [startPoint];
    for (const pivot of sortedPivots) {
      if (forScratch) {
        if (pivot.type === 'common' || pivot.type === 'scratch_cut') {
          anchors.push(pivot.point);
        }
      } else { 
        if (pivot.type === 'common' || pivot.type === 'bogoy_round') {
          anchors.push(pivot.point);
        }
      }
    }
    if (anchors[anchors.length - 1].timestamp !== endPoint.timestamp) {
      anchors.push(endPoint);
    }
    return Array.from(new Map(anchors.map(p => [p.timestamp, p])).values()).sort((a, b) => a.timestamp - b.timestamp);
  };

  const scratchAnchors = getAnchors(true);
  const bogeyAnchors = getAnchors(false);

  const buildFinalPath = (anchors: GeoPoint[], isScratchPath: boolean): GeoPoint[] => {
    const path: GeoPoint[] = [];
    if (anchors.length === 0) return [];
    path.push(anchors[0]);

    for (let i = 0; i < anchors.length - 1; i++) {
      const p1 = anchors[i];
      const p2 = anchors[i+1];
      let shouldBeStraight = false;
      const p1IndexInRaterPath = raterPathPoints.findIndex(rp => rp.timestamp === p1.timestamp);
      const p2IndexInRaterPath = raterPathPoints.findIndex(rp => rp.timestamp === p2.timestamp);

      if (p1IndexInRaterPath === -1 || p2IndexInRaterPath === -1 || p1IndexInRaterPath >= p2IndexInRaterPath) {
        shouldBeStraight = true;
      } else {
        const segmentInRaterPath = raterPathPoints.slice(p1IndexInRaterPath + 1, p2IndexInRaterPath); 
        if (isScratchPath) {
          const p2IsScratchCutPivot = sortedPivots.some(p => p.point.timestamp === p2.timestamp && p.type === 'scratch_cut');
          const skippedBogoyRoundPivots = sortedPivots.filter(p => p.type === 'bogoy_round' && segmentInRaterPath.some(rp => rp.timestamp === p.point.timestamp));
          if (p2IsScratchCutPivot || skippedBogoyRoundPivots.length > 0) shouldBeStraight = true;
        } else { 
          const skippedScratchCutPivots = sortedPivots.filter(p => p.type === 'scratch_cut' && segmentInRaterPath.some(rp => rp.timestamp === p.point.timestamp));
          if (skippedScratchCutPivots.length > 0) shouldBeStraight = true;
        }
      }
      
      if (shouldBeStraight) {
        path.push(...getInterpolatedLine(p1, p2, 10).slice(1));
      } else {
        if (p1IndexInRaterPath !== -1 && p2IndexInRaterPath !== -1 && p1IndexInRaterPath < p2IndexInRaterPath) {
          path.push(...raterPathPoints.slice(p1IndexInRaterPath + 1, p2IndexInRaterPath + 1));
        } else {
          path.push(...getInterpolatedLine(p1, p2, 10).slice(1));
        }
      }
    }
    return path;
  };

  const finalScratchPath = buildFinalPath(scratchAnchors, true);
  const finalBogeyPath = buildFinalPath(bogeyAnchors, false);
  const scratchMetrics = calculatePathDistanceAndElevation(finalScratchPath, distMult, elevMult);
  const bogeyMetrics = calculatePathDistanceAndElevation(finalBogeyPath, distMult, elevMult);

  return {
    effectivePaths: { scratch: finalScratchPath, bogey: finalBogeyPath },
    effectiveDistances: { scratch: scratchMetrics.distance, bogey: bogeyMetrics.distance },
    effectiveElevations: { scratch: scratchMetrics.elevation, bogey: bogeyMetrics.elevation },
  };
};

/** --- ACCURACY OVAL COMPONENT --- **/
const AccuracyOvals: React.FC<{ 
  pos: GeoPoint | null, 
  pivots: PivotRecord[], 
  startPoint: GeoPoint | null,
  gender: RatingGender, 
  active: boolean, 
  mode: OvalMode 
}> = ({ pos, pivots, startPoint, gender, active, mode }) => {
  if (!active || !pos || mode === 'off') return null;

  // Fix 3: Logic to find the specific anchor for the selected mode (Scratch or Bogey) using timestamp sorting
  const anchor = useMemo(() => {
    if (!startPoint) return null;
    if (mode === 'scratch') {
      const filtered = pivots.filter(p => p.type === 'common' || p.type === 'scratch_cut').sort((a, b) => b.point.timestamp - a.point.timestamp);
      return filtered.length > 0 ? filtered[0].point : startPoint;
    }
    if (mode === 'bogey') {
      const filtered = pivots.filter(p => p.type === 'common' || p.type === 'bogoy_round').sort((a, b) => b.point.timestamp - a.point.timestamp);
      return filtered.length > 0 ? filtered[0].point : startPoint;
    }
    return null;
  }, [mode, pivots, startPoint]);

  if (!anchor) return null;

  const distM = calculateDistance(anchor, pos);
  const distY = distM * 1.09361;
  const spread = interpolateSpread(distY, gender);
  if (!spread) return null;

  const latM = 111320;
  const cosLat = Math.cos(pos.lat * Math.PI / 180);
  const lngM = 111320 * cosLat;
  const dLat = (pos.lat - anchor.lat) * latM;
  const dLng = (pos.lng - anchor.lng) * lngM;
  const mag = Math.sqrt(dLat * dLat + dLng * dLng);
  
  // Use a default orientation if standing still to prevent oval from disappearing
  const ux = mag < 0.5 ? 1 : dLng / mag;
  const uy = mag < 0.5 ? 0 : dLat / mag;
  const vx = -uy, vy = ux;

  const gen = (wY: number | null, dY: number | null) => {
    if (wY === null || dY === null) return null;
    const wM = (wY * 0.9144) / 2, dM = (dY * 0.9144) / 2;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * 2 * Math.PI;
      const px = dM * Math.cos(t), py = wM * Math.sin(t);
      pts.push([pos.lat + (px * uy + py * vy) / latM, pos.lng + (px * ux + py * vx) / lngM]);
    }
    return pts;
  };

  const scratchPts = (mode === 'scratch') ? gen(spread.sw, spread.sd) : null;
  const bogeyPts = (mode === 'bogey') ? gen(spread.bw, spread.bd) : null;

  return (
    <>
      {scratchPts && <Polyline positions={scratchPts} color="#10b981" weight={2} dashArray="5, 5" />}
      {bogeyPts && <Polyline positions={bogeyPts} color="#facc15" weight={2} dashArray="5, 5" />}
    </>
  );
};

const MapController: React.FC<{ 
  pos: GeoPoint | null, active: boolean, mapPoints: GeoPoint[], completed: boolean, viewingRecord: SavedRecord | null, mode: AppView, trkPoints: GeoPoint[], isFollowing: boolean, setIsFollowing: (v: boolean) => void,
  onMapMove?: (lat: number, lng: number) => void
}> = ({ pos, active, mapPoints, completed, viewingRecord, mode, trkPoints, isFollowing, setIsFollowing, onMapMove }) => {
  const map = useMap();
  const lastViewId = useRef<string | null>(null);
  const hasInitialLock = useRef(false);
  const prevPosAccuracy = useRef<number>(Infinity);
  const prevPointsLength = useRef(0);

useMapEvents({
    dragstart: () => { setIsFollowing(false); },
    zoomstart: () => { setIsFollowing(false); },
    moveend: () => {
      if (onMapMove) {
        const center = map.getCenter();
        onMapMove(center.lat, center.lng);
      }
    }
  });

useEffect(() => {
  const currentId = viewingRecord ? viewingRecord.id : (active ? 'active' : 'idle');
  if (lastViewId.current !== currentId) {
    // When switching to a new record or starting a new hole, 
    // we want the map to automatically snap to the data.
    setIsFollowing(true); 
    lastViewId.current = currentId;
  }
}, [viewingRecord, active]);

useEffect(() => {
    const currentPts = mode === 'green' ? mapPoints : trkPoints;
    
    // Automatically resume following if a new point is added (e.g. pivot inserted)
    if (currentPts.length > prevPointsLength.current) {
      setIsFollowing(true);
    }
    prevPointsLength.current = currentPts.length;

    // Gatekeeper: if "Follow" is toggled off (manual movement), stop here
    if (!isFollowing) return;
  
    if (viewingRecord) {
      const pts = viewingRecord.type === 'Green' ? viewingRecord.points : viewingRecord.raterPathPoints;
      if (pts && pts.length > 0) {
        const bounds = L.latLngBounds(pts.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [40, 40], paddingBottomRight: [40, 280], animate: true });
      }
    } else if (completed && mode === 'green' && mapPoints.length > 2) {
      const bounds = L.latLngBounds(mapPoints.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [40, 40], paddingBottomRight: [40, 280], animate: true });
    } else if (!active && mode === 'track' && trkPoints.length > 1) {
      const bounds = L.latLngBounds(trkPoints.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [40, 40], paddingBottomRight: [40, 280], animate: true });
    } else if (pos) {
      // If following is enabled, update view if:
      // 1. Initial lock hasn't happened
      // 2. Accuracy improved significantly (e.g. IP -> WiFi/GPS)
      // 3. We are in an active session
      const accuracyImproved = pos.accuracy < prevPosAccuracy.current * 0.7;
      
      if (!hasInitialLock.current || accuracyImproved || active) {
        const targetZoom = (map.getZoom() < 10 || accuracyImproved) ? 19 : map.getZoom();
        map.setView([pos.lat, pos.lng], targetZoom, { animate: true });
        hasInitialLock.current = true;
        prevPosAccuracy.current = pos.accuracy;
      }
    }
  }, [pos, active, map, completed, mapPoints, viewingRecord, mode, trkPoints, isFollowing]);

  return null;
};

const UserManual: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [fontSize, setFontSize] = useState<FontSize>('medium');
  const cycleFontSize = () => {
    if (fontSize === 'small') setFontSize('medium');
    else if (fontSize === 'medium') setFontSize('large');
    else setFontSize('small');
  };
  const textClasses = useMemo(() => {
    switch (fontSize) {
      case 'small': return 'text-[11px] leading-relaxed';
      case 'large': return 'text-lg leading-relaxed';
      default: return 'text-sm leading-relaxed';
    }
  }, [fontSize]);
  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col p-6 overflow-y-auto no-scrollbar">
      <div className="flex justify-between items-center mb-8 mt-4">
        <h2 className="text-3xl font-black text-blue-500 uppercase tracking-tighter">User Manual</h2>
        <div className="flex gap-2">
          <button onClick={cycleFontSize} className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-blue-400 active:scale-90 transition-all border border-white/10 shadow-lg" title="Cycle Font Size">
            <CaseSensitive size={24} strokeWidth={2.5} />
          </button>
          <button onClick={onClose} className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-white active:scale-90 transition-all border border-white/10 shadow-lg">
            <X size={24} />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-8 pb-20">
        {USER_MANUAL.map((section, idx) => (
          <div key={idx} className="bg-slate-900/50 border border-white/5 rounded-[2rem] p-6 shadow-xl">
             <div className="flex items-center gap-3 mb-3">
               <div className="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center shadow-lg">
                 {section.icon}
               </div>
               <h3 className={`text-xl font-black uppercase tracking-tight ${section.color}`}>{section.title}</h3>
             </div>
             <div className={`text-slate-400 font-semibold ${textClasses}`}>{section.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const DatasetInfo: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col p-6 overflow-y-auto no-scrollbar">
      <div className="flex justify-between items-center mb-8 mt-4">
        <h2 className="text-3xl font-black text-blue-500 uppercase tracking-tighter">Dataset Info</h2>
        <button onClick={onClose} className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-white active:scale-90 transition-all border border-white/10 shadow-lg">
          <X size={24} />
        </button>
      </div>
      <div className="flex flex-col gap-8 pb-20">
        <div className="bg-slate-900/50 border border-white/5 rounded-[2rem] p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center shadow-lg">
              <Layers className="text-blue-400" size={20} />
            </div>
            <h3 className="text-xl font-black uppercase tracking-tight text-white">Scottish LiDAR DTM</h3>
          </div>
          <div className="text-slate-400 font-semibold text-sm leading-relaxed space-y-4">
            <p>The App is currently utilizing <span className="text-blue-500">Digital Terrain Model (DTM)</span> data from the Scottish LiDAR dataset.</p>
            <p>This "bare earth" data is preferred for course rating as it filters out surface features like trees and buildings, providing the most accurate representation of the ground surface for elevation and slope calculations.</p>
            <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
              <p className="text-blue-400 text-xs font-bold uppercase mb-2">Coverage Note</p>
              <p className="text-xs">The Scottish LiDAR dataset does not yet cover the entire country. The App attempts to source data from various editions and years to maximize coverage. In areas where LiDAR is unavailable, the system will rely on device-based sensors.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC<{ onClose: () => void, onOpenDataset: () => void }> = ({ onClose, onOpenDataset }) => {
  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col p-6 overflow-y-auto no-scrollbar">
      <div className="flex justify-between items-center mb-8 mt-4">
        <h2 className="text-3xl font-black text-blue-500 uppercase tracking-tighter">Settings</h2>
        <button onClick={onClose} className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-white active:scale-90 transition-all border border-white/10 shadow-lg">
          <X size={24} />
        </button>
      </div>
      
      <div className="flex flex-col gap-4">
        <button 
          onClick={onOpenDataset}
          className="bg-slate-900/50 border border-white/5 rounded-2xl p-6 flex items-center gap-4 active:bg-slate-800 transition-colors text-left w-full"
        >
          <div className="w-12 h-12 bg-blue-600/20 rounded-full flex items-center justify-center text-blue-400 shrink-0">
            <Info size={24} />
          </div>
          <div className="flex flex-col flex-1">
            <span className="text-lg font-bold text-white">Dataset Information</span>
            <span className="text-xs text-slate-400">View details about terrain data sources</span>
          </div>
          <ChevronRight size={20} className="text-slate-600" />
        </button>
      </div>
    </div>
  );
};

const StimpCalculator: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [sDownFt, setSDownFt] = useState(0);
  const [sDownIn, setSDownIn] = useState(0);
  const [sUpFt, setSUpFt] = useState(0);
  const [sUpIn, setSUpIn] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const [slopeCat, setSlopeCat] = useState<string | null>(null);
  const [slopeSub, setSlopeSub] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const calculate = () => {
    const sDownTotal = sDownFt + sDownIn / 12;
    const sUpTotal = sUpFt + sUpIn / 12;
    if (sDownTotal + sUpTotal === 0) return;
    const corrected = (2 * sDownTotal * sUpTotal) / (sDownTotal + sUpTotal);
    setResult(corrected);
    if (sUpTotal > 0) {
      const ratioValue = sDownTotal / sUpTotal;
      if (ratioValue < 2) { setSlopeCat("<2'"); setSlopeSub("RF/GS"); }
      else if (ratioValue <= 3) { setSlopeCat("2'-3'"); setSlopeSub("MC/MS"); }
      else { setSlopeCat(">3'"); setSlopeSub("HC/SS"); }
    }
    setTimeout(() => { resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 100);
  };
  const adjustValue = (val: number, set: (v: number) => void, inc: number, min: number, max: number) => {
    const next = val + inc;
    if (next >= min && next <= max) set(next);
  };
  const formatResult = (val: number) => {
    const ft = Math.floor(val);
    const inches = Math.round((val - ft) * 12);
    if (inches === 12) return `${ft + 1}' 0"`;
    return `${ft}' ${inches}"`;
  };
  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col p-4 overflow-y-auto no-scrollbar">
      <div className="flex justify-between items-center mb-4 mt-2">
<button 
          onClick={onClose} 
          className="bg-slate-800 border border-white/20 w-[46px] h-[46px] rounded-full flex items-center justify-center shadow-2xl active:scale-95 transition-all"
          title="Home"
        >
          <Home size={20} className="text-yellow-400" />
        </button>
        <h1 className="text-3xl tracking-tighter font-semibold text-blue-500">Sloping Greens</h1>
      </div>
      <div className="flex flex-col items-center mb-6">
        <p className="text-slate-500 text-[9px] font-black uppercase tracking-widest text-center">Speed correction for sloping greens</p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="bg-slate-900/50 border border-white/5 rounded-[1.8rem] p-4">
          <h3 className="text-lg font-black text-orange-400 uppercase tracking-tight mb-4">s(down) Distance</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col items-center gap-2">
              <span className="text-[9px] font-black text-slate-500 uppercase">Feet</span>
              <div className="flex items-stretch bg-slate-800/80 rounded-[1.2rem] overflow-hidden border border-white/5 w-full h-[120px]">
                <div className="flex-1 flex items-center justify-center bg-slate-900/40"><span className="text-3xl font-black tabular-nums">{sDownFt}</span></div>
                <div className="w-16 flex flex-col border-l border-white/5">
                  <button onClick={() => adjustValue(sDownFt, setSDownFt, 1, 0, 50)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronUp size={28} /></button>
                  <button onClick={() => adjustValue(sDownFt, setSDownFt, -1, 0, 50)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronDown size={28} /></button>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <span className="text-[9px] font-black text-slate-500 uppercase">Inches</span>
              <div className="flex items-stretch bg-slate-800/80 rounded-[1.2rem] overflow-hidden border border-white/5 w-full h-[120px]">
                <div className="flex-1 flex items-center justify-center bg-slate-900/40"><span className="text-3xl font-black tabular-nums">{sDownIn}</span></div>
                <div className="w-16 flex flex-col border-l border-white/5">
                  <button onClick={() => adjustValue(sDownIn, setSDownIn, 3, 0, 9)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronUp size={28} /></button>
                  <button onClick={() => adjustValue(sDownIn, setSDownIn, -3, 0, 9)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronDown size={28} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-slate-900/50 border border-white/5 rounded-[1.8rem] p-4">
          <h3 className="text-lg font-black text-emerald-400 uppercase tracking-tight mb-4">s(up) Distance</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col items-center gap-2">
              <span className="text-[9px] font-black text-slate-500 uppercase">Feet</span>
              <div className="flex items-stretch bg-slate-800/80 rounded-[1.2rem] overflow-hidden border border-white/5 w-full h-[120px]">
                <div className="flex-1 flex items-center justify-center bg-slate-900/40"><span className="text-3xl font-black tabular-nums">{sUpFt}</span></div>
                <div className="w-16 flex flex-col border-l border-white/5">
                  <button onClick={() => adjustValue(sUpFt, setSUpFt, 1, 0, 50)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronUp size={28} /></button>
                  <button onClick={() => adjustValue(sUpFt, setSUpFt, -1, 0, 50)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronDown size={28} /></button>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <span className="text-[9px] font-black text-slate-500 uppercase">Inches</span>
              <div className="flex items-stretch bg-slate-800/80 rounded-[1.2rem] overflow-hidden border border-white/5 w-full h-[120px]">
                <div className="flex-1 flex items-center justify-center bg-slate-900/40"><span className="text-3xl font-black tabular-nums">{sUpIn}</span></div>
                <div className="w-16 flex flex-col border-l border-white/5">
                  <button onClick={() => adjustValue(sUpIn, setSUpIn, 3, 0, 9)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronUp size={28} /></button>
                  <button onClick={() => adjustValue(sUpIn, setSUpIn, -3, 0, 9)} className="flex-1 flex items-center justify-center text-blue-400 active:bg-blue-500/10 transition-colors"><ChevronDown size={28} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-4 mt-2 mb-12">
          <button onClick={calculate} disabled={(sDownFt === 0 && sDownIn === 0) || (sUpFt === 0 && sUpIn === 0)} className="w-full bg-blue-600 border-2 border-blue-500 rounded-full py-4 font-bold text-xs tracking-[0.2em] uppercase text-white shadow-xl active:scale-95 disabled:opacity-30 transition-all">Calculate Speed</button>
          {result !== null && (
            <div ref={resultRef} className="bg-white/[0.04] border border-blue-500/30 rounded-[1.8rem] p-6 flex flex-col items-start animate-in zoom-in-95 duration-300">
              <span className="text-[9px] font-bold text-blue-400 uppercase tracking-[0.3em] mb-2 w-full text-left">Corrected Green Speed</span>
              <div className="text-5xl font-bold text-white tabular-nums leading-none mb-1 flex items-center justify-between w-full">
                <span className="text-left">{formatResult(result)}</span>
                {slopeCat && (
                  <div className="flex flex-col items-center">
                    <span className="text-2xl text-blue-400 bg-blue-400/10 px-3 py-1 rounded-xl border border--400/20 tabular-nums">({slopeCat})</span>
                    {slopeSub && <span className="text-[14px] font-bold text-blue-500 uppercase mt-1 tracking-widest">{slopeSub}</span>}
                  </div>
                )}
              </div>
              <div className="mt-6 pt-6 border-t border-white/10 w-full flex justify-center">
                <p className="text-center font-light text-white leading-relaxed tracking-tight text-[14px]">(2x<span className="text-orange-400 font-semibold">s(down)</span> x <span className="text-emerald-400 font-semibold">s(up)</span>)÷(<span className="text-orange-400 font-semibold">s(down)</span>+<span className="text-emerald-400 font-semibold">s(up)</span>)</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const MapBoundsController = ({ points }: { points: GeoPoint[] }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
      // --- MICRO-DELAY STRATEGY START ---
      const timer = setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(bounds, { padding: [80, 80], animate: false });
      }, 100);
      return () => clearTimeout(timer);
      // --- MICRO-DELAY STRATEGY END ---
    }
  }, [points, map]);
  return null;
};

const MapRuler: React.FC<{ isSummary: boolean }> = ({ isSummary }) => {
  const map = useMap();
  const [pixelsPerMeter, setPixelsPerMeter] = useState(0);

  useEffect(() => {
    const update = () => {
      const center = map.getCenter();
      const p1 = map.latLngToContainerPoint(center);
      const p2 = L.point(p1.x + 100, p1.y);
      const ll2 = map.containerPointToLatLng(p2);
      const dist = map.distance(center, ll2);
      if (dist > 0) setPixelsPerMeter(100 / dist);
    };
    update();
    map.on('zoomend moveend resize', update);
    return () => { map.off('zoomend moveend resize', update); };
  }, [map]);

  if (isSummary || pixelsPerMeter <= 0) return null;

  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  
  const hTicks = [];
  for (let i = 0; i * pixelsPerMeter < width; i++) hTicks.push(i);
  
  const vTicks = [];
  for (let i = 0; i * pixelsPerMeter < height; i++) vTicks.push(i);

  return (
    <div className="absolute inset-0 pointer-events-none z-[1000]">
      <div className="absolute top-0 left-0 right-0 h-4 overflow-hidden">
        {hTicks.map(m => (
          <div key={`h-${m}`} className="absolute top-0 border-l border-black/30" style={{ left: m * pixelsPerMeter, height: m % 5 === 0 ? 12 : 6 }} />
        ))}
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-4 overflow-hidden">
        {hTicks.map(m => (
          <div key={`hb-${m}`} className="absolute bottom-0 border-l border-black/30" style={{ left: m * pixelsPerMeter, height: m % 5 === 0 ? 12 : 6 }} />
        ))}
      </div>
      <div className="absolute top-0 left-0 bottom-0 w-4 overflow-hidden">
        {vTicks.map(m => (
          <div key={`v-${m}`} className="absolute left-0 border-t border-black/30" style={{ top: m * pixelsPerMeter, width: m % 5 === 0 ? 12 : 6 }} />
        ))}
      </div>
      <div className="absolute top-0 right-0 bottom-0 w-4 overflow-hidden">
        {vTicks.map(m => (
          <div key={`vr-${m}`} className="absolute right-0 border-t border-black/30" style={{ top: m * pixelsPerMeter, width: m % 5 === 0 ? 12 : 6 }} />
        ))}
      </div>
    </div>
  );
};

const ReportView: React.FC<{ 
  greens: SavedRecord[], 
  fileName: string, 
  onClose: () => void,
  units: UnitSystem
}> = ({ greens, fileName, onClose, units }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const isSummaryPage = currentIndex === greens.length;
  const currentGreen = isSummaryPage ? null : greens[currentIndex];
  
  const totalArea = useMemo(() => {
    return greens.reduce((sum, g) => sum + calculateArea(g.points), 0);
  }, [greens]);

  const allPoints = useMemo(() => {
    return greens.flatMap(g => g.points);
  }, [greens]);

  const analysis = useMemo(() => {
    if (!currentGreen) return null;
    const pts = currentGreen.points;
    let perimeter = 0, bunkerLength = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = calculateDistance(pts[i], pts[i+1]);
      perimeter += d; if (pts[i+1].type === 'bunker') bunkerLength += d;
    }
    perimeter += calculateDistance(pts[pts.length-1], pts[0]);
    const shape = analyzeGreenShape(pts, 0.82);
    return { area: calculateArea(pts), perimeter, bunkerPct: perimeter > 0 ? Math.round((bunkerLength / perimeter) * 100) : 0, shape };
  }, [currentGreen]);

  const exportPDF = async () => {
    setIsExporting(true);
    const pdf = new jsPDF('p', 'mm', 'a4');

    // Export individual greens + summary page
    for (let i = 0; i <= greens.length; i++) {
      setCurrentIndex(i);
      // Wait for re-render and map to load
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      if (reportRef.current) {
        const canvas = await html2canvas(reportRef.current, {
          useCORS: true,
          scale: 1.5, // Reduced scale slightly for size
          logging: false,
          backgroundColor: '#ffffff'
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.75); // Use JPEG with compression
        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
        
        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
      }
    }
    
    pdf.save(`${fileName}_Report.pdf`);
    setIsExporting(false);
  };

  if (!currentGreen && !isSummaryPage) return null;

  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col overflow-hidden">
      <div className="bg-slate-900 border-b border-white/10 p-4 flex justify-between items-center shrink-0">
        <button onClick={onClose} className="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center text-white active:scale-90">
          <ChevronLeft size={24} />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">Report Preview</span>
          <span className="text-sm font-bold text-white truncate max-w-[200px]">{fileName}</span>
        </div>
        <button 
          onClick={exportPDF} 
          disabled={isExporting}
          className="bg-rose-700 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2 active:scale-95 disabled:opacity-50"
        >
          {isExporting ? <RotateCcw className="animate-spin" size={14} /> : <Printer size={14} />}
          {isExporting ? 'Exporting...' : 'Export PDF'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center bg-slate-950 no-scrollbar">
        <div 
          ref={reportRef}
          className="bg-white w-full max-w-[210mm] shadow-2xl flex flex-col p-8 border border-slate-200"
          style={{ height: 'auto', minHeight: '297mm' }}
        >
          <div className="flex justify-between items-end border-b border-slate-200 pb-4 mb-6">
            <div className="flex flex-col">
              <h1 className="text-2xl font-black text-blue-600 uppercase tracking-tighter">Scottish Golf</h1>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.3em]">Green Analysis Report</span>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className="text-[10px] font-bold text-slate-600 uppercase">{fileName}</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">{new Date().toLocaleString()}</span>
            </div>
          </div>

          <div className={`flex-1 bg-white rounded-2xl overflow-hidden relative mb-6 min-h-[400px] report-map ${!isSummaryPage ? 'border-4 border-black' : 'border border-slate-200'}`}>
             <style>{`
               .report-map .leaflet-container {
                 background: white !important;
               }
             `}</style>
             <MapContainer 
                key={`report-map-${currentIndex}`}
                center={isSummaryPage ? [allPoints[0].lat, allPoints[0].lng] : [currentGreen?.points[0].lat || 0, currentGreen?.points[0].lng || 0]} 
                zoom={isSummaryPage ? 16 : 20} 
                className="h-full w-full" 
                style={{ background: 'white' }}
                zoomControl={false} 
                attributionControl={false}
                dragging={false}
                scrollWheelZoom={false}
                doubleClickZoom={false}
                preferCanvas={true}
              >
                {isSummaryPage && <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} maxNativeZoom={19} />}
                <MapBoundsController points={isSummaryPage ? allPoints : (currentGreen?.points || [])} />
                <MapRuler isSummary={isSummaryPage} />
                
                {isSummaryPage ? (
                  greens.map((g, gIdx) => (
                    <React.Fragment key={`summary-green-${gIdx}`}>
                      <Polygon positions={g.points.map(p => [p.lat, p.lng])} fillColor="#e5e7eb" fillOpacity={0.6} weight={2} color="#10b981" />
                    </React.Fragment>
                  ))
                ) : (
                  <>
                    <Polygon positions={currentGreen?.points?.map(p => [p.lat, p.lng]) || []} fillColor="#374151" fillOpacity={0.8} weight={0} />
                    {currentGreen?.points?.map((p, i, arr) => {
                      if (i === 0) return null;
                      return <Polyline key={`rep-seg-${i}`} positions={[[arr[i-1].lat, arr[i-1].lng], [p.lat, p.lng]]} color={p.type === 'bunker' ? "#fb923c" : "#10b981"} weight={4} />;
                    })}
                    <Polyline positions={[[currentGreen?.points?.[currentGreen.points.length - 1]?.lat || 0, currentGreen?.points?.[currentGreen.points.length - 1]?.lng || 0], [currentGreen?.points?.[0]?.lat || 0, currentGreen?.points?.[0]?.lng || 0]]} color={currentGreen?.points?.[0]?.type === 'bunker' ? "#fb923c" : "#10b981"} weight={4} />
                    
                    {analysis?.shape && (
                      <>
                        {(() => {
                          const s = analysis.shape as any;
                          if (s.anomalousResult) {
                            return (
                              <>
                                <Polyline positions={[[s.pA.lat, s.pA.lng], [s.pB.lat, s.pB.lng]]} color="#93c5fd" weight={2} dashArray="5, 5" />
                                <Polyline positions={s.anomalousResult.spine.map((p: any) => [p.lat, p.lng])} color="#60a5fa" weight={3} dashArray="2, 4" />
                                {s.anomalousResult.widths.map((w: any, idx: number) => (
                                  <Polyline key={`rep-anom-w-${idx}`} positions={[[w.p1.lat, w.p1.lng], [w.p2.lat, w.p2.lng]]} color={w.color} weight={2} dashArray="4, 2" />
                                ))}
                              </>
                            );
                          } else if (s.isLShape && s.s1 && s.s2) {
                            return (
                              <>
                                <Polyline positions={[[s.s1.pA.lat, s.s1.pA.lng], [s.s1.pB.lat, s.s1.pB.lng]]} color="#3b82f6" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s1.pC.lat, s.s1.pC.lng], [s.s1.pD.lat, s.s1.pD.lng]]} color="#facc15" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s2.pA.lat, s.s2.pA.lng], [s.s2.pB.lat, s.s2.pB.lng]]} color="#f472b6" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s2.pC.lat, s.s2.pC.lng], [s.s2.pD.lat, s.s2.pD.lng]]} color="#10b981" weight={2} dashArray="5, 5" />
                              </>
                            );
                          } else {
                            return (
                              <>
                                {s.pA && s.pB && <Polyline positions={[[s.pA.lat, s.pA.lng], [s.pB.lat, s.pB.lng]]} color="#3b82f6" weight={2} dashArray="5, 5" />}
                                {s.isInconsistent ? (
                                  <>
                                    {s.pC1 && s.pD1 && <Polyline positions={[[s.pC1.lat, s.pC1.lng], [s.pD1.lat, s.pD1.lng]]} color="#facc15" weight={2} dashArray="5, 5" />}
                                    {s.pC3 && s.pD3 && <Polyline positions={[[s.pC3.lat, s.pC3.lng], [s.pD3.lat, s.pD3.lng]]} color="#10b981" weight={2} dashArray="5, 5" />}
                                  </>
                                ) : (
                                  s.pC && s.pD && <Polyline positions={[[s.pC.lat, s.pC.lng], [s.pD.lat, s.pD.lng]]} color="#facc15" weight={2} dashArray="5, 5" />
                                )}
                              </>
                            );
                          }
                        })()}
                      </>
                    )}
                  </>
                )}
             </MapContainer>
          </div>

          {isSummaryPage ? (
            <div className="flex flex-col gap-6">
              <div className="bg-black border border-white/10 rounded-2xl p-6">
                <span className="text-xs font-black text-blue-400 uppercase tracking-widest block mb-4">Course Summary</span>
                <div className="grid grid-cols-2 gap-8">
                  <div>
                    <span className="text-[10px] font-bold text-white/40 uppercase block mb-1">Total Greens Analyzed:</span>
                    <span className="text-3xl font-black text-white">{greens.length}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-white/40 uppercase block mb-1">Total Green Area:</span>
                    <div className="flex flex-col gap-1">
                      <span className="text-3xl font-black text-emerald-400">{Math.round(totalArea * 1.196).toLocaleString()} yd²</span>
                      <span className="text-3xl font-black text-emerald-400">{Math.round(totalArea).toLocaleString()} m²</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black border border-white/10 rounded-2xl p-4">
                  <span className="text-[10px] font-bold text-white/40 uppercase block mb-2">Average Green Area:</span>
                  <div className="flex flex-col">
                    <span className="text-xl font-bold text-white">{Math.round((totalArea / greens.length) * 1.196)} yd²</span>
                    <span className="text-xl font-bold text-white">{Math.round(totalArea / greens.length)} m²</span>
                  </div>
                </div>
                <div className="bg-black border border-white/10 rounded-2xl p-4">
                  <span className="text-[10px] font-bold text-white/40 uppercase block mb-2">Analysis Date:</span>
                  <span className="text-xl font-bold text-white">{new Date().toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-6 mb-8">
                <div className="bg-black border border-white/10 rounded-2xl p-4">
                  <span className="text-[9px] font-black text-blue-400 uppercase tracking-widest block mb-2">Identification</span>
                  <div className="text-2xl font-bold text-white mb-1">Green #{currentGreen?.holeNumber || currentIndex + 1}</div>
                </div>
                <div className="bg-black border border-white/10 rounded-2xl p-4">
                  <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest block mb-2">Dimensions</span>
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-baseline">
                      <span className="text-[10px] font-bold text-white/40 uppercase">Area:</span>
                      <span className="text-sm font-bold text-white">{Math.round((analysis?.area || 0) * 1.196)} yd² / {Math.round(analysis?.area || 0)} m²</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-[10px] font-bold text-white/40 uppercase">Perim:</span>
                      <span className="text-sm font-bold text-white">{((analysis?.perimeter || 0) * 1.09361).toFixed(1)} yd / {(analysis?.perimeter || 0).toFixed(1)} m</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-[10px] font-bold text-white/40 uppercase">Sand:</span>
                      <span className={`text-sm font-bold ${getBunkerPercentageColor(analysis?.bunkerPct)}`}>{analysis?.bunkerPct}%</span>
                    </div>
                  </div>
                </div>
                <div className="bg-black border border-white/10 rounded-2xl p-4">
                  <span className="text-[9px] font-black text-yellow-400 uppercase tracking-widest block mb-2">EGD Analysis</span>
                  <div className="flex flex-col mb-2">
                    {(() => {
                      const s = analysis?.shape as any;
                      if (s?.isLShape && !s?.isAnomalous) {
                        return (
                          <>
                            <div className="text-2xl font-black text-yellow-400 leading-none">
                              {s.s1?.egd.toFixed(1)} / {s.s2?.egd.toFixed(1)} <span className="text-xs opacity-40">YD</span>
                            </div>
                            <div className="text-lg font-bold text-yellow-400/60 leading-none mt-1">
                              {(s.s1?.egd / 1.09361).toFixed(1)} / {(s.s2?.egd / 1.09361).toFixed(1)} <span className="text-xs opacity-40">M</span>
                            </div>
                          </>
                        );
                      }
                      if (s?.isAnomalous) return <div className="text-3xl font-black text-yellow-400">---</div>;
                      return (
                        <>
                          <div className="text-3xl font-black text-yellow-400 leading-none">
                            {s?.egd.toFixed(1)} <span className="text-xs opacity-40">YD</span>
                          </div>
                          <div className="text-xl font-bold text-yellow-400/60 leading-none mt-1">
                            {(s?.egd / 1.09361).toFixed(1)} <span className="text-xs opacity-40">M</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div className="text-[9px] font-bold text-white/40 uppercase mb-2">Method: {analysis?.shape?.method || 'N/A'}</div>
                  
                  {/* Raw Data Display */}
                  <div className="border-t border-white/10 pt-2 flex flex-col gap-1">
                    {(() => {
                      const s = analysis?.shape as any;
                      if (!s) return null;
                      if (s.anomalousResult) {
                        return (
                          <>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-blue-400">L(curv):</span>
                              <span className="text-white">{(s.anomalousResult.curvedLength).toFixed(1)}y / {(s.anomalousResult.curvedLength / 1.09361).toFixed(1)}m</span>
                            </div>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-orange-400">W1:</span>
                              <span className="text-white">{(s.anomalousResult.widths[0]?.w).toFixed(1)}y / {(s.anomalousResult.widths[0]?.w / 1.09361).toFixed(1)}m</span>
                            </div>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-yellow-400">W2:</span>
                              <span className="text-white">{(s.anomalousResult.widths[1]?.w).toFixed(1)}y / {(s.anomalousResult.widths[1]?.w / 1.09361).toFixed(1)}m</span>
                            </div>
                          </>
                        );
                      } else if (s.isLShape && s.s1 && s.s2) {
                        return (
                          <>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-blue-400">P1 L/W:</span>
                              <span className="text-white">{s.s1.L.toFixed(1)}y / {s.s1.W.toFixed(1)}y</span>
                            </div>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-fuchsia-400">P2 L/W:</span>
                              <span className="text-white">{s.s2.L.toFixed(1)}y / {s.s2.W.toFixed(1)}y</span>
                            </div>
                          </>
                        );
                      } else {
                        return (
                          <>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-blue-400">Length:</span>
                              <span className="text-white">{s.L.toFixed(1)}y / {(s.L / 1.09361).toFixed(1)}m</span>
                            </div>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-yellow-400">Width:</span>
                              <span className="text-white">{s.W.toFixed(1)}y / {(s.W / 1.09361).toFixed(1)}m</span>
                            </div>
                            <div className="flex justify-between text-[9px] font-bold uppercase">
                              <span className="text-white/40">Ratio:</span>
                              <span className="text-white">{s.ratio.toFixed(2)}</span>
                            </div>
                          </>
                        );
                      }
                    })()}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="mt-auto pt-4 border-t border-slate-200 flex justify-between items-center">
            <span className="text-[9px] font-bold text-slate-300 uppercase tracking-widest">Scottish Golf Course Rating Toolkit v03.26</span>
            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              {isSummaryPage ? 'Report Summary' : `Page ${currentIndex + 1} of ${greens.length + 1}`}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border-t border-white/10 p-6 flex justify-between items-center shrink-0">
        <button 
          onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
          disabled={currentIndex === 0}
          className="flex items-center gap-2 text-white font-bold uppercase text-xs tracking-widest disabled:opacity-30"
        >
          <ChevronLeft size={20} /> Previous
        </button>
        <span className="text-white/60 font-bold text-xs uppercase tracking-widest">
          {isSummaryPage ? 'Summary Page' : `Green ${currentIndex + 1} of ${greens.length}`}
        </span>
        <button 
          onClick={() => setCurrentIndex(prev => Math.min(greens.length, prev + 1))}
          disabled={currentIndex === greens.length}
          className="flex items-center gap-2 text-white font-bold uppercase text-xs tracking-widest disabled:opacity-30"
        >
          Next <ChevronRight size={20} />
        </button>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('landing');
  const [units, setUnits] = useState<UnitSystem>('Yards');
  const [mapStyle, setMapStyle] = useState<'Street' | 'Satellite' | 'LiDAR DTM'>('Satellite');
  const [pos, setPos] = useState<GeoPoint | null>(null);
  const [history, setHistory] = useState<SavedRecord[]>([]);
  const [viewingRecord, setViewingRecord] = useState<SavedRecord | null>(null);
  const [viewingTrackProfile, setViewingTrackProfile] = useState<TrackProfileView>('Rater\'s Walk');
  const [mapLockKey, setMapLockKey] = useState(0);
  const [locationResetKey, setLocationResetKey] = useState(0);
  const [trkActive, setTrkActive] = useState(false);
  const [trkPoints, setTrkPoints] = useState<GeoPoint[]>([]);
  const [currentPivots, setCurrentPivots] = useState<PivotRecord[]>([]);
  const [holeNum, setHoleNum] = useState(1);
  const [ratingGender, setRatingGender] = useState<RatingGender>('Men');
  const [showPivotMenu, setShowPivotMenu] = useState(false);
  const [pendingPivotType, setPendingPivotType] = useState<PivotRecord['type'] | null>(null);
  const [mapActive, setMapActive] = useState(false);
  const [mapCompleted, setMapCompleted] = useState(false);
  const [mapPoints, setMapPoints] = useState<GeoPoint[]>([]);
  const [isBunker, setIsBunker] = useState(false);
  const [ovalMode, setOvalMode] = useState<OvalMode>('off');
  const [isFollowing, setIsFollowing] = useState(true);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<GeoPoint | null>(null);
  const [lidarStatus, setLidarStatus] = useState<'idle' | 'loading' | 'error' | 'available'>('idle');
  const [lidarDebug, setLidarDebug] = useState<{ url: string, response: any, coords: { lat: number, lng: number } | null }>({ url: '', response: null, coords: null });
  const [showLidarDebug, setShowLidarDebug] = useState(false);
  const [lidarLayerLoading, setLidarLayerLoading] = useState(false);
  const [reportGreens, setReportGreens] = useState<SavedRecord[]>([]);
  const [reportFileName, setReportFileName] = useState("");
  const CONCAVITY_FIXED = 0.82;
  const greenStartRef = useRef<GeoPoint | null>(null);
  const lidarFetchRef = useRef<number>(0);

  useEffect(() => {
    if (!isFollowing && mapCenter && mapStyle === 'LiDAR DTM') {
      const timer = setTimeout(() => {
        fetchLidarElevation(mapCenter.lat, mapCenter.lng);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [mapCenter, isFollowing, mapStyle]);

  const fetchLidarElevation = async (lat: number, lng: number): Promise<number | null> => {
    setLidarStatus('loading');
    setLidarDebug(prev => ({ ...prev, coords: { lat, lng }, response: 'Waiting for response...', url: 'Constructing...' }));
    
    const identifyUrl = `https://spatialdata.gov.scot/arcgis/rest/services/Public/Lidar_DTM_1m/MapServer/identify`;
    
    const params = {
      f: 'json',
      geometryType: 'esriGeometryPoint',
      geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
      tolerance: '3',
      mapExtent: `${lng - 0.001},${lat - 0.001},${lng + 0.001},${lat + 0.001}`,
      imageDisplay: '100,100,96',
      layers: 'all:0',
      returnGeometry: 'false',
      sr: '4326'
    };

    const queryString = Object.entries(params)
      .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
      .join('&');
    
    const fullUrl = `${identifyUrl}?${queryString}`;
    setLidarDebug(prev => ({ ...prev, url: fullUrl }));

    try {
      const response = await fetch(fullUrl, { method: 'GET', mode: 'cors' });
      
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setLidarDebug(prev => ({ ...prev, response: data }));

      if (data && data.results && data.results.length > 0) {
        const res = data.results[0];
        const val = parseFloat(res.value || res.attributes?.['Pixel Value'] || res.attributes?.['Value'] || res.attributes?.['value']);
        if (!isNaN(val)) {
          setLidarStatus('available');
          return val;
        }
      }
      
      setLidarStatus('error');
      return null;
    } catch (error: any) {
      console.error("LiDAR Fetch Error:", error);
      setLidarStatus('error');
      setLidarDebug(prev => ({ ...prev, response: `FETCH ERROR: ${error.message || 'Unknown error'}` }));
      return null;
    }
  };

  const viewRef = useRef<AppView>(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    const saved = localStorage.getItem('scottish_golf_rating_toolkit_final');
    if (saved) { try { setHistory(JSON.parse(saved)); } catch (e) { console.error(e); } }
    
    const handleUpdate = (p: GeolocationPosition) => {
      setPos(prev => {
        const newPos: GeoPoint = { 
          lat: p.coords.latitude, 
          lng: p.coords.longitude, 
          alt: p.coords.altitude, 
          accuracy: p.coords.accuracy, 
          altAccuracy: p.coords.altitudeAccuracy, 
          timestamp: Date.now(),
          source: 'GPS'
        };

        if (!prev) return newPos;

        // Calculate rough distance jump (approximate degrees to meters)
        const dLat = Math.abs(newPos.lat - prev.lat);
        const dLng = Math.abs(newPos.lng - prev.lng);
        const isHugeJump = dLat > 0.5 || dLng > 0.5; // Roughly > 50km jump

        // If it's a huge jump, we should probably trust the new one if it's reasonably accurate
        // or if the previous one was very inaccurate.
        if (isHugeJump && newPos.accuracy < 5000) return newPos;

        if (newPos.accuracy < prev.accuracy * 0.8) return newPos;
        if (Date.now() - prev.timestamp > 20000) return newPos;
        if (newPos.accuracy <= prev.accuracy * 1.2) return newPos;

        return prev;
      });
    };

    // Clear any existing state for a clean start
    setPos(null);

    const options = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    };

    const coarseOptions = {
      enableHighAccuracy: false,
      maximumAge: 0,
      timeout: 5000
    };

    const handleError = (error: GeolocationPositionError) => {
      console.error("Geolocation error:", error);
      switch(error.code) {
        case error.PERMISSION_DENIED:
          setGpsError("Permission Denied: Please allow location access in your browser settings or open the app in a new tab.");
          break;
        case error.POSITION_UNAVAILABLE:
          setGpsError("Position Unavailable: GPS signal might be weak.");
          break;
        case error.TIMEOUT:
          setGpsError("Timeout: GPS request timed out.");
          break;
        default:
          setGpsError("An unknown error occurred with GPS.");
      }
    };

    const checkPermission = async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const result = await navigator.permissions.query({ name: 'geolocation' as any });
          if (result.state === 'denied') {
            setGpsError("Permission Denied: Please reset location permissions for this site in your browser address bar.");
          }
          result.onchange = () => {
            if (result.state === 'granted') setLocationResetKey(k => k + 1);
          };
        }
      } catch (e) {
        console.warn("Permissions API not supported", e);
      }
    };
    checkPermission();

    // Try multiple strategies
    navigator.geolocation.getCurrentPosition(handleUpdate, 
      () => navigator.geolocation.getCurrentPosition(handleUpdate, handleError, coarseOptions), 
      options
    );

    const watch = navigator.geolocation.watchPosition(
      async (p) => {
        setGpsError(null);
        handleUpdate(p);
        if (viewRef.current === 'track') {
          const currentTs = Date.now();
          lidarFetchRef.current = currentTs;
          const lidarAlt = await fetchLidarElevation(p.coords.latitude, p.coords.longitude);
          if (lidarFetchRef.current === currentTs && lidarAlt !== null) {
            const LIDAR_ACCURACY = 0.2;
            setPos(prev => {
              if (!prev || prev.timestamp > currentTs) return prev;
              if (prev.altAccuracy === null || prev.altAccuracy > LIDAR_ACCURACY) {
                return { ...prev, alt: lidarAlt, altAccuracy: LIDAR_ACCURACY, source: 'LiDAR' };
              }
              return prev;
            });
          }
        }
      },
      (err) => {
        handleError(err);
        navigator.geolocation.getCurrentPosition(handleUpdate, null, coarseOptions);
      },
      { ...options, timeout: 60000 }
    );

    return () => navigator.geolocation.clearWatch(watch);
  }, [locationResetKey]);

  const saveRecord = useCallback((record: Omit<SavedRecord, 'id' | 'date'>) => {
    const newRecord: SavedRecord = { ...record, id: Math.random().toString(36).substr(2, 9), date: Date.now() };
    const updated = [newRecord, ...history];
    setHistory(updated);
    localStorage.setItem('scottish_golf_rating_toolkit_final', JSON.stringify(updated));
  }, [history]);

  const analysis = useMemo(() => {
    const pts = viewingRecord?.type === 'Green' ? viewingRecord.points : mapPoints;
    if (!pts || pts.length < 2) return null;
    let perimeter = 0, bunkerLength = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = calculateDistance(pts[i], pts[i+1]);
      perimeter += d; if (pts[i+1].type === 'bunker') bunkerLength += d;
    }
    if (mapCompleted || (viewingRecord && viewingRecord.type === 'Green')) perimeter += calculateDistance(pts[pts.length-1], pts[0]);
    const shape = (pts.length >= 3 && (mapCompleted || viewingRecord)) ? analyzeGreenShape(pts, CONCAVITY_FIXED) : null;
    
    let egdDisplay = "--";
    if (shape) {
      const s = shape as any;
      const m = units === 'Yards' ? 1 : (1 / 1.09361);
      if (s.isAnomalous) egdDisplay = "---";
      else if (s.anomalousResult && s.anomalousResult.isManualReq) egdDisplay = "MANUAL";
      else if (s.isLShape) egdDisplay = `${(s.s1?.egd * m).toFixed(1)}/${(s.s2?.egd * m).toFixed(1)}`;
      else egdDisplay = `${(s.egd * m).toFixed(1)}`;
    }
    
    return { area: calculateArea(pts), perimeter, bunkerPct: perimeter > 0 ? Math.round((bunkerLength / perimeter) * 100) : 0, shape, egdDisplay };
  }, [mapPoints, mapCompleted, viewingRecord, units]);

  const handleFinalizeGreen = useCallback(() => {
    if (mapPoints.length < 3) return;

    // Bowditch-inspired Loop Closure: Distribute drift error linearly
    const first = mapPoints[0];
    const last = mapPoints[mapPoints.length - 1];
    
    // Calculate the "True Home" (midpoint between start and end)
    const midLat = (first.lat + last.lat) / 2;
    const midLng = (first.lng + last.lng) / 2;
    
    const startOffLat = midLat - first.lat;
    const startOffLng = midLng - first.lng;
    const endOffLat = midLat - last.lat;
    const endOffLng = midLng - last.lng;

    const correctedPoints = mapPoints.map((p, i) => {
      const t = i / (mapPoints.length - 1);
      const latShift = (1 - t) * startOffLat + t * endOffLat;
      const lngShift = (1 - t) * startOffLng + t * endOffLng;
      return { ...p, lat: p.lat + latShift, lng: p.lng + lngShift };
    });

    const shape = analyzeGreenShape(correctedPoints, CONCAVITY_FIXED);
    const areaVal = Math.round(calculateArea(correctedPoints) * (units === 'Yards' ? 1.196 : 1));
    let egdStr = "--";
    const s = shape as any;
    const m = units === 'Yards' ? 1 : (1 / 1.09361);
    const uLabel = units === 'Yards' ? 'yd' : 'm';
    if (s) {
      if (s.isAnomalous) egdStr = "---";
      else if (s.anomalousResult && s.anomalousResult.isManualReq) egdStr = "MANUAL REQ";
      else if (s.isLShape) egdStr = `${(s.s1?.egd * m).toFixed(1)} / ${(s.s2?.egd * m).toFixed(1)} ${uLabel}`;
      else egdStr = `${(s.egd * m).toFixed(1)} ${uLabel}`;
    }

    // Recalculate bunker percentage for corrected points
    let perimeter = 0, bunkerLength = 0;
    for (let i = 0; i < correctedPoints.length - 1; i++) {
      const d = calculateDistance(correctedPoints[i], correctedPoints[i+1]);
      perimeter += d; if (correctedPoints[i+1].type === 'bunker') bunkerLength += d;
    }
    perimeter += calculateDistance(correctedPoints[correctedPoints.length-1], correctedPoints[0]);
    const bunkerPct = perimeter > 0 ? Math.round((bunkerLength / perimeter) * 100) : 0;

    saveRecord({ 
      type: 'Green', 
      primaryValue: `${areaVal}${units === 'Yards' ? 'yd²' : 'm²'}`, 
      secondaryValue: `Bunker: ${bunkerPct}%`, 
      egdValue: egdStr, 
      points: correctedPoints, 
      holeNumber: holeNum 
    });
    
    setMapPoints(correctedPoints);
    setMapActive(false); setMapCompleted(true);
  }, [mapPoints, units, saveRecord, holeNum]);

  useEffect(() => {
    if (mapActive && pos) {
      // Accuracy gate: ignore low-confidence positions to prevent jumps
      if (pos.accuracy >= 4.0) return;

      if (mapPoints.length === 0) {
        // Motion Trigger logic: Wait for 2.0m movement before starting recording
        if (!greenStartRef.current) {
          greenStartRef.current = pos;
        } else {
          const distFromStandby = calculateDistance(greenStartRef.current, pos);
          if (distFromStandby >= 2.0) {
            setMapPoints([{ ...pos, type: isBunker ? 'bunker' : 'green' }]);
          }
        }
      } else {
        // High-resolution recording after movement confirmed
        setMapPoints(prev => {
          const last = prev[prev.length - 1];
          if (last && calculateDistance(last, pos) >= 0.4) {
            return [...prev, { ...pos, type: isBunker ? 'bunker' : 'green' }];
          }
          return prev;
        });

        // Auto-close logic checks proximity to the motion-triggered origin
        if (mapPoints.length > 20 && calculateDistance(pos, mapPoints[0]) < 0.9) {
          handleFinalizeGreen();
        }
      }
    }
  }, [pos, mapActive, isBunker, mapPoints.length, handleFinalizeGreen]);

  const distMult = units === 'Yards' ? 1.09361 : 1.0;
  const elevMult = units === 'Yards' ? 3.28084 : 1.0;

  const effectiveMetrics = useMemo(() => {
    const currentRaterPath = [...trkPoints, ...(trkActive && pos ? [pos] : [])].filter(Boolean) as GeoPoint[];
    const pivs = viewingRecord ? (viewingRecord.pivotPoints || []) : currentPivots;
    const targetPoint = viewingRecord ? (viewingRecord.raterPathPoints ? viewingRecord.raterPathPoints[viewingRecord.raterPathPoints.length - 1] : null) : (trkActive ? pos : (trkPoints.length > 0 ? trkPoints[trkPoints.length-1] : null));

    const sectorScratch = (() => {
      if (!targetPoint) return null;
      const filtered = pivs.filter(p => p.type === 'common' || p.type === 'scratch_cut').sort((a, b) => b.point.timestamp - a.point.timestamp);
      return filtered.length > 0 ? calculateDistance(filtered[0].point, targetPoint) * distMult : null;
    })();
    const sectorBogey = (() => {
      if (!targetPoint) return null;
      const filtered = pivs.filter(p => p.type === 'common' || p.type === 'bogoy_round').sort((a, b) => b.point.timestamp - a.point.timestamp);
      return filtered.length > 0 ? calculateDistance(filtered[0].point, targetPoint) * distMult : null;
    })();

    if (viewingRecord && viewingRecord.type === 'Track' && viewingRecord.effectiveDistances) {
      const raterPathMetrics = calculatePathDistanceAndElevation(viewingRecord.raterPathPoints || [], distMult, elevMult);
      return { distRater: raterPathMetrics.distance, elevRater: raterPathMetrics.elevation, distScratch: viewingRecord.effectiveDistances.scratch, elevScratch: viewingRecord.effectiveElevations?.scratch || 0, distBogey: viewingRecord.effectiveDistances.bogey, elevBogey: viewingRecord.effectiveElevations?.bogey || 0, effectivePaths: viewingRecord.effectivePaths, sectorScratch, sectorBogey };
    }

    if (currentRaterPath.length < 2) return { distRater: 0, elevRater: 0, distScratch: 0, elevScratch: 0, distBogey: 0, elevBogey: 0, effectivePaths: { scratch: [], bogey: [] }, sectorScratch: null, sectorBogey: null };
    
    const calculated = calculateEffectivePathsAndMetrics(currentRaterPath, currentPivots, distMult, elevMult);
    const raterPathMetrics = calculatePathDistanceAndElevation(currentRaterPath, distMult, elevMult);
    return { distRater: raterPathMetrics.distance, elevRater: raterPathMetrics.elevation, distScratch: calculated.effectiveDistances.scratch, elevScratch: calculated.effectiveElevations.scratch, distBogey: calculated.effectiveDistances.bogey, elevBogey: calculated.effectiveElevations.bogey, effectivePaths: calculated.effectivePaths, sectorScratch, sectorBogey };
  }, [trkPoints, currentPivots, trkActive, pos, viewingRecord, distMult, elevMult]);

  const pathsDiffer = useMemo(() => {
    const s = effectiveMetrics.effectivePaths?.scratch || [];
    const b = effectiveMetrics.effectivePaths?.bogey || [];
    if (s.length !== b.length) return true;
    for (let i = 0; i < s.length; i++) {
      if (s[i].lat !== b[i].lat || s[i].lng !== b[i].lng) return true;
    }
    return false;
  }, [effectiveMetrics.effectivePaths]);

  const handleOpenRecord = (record: SavedRecord) => {
    setViewingRecord(record); if (record.holeNumber) setHoleNum(record.holeNumber);
    if (record.type === 'Track') { setView('track'); setTrkActive(false); setTrkPoints([]); setCurrentPivots([]); setViewingTrackProfile('Rater\'s Walk'); if (record.genderRated) setRatingGender(record.genderRated); }
    else { setView('green'); setMapActive(false); setMapCompleted(true); }
  };

  const handleConfirmPivot = useCallback(() => {
    if (pos && pendingPivotType) { setCurrentPivots(prev => [...prev, { point: pos, type: pendingPivotType }]); setTrkPoints(prev => [...prev, pos]); setPendingPivotType(null); setShowPivotMenu(false); }
  }, [pos, pendingPivotType]);

  const exportKML = () => {
    let kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Scottish Golf Export</name>`;
    history.forEach(item => {
      const coords = (item.type === 'Track' && item.raterPathPoints ? item.raterPathPoints : item.points).map(p => `${p.lng},${p.lat},${p.alt || 0}`).join(' ');
      kml += `<Placemark><name>${item.type} - Hole ${item.holeNumber || '?'}</name><description>Hole:${item.holeNumber || '?'}; Type: ${item.type}</description>${item.type === 'Green' ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords} ${item.points[0].lng},${item.points[0].lat},${item.points[0].alt || 0}</coordinates></LinearRing></outerBoundaryIs></Polygon>` : `<LineString><coordinates>${coords}</coordinates></LineString>`}</Placemark>`;
    });
    kml += `</Document></kml>`;
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${String(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    a.href = url; a.download = `${ts}.kml`; a.click(); URL.revokeObjectURL(url);
  };

  const importKML = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const fileName = file.name.replace(/\.[^/.]+$/, "");
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "text/xml");
      const placemarks = xmlDoc.getElementsByTagName("Placemark");
      const newItems: SavedRecord[] = [];
      for (let i = 0; i < placemarks.length; i++) {
        const p = placemarks[i];
        const nameStr = p.getElementsByTagName("name")[0]?.textContent || "";
        const coordsStr = p.getElementsByTagName("coordinates")[0]?.textContent || "";
        const descStr = p.getElementsByTagName("description")[0]?.textContent || "";
        let extractedHole = parseInt(descStr.match(/Hole:(\d+)/)?.[1] || "0");
        const points = coordsStr.trim().split(/\s+/).map(c => { const parts = c.split(',').map(Number); return { lat: parts[1], lng: parts[0], alt: parts[2] || 0, accuracy: 0, altAccuracy: 0, timestamp: Date.now() }; });
        if (points.length < 2) continue;
        
        const first = points[0];
        const last = points[points.length - 1];
        const distToStart = calculateDistance(first, last);
        const isActuallyGreen = !!p.getElementsByTagName("Polygon")[0] || descStr.includes("Type: Green") || nameStr.startsWith("Green") || distToStart < 5;
        
        const record: SavedRecord = { id: Math.random().toString(36).substr(2, 9), date: Date.now(), type: isActuallyGreen ? 'Green' : 'Track', points, holeNumber: extractedHole || undefined, primaryValue: fileName.substring(0, 6) + "...", secondaryValue: 'KML Data' };
        newItems.push(record);
      }
      setHistory(prev => [...newItems, ...prev]);
    };
    reader.readAsText(file);
  };

  const importKMLForReport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const fileName = file.name.replace(/\.[^/.]+$/, "");
    setReportFileName(fileName);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "text/xml");
      const placemarks = xmlDoc.getElementsByTagName("Placemark");
      const greens: SavedRecord[] = [];
      for (let i = 0; i < placemarks.length; i++) {
        const p = placemarks[i];
        const nameStr = p.getElementsByTagName("name")[0]?.textContent || "";
        const coordsStr = p.getElementsByTagName("coordinates")[0]?.textContent || "";
        const descStr = p.getElementsByTagName("description")[0]?.textContent || "";
        
        // Improved hole extraction: check description then name
        let holeMatch = descStr.match(/Hole:?\s*(\d+)/i) || nameStr.match(/Hole:?\s*(\d+)/i) || nameStr.match(/(\d+)/);
        let extractedHole = holeMatch ? parseInt(holeMatch[1]) : 0;
        
        const points = coordsStr.trim().split(/\s+/).map(c => { const parts = c.split(',').map(Number); return { lat: parts[1], lng: parts[0], alt: parts[2] || 0, accuracy: 0, altAccuracy: 0, timestamp: Date.now() }; });
        if (points.length < 3) continue;
        
        const first = points[0];
        const last = points[points.length - 1];
        const distToStart = calculateDistance(first, last);
        const isActuallyGreen = !!p.getElementsByTagName("Polygon")[0] || descStr.includes("Type: Green") || nameStr.toLowerCase().includes("green") || distToStart < 5;
        
        if (isActuallyGreen) {
          const record: SavedRecord = { id: Math.random().toString(36).substr(2, 9), date: Date.now(), type: 'Green', points, holeNumber: extractedHole || undefined, primaryValue: nameStr || `Green ${i+1}`, secondaryValue: 'Report Data' };
          greens.push(record);
        }
      }
      if (greens.length > 0) {
        // Sort by hole number (1 to 18)
        greens.sort((a, b) => (a.holeNumber || 999) - (b.holeNumber || 999));
        setReportGreens(greens);
        setView('report');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#020617] text-white overflow-hidden absolute inset-0 select-none font-sans">
      <div className="h-[env(safe-area-inset-top)] bg-[#0f172a] shrink-0"></div>
      {view === 'landing' ? (
        <div className="flex-1 flex flex-col p-6 overflow-y-auto no-scrollbar animate-in fade-in duration-700">
          <header className="mb-12 mt-8 flex flex-col items-center text-center relative">
            <h1 className="text-5xl tracking-tighter font-bold text-blue-500">Scottish Golf</h1>
            <p className="text-white text-[11px] font-bold tracking-[0.4em] uppercase mt-2 opacity-80">
              Enhanced Course Rating Toolkit v03.26
              <br />
              <span className="text-yellow-400">DTM Edition</span>
            </p>
            {gpsError && (
              <div className="mt-6 bg-rose-500/20 border border-rose-500/30 p-4 rounded-2xl flex flex-col gap-3 animate-pulse">
                <div className="flex items-center gap-3">
                  <AlertTriangle size={16} className="text-rose-400 shrink-0" />
                  <p className="text-[10px] font-bold text-rose-400 uppercase tracking-widest text-left leading-relaxed">{gpsError}</p>
                </div>
                <button 
                  onClick={() => setLocationResetKey(k => k + 1)}
                  className="bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest text-rose-400 transition-all active:scale-95"
                >
                  Retry GPS Connection
                </button>
              </div>
            )}
            {!gpsError && !pos && (
              <div className="mt-6 bg-blue-500/10 border border-blue-500/20 p-4 rounded-2xl flex items-center gap-3">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-ping" />
                <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">Waiting for GPS lock...</p>
              </div>
            )}
          </header>
          <div className="flex flex-col gap-6">
            <div className="flex justify-end -mb-2">
              <button 
                onClick={() => setView('settings')}
                className="bg-slate-800/50 border border-white/10 p-2.5 rounded-full text-slate-400 active:scale-95 transition-all shadow-lg"
                title="Settings"
              >
                <Settings size={24} />
              </button>
            </div>
            <button onClick={() => { setViewingRecord(null); setTrkPoints([]); setCurrentPivots([]); setView('track'); }} className="bg-slate-900 border border-white/5 rounded-[2.5rem] p-10 flex flex-col items-center justify-center shadow-2xl active:scale-95 transition-all">
              <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mb-6 shadow-xl shadow-blue-600/40"><Navigation2 size={28} /></div>
              <h2 className="text-2xl font-bold mb-2 uppercase text-blue-500">Distance tracker</h2>
              <p className="text-slate-400 text-[11px] font-medium text-center max-w-[220px]">Real-time distance measurement and elevation change</p>
            </button>
            <div className="bg-slate-900/50 border border-white/5 rounded-[1.8rem] py-4 px-6 flex justify-around items-center">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Rating For:</span>
                <div className="flex bg-slate-800 rounded-full p-1 border border-white/10">
                    <button onClick={() => setRatingGender('Men')} className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${ratingGender === 'Men' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}>Men</button>
                    <button onClick={() => setRatingGender('Women')} className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${ratingGender === 'Women' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}>Women</button>
                </div>
            </div>
            <button onClick={() => { setViewingRecord(null); setMapPoints([]); setMapCompleted(false); setView('green'); }} className="bg-slate-900 border border-white/5 rounded-[2.5rem] p-10 flex flex-col items-center justify-center shadow-2xl active:scale-95 transition-all">
              <div className="w-16 h-16 bg-emerald-600 rounded-full flex items-center justify-center mb-6 shadow-xl shadow-emerald-600/40"><Target size={28} /></div>
              <h2 className="text-2xl font-bold mb-2 uppercase text-emerald-500">Green Mapper</h2>
              <p className="text-slate-400 text-[11px] font-medium text-center max-w-[220px]">Green mapping and Effective Green Diameter</p>
            </button>
            <label className="bg-slate-900 border border-white/5 rounded-[2.5rem] p-10 flex flex-col items-center justify-center shadow-2xl active:scale-95 transition-all cursor-pointer">
              <div className="w-16 h-16 bg-rose-700 rounded-full flex items-center justify-center mb-6 shadow-xl shadow-rose-700/40"><FileText size={28} /></div>
              <h2 className="text-2xl font-bold mb-2 uppercase text-rose-700">Green Report Tool</h2>
              <p className="text-slate-400 text-[11px] font-medium text-center max-w-[220px]">Batch process KML greens into PDF reports</p>
              <input type="file" accept=".kml" onChange={importKMLForReport} className="hidden" />
            </label>
            <button onClick={() => { setViewingRecord(null); setView('stimp'); }} className="bg-slate-900 border border-white/5 rounded-[2.5rem] p-10 flex flex-col items-center justify-center shadow-2xl active:scale-95 transition-all">
              <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mb-6 shadow-xl border border-blue-500/20"><Gauge size={28} className="text-lime-500" /></div>
              <h2 className="text-2xl font-bold mb-2 uppercase text-lime-400">Stimp Slopes</h2>
              <p className="text-slate-400 text-[11px] font-medium text-center max-w-[220px]">Speed correction for sloping greens</p>
            </button>
            <button onClick={() => setView('manual')} className="mt-2 bg-slate-800/50 border border-white/10 rounded-[1.8rem] py-6 flex items-center justify-center gap-4 active:bg-slate-700 transition-colors">
              <BookOpen size={20} className="text-blue-400" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-white">User Manual</span>
            </button>
            <div className="flex gap-4 mt-2">
               <button onClick={exportKML} className="flex-1 bg-slate-800/50 border border-blue-500/20 rounded-[1.8rem] py-6 flex items-center justify-center gap-3 active:bg-slate-700 transition-colors shadow-lg"><Download size={18} className="text-blue-500" /><span className="text-[10px] font-bold uppercase tracking-widest text-white">Export</span></button>
               <label className="flex-1 bg-slate-800/50 border border-emerald-500/20 rounded-[1.8rem] py-6 flex items-center justify-center gap-3 active:bg-slate-700 transition-colors shadow-lg cursor-pointer"><Upload size={18} className="text-emerald-500" /><span className="text-[10px] font-bold uppercase tracking-widest text-white">Import</span><input type="file" accept=".kml" onChange={importKML} className="hidden" /></label>
            </div>
          </div>
          <footer className="mt-auto pb-6 pt-12">
            {history.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 px-2 mb-4"><Info size={12} className="text-blue-400" /><span className="text-[10px] font-bold tracking-[0.2em] text-slate-500 uppercase">Assessment History</span></div>
                <div className="flex gap-4 overflow-x-auto pb-4 no-scrollbar">
                  {history.map(item => (
                    <div key={item.id} className="relative shrink-0">
                      <button onClick={() => handleOpenRecord(item)} className="bg-slate-900 border border-white/10 px-6 py-5 rounded-[2rem] flex flex-col min-w-[170px] text-left shadow-lg active:scale-95 transition-transform">
                        <div className="flex justify-between items-start mb-1"><span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">{item.type} {item.holeNumber && ` - Hole ${item.holeNumber}`}</span>{item.type === 'Green' ? <Target size={12} className="text-emerald-500/60" /> : <Navigation2 size={12} className="text-blue-500/60" />}</div>
                        <span className="text-xl font-bold text-white">{item.primaryValue}</span>
                        <span className="text-[11px] font-bold text-slate-400 mt-1">{item.egdValue || item.secondaryValue}</span>
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setHistory(h => h.filter(x => x.id !== item.id)); }} className="absolute -top-2 -right-2 w-8 h-8 bg-red-600 rounded-full flex items-center justify-center border-2 border-[#020617] text-white shadow-xl active:scale-90"><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </footer>
        </div>
      ) : view === 'manual' ? (
        <UserManual onClose={() => setView('landing')} />
      ) : view === 'settings' ? (
        <SettingsView onClose={() => setView('landing')} onOpenDataset={() => setView('dataset')} />
      ) : view === 'dataset' ? (
        <DatasetInfo onClose={() => setView('settings')} />
      ) : view === 'stimp' ? (
        <StimpCalculator onClose={() => setView('landing')} />
      ) : view === 'report' ? (
        <ReportView greens={reportGreens} fileName={reportFileName} onClose={() => setView('landing')} units={units} />
      ) : (
        <div className="flex-1 flex flex-col relative animate-in slide-in-from-right duration-300">
          <div className="absolute top-0 left-0 right-0 z-[1000] p-4 flex justify-between pointer-events-none">
          <button onClick={() => { 
            setView('landing'); setTrkActive(false); setMapActive(false); setViewingRecord(null); setShowPivotMenu(false); setTrkPoints([]); setCurrentPivots([]); 
              }} 
              className="pointer-events-auto bg-slate-800 border border-white/20 w-[46px] h-[46px] rounded-full flex items-center justify-center shadow-2xl active:scale-95 transition-all"
              title="Home"
            >
              <Home size={20} className="text-yellow-400" />
            </button>
            <div className="flex gap-2 pointer-events-auto">
              {((view === 'track' && (trkActive || trkPoints.length > 0)) || (view === 'green' && mapActive) || viewingRecord) && (
                <div className="bg-slate-800 border border-white/20 w-[46px] h-[46px] rounded-full flex items-center justify-center shadow-2xl"><span className="text-xl font-bold text-blue-400 tabular-nums">{holeNum}</span></div>
              )}
              {view === 'track' && (
                <button onClick={() => setOvalMode(m => m === 'off' ? 'scratch' : m === 'scratch' ? 'bogey' : 'off')} className="bg-slate-800 border border-white/20 rounded-full shadow-2xl active:scale-90 flex items-center justify-center w-[46px] h-[46px]">
                  {ovalMode === 'off' && <CircleOff size={20} className="text-slate-400" />}
                  {ovalMode === 'scratch' && <span className="text-emerald-400 font-bold text-2xl flex items-center justify-center leading-none">S</span>}
                  {ovalMode === 'bogey' && <span className="text-yellow-400 font-bold text-2xl flex items-center justify-center leading-none">B</span>}
                </button>
              )}
              {view === 'track' && (
                <button onClick={() => setViewingTrackProfile(p => p === 'Rater\'s Walk' ? 'Scratch' : 'Rater\'s Walk')} className="bg-slate-800 border border-white/20 rounded-full shadow-2xl active:scale-90 flex items-center justify-center w-[46px] h-[46px]">
                  {viewingTrackProfile === 'Rater\'s Walk' ? <Route size={20} className="text-rose-500" /> : <Waypoints size={20} className="text-emerald-400" />}
                </button>
              )}
              <button onClick={() => { setIsFollowing(true); setMapLockKey(k => k + 1); setLocationResetKey(k => k + 1); }} className={`bg-slate-800 border border-white/20 p-3.5 rounded-full shadow-2xl active:scale-90 transition-all ${isFollowing ? 'text-emerald-400' : 'text-slate-500'}`} title="Recenter Map"> <Crosshair size={20} className={isFollowing ? 'animate-pulse' : ''} /></button>
              <button onClick={() => setUnits(u => u === 'Yards' ? 'Metres' : 'Yards')} className="bg-slate-800 border border-white/20 p-3.5 rounded-full text-emerald-400 shadow-2xl active:scale-90"><Ruler size={20} /></button>
              <button onClick={() => setMapStyle(s => s === 'Street' ? 'Satellite' : s === 'Satellite' ? 'LiDAR DTM' : 'Street')} className="bg-slate-800 border border-white/20 p-3.5 rounded-full text-blue-400 shadow-2xl active:scale-90"><Layers size={20} /></button>
            </div>
          </div>
          <main className="flex-1">
            {(pos || viewingRecord) ? (
              <MapContainer center={[0, 0]} zoom={2} className="h-full w-full" zoomControl={false} attributionControl={false} style={{ backgroundColor: '#020617' }}>
                {mapStyle === 'LiDAR DTM' ? (
                  <WMSTileLayer
                    url="https://spatialdata.gov.scot/arcgis/services/Public/Lidar_DTM_1m/MapServer/WMSServer"
                    layers="0"
                    format="image/png"
                    transparent={true}
                    version="1.3.0"
                    maxZoom={22}
                    eventHandlers={{
                      loading: () => { setLidarLayerLoading(true); },
                      load: () => { setLidarLayerLoading(false); },
                      tileerror: () => { setLidarStatus('error'); }
                    }}
                  />
                ) : (
                  <TileLayer 
                    url={mapStyle === 'Street' ? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"} 
                    maxZoom={22} 
                    maxNativeZoom={19} 
                  />
                )}
                <MapController 
                  key={mapLockKey} 
                  pos={pos} 
                  active={trkActive || mapActive} 
                  mapPoints={mapPoints} 
                  completed={mapCompleted} 
                  viewingRecord={viewingRecord} 
                  mode={view} 
                  trkPoints={trkPoints} 
                  isFollowing={isFollowing} 
                  setIsFollowing={setIsFollowing}
                  onMapMove={(lat, lng) => setMapCenter({ lat, lng, accuracy: 0, timestamp: Date.now(), alt: null, altAccuracy: null })}
                />
                
                {mapStyle === 'LiDAR DTM' && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
                    {(lidarLayerLoading || lidarStatus === 'loading') ? (
                      <div className="bg-slate-900/80 backdrop-blur-md border border-blue-500/30 px-4 py-2 rounded-full flex items-center gap-3 shadow-2xl">
                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-ping" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-blue-400">Loading LiDAR Terrain...</span>
                      </div>
                    ) : lidarStatus === 'error' ? (
                      <div className="bg-rose-900/80 backdrop-blur-md border border-rose-500/30 px-4 py-2 rounded-full flex items-center gap-3 shadow-2xl pointer-events-auto cursor-pointer" onClick={() => setShowLidarDebug(true)}>
                        <AlertTriangle size={12} className="text-rose-400" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-rose-400">LiDAR Data Unavailable Here</span>
                      </div>
                    ) : lidarStatus === 'available' ? (
                      <div className="bg-emerald-900/80 backdrop-blur-md border border-emerald-500/30 px-4 py-2 rounded-full flex items-center gap-3 shadow-2xl pointer-events-auto cursor-pointer" onClick={() => setShowLidarDebug(true)}>
                        <CheckCircle2 size={12} className="text-emerald-400" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">LiDAR Active</span>
                      </div>
                    ) : null}
                  </div>
                )}

                {showLidarDebug && (
                  <div className="fixed inset-0 z-[3000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
                    <div className="bg-slate-900 border border-white/10 rounded-3xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
                      <div className="p-6 border-b border-white/5 flex justify-between items-center bg-slate-800/50">
                        <div className="flex items-center gap-3">
                          <Cpu size={20} className="text-blue-400" />
                          <h3 className="text-lg font-black uppercase tracking-tighter">LiDAR Diagnostic Data</h3>
                        </div>
                        <button onClick={() => setShowLidarDebug(false)} className="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center text-slate-400 active:scale-90 transition-all">
                          <X size={20} />
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto p-6 space-y-6 font-mono text-xs">
                        <section>
                          <h4 className="text-blue-400 font-bold uppercase mb-2 text-[10px] tracking-widest">Query Coordinates</h4>
                          <div className="bg-black/40 p-3 rounded-xl border border-white/5">
                            Lat: {lidarDebug.coords?.lat.toFixed(6)}<br />
                            Lng: {lidarDebug.coords?.lng.toFixed(6)}
                          </div>
                        </section>
                        <section>
                          <h4 className="text-blue-400 font-bold uppercase mb-2 text-[10px] tracking-widest">Request URL</h4>
                          <div className="bg-black/40 p-3 rounded-xl border border-white/5 break-all text-[10px] leading-relaxed">
                            {lidarDebug.url}
                          </div>
                        </section>
                        <section>
                          <h4 className="text-blue-400 font-bold uppercase mb-2 text-[10px] tracking-widest">Server Response</h4>
                          <pre className="bg-black/40 p-3 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                            {JSON.stringify(lidarDebug.response, null, 2)}
                          </pre>
                        </section>
                        <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                          <p className="text-[10px] text-blue-300 leading-relaxed italic">
                            Tip: If "results" is empty, the ArcGIS server has no 1m DTM data for this exact coordinate. 
                            Try panning slightly or zooming in.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <AccuracyOvals 
                  pos={pos} 
                  pivots={currentPivots} 
                  startPoint={trkPoints.length > 0 ? trkPoints[0] : null} 
                  gender={ratingGender} 
                  active={view === 'track' && trkActive} 
                  mode={ovalMode} 
                />
                {pos && !viewingRecord && (<><Circle center={[pos.lat, pos.lng]} radius={pos.accuracy} pathOptions={{ color: 'transparent', fillColor: getAccuracyColor(pos.accuracy), fillOpacity: 1, weight: 0 }} /><CircleMarker center={[pos.lat, pos.lng]} radius={7} pathOptions={{ color: '#fff', fillColor: '#10b981', fillOpacity: 1, weight: 2.5 }} /></>)}
                {view === 'track' && (trkActive || viewingRecord || trkPoints.length > 1) && (
                    <>
                      {/* Pivots markers rendering */}
                      {(trkActive || (!viewingRecord && trkPoints.length > 0) ? currentPivots : (viewingRecord?.pivotPoints || [])).map((piv, idx) => (
                        <CircleMarker 
                          key={`piv-${idx}`} 
                          center={[piv.point.lat, piv.point.lng]} 
                          radius={6} 
                          pathOptions={{ 
                            fillColor: piv.type === 'common' ? '#3b82f6' : (piv.type === 'scratch_cut' ? '#10b981' : '#facc15'),
                            color: '#fff',
                            weight: 2,
                            fillOpacity: 1
                          }} 
                        />
                      ))}
                      
                      {/* Conditional path rendering based on divergence */}
                      {(() => {
                        const scratchPath = effectiveMetrics.effectivePaths?.scratch || [];
                        const bogeyPath = effectiveMetrics.effectivePaths?.bogey || [];
                        const raterWalk = trkActive ? [...trkPoints, ...(pos?[pos]:[])] : (viewingRecord ? (viewingRecord.raterPathPoints || []) : trkPoints);
                        
                        if (viewingTrackProfile === 'Rater\'s Walk') {
                          return <Polyline positions={raterWalk.map(p => [p.lat, p.lng])} color="#ef4444" weight={5} />;
                        }
                        
                        if (!pathsDiffer) {
                          return <Polyline positions={scratchPath.map(p => [p.lat, p.lng])} color="#ef4444" weight={5} />;
                        } else {
                          return (
                            <>
                              <Polyline positions={scratchPath.map(p => [p.lat, p.lng])} color="#10b981" weight={5} />
                              <Polyline positions={bogeyPath.map(p => [p.lat, p.lng])} color="#facc15" weight={5} />
                            </>
                          );
                        }
                      })()}
                    </>
                )}
                {view === 'green' && (viewingRecord?.points || mapPoints).length > 1 && (
                  <>
                    <Polygon positions={(viewingRecord?.points || mapPoints).map(p => [p.lat, p.lng])} fillColor="#10b981" fillOpacity={0.1} weight={0} />
                    {(viewingRecord?.points || mapPoints).map((p, i, arr) => {
                      if (i === 0) return null;
                      return <Polyline key={`seg-${i}`} positions={[[arr[i-1].lat, arr[i-1].lng], [p.lat, p.lng]]} color={p.type === 'bunker' ? "#fb923c" : "#10b981"} weight={4} />;
                    })}
                    {(mapCompleted || (viewingRecord && viewingRecord.type === 'Green')) && (viewingRecord?.points || mapPoints).length > 2 && (
                      <Polyline positions={[[(viewingRecord?.points || mapPoints)[(viewingRecord?.points || mapPoints).length - 1].lat, (viewingRecord?.points || mapPoints)[(viewingRecord?.points || mapPoints).length - 1].lng], [(viewingRecord?.points || mapPoints)[0].lat, (viewingRecord?.points || mapPoints)[0].lng]]} color={(viewingRecord?.points || mapPoints)[0].type === 'bunker' ? "#fb923c" : "#10b981"} weight={4} />
                    )}
                    {(mapCompleted || (viewingRecord && viewingRecord.type === 'Green')) && analysis?.shape && (
                      <>
                        {(() => {
                          const s = analysis.shape as any;
                          if (s.anomalousResult) {
                            return (
                              <>
                                <Polyline positions={[[s.pA.lat, s.pA.lng], [s.pB.lat, s.pB.lng]]} color="#93c5fd" weight={2} dashArray="5, 5" />
                                <Polyline positions={s.anomalousResult.spine.map((p: any) => [p.lat, p.lng])} color="#60a5fa" weight={3} dashArray="2, 4" />
                                {s.anomalousResult.widths.map((w: any, idx: number) => (
                                  <Polyline key={`anom-w-${idx}`} positions={[[w.p1.lat, w.p1.lng], [w.p2.lat, w.p2.lng]]} color={w.color} weight={2} dashArray="4, 2" />
                                ))}
                              </>
                            );
                          } else if (s.isLShape && s.s1 && s.s2) {
                            return (
                              <>
                                <Polyline positions={[[s.s1.pA.lat, s.s1.pA.lng], [s.s1.pB.lat, s.s1.pB.lng]]} color="#3b82f6" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s1.pC.lat, s.s1.pC.lng], [s.s1.pD.lat, s.s1.pD.lng]]} color="#facc15" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s2.pA.lat, s.s2.pA.lng], [s.s2.pB.lat, s.s2.pB.lng]]} color="#f472b6" weight={2} dashArray="5, 5" />
                                <Polyline positions={[[s.s2.pC.lat, s.s2.pC.lng], [s.s2.pD.lat, s.s2.pD.lng]]} color="#10b981" weight={2} dashArray="5, 5" />
                              </>
                            );
                          } else {
                            return (
                              <>
                                {s.pA && s.pB && <Polyline positions={[[s.pA.lat, s.pA.lng], [s.pB.lat, s.pB.lng]]} color="#3b82f6" weight={2} dashArray="5, 5" />}
                                {s.isInconsistent ? (
                                  <>
                                    {s.pC1 && s.pD1 && <Polyline positions={[[s.pC1.lat, s.pC1.lng], [s.pD1.lat, s.pD1.lng]]} color="#facc15" weight={2} dashArray="5, 5" />}
                                    {s.pC3 && s.pD3 && <Polyline positions={[[s.pC3.lat, s.pC3.lng], [s.pD3.lat, s.pD3.lng]]} color="#10b981" weight={2} dashArray="5, 5" />}
                                  </>
                                ) : (
                                  s.pC && s.pD && <Polyline positions={[[s.pC.lat, s.pC.lng], [s.pD.lat, s.pD.lng]]} color="#facc15" weight={2} dashArray="5, 5" />
                                )}
                              </>
                            );
                          }
                        })()}
                      </>
                    )}
                  </>
                )}
              </MapContainer>
            ) : <div className="flex items-center justify-center h-full w-full text-white/50 animate-pulse">Waiting for location signal...</div>}
          </main>
          <div className="absolute inset-x-0 bottom-0 z-[1000] p-4 pointer-events-none flex flex-col gap-2 items-center pb-12">
            <div className="flex flex-col gap-2 w-full max-w-[340px]">
              <div className="pointer-events-auto bg-slate-900/95 border border-white/20 rounded-[2.8rem] px-6 py-4 w-full shadow-2xl backdrop-blur-md">
                {view === 'track' ? (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 text-center flex flex-col items-center">
                        <span className="text-[10px] font-bold text-white/40 uppercase block mb-2 leading-none">DISTANCE</span>
                        <div className="flex flex-col gap-1">
                            {(() => {
                              const pivs = viewingRecord ? (viewingRecord.pivotPoints || []) : currentPivots;
                              const sCount = pivs.filter(p => p.type === 'common' || p.type === 'scratch_cut').length;
                              const bCount = pivs.filter(p => p.type === 'common' || p.type === 'bogoy_round').length;
                              const targetMult = units === 'Yards' ? 1 : (1 / 1.09361);
                              const sT = SHOT_TARGETS[ratingGender].Scratch[sCount === 0 ? 'first' : 'subseq'];
                              const bT = SHOT_TARGETS[ratingGender].Bogey[bCount === 0 ? 'first' : 'subseq'];
                              const sTargetStr = `(C:${(sT.c * targetMult).toFixed(0)} T:${(sT.t * targetMult).toFixed(0)})`;
                              const bTargetStr = `(C:${(bT.c * targetMult).toFixed(0)} T:${(bT.t * targetMult).toFixed(0)})`;
                              
                              return (
                                <>
                                  <div className="text-4xl font-bold text-emerald-400 tabular-nums leading-none">
                                    S: {effectiveMetrics.distScratch.toFixed(1)}
                                    {effectiveMetrics.sectorScratch !== null && <span className="text-2xl text-white/60 ml-2">/ {effectiveMetrics.sectorScratch.toFixed(1)}</span>}
                                    <span className="text-[11px] font-bold text-white/30 ml-2">{sTargetStr}</span>
                                    <span className="text-[10px] ml-1 opacity-40 uppercase">{units === 'Yards' ? 'YD' : 'M'}</span>
                                  </div>
                                  <div className="text-4xl font-bold text-yellow-400 tabular-nums leading-none">
                                    B: {effectiveMetrics.distBogey.toFixed(1)}
                                    {effectiveMetrics.sectorBogey !== null && <span className="text-2xl text-white/60 ml-2">/ {effectiveMetrics.sectorBogey.toFixed(1)}</span>}
                                    <span className="text-[11px] font-bold text-white/30 ml-2">{bTargetStr}</span>
                                    <span className="text-[10px] ml-1 opacity-40 uppercase">{units === 'Yards' ? 'YD' : 'M'}</span>
                                  </div>
                                </>
                              );
                            })()}
                        </div>
                      </div>
                      <div className="col-span-1 text-center border-l border-white/10 flex flex-col items-center justify-center">
                        <span className="text-[10px] font-bold text-white/40 uppercase block mb-2 leading-none">ELEVATION</span>
                        <div className={`text-4xl font-bold tabular-nums leading-none tracking-tighter ${(!viewingRecord && !['Barometric', 'LiDAR DTM'].includes(getVerticalMethod(pos?.altAccuracy ?? null, pos?.alt ?? null))) ? 'text-rose-500 animate-pulse' : 'text-yellow-400'}`}>{`${effectiveMetrics.elevRater > 0 ? '+' : ''}${effectiveMetrics.elevRater.toFixed(1)}`}<span className="text-[10px] ml-0.5 opacity-40 uppercase">{units === 'Yards' ? 'FT' : 'M'}</span></div>
                      </div>
                    </div>
                    {pos && !viewingRecord && (
                      <div className="flex justify-between pt-2 border-t border-white/10 px-2">
                        <div className="flex items-center gap-1.5">
                          <div className={`w-1.5 h-1.5 rounded-full ${pos.accuracy < 2 ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} title="GNSS Signal"></div>
                          <span className="text-[9px] font-bold text-white/40 uppercase tracking-widest">GNSS: {pos.accuracy.toFixed(1)}m</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className={`w-1.5 h-1.5 rounded-full ${getVerticalMethod(pos.altAccuracy, pos.alt) === 'Barometric' ? 'bg-blue-500' : (getVerticalMethod(pos.altAccuracy, pos.alt) === 'LiDAR DTM' ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)]' : 'bg-emerald-500')}`} title="Elevation Method"></div>
                          <span className="text-[9px] font-bold text-white/40 uppercase tracking-widest">{getVerticalMethod(pos.altAccuracy, pos.alt)}{pos.altAccuracy !== null && `: ±${pos.altAccuracy.toFixed(1)}m`}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="grid grid-cols-3 gap-2 text-center mb-4 w-full">
                      <div><span className="text-white/40 text-[8px] font-bold uppercase block tracking-widest mb-1">Sq. Area</span><div className="text-xl font-bold text-emerald-400 tabular-nums">{Math.round((analysis?.area || 0) * (units === 'Yards' ? 1.196 : 1))}<span className="text-[8px] ml-0.5 opacity-40 uppercase">{units === 'Yards' ? 'YD²' : 'M²'}</span></div></div>
                      <div><span className="text-white/40 text-[8px] font-bold uppercase block tracking-widest mb-1">Perimeter</span><div className="text-xl font-bold text-blue-400 tabular-nums">{((analysis?.perimeter || 0) * distMult).toFixed(1)}<span className="text-[8px] ml-0.5 opacity-40 uppercase">{units === 'Yards' ? 'YD' : 'M'}</span></div></div>
                      <div><span className="text-white/40 text-[8px] font-bold uppercase block tracking-widest mb-1">Bunker%</span><div className={`text-xl font-bold ${getBunkerPercentageColor(analysis?.bunkerPct)} tabular-nums`}>{analysis?.bunkerPct || 0}%</div></div>
                    </div>
                    
                    <div className="border-t border-white/10 pt-3 flex flex-col items-center w-full">
                      <div className="flex items-baseline gap-1 mb-0.5">
                        <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">EGD:</span>
                        <span className="text-[10px] font-medium text-white/60 uppercase tracking-widest">{(analysis?.shape as any)?.method || '--'}</span>
                      </div>

                      <div className="text-5xl font-bold tabular-nums tracking-tighter my-1 text-center flex items-baseline justify-center">
                        {(() => {
                          const s = analysis?.shape as any;
                          const m = units === 'Yards' ? 1 : (1 / 1.09361);
                          if (s?.isLShape && !s?.isAnomalous) {
                            return (
                              <>
                                <span className="text-blue-400">{((s.s1?.egd ?? 0) * m).toFixed(1)}</span>
                                <span className="text-white/20 mx-1">/</span>
                                <span className="text-fuchsia-400">{((s.s2?.egd ?? 0) * m).toFixed(1)}</span>
                              </>
                            );
                          }
                          return <span className="text-yellow-400">{analysis?.egdDisplay || '--'}</span>;
                        })()}
                        {analysis?.egdDisplay !== '--' && analysis?.egdDisplay !== '---' && analysis?.egdDisplay !== 'MANUAL' && (
                          <span className="text-xl ml-1 opacity-50 font-semibold text-white">{units === 'Yards' ? 'YD' : 'M'}</span>
                        )}
                      </div>

                      {analysis?.shape && (
                        <div className="mt-1 flex flex-col items-center w-full">
                          {(() => {
                            const s = analysis.shape as any;
                            const m = units === 'Yards' ? 1 : (1 / 1.09361);
                            if (s.isAnomalous) {
                              return (
                                <div className="flex flex-col items-center gap-1 w-full">
                                  <div className="flex gap-4 mb-0.5">
                                    <span className="text-[10px] font-bold uppercase text-blue-400">L(curved): {(s.anomalousResult.curvedLength * m).toFixed(1)}</span>
                                    <span className="text-[10px] font-bold uppercase text-blue-300">L(straight): {(s.anomalousResult.straightLength * m).toFixed(1)}</span>
                                  </div>
                                  <div className="flex gap-4">
                                    <span className="text-[10px] font-bold uppercase text-orange-400">W1: {(s.anomalousResult.widths[0]?.w * m).toFixed(1)}</span>
                                    <span className="text-[10px] font-bold uppercase text-yellow-400">W2: {(s.anomalousResult.widths[1]?.w * m).toFixed(1)}</span>
                                    <span className="text-[10px] font-bold uppercase text-fuchsia-400">W3: {(s.anomalousResult.widths[2]?.w * m).toFixed(1)}</span>
                                  </div>
                                </div>
                              );
                            } else if (s.isLShape && s.s1 && s.s2) {
                              return (
                                <div className="flex flex-col items-center gap-1 w-full mt-1">
                                  <div className="flex gap-4 border-b border-white/5 pb-1">
                                    <span className="text-[9px] font-black text-white/30 tracking-widest">PORTION 1:</span>
                                    <span className="text-[10px] font-bold uppercase text-blue-400">L {(s.s1.L * m).toFixed(1)}</span>
                                    <span className="text-[10px] font-bold uppercase text-yellow-400">W {(s.s1.W * m).toFixed(1)}</span>
                                  </div>
                                  <div className="flex gap-4 pt-1">
                                    <span className="text-[9px] font-black text-white/30 tracking-widest">PORTION 2:</span>
                                    <span className="text-[10px] font-bold uppercase text-fuchsia-400">L {(s.s2.L * m).toFixed(1)}</span>
                                    <span className="text-[10px] font-bold uppercase text-emerald-400">W {(s.s2.W * m).toFixed(1)}</span>
                                  </div>
                                </div>
                              );
                            } else if (s.isInconsistent) {
                              return (
                                <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
                                  <span className="text-[10px] font-bold uppercase text-blue-400">L: {(s.L * m).toFixed(1)}</span>
                                  <span className="text-[10px] font-bold uppercase text-yellow-400">W1: {(s.w1_yds * m).toFixed(1)}</span>
                                  <span className="text-[10px] font-bold uppercase text-emerald-400">W2: {(s.w3_yds * m).toFixed(1)}</span>
                                </div>
                              );
                            } else {
                              return (
                                <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
                                  <span className="text-[10px] font-bold uppercase text-blue-400">Length: {(s.L * m).toFixed(1)}</span>
                                  <span className="text-[10px] font-bold uppercase text-yellow-400">Width: {(s.W * m).toFixed(1)}</span>
                                  <span className="text-[10px] font-bold uppercase text-white/40">Ratio: {s.ratio.toFixed(2)}</span>
                                </div>
                              );
                            }
                          })()}
                        </div>
                      )}
                    </div>

                    {pos && !viewingRecord && (
                      <div className="flex justify-center pt-3 mt-3 border-t border-white/10 px-2 w-full">
                        <div className="flex items-center gap-1.5">
                          <div className={`w-1.5 h-1.5 rounded-full ${pos.accuracy < 2 ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`}></div>
                          <span className="text-[9px] font-bold text-white/40 uppercase tracking-widest">GNSS: {pos.accuracy.toFixed(1)}m</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="pointer-events-auto flex flex-col gap-2 w-full">
                {viewingRecord ? <button onClick={() => { setViewingRecord(null); setView('landing'); setTrkPoints([]); setCurrentPivots([]); }} className="h-14 bg-slate-800 border-2 border-white/10 rounded-full font-bold text-xs tracking-[0.2em] uppercase text-white shadow-xl active:scale-95 transition-all">Close Viewer</button> : (
                  <>
                    {view === 'track' ? (
                        <div className="flex gap-2 w-full">
                          {!trkActive && (
                            <div className="flex-1 flex items-center justify-between bg-slate-900 border-2 border-white/10 rounded-full px-4 h-14 shadow-xl">
                              <button onClick={() => setHoleNum(h => Math.max(1, h - 1))} className="w-9 h-9 bg-slate-800 rounded-full flex items-center justify-center border border-white/10 active:bg-blue-600 transition-colors"><Minus size={14} /></button>
                              <div className="flex flex-col items-center"><span className="text-[7px] font-bold uppercase tracking-widest text-white/40">HOLE</span><span className="text-xl font-bold tabular-nums text-blue-400 leading-none">{holeNum}</span></div>
                              <button onClick={() => setHoleNum(h => Math.min(18, h + 1))} className="w-9 h-9 bg-slate-800 rounded-full flex items-center justify-center border border-white/10 active:bg-blue-600 transition-colors"><Plus size={14} /></button>
                            </div>
                          )}
                          <button onClick={() => { if(!trkActive) { setTrkActive(true); setTrkPoints(pos ? [pos] : []); setCurrentPivots([]); } else { const finalPath = [...trkPoints, pos].filter(Boolean) as GeoPoint[]; setTrkPoints(finalPath); const calculated = calculateEffectivePathsAndMetrics(finalPath, currentPivots, distMult, elevMult); saveRecord({ type: 'Track', primaryValue: `S: ${calculated.effectiveDistances.scratch.toFixed(1)} / B: ${calculated.effectiveDistances.bogey.toFixed(1)}`, points: finalPath, raterPathPoints: finalPath, pivotPoints: currentPivots, genderRated: ratingGender, effectiveDistances: calculated.effectiveDistances, effectiveElevations: calculated.effectiveElevations, effectivePaths: calculated.effectivePaths, holeNumber: holeNum }); setTrkActive(false); } }} className={`flex-1 h-14 rounded-full font-bold text-xs tracking-[0.2em] uppercase border-2 shadow-xl active:scale-95 ${trkActive ? 'bg-red-600 border-red-500' : 'bg-blue-600 border-blue-500'}`}>{trkActive ? 'STOP TRACK' : 'START TRACK'}</button>
                          {trkActive && <button onClick={() => setShowPivotMenu(true)} className="flex-1 h-14 rounded-full font-bold text-xs tracking-[0.1em] uppercase border-2 bg-slate-800 border-blue-500 text-blue-100 shadow-xl active:scale-95">PIVOT ({currentPivots.length})</button>}
                        </div>
                    ) : (
                      <div className="flex gap-2 w-full">
                        {!mapActive && (
                            <div className="flex-1 flex items-center justify-between bg-slate-900 border-2 border-white/10 rounded-full px-4 h-14 shadow-xl">
                              <button onClick={() => setHoleNum(h => Math.max(1, h - 1))} className="w-9 h-9 bg-slate-800 rounded-full flex items-center justify-center border border-white/10 active:bg-blue-600 transition-colors"><Minus size={14} /></button>
                              <div className="flex flex-col items-center"><span className="text-[7px] font-bold uppercase tracking-widest text-white/40">HOLE</span><span className="text-xl font-bold tabular-nums text-emerald-400 leading-none">{holeNum}</span></div>
                              <button onClick={() => setHoleNum(h => Math.min(18, h + 1))} className="w-9 h-9 bg-slate-800 rounded-full flex items-center justify-center border border-white/10 active:bg-blue-600 transition-colors"><Plus size={14} /></button>
                            </div>
                          )}
                        <button onClick={() => { if(mapActive) handleFinalizeGreen(); else { greenStartRef.current = null; setMapPoints([]); setMapActive(true); setMapCompleted(false); } }} className={`flex-1 h-14 rounded-full font-bold text-xs tracking-[0.2em] uppercase border-2 shadow-xl active:scale-95 ${mapActive ? 'bg-blue-600 border-blue-500' : 'bg-emerald-600 border-emerald-500'}`}>{mapActive ? 'CLOSE' : 'START GREEN'}</button>
                        {mapActive && <button onClick={() => setIsBunker(!isBunker)} className={`flex-1 h-14 rounded-full font-bold text-xs tracking-[0.1em] uppercase border-2 transition-all shadow-xl ${isBunker ? 'bg-orange-600 border-orange-500 scale-105' : 'bg-slate-800 border-orange-500/50 text-orange-400'}`}>BUNKER</button>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            {showPivotMenu && (
              <div className="absolute inset-x-0 bottom-[160px] z-[1010] p-4 flex flex-col gap-3 items-center animate-in slide-in-from-bottom duration-200 pointer-events-none">
                <div className="pointer-events-auto bg-slate-900/95 border border-white/20 rounded-[2.8rem] p-5 w-full max-w-[300px] shadow-2xl backdrop-blur-md flex flex-col items-center">
                  <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-3">Set Pivot Type:</span>
                  <div className="flex gap-2 mb-4 w-full">
                    <button onClick={() => setPendingPivotType('common')} className={`flex-1 h-12 rounded-full font-bold text-xs uppercase border-2 transition-all ${pendingPivotType === 'common' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-white/10 text-slate-400'}`}>Both</button>
                    <button onClick={() => setPendingPivotType('scratch_cut')} className={`flex-1 h-12 rounded-full font-bold text-xs uppercase border-2 transition-all ${pendingPivotType === 'scratch_cut' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-white/10 text-slate-400'}`}>Scratch</button>
                    <button onClick={() => setPendingPivotType('bogoy_round')} className={`flex-1 h-12 rounded-full font-bold text-xs uppercase border-2 transition-all ${pendingPivotType === 'bogoy_round' ? 'bg-yellow-600 border-yellow-500 text-white' : 'bg-slate-800 border-white/10 text-slate-400'}`}>Bogey</button>
                  </div>
                  <div className="flex gap-2 w-full">
                    <button onClick={handleConfirmPivot} disabled={!pendingPivotType} className="flex-1 h-12 rounded-full font-bold text-xs uppercase border-2 bg-blue-600 border-blue-500 text-white shadow-xl active:scale-95 disabled:opacity-30 transition-all">Confirm</button>
                    <button onClick={() => setShowPivotMenu(false)} className="flex-1 h-12 rounded-full font-bold text-xs uppercase border-2 bg-slate-800 border-slate-700/50 text-slate-400 shadow-xl active:scale-95">Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <style>{`.leaflet-tile-pane { filter: brightness(0.8) contrast(1.1) saturate(0.85); }.no-scrollbar::-webkit-scrollbar { display: none; }.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }`}</style>
    </div>
  );
};
export default App;
