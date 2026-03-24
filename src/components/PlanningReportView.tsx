import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Printer, RotateCcw, ChartSpline, Download, Loader2, FileText, Wind } from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Line,
  Label,
  ReferenceLine
} from 'recharts';
import { SavedRecord, GeoPoint, UnitSystem, calculateDistance, MapBoundsController, MapRuler } from '../App';
import { lidarGeoTiffService } from '../services/lidarGeoTiffService';
import { fetchAverageWindData, WindData } from '../services/windService';
import { MapContainer, TileLayer, Polyline, Marker, Tooltip as LeafletTooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface PlanningReportViewProps {
  tracks: SavedRecord[];
  fileName: string;
  onClose: () => void;
  units: UnitSystem;
}

interface ProfilePoint {
  distance: number;
  distanceMetres: number;
  elevationDiff: number;
  elevationDiffMetres: number;
  absoluteAltitude: number;
  absoluteAltitudeMetres: number;
  isPivot?: boolean;
}

export const PlanningReportView: React.FC<PlanningReportViewProps> = ({ tracks, fileName, onClose, units }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reportUnits, setReportUnits] = useState<UnitSystem>(units);
  const [isExporting, setIsExporting] = useState(false);
  const [isLoadingLidar, setIsLoadingLidar] = useState(false);
  const [reportTitle, setReportTitle] = useState(fileName);
  const [showTitleDialog, setShowTitleDialog] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, { scratch: ProfilePoint[], bogey: ProfilePoint[] }>>({});
  const [avgWindData, setAvgWindData] = useState<WindData | null>(null);
  const [loadingWind, setLoadingWind] = useState(false);
  const profilesRef = useRef(profiles);
  const isLoadingLidarRef = useRef(isLoadingLidar);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => { profilesRef.current = profiles; }, [profiles]);
  useEffect(() => { isLoadingLidarRef.current = isLoadingLidar; }, [isLoadingLidar]);

  const currentTrack = tracks[currentIndex];
  const isSummaryPage = currentIndex === tracks.length;

  useEffect(() => {
    if (isSummaryPage && tracks.length > 0 && avgWindData === null && !loadingWind) {
      const fetchWind = async () => {
        setLoadingWind(true);
        const firstPoint = tracks[0].points[0];
        if (firstPoint) {
          const data = await fetchAverageWindData(firstPoint.lat, firstPoint.lng);
          setAvgWindData(data);
        }
        setLoadingWind(false);
      };
      fetchWind();
    }
  }, [isSummaryPage, tracks, avgWindData, loadingWind]);

  const getCardinalDirection = (deg: number) => {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(deg / 22.5) % 16;
    return directions[index];
  };

  const [isTiffReady, setIsTiffReady] = useState(false);

  useEffect(() => {
    const loadTiffs = async () => {
      await lidarGeoTiffService.loadAll();
      setIsTiffReady(true);
    };
    loadTiffs();
  }, []);

  const reportPoint = useMemo(() => {
    if (isSummaryPage) return tracks[0]?.points[0];
    return currentTrack?.raterPathPoints?.[0] || currentTrack?.points[0];
  }, [isSummaryPage, currentTrack, tracks]);

  const fetchLidar = async (lat: number, lng: number): Promise<number | null> => {
    // 1. Check offline GeoTIFF data first (highest priority)
    try {
      const offlineElev = await lidarGeoTiffService.getElevation(lat, lng);
      if (offlineElev !== null) return offlineElev;
    } catch (e) {
      console.error('[LiDAR] Failed to read elevation from GeoTIFF in report', e);
    }

    // 2. Fallback to Online API
    try {
      const response = await fetch(`/api/lidar?lat=${lat}&lng=${lng}`);
      if (!response.ok) return null;
      const data = await response.json();
      
      // Handle new JNCC WCS format
      if (data && data.elevation !== undefined) {
        const val = parseFloat(String(data.elevation).trim());
        if (!isNaN(val)) return val;
      }
      
      // Fallback for old ArcGIS format
      if (data && data.results && data.results.length > 0) {
        const res = data.results[0];
        const val = parseFloat(res.value || res.attributes?.['Pixel Value'] || res.attributes?.['Value'] || res.attributes?.['value'] || res.attributes?.['ST_Elevation']);
        if (!isNaN(val)) return val;
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const generateProfile = async (record: SavedRecord) => {
    if (profiles[record.id]) {
      setIsTiffReady(true);
      return;
    }

    setIsLoadingLidar(true);
    
    // Ensure GeoTIFFs are loaded into memory for fast lookup
    await lidarGeoTiffService.loadAll();
    setIsTiffReady(true);
    
    const getAnchors = (forScratch: boolean): GeoPoint[] => {
      const startPoint = record.raterPathPoints?.[0] || record.points[0];
      const endPoint = record.raterPathPoints?.[record.raterPathPoints.length - 1] || record.points[record.points.length - 1];
      const sortedPivots = [...(record.pivotPoints || [])].sort((a, b) => a.point.timestamp - b.point.timestamp);
      
      let anchors: GeoPoint[] = [startPoint];
      for (const pivot of sortedPivots) {
        if (forScratch) {
          if (pivot.type === 'common' || pivot.type === 'scratch_cut') anchors.push(pivot.point);
        } else { 
          if (pivot.type === 'common' || pivot.type === 'bogoy_round') anchors.push(pivot.point);
        }
      }
      anchors.push(endPoint);
      return anchors;
    };

    const processAnchors = async (anchors: GeoPoint[]): Promise<ProfilePoint[]> => {
      const result: ProfilePoint[] = [];
      let totalDistMetres = 0;
      
      // Try to find a valid starting altitude for the baseline
      let startAlt = anchors[0].alt || (await fetchLidar(anchors[0].lat, anchors[0].lng));
      if (startAlt === null) {
        // Search anchors for any valid altitude to use as baseline
        for (const a of anchors) {
          const alt = a.alt || (await fetchLidar(a.lat, a.lng));
          if (alt !== null) {
            startAlt = alt;
            break;
          }
        }
      }
      const baselineAlt = startAlt !== null ? startAlt : 0;
      let lastKnownAlt = baselineAlt;

      for (let i = 0; i < anchors.length - 1; i++) {
        const p1 = anchors[i];
        const p2 = anchors[i+1];
        const segmentDist = calculateDistance(p1, p2);
        
        // Determine interval based on GeoTIFF availability and resolution
        // Use 1m only if we have a 1m tile AND it actually contains data for this point
        const bestRes = lidarGeoTiffService.getBestResolution(p1.lat, p1.lng);
        const hasOfflineData = (await lidarGeoTiffService.getElevation(p1.lat, p1.lng)) !== null;
        const interval = (hasOfflineData && bestRes !== null && bestRes <= 1) ? 1 : 5;
        
        const numSteps = Math.max(1, Math.floor(segmentDist / interval));

        for (let step = 0; step <= numSteps; step++) {
          const t = step / numSteps;
          const lat = p1.lat + (p2.lat - p1.lat) * t;
          const lng = p1.lng + (p2.lng - p1.lng) * t;
          const stepDistMetres = totalDistMetres + (segmentDist * t);
          
          const alt = await fetchLidar(lat, lng);
          if (alt !== null) {
            lastKnownAlt = alt;
          } else if (step === 0 && p1.alt) {
            lastKnownAlt = p1.alt;
          }
          
          const currentAlt = lastKnownAlt;

          result.push({
            distance: stepDistMetres * 1.09361, // Yards for X-axis display
            distanceMetres: stepDistMetres,
            elevationDiff: (currentAlt - baselineAlt) * 3.28084, // Feet
            elevationDiffMetres: currentAlt - baselineAlt,
            absoluteAltitude: currentAlt * 3.28084, // Feet
            absoluteAltitudeMetres: currentAlt,
            isPivot: step === 0 || (i === anchors.length - 2 && step === numSteps)
          });
        }
        totalDistMetres += segmentDist;
      }
      return result;
    };

    const scratchProfile = await processAnchors(getAnchors(true));
    const bogeyProfile = await processAnchors(getAnchors(false));

    setProfiles(prev => ({ ...prev, [record.id]: { scratch: scratchProfile, bogey: bogeyProfile } }));
    setIsLoadingLidar(false);
  };

  useEffect(() => {
    if (currentTrack && !isSummaryPage) {
      generateProfile(currentTrack);
    }
  }, [currentIndex, tracks, isSummaryPage]);

  const exportPDF = async () => {
    setIsExporting(true);
    window.scrollTo(0, 0);
    const pdf = new jsPDF('p', 'mm', 'a4');

    for (let i = 0; i <= tracks.length; i++) {
      setCurrentIndex(i);
      
      if (i < tracks.length) {
        // Wait for profile to be generated for this specific track AND for loading to finish
        let attempts = 0;
        while ((!profilesRef.current[tracks[i].id] || isLoadingLidarRef.current) && attempts < 300) {
          await new Promise(resolve => setTimeout(resolve, 200));
          attempts++;
        }
      }
      
      // Extra wait for Recharts or Leaflet to render
      const waitTime = i === tracks.length ? 3000 : 1500;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      if (reportRef.current) {
        const canvas = await html2canvas(reportRef.current, {
          useCORS: true,
          scale: 2,
          logging: false,
          backgroundColor: '#ffffff'
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.9);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        
        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
      }
    }
    
    pdf.save(`${fileName}_Planning_Report.pdf`);
    setIsExporting(false);
  };

  const renderChart = (data: ProfilePoint[], title: string, color: string) => {
    if (!data || data.length === 0) return null;
    const isImperial = reportUnits === 'Yards';
    const xKey = isImperial ? 'distance' : 'distanceMetres';
    const yLeftKey = isImperial ? 'elevationDiff' : 'elevationDiffMetres';
    const yRightKey = isImperial ? 'absoluteAltitude' : 'absoluteAltitudeMetres';
    const xUnit = isImperial ? 'Yards' : 'Metres';
    const yUnit = isImperial ? 'Feet' : 'Metres';

    // Calculate synchronized domains for both Y-axes to ensure visual alignment
    const yLeftValues = data.map(p => p[yLeftKey as keyof ProfilePoint] as number);
    const minLeft = Math.min(...yLeftValues);
    const maxLeft = Math.max(...yLeftValues);
    const diff = maxLeft - minLeft;
    const padding = diff === 0 ? 10 : diff * 0.15;
    const leftDomain = [minLeft - padding, maxLeft + padding];
    
    // The right axis (Absolute Altitude) must be offset by the starting altitude
    const startAlt = data[0][yRightKey as keyof ProfilePoint] as number;
    const rightDomain = [leftDomain[0] + startAlt, leftDomain[1] + startAlt];

    const lastPoint = data[data.length - 1];
    const holeLength = isImperial ? lastPoint.distance : lastPoint.distanceMetres;
    const elevDiff = isImperial ? lastPoint.elevationDiff : lastPoint.elevationDiffMetres;
    
    // Course Rating System Manual adjustment for EPL [Elevation]
    // 1. Determine if it's a short hole for max adjustment constraint
    const holeLengthYards = lastPoint.distance;
    const isMen = currentTrack?.genderRated === 'Men';
    const isWomen = currentTrack?.genderRated === 'Women';
    const isShortHole = (isMen && holeLengthYards < 230) || (isWomen && holeLengthYards < 200);

    let adjustment = 0;
    if (isImperial) {
      // Lower limit of 10 feet elevation difference
      if (Math.abs(elevDiff) >= 10) {
        // Elevation is in feet. Round to nearest 10 feet.
        let roundedElevFeet = Math.round(elevDiff / 10) * 10;
        // For short holes, maximum adjustment is 40 feet
        if (isShortHole) {
          roundedElevFeet = Math.max(-40, Math.min(40, roundedElevFeet));
        }
        // Add to distance. Since distance is in yards, convert feet to yards (3 ft = 1 yd)
        adjustment = roundedElevFeet / 3;
      }
    } else {
      // Lower limit of 3 metres elevation difference (approx 10 feet)
      if (Math.abs(elevDiff) >= 3) {
        // Elevation is in metres. Round to nearest 3 metres.
        let roundedElevMetres = Math.round(elevDiff / 3) * 3;
        // For short holes, maximum adjustment is 40 feet (~12.2 metres)
        if (isShortHole) {
          const maxAdjMetres = 40 / 3.28084;
          roundedElevMetres = Math.max(-maxAdjMetres, Math.min(maxAdjMetres, roundedElevMetres));
        }
        // Add to distance in metres
        adjustment = roundedElevMetres;
      }
    }

    const epl = holeLength + adjustment;
    
    const lengthLabel = `${holeLength.toFixed(0)}${xUnit === 'Yards' ? 'y' : 'm'}`;
    const eplLabel = `${epl.toFixed(0)}${xUnit === 'Yards' ? 'y' : 'm'}`;

    return (
      <div className="flex flex-col w-full mb-6">
        <div className="flex justify-between items-center mb-2 px-4">
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-widest">{title} Profile</h3>
          <div className="flex gap-4 text-[10px] font-bold text-slate-900">
            <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }}></div> Elevation Profile</span>
          </div>
        </div>
        <div className="h-[260px] bg-slate-50 rounded-xl p-4 border border-slate-100">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 40, left: 40, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#94a3b8" />
              <XAxis 
                dataKey={xKey} 
                type="number" 
                domain={[0, 'dataMax']}
                tick={{ fontSize: 9, fill: '#0f172a' }}
                tickFormatter={(val) => val.toFixed(1)}
                stroke="#0f172a"
              >
                <Label 
                  value={`Distance (${xUnit}) | Length: ${lengthLabel} | EPL [Elevation]: ${eplLabel}`} 
                  offset={-10} 
                  position="insideBottom" 
                  fontSize={10} 
                  fontWeight="bold" 
                  fill="#0f172a" 
                />
              </XAxis>
              
              <YAxis 
                yAxisId="left"
                tick={{ fontSize: 9, fill: '#0f172a' }}
                stroke="#0f172a"
                domain={leftDomain}
                tickFormatter={(val) => Math.round(val).toString()}
              >
                <Label value={`Elev Diff (${yUnit})`} angle={-90} position="insideLeft" offset={10} fontSize={10} fontWeight="bold" fill="#0f172a" />
              </YAxis>

              <YAxis 
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 9, fill: '#0f172a' }}
                stroke="#0f172a"
                domain={rightDomain}
                tickFormatter={(val) => Math.round(val).toString()}
              >
                <Label value={`Altitude (${yUnit})`} angle={90} position="insideRight" offset={10} fontSize={10} fontWeight="bold" fill="#0f172a" />
              </YAxis>

              <Tooltip 
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const d = payload[0].payload as ProfilePoint;
                    return (
                      <div className="bg-white border border-slate-200 p-3 shadow-xl rounded-lg text-[10px]">
                        <p className="font-bold text-slate-800 mb-1 border-b pb-1">Distance: {d.distance.toFixed(1)}y / {d.distanceMetres.toFixed(1)}m</p>
                        <p className="text-blue-600 font-medium">Elev Diff: {d.elevationDiff.toFixed(1)}ft / {d.elevationDiffMetres.toFixed(1)}m</p>
                        <p className="text-slate-500 font-medium">Altitude: {d.absoluteAltitude.toFixed(1)}ft / {d.absoluteAltitudeMetres.toFixed(1)}m</p>
                      </div>
                    );
                  }
                  return null;
                }}
              />

              {data.filter(p => p.isPivot).map((p, i) => (
                <ReferenceLine 
                  key={i} 
                  x={p[xKey]} 
                  stroke="#0f172a" 
                  strokeDasharray="3 3" 
                  yAxisId="left"
                />
              ))}
              
              <Area 
                yAxisId="left"
                type="monotone" 
                dataKey={yLeftKey} 
                stroke={color} 
                fill={color} 
                fillOpacity={0.1} 
                strokeWidth={2}
                dot={false}
              />
              
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={yRightKey}
                stroke="none"
                dot={false}
                activeDot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Pivot Points Table */}
        <div className="mt-4 px-4">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-1 font-bold text-slate-900 uppercase tracking-widest">Point</th>
                <th className="text-right py-1 font-bold text-slate-900 uppercase tracking-widest">Leg Dist ({isImperial ? 'yd' : 'm'})</th>
                <th className="text-right py-1 font-bold text-slate-900 uppercase tracking-widest">Leg Elev ({isImperial ? 'ft' : 'm'})</th>
                <th className="text-right py-1 font-bold text-slate-900 uppercase tracking-widest">Total Elev ({isImperial ? 'ft' : 'm'})</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const pivots = data.filter(p => p.isPivot);
                return pivots.map((p, i) => {
                  if (i === 0) return null; // Skip the "Start" point
                  const prev = pivots[i-1];
                  const legDist = isImperial ? (p.distance - prev.distance) : (p.distanceMetres - prev.distanceMetres);
                  const legElev = isImperial ? (p.elevationDiff - prev.elevationDiff) : (p.elevationDiffMetres - prev.elevationDiffMetres);
                  const totalElev = isImperial ? p.elevationDiff : p.elevationDiffMetres;
                  const label = i === pivots.length - 1 ? "End" : `Pivot ${i}`;

                  return (
                    <tr key={i} className="border-b border-slate-200">
                      <td className="py-1 font-bold text-slate-950">{label}</td>
                      <td className="py-1 text-right font-medium text-slate-950">{legDist.toFixed(1)}</td>
                      <td className="py-1 text-right font-medium text-slate-950">{(legElev >= 0 ? '+' : '') + legElev.toFixed(1)}</td>
                      <td className="py-1 text-right font-bold text-blue-700">{(totalElev >= 0 ? '+' : '') + totalElev.toFixed(1)}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const currentProfile = profiles[currentTrack?.id];

  return (
    <div className="fixed inset-0 z-[2000] bg-[#020617] flex flex-col overflow-hidden">
      <div className="bg-slate-900 border-b border-white/10 p-4 flex justify-between items-center shrink-0">
        <button onClick={onClose} className="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center text-white active:scale-90">
          <ChevronLeft size={24} />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Planning Report Tool</span>
          <span className="text-sm font-bold text-white truncate max-w-[200px]">{fileName}</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-slate-800 p-1 rounded-full border border-white/5">
            <button 
              onClick={() => setReportUnits('Yards')}
              className={`px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${reportUnits === 'Yards' ? 'bg-amber-600 text-white shadow-lg' : 'text-slate-400'}`}
            >
              Imperial
            </button>
            <button 
              onClick={() => setReportUnits('Metres')}
              className={`px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${reportUnits === 'Metres' ? 'bg-amber-600 text-white shadow-lg' : 'text-slate-400'}`}
            >
              Metric
            </button>
          </div>
          <button 
            onClick={exportPDF} 
            disabled={isExporting || isLoadingLidar}
            className="bg-amber-600 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2 active:scale-95 disabled:opacity-50"
          >
            {isExporting ? <RotateCcw className="animate-spin" size={14} /> : <Printer size={14} />}
            {isExporting ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center bg-slate-950 no-scrollbar">
        <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar w-full max-w-[210mm]">
          {tracks.map((t, idx) => (
            <button
              key={t.id}
              onClick={() => setCurrentIndex(idx)}
              className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-widest whitespace-nowrap transition-all ${currentIndex === idx ? 'bg-amber-600 text-white shadow-lg' : 'bg-slate-800 text-slate-400'}`}
            >
              Hole {t.holeNumber || idx + 1}
            </button>
          ))}
          <button
            onClick={() => setCurrentIndex(tracks.length)}
            className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-widest whitespace-nowrap transition-all ${currentIndex === tracks.length ? 'bg-amber-600 text-white shadow-lg' : 'bg-slate-800 text-slate-400'}`}
          >
            Summary
          </button>
        </div>

        <div 
          ref={reportRef}
          className="bg-white w-full max-w-[210mm] shadow-2xl flex flex-col p-8 border border-slate-200 relative"
          style={{ minHeight: '297mm' }}
        >
          {isLoadingLidar && (
            <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
              <Loader2 className="animate-spin text-amber-600 mb-4" size={48} />
              <p className="text-slate-900 font-bold uppercase tracking-widest text-sm">Fetching LiDAR Terrain Data...</p>
              <p className="text-slate-900 text-xs mt-2">
                Sampling path at {!isTiffReady ? '...' : ((lidarGeoTiffService.getBestResolution(reportPoint?.lat || 0, reportPoint?.lng || 0) || 5) <= 1 ? '1m' : '5m')} intervals
              </p>
            </div>
          )}

          <div className="flex justify-between items-end border-b-2 border-slate-100 pb-4 mb-6">
            <div className="flex flex-col">
              <div className="flex items-baseline gap-3">
                <h1 className="text-2xl font-black text-slate-900 uppercase tracking-tighter leading-none">Scottish Golf</h1>
                <span className="text-[10px] font-bold text-amber-600 uppercase tracking-[0.3em]">Planning Report Tool</span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <span className="text-[7px] font-bold text-slate-900 uppercase tracking-widest">
                  LiDAR Source: {!isTiffReady ? 'Checking Cache...' : ((lidarGeoTiffService.getBestResolution(reportPoint?.lat || 0, reportPoint?.lng || 0) || 5) <= 1 ? 'Offline GeoTIFF Cache (1m)' : 'Scottish Government LiDAR (5m)')}
                </span>
                {!lidarGeoTiffService.isAreaDownloaded(reportPoint?.lat || 0, reportPoint?.lng || 0) && <span className="text-[7px] font-medium text-blue-500 underline">https://remotesensingdata.gov.scot/</span>}
              </div>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className="text-base font-black text-slate-900 uppercase">{isSummaryPage ? 'Course Summary' : `Hole ${currentTrack?.holeNumber || currentIndex + 1}`}</span>
              <span className="text-[9px] font-bold text-slate-900 uppercase tracking-widest mb-1">{reportTitle}</span>
              {(() => {
                const startPoint = isSummaryPage ? tracks[0]?.points[0] : (currentTrack?.raterPathPoints?.[0] || currentTrack?.points[0]);
                if (!startPoint) return null;
                return (
                  <a 
                    href={`https://www.google.com/maps?q=${startPoint.lat},${startPoint.lng}`} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-[7px] font-bold text-blue-600 underline uppercase tracking-widest"
                  >
                    Google Maps Link
                  </a>
                );
              })()}
            </div>
          </div>

          <div className={`flex-1 flex flex-col report-map`}>
            <style>{`
              .report-map .leaflet-container {
                background: white !important;
              }
              .custom-div-icon {
                background: none !important;
                border: none !important;
              }
            `}</style>
            {isSummaryPage ? (
              <div className="flex-1 flex flex-col">
                <div className="h-[600px] w-full rounded-3xl overflow-hidden border border-slate-200 shadow-inner relative">
                  <MapContainer
                    key="report-map-summary"
                    center={[tracks[0]?.points[0]?.lat || 0, tracks[0]?.points[0]?.lng || 0]}
                    zoom={16}
                    style={{ height: '100%', width: '100%' }}
                    zoomControl={false}
                    dragging={false}
                    scrollWheelZoom={false}
                    doubleClickZoom={false}
                    attributionControl={false}
                    preferCanvas={true}
                  >
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    attribution='&copy; Esri'
                  />
                  {tracks.map((track, idx) => {
                    const points = track.raterPathPoints || track.points;
                    const midIdx = Math.floor(points.length / 2);
                    const midPoint = points[midIdx];
                    return (
                      <React.Fragment key={track.id}>
                        <Polyline
                          positions={points.map(p => [p.lat, p.lng])}
                          color="#fbbf24"
                          weight={4}
                          opacity={0.9}
                        />
                        <Marker
                          position={[midPoint.lat, midPoint.lng]}
                          icon={L.divIcon({
                            className: 'custom-div-icon',
                            html: `<div style="background-color: white; color: #1e293b; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 12px; border: 2px solid #fbbf24; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${track.holeNumber || idx + 1}</div>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12]
                          })}
                        />
                      </React.Fragment>
                    );
                  })}
                  <MapBoundsController points={tracks.flatMap(t => t.raterPathPoints || t.points)} />
                  <MapRuler isSummary={true} />
                </MapContainer>
                
                {avgWindData && (
                  <div className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm p-2 rounded-2xl border border-slate-200 shadow-sm z-[1000] flex flex-col items-center gap-1">
                    <span className="text-[7px] font-black text-slate-400 uppercase tracking-[0.2em]">Prevailing Wind</span>
                    <div className="w-14 h-14 rounded-full border-2 border-slate-200 flex items-center justify-center relative bg-white shadow-sm">
                      <div 
                        className="absolute inset-0 flex items-center justify-center transition-transform duration-1000 ease-out"
                        style={{ transform: `rotate(${avgWindData.avgDirectionDeg + 180}deg)` }}
                      >
                        <div className="h-full w-full relative">
                          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-b-[8px] border-b-emerald-500" />
                        </div>
                      </div>
                      <div className="z-10 flex flex-col items-center justify-center bg-white rounded-full w-10 h-10">
                        <span className="text-xs font-black text-slate-900 leading-none">{avgWindData.avgSpeedMph.toFixed(0)}</span>
                        <span className="text-[6px] font-bold text-slate-500 uppercase">mph</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-center -mt-0.5">
                      <span className="text-[9px] font-black text-slate-900 uppercase tracking-widest">
                        {getCardinalDirection(avgWindData.avgDirectionDeg)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-full border border-slate-200 shadow-sm z-[1000]">
                  <span className="text-[10px] font-black text-slate-900 uppercase tracking-widest">Satellite Overview</span>
                </div>
              </div>
              
              {/* Environmental Data Section */}
              <div className="mt-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center">
                  <div>
                    <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-0.5">Environmental Data</h4>
                    <h3 className="text-base font-bold text-slate-900 uppercase tracking-widest">Daytime Climatology Summary</h3>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Period: April – October (08:00–20:00)</p>
                  </div>
                </div>
                
                <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center">
                      <Wind className="w-4 h-4 text-amber-500" />
                    </div>
                    <div>
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Daytime Avg Wind</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-black text-slate-900">
                          {loadingWind ? (
                            <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                          ) : avgWindData !== null ? (
                            avgWindData.avgSpeedMph.toFixed(1)
                          ) : (
                            '--'
                          )}
                        </span>
                        <span className="text-[9px] font-bold text-slate-500 uppercase">mph</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-orange-50 flex items-center justify-center">
                      <Wind className="w-4 h-4 text-orange-500" />
                    </div>
                    <div>
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Daytime Avg Gust</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-black text-slate-900">
                          {loadingWind ? (
                            <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                          ) : avgWindData !== null ? (
                            avgWindData.avgGustMph.toFixed(1)
                          ) : (
                            '--'
                          )}
                        </span>
                        <span className="text-[9px] font-bold text-slate-500 uppercase">mph</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full border-2 border-emerald-100 flex items-center justify-center relative bg-emerald-50/30">
                      <div 
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ transform: avgWindData ? `rotate(${avgWindData.avgDirectionDeg + 180}deg)` : 'none' }}
                      >
                        <div className="h-full w-full relative">
                          <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[3px] border-l-transparent border-r-[3px] border-r-transparent border-b-[5px] border-b-emerald-500" />
                        </div>
                      </div>
                      <div className="z-10 flex flex-col items-center justify-center">
                        <span className="text-[10px] font-black text-slate-900 leading-none">
                          {avgWindData ? getCardinalDirection(avgWindData.avgDirectionDeg) : '--'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Daytime Avg Direction</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-black text-slate-900">
                          {loadingWind ? (
                            <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                          ) : avgWindData !== null ? (
                            avgWindData.avgDirectionDeg.toFixed(0)
                          ) : (
                            '--'
                          )}
                        </span>
                        <span className="text-[9px] font-bold text-slate-500 uppercase">°</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center">
                      <FileText className="w-4 h-4 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Data Source</p>
                      <a 
                        href="https://open-meteo.com/" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[9px] font-bold text-blue-600 uppercase tracking-widest hover:underline"
                      >
                        Open-Meteo Archive
                      </a>
                    </div>
                  </div>
                </div>
                
                <p className="mt-3 text-[7px] font-medium text-slate-400 leading-relaxed italic">
                  * Average daytime wind speed (08:00–20:00), direction, and max gust calculated at 10m height using historical data from the last 3 full years (2022-2024) for the months of April to October.
                </p>
              </div>
            </div>
          ) : currentProfile ? (
            <div className="flex-1 flex flex-col">
              {renderChart(currentProfile.scratch, `Scratch ${currentTrack?.genderRated ? `(${currentTrack.genderRated})` : ''}`, '#10b981')}
              {renderChart(currentProfile.bogey, `Bogey ${currentTrack?.genderRated ? `(${currentTrack.genderRated})` : ''}`, '#facc15')}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center border-2 border-dashed border-slate-100 rounded-[2rem]">
              <p className="text-slate-900 font-bold uppercase tracking-widest">No Profile Data Available</p>
            </div>
          )}
          </div>

          <div className="mt-auto pt-8 border-t border-slate-100 flex justify-between items-center text-[9px] font-bold text-slate-900 uppercase tracking-widest">
            <span>Generated by Scottish Golf Rating Toolkit</span>
            <span>{new Date().toLocaleDateString()}</span>
            <span>Page {currentIndex + 1} of {tracks.length + 1}</span>
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
        <div className="flex flex-col items-center gap-1">
          <span className="text-white/60 font-bold text-xs uppercase tracking-widest">
            {isSummaryPage ? 'Course Summary' : `Hole ${currentTrack?.holeNumber || currentIndex + 1} of ${tracks.length}`}
          </span>
          <button 
            onClick={() => setShowTitleDialog(true)}
            className="text-[9px] text-amber-400 font-bold uppercase tracking-widest hover:underline"
          >
            Edit Report Title
          </button>
        </div>
        <button 
          onClick={() => setCurrentIndex(prev => Math.min(tracks.length, prev + 1))}
          disabled={currentIndex === tracks.length}
          className="flex items-center gap-2 text-white font-bold uppercase text-xs tracking-widest disabled:opacity-30"
        >
          Next <ChevronRight size={20} />
        </button>
      </div>

      {showTitleDialog && (
        <div className="fixed inset-0 z-[3000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-white/10 w-full max-w-md rounded-[2.5rem] p-8 shadow-2xl animate-in zoom-in-95 duration-300">
            <div className="w-16 h-16 bg-amber-600 rounded-full flex items-center justify-center mb-6 shadow-xl shadow-amber-600/20 mx-auto">
              <FileText size={32} className="text-white" />
            </div>
            <h2 className="text-2xl font-bold text-white text-center mb-2">Report Title</h2>
            <p className="text-slate-400 text-xs text-center mb-8 leading-relaxed">
              Enter a title for your planning report, such as the name of the golf course or project.
            </p>
            
            <div className="space-y-6">
              <div className="relative">
                <input 
                  type="text"
                  value={reportTitle}
                  onChange={(e) => setReportTitle(e.target.value)}
                  placeholder="e.g. St Andrews Old Course"
                  className="w-full bg-slate-950 border border-white/10 rounded-2xl py-4 px-6 text-white focus:outline-none focus:border-amber-500 transition-all text-lg font-bold"
                  autoFocus
                />
              </div>
              
              <button 
                onClick={() => setShowTitleDialog(false)}
                className="w-full bg-amber-600 text-white font-bold py-4 rounded-2xl shadow-xl shadow-amber-600/20 active:scale-95 transition-all uppercase tracking-widest text-sm"
              >
                Set Title & Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
