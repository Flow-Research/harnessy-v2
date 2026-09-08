import { useState } from 'react';
import { motion } from 'motion/react';
import {
  RouterIcon,
  GateIcon,
  DialIcon,
  StackedLayerIcon,
  TerminalCaretIcon,
  BranchMergeIcon
} from '@/components/Icons';
import { HarnessDiagram } from '@/components/HarnessDiagram';

function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-20%" }}
      transition={{ duration: 0.4, ease: "easeOut", delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function CopyButton() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText('npm install');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="bg-signal-amber text-rig-black font-sans font-medium text-[13px] tracking-wide uppercase px-4 py-2 rounded flex items-center gap-2 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-signal-amber focus:ring-offset-2 focus:ring-offset-rig-black"
    >
      {copied ? (
        <span className="flex items-center gap-1.5">
          <motion.svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <motion.path
              d="M20 6L9 17l-5-5"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.3 }}
            />
          </motion.svg>
          Copied
        </span>
      ) : (
        'Copy install command'
      )}
    </button>
  );
}

export default function App() {
  return (
    <div className="relative w-full">
      {/* Schematic Grid Background (Hero & Pillars only) */}
      <div className="absolute top-0 left-0 w-full h-[1800px] pointer-events-none z-[-1] flex justify-center overflow-hidden">
        <div className="w-full max-w-[1200px] h-full" style={{
          backgroundImage: 'linear-gradient(to right, var(--color-hairline) 1px, transparent 1px), linear-gradient(to bottom, var(--color-hairline) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          opacity: 0.2,
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)'
        }}></div>
      </div>

      {/* Nav */}
      <nav className="fixed top-0 left-0 w-full h-16 bg-panel-dark border-b border-hairline z-50 flex items-center justify-center px-6 sm:px-12">
        <div className="w-full max-w-[1200px] flex items-center justify-between">
          <div className="font-display font-semibold text-xl lowercase tracking-tight">harnessy</div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/Flow-Research/harnessy-v2" className="hidden sm:inline-flex px-4 py-2 text-[13px] uppercase font-medium tracking-wide text-fog border border-hairline rounded hover:bg-hairline/50 transition-colors focus:outline-none focus:ring-2 focus:ring-signal-amber focus:ring-offset-2 focus:ring-offset-panel-dark">
              GitHub
            </a>
            <CopyButton />
          </div>
        </div>
      </nav>

      <main className="w-full max-w-[1200px] mx-auto px-6 sm:px-12 pt-32 pb-24 flex flex-col gap-14 sm:gap-24">
        
        {/* 6.2 Hero */}
        <section className="flex flex-col items-start pt-12 sm:pt-20">
          <Reveal delay={0}>
            <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-signal-amber mb-4 block">
              OPEN SOURCE · MIT · BUILT ON PI
            </span>
            <h1 className="font-display font-semibold text-[40px] leading-[1.1] sm:text-[72px] sm:leading-[1.02] tracking-tight text-fog max-w-3xl mb-6">
              Reusable Harness for all your agents.
            </h1>
            <p className="font-sans text-[16px] leading-[1.6] sm:text-[19px] sm:leading-[1.55] text-fog-dim max-w-[640px] mb-8">
              Harnessy packages your skills, memory, configuration, and connectors into one portable capability layer, so Claude Code, Codex, and OpenCode can all work from the same brain instead of you maintaining three of them.
            </p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-16">
              <CopyButton />
              <a href="https://github.com/Flow-Research/harnessy-v2" className="inline-flex px-4 py-2 text-[13px] uppercase font-medium tracking-wide text-fog border border-hairline rounded hover:bg-hairline/50 transition-colors focus:outline-none focus:ring-2 focus:ring-signal-amber focus:ring-offset-2 focus:ring-offset-rig-black">
                View on GitHub
              </a>
            </div>
          </Reveal>

          <Reveal delay={0.2} className="w-full">
            <HarnessDiagram />
            <p className="font-mono text-[14px] text-fog-dim text-center mt-6">
              <span className="text-signal-amber">harnessy verify</span> → checks lockfile, context, profile, paths
            </p>
          </Reveal>
        </section>

        {/* 6.3 The problem */}
        <section className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-8 md:gap-12 items-start pt-12 sm:pt-24 border-t border-hairline/50">
          <Reveal className="flex flex-col gap-4">
            <h2 className="font-display font-medium text-[24px] sm:text-[32px] leading-[1.1] text-fog">
              Every new agent tool taxes you the same way.
            </h2>
            <p className="font-sans text-[16px] leading-[1.6] text-fog-dim">
              A new coding agent ships. You rewrite the skills. You re-teach the memory. You rebuild the connectors. Do this enough times and your 'agent stack' is really just the same work, copied three times, slowly drifting out of sync.
            </p>
          </Reveal>
          
          <div className="hidden md:block w-px h-full bg-hairline"></div>

          <Reveal delay={0.1} className="flex flex-col gap-4">
             <div className="text-signal-amber mb-2"><BranchMergeIcon className="w-8 h-8" /></div>
            <p className="font-sans text-[16px] leading-[1.6] text-fog-dim">
              This is what happened inside Flow Research's own tooling. Harnessy v1 was a working, bespoke ~28,000-line Python engine — one implementation, locked to its own runtime.
            </p>
            <p className="font-sans text-[16px] leading-[1.6] text-fog-dim">
              v2 rebuilds it as a portable layer on Pi, and keeps v1 running underneath as a compatibility pack while that happens. Nothing regresses on the way.
            </p>
          </Reveal>
        </section>

        {/* 6.4 How it works - Four pillars */}
        <section className="pt-12 sm:pt-24">
          <Reveal>
            <h2 className="font-display font-semibold text-[32px] sm:text-[48px] leading-[1.1] sm:leading-[1.05] tracking-tight text-fog mb-4">
              What actually moves with you
            </h2>
            <p className="font-sans text-[16px] leading-[1.6] text-fog-dim max-w-2xl mb-12">
              Four things Harnessy standardizes so they outlive whichever tool you're using this month.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Reveal delay={0.1}>
              <div className="bg-paper text-ink rounded flex flex-col p-8 h-full border border-black/5 group">
                <RouterIcon className="w-8 h-8 text-fog-dim group-hover:text-signal-amber transition-colors mb-6" />
                <h3 className="font-display font-medium text-[24px] leading-[1.2] mb-3">Portable, not personal to one agent.</h3>
                <p className="font-sans text-[16px] leading-[1.6] text-ink/70 mb-8 flex-grow">
                  Skills, memory, config, and connectors are packaged as capability packs that any supported agent host can read — Claude Code, Codex, OpenCode, and compatible runtimes.
                </p>
                <div className="font-mono text-[14px] text-ink/60 bg-black/5 px-3 py-2 rounded-sm self-start">
                  harnessy capability add &lt;source&gt;
                </div>
              </div>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="bg-paper text-ink rounded flex flex-col p-8 h-full border border-black/5 group">
                <GateIcon className="w-8 h-8 text-fog-dim group-hover:text-signal-amber transition-colors mb-6" />
                <h3 className="font-display font-medium text-[24px] leading-[1.2] mb-3">Plan-only until you say otherwise.</h3>
                <p className="font-sans text-[16px] leading-[1.6] text-ink/70 mb-8 flex-grow">
                  Global writes, command execution, and clones only happen behind explicit flags. Nothing reaches outside the project by accident.
                </p>
                <div className="font-mono text-[14px] text-ink/60 bg-black/5 px-3 py-2 rounded-sm self-start whitespace-nowrap overflow-x-auto max-w-full">
                  --apply-global --apply-bootstrap --run-external
                </div>
              </div>
            </Reveal>

            <Reveal delay={0.3}>
              <div className="bg-paper text-ink rounded flex flex-col p-8 h-full border border-black/5 group">
                <DialIcon className="w-8 h-8 text-fog-dim group-hover:text-signal-amber transition-colors mb-6" />
                <h3 className="font-display font-medium text-[24px] leading-[1.2] mb-3">Skills that get scored, not just shipped.</h3>
                <p className="font-sans text-[16px] leading-[1.6] text-ink/70 mb-8 flex-grow">
                  Every skill has a lifecycle — create, validate, promote, gather feedback — and a quality trail: metrics, trend, and per-component attribution.
                </p>
                <div className="font-mono text-[14px] text-ink/60 bg-black/5 px-3 py-2 rounded-sm self-start whitespace-nowrap overflow-x-auto max-w-full">
                  harnessy skill ratchet score|gates|snapshot
                </div>
              </div>
            </Reveal>

            <Reveal delay={0.4}>
              <div className="bg-paper text-ink rounded flex flex-col p-8 h-full border border-black/5 group">
                <StackedLayerIcon className="w-8 h-8 text-fog-dim group-hover:text-signal-amber transition-colors mb-6" />
                <h3 className="font-display font-medium text-[24px] leading-[1.2] mb-3">Deterministic underneath.</h3>
                <p className="font-sans text-[16px] leading-[1.6] text-ink/70 mb-8 flex-grow">
                  Built on Pi, Harnessy's services are typed and tested with fakes — no live network or timing dependencies in the test suite, so runs stay repeatable.
                </p>
                <div className="font-mono text-[14px] text-ink/60 bg-black/5 px-3 py-2 rounded-sm self-start whitespace-nowrap overflow-x-auto max-w-full">
                  packages/agent · packages/ai · packages/tui
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 6.5 The CLI */}
        <section className="pt-12 sm:pt-24">
          <Reveal delay={0.1}>
            <div className="bg-panel-dark border border-hairline rounded-none overflow-hidden flex flex-col w-full shadow-[0_2px_0_0_rgba(0,0,0,0.5)]">
              {/* Terminal header */}
              <div className="h-8 border-b border-hairline flex items-center px-4 gap-2">
                <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
                <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
                <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
              </div>
              {/* Terminal body */}
              <div className="p-6 sm:p-8 font-mono text-[14px] sm:text-[15px] leading-[1.6] overflow-x-auto whitespace-pre">
