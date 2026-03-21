import React, { useState, useEffect } from 'react';
import { ChevronLeft, Layers, Globe, Database, Info, Loader2, AlertCircle } from 'lucide-react';

interface WCSCapabilities {
  serviceName: string;
  serviceTitle: string;
  version: string;
  supportedCRS: string[];
  supportedFormats: string[];
  coverages: {
    id: string;
    subtypes: string[];
  }[];
}

interface WCSAnalyzerProps {
  onBack: () => void;
  onSelectCoverage?: (coverageId: string) => void;
}

export const WCSAnalyzer: React.FC<WCSAnalyzerProps> = ({ onBack, onSelectCoverage }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<WCSCapabilities | null>(null);
  const [activeCoverageId, setActiveCoverageId] = useState<string | null>(null);

  useEffect(() => {
    const fetchCapabilities = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/wcs-capabilities');
        if (!response.ok) throw new Error('Failed to fetch capabilities');
        
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

        // Check for parsing errors
        const parseError = xmlDoc.getElementsByTagName('parsererror');
        if (parseError.length > 0) throw new Error('Error parsing XML');

        // Extract Service Identification
        const serviceId = xmlDoc.getElementsByTagName('ows:ServiceIdentification')[0];
        const title = serviceId?.getElementsByTagName('ows:Title')[0]?.textContent || 'Unknown';
        const name = serviceId?.getElementsByTagName('ows:ServiceType')[0]?.textContent || 'WCS';
        const version = xmlDoc.documentElement.getAttribute('version') || '2.0.1';

        // Extract Service Metadata (CRS and Formats)
        const serviceMetadata = xmlDoc.getElementsByTagName('wcs:ServiceMetadata')[0];
        
        const crsElements = Array.from(xmlDoc.getElementsByTagName('wcs:crsSupported'));
        const crsList = crsElements.map(el => el.textContent || '').filter(Boolean);

        const formatElements = Array.from(xmlDoc.getElementsByTagName('wcs:formatSupported'));
        const formatList = formatElements.map(el => el.textContent || '').filter(Boolean);

        // Extract Contents (Coverages)
        const coverageSummaries = Array.from(xmlDoc.getElementsByTagName('wcs:CoverageSummary'));
        const coverages = coverageSummaries.map(summary => {
          const id = summary.getElementsByTagName('wcs:CoverageId')[0]?.textContent || 'Unknown';
          const subtypes = Array.from(summary.getElementsByTagName('wcs:CoverageSubtype'))
            .map(st => st.textContent || '')
            .filter(Boolean);
          return { id, subtypes };
        });

        setCapabilities({
          serviceName: name,
          serviceTitle: title,
          version,
          supportedCRS: crsList,
          supportedFormats: formatList,
          coverages
        });
      } catch (err: any) {
        console.error('WCS Analysis Error:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchCapabilities();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-white">
        <Loader2 className="w-12 h-12 mb-4 animate-spin text-blue-500" />
        <p className="text-lg font-medium">Analyzing WCS Capabilities...</p>
        <p className="text-sm text-white/60">Fetching XML from JNCC SRSP...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-white">
        <AlertCircle className="w-12 h-12 mb-4 text-rose-500" />
        <p className="text-lg font-medium">Analysis Failed</p>
        <p className="text-sm text-rose-500/80 mb-6">{error}</p>
        <button 
          onClick={onBack}
          className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-xl transition-colors"
        >
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="flex items-center p-4 border-b border-white/10">
        <button onClick={onBack} className="p-2 hover:bg-white/10 rounded-lg mr-4">
          <ChevronLeft size={24} />
        </button>
        <div>
          <h1 className="text-xl font-bold">WCS Capabilities Analysis</h1>
          <p className="text-xs text-white/40">SRSP-OWS JNCC Service</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Service Info */}
        <section className="bg-white/5 rounded-2xl p-6 border border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <Info className="text-blue-400" />
            <h2 className="text-lg font-semibold">Service Identification</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-white/40 uppercase font-bold">Title</p>
              <p className="text-sm">{capabilities?.serviceTitle}</p>
            </div>
            <div>
              <p className="text-xs text-white/40 uppercase font-bold">Version</p>
              <p className="text-sm">{capabilities?.version}</p>
            </div>
            <div>
              <p className="text-xs text-white/40 uppercase font-bold">Service Type</p>
              <p className="text-sm">{capabilities?.serviceName}</p>
            </div>
          </div>
        </section>

        {/* Supported CRS */}
        <section className="bg-white/5 rounded-2xl p-6 border border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <Globe className="text-emerald-400" />
            <h2 className="text-lg font-semibold">Supported CRS</h2>
          </div>
          <p className="text-sm text-white/60 mb-4">
            The service supports {capabilities?.supportedCRS.length} coordinate reference systems.
          </p>
          <div className="max-h-48 overflow-y-auto bg-black/40 rounded-xl p-3 border border-white/5">
            <div className="grid grid-cols-1 gap-1">
              {capabilities?.supportedCRS.map((crs, i) => (
                <div key={i} className="text-[10px] font-mono text-emerald-500/80 break-all py-1 border-b border-white/5 last:border-0">
                  {crs}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Supported Formats */}
        <section className="bg-white/5 rounded-2xl p-6 border border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <Database className="text-amber-400" />
            <h2 className="text-lg font-semibold">Supported Formats</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {capabilities?.supportedFormats.map((format, i) => (
              <span key={i} className="px-3 py-1 bg-amber-500/10 border border-amber-500/20 rounded-full text-xs text-amber-400">
                {format}
              </span>
            ))}
          </div>
        </section>

        {/* Available Coverages */}
        <section className="bg-white/5 rounded-2xl p-6 border border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <Layers className="text-blue-400" />
            <h2 className="text-lg font-semibold">Available Coverages</h2>
          </div>
          <div className="space-y-3">
            {capabilities?.coverages.map((cov, i) => (
              <div key={i} className="p-4 bg-black/40 rounded-xl border border-white/5 flex justify-between items-start gap-4">
                <div className="flex-1">
                  <p className="text-sm font-bold text-blue-400 mb-1">{cov.id}</p>
                  <div className="flex flex-wrap gap-2">
                    {cov.subtypes.map((st, j) => (
                      <span key={j} className="text-[10px] bg-white/5 px-2 py-0.5 rounded text-white/60">
                        {st}
                      </span>
                    ))}
                  </div>
                </div>
                {onSelectCoverage && (
                  <button 
                    onClick={() => {
                      setActiveCoverageId(cov.id);
                      onSelectCoverage(cov.id);
                    }}
                    className={`shrink-0 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${activeCoverageId === cov.id ? 'bg-emerald-600 text-white' : 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/40'}`}
                  >
                    {activeCoverageId === cov.id ? 'Active' : 'View on Map'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
