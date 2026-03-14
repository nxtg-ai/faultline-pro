
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Map, Activity, Shield, Zap, Info } from 'lucide-react';
import { FEATURES } from './featureData';

interface TourProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenLiveDemo: () => void;
}

export const Tour: React.FC<TourProps> = ({ isOpen, onClose, onOpenLiveDemo }) => {
  const [step, setStep] = useState(0);

  // Reset step when opened
  useEffect(() => {
    if (isOpen) setStep(0);
  }, [isOpen]);

  if (!isOpen) return null;

  const totalSteps = 6; // Intro + Input + 3 Features + Outro

  const nextStep = () => {
    if (step < totalSteps - 1) setStep(step + 1);
    else onClose(); // Finish
  };

  const prevStep = () => {
    if (step > 0) setStep(step - 1);
  };

  // Render content based on step
  const renderContent = () => {
    switch (step) {
      case 0:
        return (
          <div className="text-center space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            <div className="w-20 h-20 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto border border-orange-500/30 mb-6 shadow-[0_0_30px_rgba(249,115,22,0.2)]">
                <Activity size={40} className="text-orange-500 animate-pulse" />
            </div>
            <h2 className="text-3xl font-extrabold text-white tracking-tight">Mission Briefing</h2>
            <p className="text-slate-300 text-lg leading-relaxed max-w-md mx-auto">
              Welcome to <strong>Faultline</strong>.
              <br/><br/>
              In a world flooded with synthetic text, structural integrity is the new scarcity. This tool is designed to identify and map the logical fractures in AI-generated answers.
            </p>
          </div>
        );
      case 1:
        return (
          <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
             <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-slate-800 rounded-lg border border-slate-700">
                    <Map size={24} className="text-blue-400" />
                </div>
                <h3 className="text-2xl font-bold text-white">The Vector</h3>
             </div>
             <p className="text-slate-300 leading-relaxed">
                Start by providing the suspect material. You can paste <strong>text</strong> directly or upload an <strong>image</strong> (like a screenshot of a chart or article).
             </p>
             <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-sm text-slate-400 italic">
                "Gemini 3 Pro will analyze this input to extract the underlying claims before we apply pressure."
             </div>
          </div>
        );
      // Reuse Feature Cards for Steps 2, 3, 4
      case 2:
      case 3:
      case 4:
        const featureIndex = step - 2;
        const feature = FEATURES[featureIndex];
        return (
          <div className="animate-in slide-in-from-right-4 duration-300">
            <div className="flex items-start gap-4 mb-6">
                <div className={`p-3 rounded-xl border bg-opacity-10 ${
                        featureIndex === 0 ? 'bg-cyan-500 border-cyan-500/30 text-cyan-400' :
                        featureIndex === 1 ? 'bg-emerald-500 border-emerald-500/30 text-emerald-400' :
                        'bg-red-500 border-red-500/30 text-red-400'
                }`}>
                    {React.createElement(feature.icon, { size: 32 })}
                </div>
                <div>
                    <h3 className="text-xl font-bold text-white tracking-tight">{feature.modalTitle}</h3>
                    <p className={`text-sm font-medium uppercase tracking-wider mt-1 ${feature.color}`}>
                        {feature.modalSubtitle}
                    </p>
                </div>
            </div>
            <div className="prose prose-invert prose-sm">
                {feature.content}
            </div>
          </div>
        );
      case 5:
        return (
           <div className="text-center space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mx-auto border border-slate-700 mb-6">
                <Zap size={40} className="text-yellow-400" />
            </div>
            <h2 className="text-2xl font-bold text-white">Ready to Deploy?</h2>
            <p className="text-slate-300 text-lg leading-relaxed max-w-md mx-auto">
              You are now briefed on the structural engineering behind Faultline.
              <br/><br/>
              Access the <strong>Live Demo</strong> information for the source code, video walkthrough, and our Kaggle writeup.
            </p>
            <button
                onClick={() => { onClose(); onOpenLiveDemo(); }}
                className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white rounded-lg font-bold shadow-lg shadow-orange-900/40 transition-all transform hover:scale-105"
            >
                <Info size={18} />
                <span>Open Live Demo Info</span>
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl relative overflow-hidden flex flex-col min-h-[500px]">

        {/* Progress Bar */}
        <div className="h-1 bg-slate-800 w-full">
            <div
                className="h-full bg-orange-500 transition-all duration-500 ease-out"
                style={{ width: `${((step + 1) / totalSteps) * 100}%` }}
            />
        </div>

        {/* Header */}
        <div className="p-6 flex justify-between items-center border-b border-slate-800">
            <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">
                Classified Briefing // Step {step + 1} of {totalSteps}
            </span>
            <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
                <X size={20} />
            </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 p-8 flex flex-col justify-center">
            {renderContent()}
        </div>

        {/* Footer Navigation */}
        <div className="p-6 border-t border-slate-800 flex justify-between items-center bg-slate-950/30">
            <button
                onClick={prevStep}
                disabled={step === 0}
                className={`flex items-center gap-1 text-sm font-medium transition-colors ${step === 0 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-400 hover:text-white'}`}
            >
                <ChevronLeft size={16} />
                Back
            </button>

            <div className="flex gap-1">
                {[...Array(totalSteps)].map((_, i) => (
                    <div key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i === step ? 'bg-orange-500' : 'bg-slate-700'}`} />
                ))}
            </div>

            {step < totalSteps - 1 ? (
                <button
                    onClick={nextStep}
                    className="flex items-center gap-1 text-sm font-bold text-orange-500 hover:text-orange-400 transition-colors"
                >
                    Next
                    <ChevronRight size={16} />
                </button>
            ) : (
                <button
                    onClick={onClose}
                    className="flex items-center gap-1 text-sm font-bold text-slate-400 hover:text-white transition-colors"
                >
                    Finish
                </button>
            )}
        </div>
      </div>
    </div>
  );
};