<span className="text-signal-amber">harnessy</span> init{'\n'}
<span className="text-signal-amber">harnessy</span> install{'\n'}
<span className="text-signal-amber">harnessy</span> verify{'\n'}
<span className="text-signal-amber">harnessy</span> capability add <span className="text-fog-dim">&lt;source&gt;</span>{'\n'}
<span className="text-signal-amber">harnessy</span> skill create|validate|promote <span className="text-fog-dim">&lt;skill&gt;</span>
<TerminalCaretIcon className="w-4 h-4 inline-block text-fog ml-1 -mb-0.5" />
              </div>
            </div>
          </Reveal>
        </section>

        {/* 6.6 Roadmap */}
        <section className="pt-12 sm:pt-24">
           <Reveal>
             <h2 className="font-display font-semibold text-[32px] sm:text-[48px] leading-[1.1] sm:leading-[1.05] tracking-tight text-fog mb-12">
               Roadmap
             </h2>
          </Reveal>

          <div className="relative border-l border-hairline ml-3 sm:ml-4 pl-8 sm:pl-12 flex flex-col gap-12">
            {[
              "Re-home v1's connectors (AnyType, Notion, GitHub, meetings) as portable Harnessy capabilities with a reviewed execution boundary.",
              "Ship an agent-first capability runtime on Pi — resolving and running skills, memory, and connectors without hand-run CLI steps.",
              "Prove it on real knowledge workflows: GitHub pushes that update docs automatically, meeting notes that become tasks, daily briefings assembled from both.",
              "Rebuild Jarvis's orchestration layer natively on Pi, replacing the original Python engine it was ported from."
            ].map((text, i) => (
              <Reveal key={i} delay={i * 0.1} className="relative">
                {/* Marker */}
                <div className="absolute -left-[39px] sm:-left-[55px] top-1.5 w-[14px] h-[14px] rounded-full border-2 border-rig-black bg-signal-amber ring-1 ring-hairline"></div>
                <p className="font-sans text-[16px] sm:text-[19px] leading-[1.6] text-fog-dim">
                  {text}
                </p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* 6.9 Open source / install */}
        <section className="pt-12 sm:pt-24 mb-12">
          <Reveal>
             <h2 className="font-display font-semibold text-[32px] sm:text-[48px] leading-[1.1] sm:leading-[1.05] tracking-tight text-fog mb-12">
               MIT-licensed. Install it and read the source.
             </h2>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
             <Reveal delay={0.1} className="flex flex-col gap-8">
               <p className="font-sans text-[16px] leading-[1.6] text-fog-dim">
                  Harnessy is MIT-licensed, and so is Pi underneath it. There's no hosted version of this page to sign up for — clone it, build it, and run <code className="font-mono text-[14px] bg-panel-dark px-1.5 py-0.5 rounded border border-hairline">--help</code> to see what your version supports.
               </p>
               <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <CopyButton />
                   <a href="https://github.com/Flow-Research/harnessy-v2/blob/dev/CONTRIBUTING.md" className="inline-flex px-4 py-2 text-[13px] uppercase font-medium tracking-wide text-fog border border-hairline rounded hover:bg-hairline/50 transition-colors focus:outline-none focus:ring-2 focus:ring-signal-amber focus:ring-offset-2 focus:ring-offset-rig-black">
                     Read CONTRIBUTING.md
                   </a>
               </div>
             </Reveal>

             <Reveal delay={0.2}>
               <div className="bg-panel-dark border border-hairline rounded-none overflow-hidden shadow-[0_2px_0_0_rgba(0,0,0,0.5)]">
                  <div className="h-8 border-b border-hairline flex items-center px-4 gap-2">
                    <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
                    <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
                    <div className="w-2.5 h-2.5 bg-hairline rounded-sm"></div>
                  </div>
                  <div className="p-6 font-mono text-[14px] leading-[1.6] text-fog overflow-x-auto whitespace-pre">
npm install{'\n'}
npm run build{'\n'}
node packages/harnessy-core/dist/cli.js --help
                  </div>
               </div>
             </Reveal>
          </div>
        </section>
      </main>

      {/* 6.10 Footer */}
      <footer className="w-full bg-panel-dark border-t border-hairline py-12 px-6 sm:px-12 mt-12">
        <div className="w-full max-w-[1200px] mx-auto flex flex-col gap-12">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
            <div className="flex flex-col gap-2">
              <div className="font-display font-semibold text-xl lowercase tracking-tight">harnessy</div>
              <div className="font-sans text-[16px] text-fog-dim">An open-source project from Flow Research.</div>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <a href="https://github.com/Flow-Research/harnessy-v2" className="font-sans text-[16px] text-fog-dim hover:text-fog transition-colors">GitHub</a>
              <a href="https://github.com/Flow-Research/harnessy-v2/blob/main/VISION.md" className="font-sans text-[16px] text-fog-dim hover:text-fog transition-colors">VISION.md</a>
              <a href="https://github.com/Flow-Research/harnessy-v2/blob/dev/CONTRIBUTING.md" className="font-sans text-[16px] text-fog-dim hover:text-fog transition-colors">Contributing</a>
              <a href="https://github.com/Flow-Research/harnessy-v2/security/policy" className="font-sans text-[16px] text-fog-dim hover:text-fog transition-colors">Security policy</a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-medium tracking-wide uppercase text-fog-dim border-t border-hairline/50 pt-8">
            <span className="text-fog">Jarvis</span> <span className="opacity-50">— the collaboration protocol</span>
            <span className="opacity-30">·</span>
            <span className="text-fog">Garden</span> <span className="opacity-50">— the workspace</span>
            <span className="opacity-30">·</span>
            <span className="text-fog">WorkStream</span> <span className="opacity-50">— the task pipeline</span>
            <span className="opacity-30">·</span>
            <span className="text-signal-amber">Harnessy</span> <span className="opacity-50">— this project</span>
          </div>

          <div className="font-mono text-[13px] text-fog-dim/50">
            MIT License · Built on Pi
          </div>
        </div>
      </footer>
    </div>
  );
}
