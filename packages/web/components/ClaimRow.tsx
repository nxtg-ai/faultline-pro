
import React from 'react';
import type { Claim, VerificationResult } from '../types';
import { CheckCircle2, XCircle, AlertTriangle, HelpCircle, ExternalLink, Loader2, MinusCircle } from 'lucide-react';

interface ClaimRowProps {
  claim: Claim;
  verification?: VerificationResult;
}

export const ClaimRow: React.FC<ClaimRowProps> = ({ claim, verification }) => {
  const getStatusIcon = () => {
    // If no verification object exists at all, it's a loading state fallback
    if (!verification) return <Loader2 className="animate-spin text-slate-500" size={20} />;

    switch (verification.status) {
      case 'supported': return <CheckCircle2 className="text-emerald-500" size={20} />;
      case 'contradicted': return <XCircle className="text-red-500" size={20} />;
      case 'mixed': return <AlertTriangle className="text-amber-500" size={20} />;
      case 'unverified': return <HelpCircle className="text-slate-500" size={20} />;
      case 'loading': return <Loader2 className="animate-spin text-orange-500" size={20} />;
      case 'skipped': return <MinusCircle className="text-slate-600" size={20} />;
      default: return <HelpCircle className="text-slate-500" size={20} />;
    }
  };

  const getStatusColor = () => {
    if (!verification) return 'border-l-slate-700 bg-slate-800/30 opacity-50';
    switch (verification.status) {
      case 'supported': return 'border-l-emerald-500 bg-emerald-950/10';
      case 'contradicted': return 'border-l-red-500 bg-red-950/10';
      case 'mixed': return 'border-l-amber-500 bg-amber-950/10';
      case 'skipped': return 'border-l-slate-700 bg-slate-800/20'; // Dimmed for skipped
      case 'loading': return 'border-l-orange-500/50 bg-orange-950/5';
      default: return 'border-l-slate-500 bg-slate-800/30';
    }
  };

  return (
    <div className={`p-4 rounded-r-lg border-l-4 mb-3 transition-all ${getStatusColor()}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-mono uppercase tracking-wider ${verification?.status === 'skipped' ? 'text-slate-600' : 'text-slate-500'}`}>
              {claim.type} • Load Bearing: {claim.importance}/5
            </span>
          </div>
          <p className={`font-medium text-lg leading-snug ${verification?.status === 'skipped' ? 'text-slate-500' : 'text-slate-200'}`}>
            {claim.text}
          </p>

          {verification && verification.status !== 'loading' && verification.status !== 'skipped' && (
            <div className="mt-3 text-sm text-slate-400 bg-slate-900/50 p-3 rounded border border-white/5">
              <p className="mb-2"><span className="font-semibold text-slate-300">Structural Analysis:</span> {verification.explanation}</p>

              {verification.sources.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {verification.sources.map((source, idx) => (
                    <a
                      key={idx}
                      href={source.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300 hover:underline bg-orange-950/30 px-2 py-1 rounded transition-colors"
                    >
                      <ExternalLink size={10} />
                      {source.title.length > 30 ? source.title.substring(0, 30) + '...' : source.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {verification?.status === 'skipped' && (
             <div className="mt-2 text-xs text-slate-600 italic">
               {verification.explanation}
             </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-2 min-w-[40px]">
          {getStatusIcon()}
          {verification && verification.status !== 'loading' && verification.status !== 'skipped' && (
            <span className={`text-[10px] uppercase font-bold tracking-wider ${
              verification.status === 'supported' ? 'text-emerald-500' :
              verification.status === 'contradicted' ? 'text-red-500' :
              verification.status === 'mixed' ? 'text-amber-500' : 'text-slate-500'
            }`}>
              {verification.status}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
