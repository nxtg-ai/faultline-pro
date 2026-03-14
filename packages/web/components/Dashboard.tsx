import React, { useEffect, useState } from 'react';
import type { AnalysisState, VerificationResult } from '../types';
import { ClaimRow } from './ClaimRow';
import { ArrowLeft, Activity, Hammer, Construction, Loader2, CheckCircle2, AlertTriangle, AlertOctagon, Check } from 'lucide-react';

interface DashboardProps {
  state: AnalysisState;
  onReset: () => void;
}

// Seismic Barometer Component
const SeismicBarometer = () => {
  return (
    <div className="flex items-center gap-[3px] h-8 px-2">
      {[...Array(12)].map((_, i) => (
        <div
          key={i}
          className="w-1.5 bg-orange-500 rounded-sm animate-seismic shadow-[0_0_8px_rgba(249,115,22,0.6)]"
          style={{
            animationDelay: `${Math.random() * -1}s`,
            animationDuration: `${0.4 + Math.random() * 0.4}s`
          }}
        />
      ))}
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({ state, onReset }) => {
  const { claims, verifications, overallRisk, critique, improvedPrompt, step } = state;
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // Trigger toast when analysis completes
  useEffect(() => {
    if (step === 'complete') {
      setShowCompletionToast(true);
      const timer = setTimeout(() => setShowCompletionToast(false), 5000); // Hide after 5s
      return () => clearTimeout(timer);
    }
  }, [step]);

  const handleCopy = async () => {
    if (!improvedPrompt) return;
    try {
      await navigator.clipboard.writeText(improvedPrompt);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  // Explicit casting for safety
  const verificationValues = Object.values(verifications) as VerificationResult[];

  const stats = {
    supported: verificationValues.filter((v) => v.status === 'supported').length,
    contradicted: verificationValues.filter((v) => v.status === 'contradicted').length,
    mixed: verificationValues.filter((v) => v.status === 'mixed').length,
    skipped: verificationValues.filter((v) => v.status === 'skipped').length,
    loading: verificationValues.filter((v) => v.status === 'loading').length,
    total: claims.length
  };

  // The Pie Chart uses the TOTAL claims as the denominator now.
  // As tests complete, the 'loading' gap fills with Green/Red/Yellow.
  const totalElements = stats.total || 1; // Prevent div by zero

  // Simple SVG Pie Chart Logic
  const createPieSlice = (startAngle: number, endAngle: number, color: string) => {
    const x1 = 50 + 50 * Math.cos(Math.PI * startAngle / 180);
    const y1 = 50 + 50 * Math.sin(Math.PI * startAngle / 180);
    const x2 = 50 + 50 * Math.cos(Math.PI * endAngle / 180);
    const y2 = 50 + 50 * Math.sin(Math.PI * endAngle / 180);

    // Flag for large arc (if > 180 degrees)
    const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

    // Handle full circle case
    if (Math.abs(endAngle - startAngle) >= 360) {
        return <circle cx="50" cy="50" r="50" fill={color} />;
    }

    return (
      <path
        d={`M 50 50 L ${x1} ${y1} A 50 50 0 ${largeArcFlag} 1 ${x2} ${y2} Z`}
        fill={color}
      />
    );
  };

  const renderPieChart = () => {
    // Determine slices based on TOTAL elements
    // Order: Supported (Green) -> Contradicted (Red) -> Mixed (Yellow) -> Skipped (Grey) -> Loading (Transparent/Empty)

    const data = [
      { value: stats.supported, color: '#10b981' }, // emerald-500
      { value: stats.contradicted, color: '#ef4444' }, // red-500
      { value: stats.mixed, color: '#f59e0b' }, // amber-500
      { value: stats.skipped, color: '#334155' }, // slate-700 (Untested/Skipped)
    ];

    let currentAngle = -90; // Start at top

    return (
      <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-0">
        {data.map((slice, i) => {
          if (slice.value === 0) return null;
          // Calculate angle based on TOTAL elements
          const sliceAngle = (slice.value / totalElements) * 360;
          const endAngle = currentAngle + sliceAngle;
          const path = createPieSlice(currentAngle, endAngle, slice.color);
          currentAngle = endAngle;
          return <g key={i}>{path}</g>;
        })}
        {/* Inner circle for donut effect */}
        <circle cx="50" cy="50" r="38" fill="#1e293b" />
      </svg>
    );
  };

  const getRiskColor = () => {
    switch (overallRisk) {
      case 'low': return 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.2)]';
      case 'medium': return 'text-amber-400 border-amber-500/50 bg-amber-500/10 shadow-[0_0_15px_rgba(245,158,11,0.2)]';
      case 'high': return 'text-orange-500 border-orange-500/50 bg-orange-500/10 shadow-[0_0_15px_rgba(249,115,22,0.2)]';
      case 'critical': return 'text-red-500 border-red-500/50 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.2)]';
      default: return 'text-slate-400 border-slate-500';
    }
  };

  const isAnalysisComplete = step === 'complete';
  const stabilityScore = totalElements > 0 ? Math.round((stats.supported / (totalElements - stats.skipped)) * 100) : 0;
  // Fallback for divide by zero if everything is skipped (unlikely)
  const displayScore = isNaN(stabilityScore) ? 0 : stabilityScore;

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 pb-20 relative">
      <button
        onClick={onReset}
        className="flex items-center space-x-2 text-slate-400 hover:text-white mb-6 transition-colors group"
      >
        <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
        <span>New Seismic Survey</span>
      </button>

      {/* Header Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Scorecard */}
        <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-xl relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-2xl font-bold text-white mb-2">Seismic Integrity Report</h2>
              <div className="flex items-center gap-4 text-sm text-slate-400">
                <span>{claims.length} Structural Elements</span>
                {isAnalysisComplete ? (
                    <span className="text-emerald-400 transition-opacity duration-500">• Verification Complete</span>
                ) : (
                    <span className="text-orange-400 animate-pulse">• Scanning...</span>
                )}
              </div>
            </div>

            {/* Risk Badge or Seismic Barometer */}
            <div className={`px-4 py-2 rounded-lg border flex items-center gap-3 transition-all duration-700 overflow-hidden ${isAnalysisComplete ? getRiskColor() : 'border-slate-700 bg-slate-900/50'}`}>
              {isAnalysisComplete ? (
                <>
                  <Activity size={20} />
                  <span className="font-bold uppercase tracking-wider text-sm">{overallRisk} Risk</span>
                </>
              ) : (
                <>
                  <div className="flex flex-col justify-center">
                    <span className="text-[10px] text-orange-500 font-bold uppercase tracking-widest animate-pulse mb-0.5">Stress Testing...</span>
                    <SeismicBarometer />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center mt-6 gap-8">
             <div className="flex flex-col items-center relative group">
                <div className="h-32 w-32 relative flex-shrink-0 mb-2">
                    {renderPieChart()}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className={`text-2xl font-bold transition-all duration-500 ${isAnalysisComplete ? 'text-white' : 'text-slate-500'}`}>
                            {isAnalysisComplete ? `${displayScore}%` : <Loader2 className="animate-spin opacity-50" />}
                        </span>
                    </div>
                </div>
                <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Stability Score</span>
             </div>

             <div className="flex-1 grid grid-cols-2 gap-4 w-full">
                <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 transition-all hover:border-emerald-500/30">
                    <div className="text-emerald-400 font-bold text-xl">{stats.supported}</div>
                    <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Stable</div>
                </div>
                <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 transition-all hover:border-red-500/30">
                    <div className="text-red-400 font-bold text-xl">{stats.contradicted}</div>
                    <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Fractured</div>
                </div>
                <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 transition-all hover:border-amber-500/30">
                    <div className="text-amber-400 font-bold text-xl">{stats.mixed}</div>
                    <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Unstable</div>
                </div>
                {/* Skipped / Untested Card */}
                <div className="bg-slate-900/20 p-3 rounded-lg border border-dashed border-slate-700 opacity-80">
                    <div className="text-slate-500 font-bold text-xl">{stats.skipped}</div>
                    <div className="text-xs uppercase text-slate-600 font-bold tracking-wider">Untested</div>
                </div>
             </div>
          </div>
        </div>

        {/* AI Critique */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-6 shadow-xl flex flex-col justify-center relative overflow-hidden min-h-[200px]">
             <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
                <Activity size={100} />
             </div>
             <h3 className="text-slate-400 font-semibold mb-3 flex items-center gap-2">
                <Activity size={18} />
                Structural Assessment
             </h3>
             <div className="relative z-10">
               {!isAnalysisComplete && !critique ? (
                 <div className="flex flex-col gap-2 animate-pulse">
                   <div className="h-4 bg-slate-700 rounded w-3/4"></div>
                   <div className="h-4 bg-slate-700 rounded w-full"></div>
                   <div className="h-4 bg-slate-700 rounded w-5/6"></div>
                   <p className="text-sm text-slate-500 mt-2 italic flex items-center gap-2">
                     <span className="w-2 h-2 bg-orange-500 rounded-full animate-ping"></span>
                     Waiting for stress-test results...
                   </p>
                 </div>
               ) : (
                 <p className="text-lg text-slate-200 italic leading-relaxed">
                    "{critique}"
                 </p>
               )}
             </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Claim Table */}
        <div className="lg:col-span-2 space-y-4">
            <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
               Element Stress Testing
               {!isAnalysisComplete && <span className="text-xs font-normal text-slate-500 ml-2 animate-pulse">(Live Data)</span>}
            </h3>
            <div className="space-y-2">
                {claims.map(claim => (
                    <ClaimRow
                        key={claim.id}
                        claim={claim}
                        verification={verifications[claim.id]}
                    />
                ))}
            </div>
        </div>

        {/* Sidebar: Prompt Improvement */}
        <div className="space-y-6">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 sticky top-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <Construction size={18} className="text-purple-400" />
                    Reinforce Foundations
                </h3>

                {!isAnalysisComplete ? (
                   <div className="flex flex-col items-center justify-center py-10 text-slate-500 gap-3">
                      <div className="relative">
                        <Loader2 size={32} className="animate-spin opacity-50" />
                      </div>
                      <span className="text-sm font-light">Drafting blueprints...</span>
                   </div>
                ) : (
                  <>
                    <div className="text-sm text-slate-400 mb-4">
                        To prevent structural failure in future generations, use this reinforced prompt:
                    </div>
                    <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 font-mono text-sm text-purple-200 whitespace-pre-wrap">
                        {improvedPrompt}
                    </div>
                    <button
                        onClick={handleCopy}
                        className={`mt-4 w-full py-2 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 ${isCopied ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white'}`}
                    >
                        {isCopied ? <Check size={14} /> : <Hammer size={14} />}
                        {isCopied ? "Blueprints Copied!" : "Copy Blueprints"}
                    </button>
                  </>
                )}
            </div>
        </div>
      </div>

      {/* Completion Toast Notification */}
      <div className={`fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-slate-800 border border-emerald-500/30 text-emerald-400 px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 transition-all duration-700 z-50 ${showCompletionToast ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}>
          <div className="bg-emerald-500/20 p-2 rounded-full">
            <CheckCircle2 size={24} className="text-emerald-500" />
          </div>
          <div className="flex flex-col">
             <span className="font-bold text-white">Seismic Survey Complete</span>
             <span className="text-xs text-slate-400">All fault lines mapped successfully.</span>
          </div>
      </div>
    </div>
  );
};
