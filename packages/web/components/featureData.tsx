
import React from 'react';
import { Layers, Search, AlertTriangle, Code, Cpu, Trophy, ExternalLink } from 'lucide-react';

export const FEATURES = [
    {
      id: 0,
      icon: Layers,
      color: "text-cyan-400",
      borderColor: "group-hover:border-cyan-500/50",
      hoverText: "group-hover:text-cyan-400",
      title: "Maps Information Plates",
      modalTitle: "Structural Decomposition",
      modalSubtitle: "Powered by Gemini 3 Pro Reasoning",
      content: (
        <div className="space-y-4 text-slate-300">
            <p>
                LLMs are convincing because they are fluent. <strong>Faultline</strong> disrupts that fluency.
            </p>
            <p>
                We use Gemini 3's advanced reasoning capabilities to strip away rhetoric and isolate <strong>"Atomic Claims"</strong>. By requesting a strict JSON schema, we force the model to categorize every sentence as a <em>Fact</em> (Testable), <em>Opinion</em> (Subjective), or <em>Interpretation</em>.
            </p>
            <div className="bg-cyan-950/30 p-4 rounded-lg border border-cyan-500/20 text-sm mt-4">
                <div className="flex items-center gap-2 mb-2 text-cyan-400 font-bold">
                    <Code size={16} />
                    <span>Dev Lesson: Schema is Strategy</span>
                </div>
                Don't just ask for text. Use Gemini's <code>responseSchema</code> to enforce structural thinking. It turns a creative writer into a data parser.
            </div>
            <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-cyan-400 transition-colors mt-2">
                <ExternalLink size={12} />
                Try JSON Mode in Google AI Studio
            </a>
        </div>
      )
    },
    {
      id: 1,
      icon: Search,
      color: "text-emerald-400",
      borderColor: "group-hover:border-emerald-500/50",
      hoverText: "group-hover:text-emerald-400",
      title: "Stress-Tests Claims",
      modalTitle: "Adversarial Verification",
      modalSubtitle: "Powered by Google Search Grounding",
      content: (
        <div className="space-y-4 text-slate-300">
            <p>
                Hallucinations happen when models are confident but wrong. To catch them, we must introduce <strong>Friction</strong>.
            </p>
            <p>
                Faultline isolates "Load-Bearing Facts" (high importance claims) and uses the <strong>Gemini API's native <code>googleSearch</code> tool</strong> to run live verification queries. If the search results don't align with the claim, we flag it as a fracture.
            </p>
            <div className="bg-emerald-950/30 p-4 rounded-lg border border-emerald-500/20 text-sm mt-4">
                <div className="flex items-center gap-2 mb-2 text-emerald-400 font-bold">
                    <Cpu size={16} />
                    <span>Dev Lesson: Grounding</span>
                </div>
                For enterprise applications, reasoning without grounding is dangerous. Always connect your model to the world using Tools.
            </div>
        </div>
      )
    },
    {
      id: 2,
      icon: AlertTriangle,
      color: "text-red-400",
      borderColor: "group-hover:border-red-500/50",
      hoverText: "group-hover:text-red-400",
      title: "Locates Fault Lines",
      modalTitle: "Seismic Risk Assessment",
      modalSubtitle: "Join the Kaggle Competition",
      content: (
        <div className="space-y-4 text-slate-300">
            <p>
                Not all errors are equal. A wrong date is a crack; a wrong conclusion is a collapse.
            </p>
            <p>
                We calculate a <strong>Stability Score</strong> based strictly on verified facts, ignoring subjective fluff. This is the kind of "System 2" thinking that Gemini 3 excels at—analyzing its own output for logical consistency.
            </p>
            <div className="bg-red-950/30 p-4 rounded-lg border border-red-500/20 text-sm mt-4">
                <div className="flex items-center gap-2 mb-2 text-red-400 font-bold">
                    <Trophy size={16} />
                    <span>Steal this Idea</span>
                </div>
                We built this for the Gemini 3 Kaggle Competition. The tools are free to try. What will you build?
            </div>
            <a href="https://www.kaggle.com/competitions/gemini-3" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-red-400 transition-colors mt-2">
                <ExternalLink size={12} />
                View the Competition on Kaggle
            </a>
        </div>
      )
    }
  ];
