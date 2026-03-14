
import React, { useState, useCallback, useEffect } from 'react';
import type { AnalysisState, VerificationResult } from './types';
import { extractClaims, verifyClaim, generateCritiqueAndPrompt } from './services/geminiService';
import { InputSection } from './components/InputSection';
import { Dashboard } from './components/Dashboard';
import { Tour } from './components/Tour';
import { Info, X, Zap, ExternalLink, Github, Youtube, FileText, PlayCircle } from 'lucide-react';

// Safe environment variable access helper
const getApiKey = (): string | undefined => {
  // Check if process exists and has the expected structure
  if (typeof process !== 'undefined' && process.env) {
    return process.env.API_KEY;
  }
  return undefined;
};

type ViewMode = 'INPUT' | 'REPORT';

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('INPUT');
  const [showDemoInfo, setShowDemoInfo] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    claims: [],
    verifications: {},
    isProcessing: false,
    progressMessage: '',
    step: 'idle',
    overallRisk: 'low'
  });

  // Check for first-time visitor
  useEffect(() => {
    const hasSeenTour = localStorage.getItem('faultline_has_seen_tour');
    if (!hasSeenTour) {
      setShowTour(true);
      localStorage.setItem('faultline_has_seen_tour', 'true');
    }
  }, []);

  const handleReset = () => {
    setAnalysisState({
      claims: [],
      verifications: {},
      isProcessing: false,
      progressMessage: '',
      step: 'idle',
      overallRisk: 'low'
    });
    setViewMode('INPUT');
  };

  const calculateRisk = (verifications: Record<string, VerificationResult>, totalClaims: number): AnalysisState['overallRisk'] => {
    const values = Object.values(verifications);
    const contradicted = values.filter(v => v.status === 'contradicted').length;
    const mixed = values.filter(v => v.status === 'mixed').length;

    if (contradicted > 2) return 'critical';
    if (contradicted > 0 || mixed > 2) return 'high';
    if (mixed > 0) return 'medium';
    return 'low';
  };

  const handleAnalyze = useCallback(async (text: string, image?: { data: string, mimeType: string }) => {
    const apiKey = getApiKey();

    if (!apiKey) {
        alert("API Key missing. Please ensure you are running in an environment with API_KEY configured.");
        return;
    }

    setViewMode('REPORT');
    setAnalysisState(prev => ({
        ...prev,
        isProcessing: true,
        progressMessage: 'Mapping geological structure...',
        step: 'extracting'
    }));

    try {
        // Step 1: Extraction
        const claims = await extractClaims(text, apiKey, image);

        if (claims.length === 0) {
            throw new Error("No structural elements detected.");
        }

        // Identify which claims are testable (Facts with importance >= 3)
        // We do verify ALL important facts now, not just top 5, but let's cap at 8 for performance/rate-limits
        const claimsToVerify = claims
            .filter(c => c.type === 'fact' && c.importance >= 3)
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 8);

        const claimIdsToVerify = new Set(claimsToVerify.map(c => c.id));

        setAnalysisState(prev => ({
            ...prev,
            claims,
            progressMessage: `Mapped ${claims.length} structural elements. Stress-testing ${claimsToVerify.length} critical load-bearing facts...`,
            step: 'verifying'
        }));

        // Initialize verifications state
        // IMPORTANT: We must set a state for ALL claims, otherwise 'ClaimRow' might get stuck loading
        const initialVerifications: Record<string, VerificationResult> = {};

        claims.forEach(c => {
             if (claimIdsToVerify.has(c.id)) {
                 initialVerifications[c.id] = { claimId: c.id, status: 'loading', explanation: 'Queued for stress-testing...', sources: [] };
             } else {
                 // Mark as skipped (Opinion or Low Importance)
                 let reason = 'Low load-bearing impact.';
                 if (c.type === 'opinion') reason = 'Subjective opinion (not testable).';
                 if (c.type === 'interpretation') reason = 'Interpretation (context dependent).';

                 initialVerifications[c.id] = {
                     claimId: c.id,
                     status: 'skipped',
                     explanation: reason,
                     sources: []
                 };
             }
        });

        setAnalysisState(prev => ({ ...prev, verifications: initialVerifications }));

        // Step 2: Verification Loop
        for (const claim of claimsToVerify) {
            // Update progress for specific claim
            setAnalysisState(prev => ({
                ...prev,
                verifications: {
                    ...prev.verifications,
                    [claim.id]: { ...prev.verifications[claim.id], explanation: 'Running seismic stress test...' }
                }
            }));

            const result = await verifyClaim(claim, apiKey);

            setAnalysisState(prev => {
                const updatedVerifications = { ...prev.verifications, [claim.id]: result };
                return {
                    ...prev,
                    verifications: updatedVerifications,
                    overallRisk: calculateRisk(updatedVerifications, claims.length)
                };
            });
        }

        // Step 3: Critique
        const { critique, improvedPrompt } = await generateCritiqueAndPrompt(text || "Image-based analysis", claimsToVerify, apiKey);

        setAnalysisState(prev => ({
            ...prev,
            isProcessing: false,
            step: 'complete',
            critique,
            improvedPrompt
        }));

    } catch (error) {
        console.error(error);
        setAnalysisState(prev => ({
            ...prev,
            isProcessing: false,
            progressMessage: 'Seismic survey interrupted due to technical error.',
            step: 'idle'
        }));
        alert("An error occurred during analysis. Check console for details.");
        setViewMode('INPUT');
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 selection:bg-orange-500/30">
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none"></div>

      <header className="absolute top-0 left-0 w-full p-6 flex justify-between items-center z-10 pointer-events-none">
        <div className="text-xl font-bold tracking-tighter text-slate-500 pointer-events-auto cursor-pointer select-none" onClick={handleReset}>
          Fault<span className="text-orange-500">line</span>
        </div>

        {/* Live Demo Button */}
        <button
            onClick={() => setShowDemoInfo(true)}
            className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700/50 hover:bg-slate-700 hover:border-orange-500/30 transition-all text-sm text-slate-400 hover:text-orange-400 group cursor-pointer"
            title="learn more"
        >
            <span>Live Demo</span>
            <Info size={16} />
        </button>
      </header>

      <main className="relative z-0">
        {viewMode === 'INPUT' ? (
          <InputSection onAnalyze={handleAnalyze} isProcessing={analysisState.isProcessing} />
        ) : (
          <Dashboard state={analysisState} onReset={handleReset} />
        )}
      </main>

      {/* Guided Tour Modal */}
      <Tour
        isOpen={showTour}
        onClose={() => setShowTour(false)}
        onOpenLiveDemo={() => {
            setShowTour(false);
            setShowDemoInfo(true);
        }}
      />

      {/* Demo Info Modal */}
      {showDemoInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full p-6 relative animate-in zoom-in-95 duration-200">
                <button
                    onClick={() => setShowDemoInfo(false)}
                    className="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors"
                >
                    <X size={20} />
                </button>

                <div className="flex items-start gap-4 mb-6">
                    <div className="p-3 bg-orange-500/10 rounded-full border border-orange-500/20 flex-shrink-0">
                        <Zap className="text-orange-500" size={24} />
                    </div>
                    <div>
                        <h3 className="text-xl font-bold text-white">Hackathon Live Demo</h3>
                        <p className="text-slate-400 text-sm mt-2 leading-relaxed">
                            ⚡ This is a fully functional Live Demo built for the Gemini 3 Hackathon. Expect rapid iteration, not production polish.
                        </p>
                    </div>
                </div>

                <div className="mb-6">
                    <button
                        onClick={() => {
                            setShowDemoInfo(false);
                            setShowTour(true);
                        }}
                        className="w-full flex items-center justify-center gap-2 p-3 rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 hover:text-white transition-all group"
                    >
                        <PlayCircle size={20} className="group-hover:scale-110 transition-transform" />
                        <span className="font-bold">Start Guided Mission Briefing</span>
                    </button>
                </div>

                <div className="space-y-3 bg-slate-950/50 rounded-xl p-4 border border-slate-800">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Steal my work</h4>

                    <a href="https://ai.studio/apps/drive/1zAf8IZnRT6w8kXJ42aTT0DUNhYhacjmT?fullscreenApplet=true" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between group p-3 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700/50">
                        <div className="flex items-center gap-3">
                            <ExternalLink size={18} className="text-blue-400" />
                            <span className="text-slate-300 text-sm font-medium group-hover:text-white">Project Link: Faultline</span>
                        </div>
                        <ExternalLink size={14} className="text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>

                    <a href="https://www.kaggle.com/competitions/gemini-3/writeups/faultline-seismic-stress-testing-for-ai-hallucina" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between group p-3 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700/50">
                        <div className="flex items-center gap-3">
                            <FileText size={18} className="text-cyan-400" />
                            <span className="text-slate-300 text-sm font-medium group-hover:text-white">Kaggle Writeup</span>
                        </div>
                        <ExternalLink size={14} className="text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>

                    <a href="https://youtu.be/9UTA2nIYmCM" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between group p-3 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700/50">
                        <div className="flex items-center gap-3">
                            <Youtube size={18} className="text-red-500" />
                            <span className="text-slate-300 text-sm font-medium group-hover:text-white">Video Demo: Faultline Demo</span>
                        </div>
                        <ExternalLink size={14} className="text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>

                    <a href="https://github.com/awaliuddin/Faultline" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between group p-3 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700/50">
                        <div className="flex items-center gap-3">
                            <Github size={18} className="text-white" />
                            <span className="text-slate-300 text-sm font-medium group-hover:text-white">GitHub Repo: Faultline Repo</span>
                        </div>
                        <ExternalLink size={14} className="text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>
                </div>

                 <div className="mt-6 flex justify-end">
                    <button
                        onClick={() => setShowDemoInfo(false)}
                        className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-lg transition-colors border border-slate-700"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
}

export default App;
