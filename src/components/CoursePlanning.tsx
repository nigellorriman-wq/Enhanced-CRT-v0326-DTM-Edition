import React, { useState, useEffect, useMemo } from 'react';
import { Search, MapPin, ChevronRight, X, Navigation2, Zap, Wind, Loader2, Database, CheckCircle2, AlertCircle } from 'lucide-react';
import { golfCourses } from '../constants/golfCourses';
import { osgbToWgs84 } from '../utils/coords';
import { fetchAverageWindData, WindData } from '../services/windService';

interface LidarSummary {
  coveragePercent: number;
  maxResolution: number | null;
  scanning: boolean;
}

interface CoursePlanningProps {
  onSelect: (lat: number, lng: number, name: string) => void;
  onClose: () => void;
}

export const CoursePlanning: React.FC<CoursePlanningProps> = ({ onSelect, onClose }) => {
  const [search, setSearch] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<typeof golfCourses[0] | null>(null);
  const [weatherData, setWeatherData] = useState<WindData | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [lidarSummary, setLidarSummary] = useState<LidarSummary | null>(null);

  useEffect(() => {
    if (selectedCourse) {
      const { lat, lng } = osgbToWgs84(selectedCourse.easting, selectedCourse.northing);

      const fetchWeather = async () => {
        setLoadingWeather(true);
        const data = await fetchAverageWindData(lat, lng);
        setWeatherData(data);
        setLoadingWeather(false);
      };

      const scanLidar = async () => {
        setLidarSummary({ coveragePercent: 0, maxResolution: null, scanning: true });
        
        // 3x3 grid, 500m intervals
        const points: { lat: number, lng: number }[] = [];
        const intervalDegrees = 500 / 111320; // Approx 500m in degrees
        
        for (let x = -1; x <= 1; x++) {
          for (let y = -1; y <= 1; y++) {
            points.push({
              lat: lat + (y * intervalDegrees),
              lng: lng + (x * intervalDegrees / Math.cos(lat * Math.PI / 180))
            });
          }
        }

        let hits = 0;
        let bestRes = Infinity;

        // Track seen resolutions and coverage
        for (const pt of points) {
          try {
            const response = await fetch(`/api/lidar?lat=${pt.lat}&lng=${pt.lng}`);
            if (response.ok) {
              const data = await response.json();
              if (data && typeof data.elevation === 'number' && data.elevation !== null) {
                hits++;
              }
            }
          } catch (e) {
            console.error('LiDAR scan point failed', e);
          }
        }

        setLidarSummary({
          coveragePercent: (hits / points.length) * 100,
          maxResolution: hits > 0 ? 0.5 : null, // Scottish LiDAR typically includes 0.5m in most active areas
          scanning: false
        });
      };

      fetchWeather();
      scanLidar();
    } else {
      setWeatherData(null);
      setLidarSummary(null);
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

  return (
    <div className="flex-1 flex flex-col p-6 bg-[#020617] animate-in slide-in-from-right duration-300 overflow-hidden">
      <header className="mb-8 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-600/20">
            <Navigation2 size={20} />
          </div>
          <h1 className="text-3xl font-bold text-blue-500 tracking-tighter">Course Planning</h1>
        </div>
        <button onClick={onClose} className="p-2 bg-slate-800 rounded-full text-slate-400 active:scale-90 transition-all"><X size={20} /></button>
      </header>

      <p className="text-white-400 text-xs mb-6 px-1 leading-relaxed">
        Pre-visit analysis tool. Search for a course below.
      </p>

      <div className="flex flex-col gap-4 shrink-0 mb-6">
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
            className="flex-1 bg-blue-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold py-4 rounded-2xl shadow-xl shadow-blue-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Zap size={18} />
            <span>GO TO COURSE</span>
          </button>
          <button 
            onClick={() => onSelect(56.3436, -2.8025, 'Manual Roam')}
            className="flex-1 bg-slate-800 border border-white/10 text-slate-300 font-bold py-4 rounded-2xl shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Navigation2 size={18} />
            <span>SKIP SEARCH</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-2 pb-8">
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
          <div className="bg-blue-500/5 border border-blue-500/20 p-6 rounded-[2rem] flex flex-col md:flex-row items-center md:items-start gap-8 animate-in zoom-in-95 duration-300">
            <div className="flex flex-col items-center md:items-start text-center md:text-left">
              <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mb-4 shadow-xl shadow-blue-600/40">
                <MapPin size={32} />
              </div>
              <h3 className="text-xl font-bold text-white mb-1">{selectedCourse.site_name}</h3>
              <p className="text-blue-400 text-xs font-bold uppercase tracking-widest mb-6">{selectedCourse.town}</p>         
              <p className="text-yellow-600 text-[12px] leading-relaxed max-w-[180px] mb-6">
                Ready to analyze this course? Hit the GO button above to load LiDAR terrain data.
              </p>
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
                      <div className="w-5 h-5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
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
          </div>
        )}
      </div>
    </div>
  );
};
