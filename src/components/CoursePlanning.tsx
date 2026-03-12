import React, { useState } from 'react';
import { Search, MapPin, ChevronRight, X, Navigation2, Zap } from 'lucide-react';
import { golfCourses } from '../constants/golfCourses';
import { osgbToWgs84 } from '../utils/coords';

interface CoursePlanningProps {
  onSelect: (lat: number, lng: number, name: string) => void;
  onClose: () => void;
}

export const CoursePlanning: React.FC<CoursePlanningProps> = ({ onSelect, onClose }) => {
  const [search, setSearch] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<typeof golfCourses[0] | null>(null);
  
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
          <div className="bg-blue-500/5 border border-blue-500/20 p-6 rounded-[2rem] flex flex-col items-center text-center animate-in zoom-in-95 duration-300">
            <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mb-4 shadow-xl shadow-blue-600/40">
              <MapPin size={32} />
            </div>
            <h3 className="text-xl font-bold text-white mb-1">{selectedCourse.site_name}</h3>
            <p className="text-blue-400 text-xs font-bold uppercase tracking-widest mb-6">{selectedCourse.town}</p>         
            <p className="text-yellow-600 text-[12px] leading-relaxed max-w-[200px]">
              Ready to analyze this course? Hit the GO button above to load LiDAR terrain data.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
