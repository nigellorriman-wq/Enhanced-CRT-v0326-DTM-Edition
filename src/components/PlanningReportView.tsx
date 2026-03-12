import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Printer, RotateCcw, BarChart3, Download, Loader2 } from 'lucide-react';
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
import { SavedRecord, GeoPoint, UnitSystem, calculateDistance } from '../App';

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
  const [profiles, setProfiles] = useState<Record<string, { scratch: ProfilePoint[], bogey: ProfilePoint[] }>>({});
  const profilesRef = useRef(profiles);
  const isLoadingLidarRef = useRef(isLoadingLidar);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => { profilesRef.current = profiles; }, [profiles]);
  useEffect(() => { isLoadingLidarRef.current = isLoadingLidar; }, [isLoadingLidar]);

  const currentTrack = tracks[currentIndex];

  const fetchLidar = async (lat: number, lng: number): Promise<number | null> => {
    try {
      const response = await fetch(`/api/lidar?lat=${lat}&lng=${lng}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (data && data.elevation !== undefined) return parseFloat(data.elevation);
      if (data && data.results && data.results.length > 0) {
        const res = data.results[0];
        return parseFloat(res.value || res.attributes?.['Pixel Value'] || res.attributes?.['Value'] || res.attributes?.['value'] || res.attributes?.['ST_Elevation']);
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const generateProfile = async (record: SavedRecord) => {
    if (profiles[record.id]) return;

    setIsLoadingLidar(true);
    
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
      const startAlt = anchors[0].alt || (await fetchLidar(anchors[0].lat, anchors[0].lng)) || 0;

      for (let i = 0; i < anchors.length - 1; i++) {
        const p1 = anchors[i];
        const p2 = anchors[i+1];
        const segmentDist = calculateDistance(p1, p2);
        const interval = 5; // 5m interval
        const numSteps = Math.max(1, Math.floor(segmentDist / interval));

        for (let step = 0; step <= numSteps; step++) {
          const t = step / numSteps;
          const lat = p1.lat + (p2.lat - p1.lat) * t;
          const lng = p1.lng + (p2.lng - p1.lng) * t;
          const stepDistMetres = totalDistMetres + (segmentDist * t);
          
          const alt = await fetchLidar(lat, lng);
          const currentAlt = alt !== null ? alt : (p1.alt || 0);

          result.push({
            distance: stepDistMetres * 1.09361, // Yards for X-axis display
            distanceMetres: stepDistMetres,
            elevationDiff: (currentAlt - startAlt) * 3.28084, // Feet
            elevationDiffMetres: currentAlt - startAlt,
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
    if (currentTrack) {
      generateProfile(currentTrack);
    }
  }, [currentIndex, tracks]);

  const exportPDF = async () => {
    setIsExporting(true);
    const pdf = new jsPDF('p', 'mm', 'a4');

    for (let i = 0; i < tracks.length; i++) {
      setCurrentIndex(i);
      
      // Wait for profile to be generated for this specific track AND for loading to finish
      let attempts = 0;
      while ((!profilesRef.current[tracks[i].id] || isLoadingLidarRef.current) && attempts < 300) {
        await new Promise(resolve => setTimeout(resolve, 200));
        attempts++;
      }
      
      // Extra wait for Recharts to render
      await new Promise(resolve => setTimeout(resolve, 1000));
      
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
    const isImperial = reportUnits === 'Yards';
    const xKey = isImperial ? 'distance' : 'distanceMetres';
    const yLeftKey = isImperial ? 'elevationDiff' : 'elevationDiffMetres';
    const yRightKey = isImperial ? 'absoluteAltitude' : 'absoluteAltitudeMetres';
    const xUnit = isImperial ? 'Yards' : 'Metres';
    const yUnit = isImperial ? 'Feet' : 'Metres';

    return (
      <div className="flex flex-col w-full mb-12">
        <div className="flex justify-between items-center mb-2 px-4">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">{title} Profile</h3>
          <div className="flex gap-4 text-[10px] font-bold text-slate-400">
            <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }}></div> Elevation Profile</span>
          </div>
        </div>
        <div className="h-[300px] bg-slate-50 rounded-xl p-4 border border-slate-100">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 40, left: 40, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis 
                dataKey={xKey} 
                type="number" 
                domain={[0, 'dataMax']}
                tick={{ fontSize: 9, fill: '#64748b' }}
                tickFormatter={(val) => val.toFixed(1)}
                stroke="#cbd5e1"
              >
                <Label value={`Distance (${xUnit})`} offset={-10} position="insideBottom" fontSize={10} fontWeight="bold" fill="#475569" />
              </XAxis>
              
              <YAxis 
                yAxisId="left"
                tick={{ fontSize: 9, fill: '#64748b' }}
                stroke="#cbd5e1"
              >
                <Label value={`Elev Diff (${yUnit})`} angle={-90} position="insideLeft" offset={10} fontSize={10} fontWeight="bold" fill="#475569" />
              </YAxis>

              <YAxis 
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 9, fill: '#64748b' }}
                stroke="#cbd5e1"
              >
                <Label value={`Altitude (${yUnit})`} angle={90} position="insideRight" offset={10} fontSize={10} fontWeight="bold" fill="#475569" />
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
                  stroke="#94a3b8" 
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
                <th className="text-left py-1 font-bold text-slate-400 uppercase tracking-widest">Point</th>
                <th className="text-right py-1 font-bold text-slate-400 uppercase tracking-widest">Leg Dist ({isImperial ? 'yd' : 'm'})</th>
                <th className="text-right py-1 font-bold text-slate-400 uppercase tracking-widest">Leg Elev ({isImperial ? 'ft' : 'm'})</th>
                <th className="text-right py-1 font-bold text-slate-400 uppercase tracking-widest">Total Elev ({isImperial ? 'ft' : 'm'})</th>
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
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-1 font-bold text-slate-800">{label}</td>
                      <td className="py-1 text-right font-medium text-slate-600">{legDist.toFixed(1)}</td>
                      <td className="py-1 text-right font-medium text-slate-600">{(legElev >= 0 ? '+' : '') + legElev.toFixed(1)}</td>
                      <td className="py-1 text-right font-bold text-blue-600">{(totalElev >= 0 ? '+' : '') + totalElev.toFixed(1)}</td>
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
        </div>

        <div 
          ref={reportRef}
          className="bg-white w-full max-w-[210mm] shadow-2xl flex flex-col p-12 border border-slate-200 relative"
          style={{ minHeight: '297mm' }}
        >
          {isLoadingLidar && (
            <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
              <Loader2 className="animate-spin text-amber-600 mb-4" size={48} />
              <p className="text-slate-800 font-bold uppercase tracking-widest text-sm">Fetching LiDAR Terrain Data...</p>
              <p className="text-slate-400 text-xs mt-2">Sampling path at 5m intervals</p>
            </div>
          )}

          <div className="flex justify-between items-end border-b-2 border-slate-100 pb-6 mb-10">
            <div className="flex flex-col">
              <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tighter leading-none">Scottish Golf</h1>
              <span className="text-[11px] font-bold text-amber-600 uppercase tracking-[0.4em] mt-1">Planning Report Tool</span>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className="text-lg font-black text-slate-900 uppercase">Hole {currentTrack?.holeNumber || currentIndex + 1}</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{fileName}</span>
            </div>
          </div>

          {currentProfile ? (
            <div className="flex-1 flex flex-col">
              {renderChart(currentProfile.scratch, 'Scratch', '#10b981')}
              {renderChart(currentProfile.bogey, 'Bogey', '#facc15')}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center border-2 border-dashed border-slate-100 rounded-[2rem]">
              <p className="text-slate-300 font-bold uppercase tracking-widest">No Profile Data Available</p>
            </div>
          )}

          <div className="mt-auto pt-8 border-t border-slate-100 flex justify-between items-center text-[9px] font-bold text-slate-400 uppercase tracking-widest">
            <span>Generated by Scottish Golf Rating Toolkit</span>
            <span>{new Date().toLocaleDateString()}</span>
            <span>Page {currentIndex + 1} of {tracks.length}</span>
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
          Hole {currentTrack?.holeNumber || currentIndex + 1} of {tracks.length}
        </span>
        <button 
          onClick={() => setCurrentIndex(prev => Math.min(tracks.length - 1, prev + 1))}
          disabled={currentIndex === tracks.length - 1}
          className="flex items-center gap-2 text-white font-bold uppercase text-xs tracking-widest disabled:opacity-30"
        >
          Next <ChevronRight size={20} />
        </button>
      </div>
    </div>
  );
};
