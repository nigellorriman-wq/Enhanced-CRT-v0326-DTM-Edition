import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, MapPin, ChevronRight, X, Navigation2, Zap, Wind, Loader2, Database, CheckCircle2, AlertCircle, FileDown, Globe, Phone, Home, BookOpen } from 'lucide-react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { GoogleGenAI, Type } from '@google/genai';
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

interface CoursePlanningProps {
  onSelect: (lat: number, lng: number, name: string) => void;
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

  const courseCoords = useMemo(() => {
    if (!selectedCourse) return null;
    return osgbToWgs84(selectedCourse.easting, selectedCourse.northing);
  }, [selectedCourse]);

  const fetchContactInfo = async (course: typeof golfCourses[0]) => {
    const coords = osgbToWgs84(course.easting, course.northing);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Find the official contact information for the golf course: "${course.site_name}" located in "${course.town}", Scotland (Approx. Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}).

        STRICT LOCATION VERIFICATION:
        1. Identify the exact club at the provided town and coordinates.
        2. BEWARE: Avoid confusion with similarly named clubs (e.g., "Musselburgh Golf Club" vs "Royal Musselburgh Golf Club").
        3. Verify the found course's postcode area matches the expected area for ${course.town}.
        4. If the closest match is in a different town or has a different postcode area than expected for ${course.town}, do not confirm the match.

        Return ONLY a JSON object with: website (full URL), phone, full_address, postcode, and verified_match (boolean).`,
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
          tools: [{ googleSearch: {} }],
          toolConfig: { includeServerSideToolInvocations: true }
        }
      });

      if (response.text) {
        const data = JSON.parse(response.text.trim()) as CourseContactInfo;
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
          try {
            const response = await fetch(`/api/lidar?lat=${pt.lat}&lng=${pt.lng}`);
            if (response.ok) {
              const data = await response.json();
              if (data && typeof data.elevation === 'number' && data.elevation !== null) {
                hits++;
                currentReadings.push({ elevation: data.elevation, lat: pt.lat, lng: pt.lng });
              } else {
                currentReadings.push({ elevation: null, lat: pt.lat, lng: pt.lng });
              }
            } else {
              currentReadings.push({ elevation: null, lat: pt.lat, lng: pt.lng });
            }
          } catch (e) {
            console.error('LiDAR scan point failed', e);
            currentReadings.push({ elevation: null, lat: pt.lat, lng: pt.lng });
          }
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
                className="w-full md:w-auto bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed border border-white/10 text-white font-bold py-3 px-6 rounded-2xl shadow-xl hover:bg-slate-700 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group"
              >
                {isExporting ? <Loader2 size={18} className="animate-spin text-blue-500" /> : <FileDown size={18} className={`${(loadingWeather || lidarSummary?.scanning || loadingContact) ? 'text-slate-500' : 'text-blue-400'} group-hover:scale-110 transition-transform`} />}
                <span className="text-xs">
                  {isExporting ? 'EXPORTING...' : (loadingWeather || lidarSummary?.scanning || loadingContact) ? 'ANALYZING COURSE...' : 'EXPORT SUMMARY PDF'}
                </span>
              </button>
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
