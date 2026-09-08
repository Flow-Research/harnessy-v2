import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';

type AgentNode = 'claude' | 'codex' | 'opencode' | null;

export function HarnessDiagram() {
  const [hoveredNode, setHoveredNode] = useState<AgentNode>(null);
  const [pulseIndices, setPulseIndices] = useState<number[]>([]);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 640);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setPulseIndices((prev) => [...prev, Date.now()]);
    }, 2500);
    return () => clearInterval(interval);
  }, [isMobile]);

  const agents = [
    { id: 'claude', label: 'Claude Code', yDesktop: 40, xMobile: 40 },
    { id: 'codex', label: 'Codex', yDesktop: 160, xMobile: 160 },
    { id: 'opencode', label: 'OpenCode', yDesktop: 280, xMobile: 280 },
  ];

  const caps = [
    { id: 'skills', label: 'skills', yDesktop: 20, xMobile: 40 },
    { id: 'memory', label: 'memory', yDesktop: 100, xMobile: 120 },
    { id: 'config', label: 'config', yDesktop: 220, xMobile: 200 },
    { id: 'connectors', label: 'connectors', yDesktop: 300, xMobile: 280 },
  ];

  const getOpacity = (id: string) => {
    if (!hoveredNode) return 1;
    if (hoveredNode === id) return 1;
    return 0.3;
  };

  return (
    <div className="w-full max-w-4xl mx-auto overflow-visible" aria-label="Harnessy Diagram showing agents connecting to capabilities via harnessy">
      {/* Desktop Version */}
      <svg
        className="hidden sm:block w-full h-auto"
        viewBox="0 0 800 320"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g className="lines">
          {agents.map((agent, i) => (
            <g key={agent.id} className="transition-opacity duration-300" style={{ opacity: getOpacity(agent.id) }}>
              <motion.path
                d={`M 180 ${agent.yDesktop} L 280 ${agent.yDesktop} L 360 160`}
                stroke="var(--color-hairline)"
                strokeWidth="2"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: i * 0.1 }}
              />
              {pulseIndices.map(key => (
                <motion.path
                  key={key}
                  d={`M 180 ${agent.yDesktop} L 280 ${agent.yDesktop} L 360 160`}
                  stroke="var(--color-signal-amber)"
                  strokeWidth="2"
                  strokeDasharray="40 1000"
                  initial={{ strokeDashoffset: 1040 }}
                  animate={{ strokeDashoffset: -40 }}
                  transition={{ duration: 2, ease: "linear" }}
                />
              ))}
            </g>
          ))}

          {caps.map((cap, i) => (
            <g key={cap.id} className="transition-opacity duration-300" style={{ opacity: hoveredNode ? 1 : 1 }}>
              <motion.path
                d={`M 440 160 L 520 ${cap.yDesktop} L 620 ${cap.yDesktop}`}
                stroke="var(--color-hairline)"
                strokeWidth="2"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: 0.4 + i * 0.1 }}
              />
               {pulseIndices.map(key => (
                <motion.path
                  key={`${key}-${cap.id}`}
                  d={`M 440 160 L 520 ${cap.yDesktop} L 620 ${cap.yDesktop}`}
                  stroke="var(--color-signal-amber)"
                  strokeWidth="2"
                  strokeDasharray="40 1000"
                  initial={{ strokeDashoffset: 1040 }}
                  animate={{ strokeDashoffset: -40 }}
                  transition={{ duration: 2, ease: "linear", delay: 1 }}
                />
              ))}
            </g>
          ))}
        </g>

        <g className="nodes">
          {agents.map((agent) => (
            <g
              key={agent.id}
              transform={`translate(40, ${agent.yDesktop})`}
              onMouseEnter={() => setHoveredNode(agent.id as AgentNode)}
              onMouseLeave={() => setHoveredNode(null)}
              className="cursor-pointer transition-opacity duration-300 outline-none focus-visible:ring-2 ring-signal-amber ring-offset-2 ring-offset-rig-black"
              style={{ opacity: getOpacity(agent.id) }}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setHoveredNode(agent.id as AgentNode);
                if (e.key === 'Escape') setHoveredNode(null);
              }}
            >
              <text y="5" fill="var(--color-fog)" className="font-mono text-sm" textAnchor="start">
                [ {agent.label} ]
              </text>
            </g>
          ))}

          <g transform={`translate(400, 160)`}>
            <rect x="-40" y="-16" width="80" height="32" rx="4" fill="var(--color-panel-dark)" stroke="var(--color-hairline)" />
            <text y="4" fill="var(--color-fog)" className="font-mono text-sm" textAnchor="middle">
              harnessy
            </text>
          </g>

          {caps.map((cap) => (
            <g
              key={cap.id}
              transform={`translate(640, ${cap.yDesktop})`}
              className="transition-opacity duration-300"
              style={{ opacity: hoveredNode ? 1 : 1 }}
            >
               <text y="5" fill="var(--color-fog-dim)" className="font-mono text-sm" textAnchor="start">
                [ {cap.label} ]
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* Mobile Version */}
      <svg
        className="block sm:hidden w-full h-auto min-h-[400px]"
        viewBox="0 0 320 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
         <g className="lines-mobile">
          {agents.map((agent, i) => (
            <g key={agent.id} className="transition-opacity duration-300" style={{ opacity: getOpacity(agent.id) }}>
              <motion.path
                d={`M ${agent.xMobile} 60 L ${agent.xMobile} 100 L 160 160`}
                stroke="var(--color-hairline)"
                strokeWidth="2"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: i * 0.1 }}
              />
              {pulseIndices.map(key => (
                <motion.path
                  key={key}
                  d={`M ${agent.xMobile} 60 L ${agent.xMobile} 100 L 160 160`}
                  stroke="var(--color-signal-amber)"
                  strokeWidth="2"
                  strokeDasharray="40 1000"
                  initial={{ strokeDashoffset: 1040 }}
                  animate={{ strokeDashoffset: -40 }}
                  transition={{ duration: 1.5, ease: "linear" }}
                />
              ))}
            </g>
          ))}

          {caps.map((cap, i) => (
            <g key={cap.id} className="transition-opacity duration-300" style={{ opacity: hoveredNode ? 1 : 1 }}>
              <motion.path
                d={`M 160 200 L ${cap.xMobile} 260 L ${cap.xMobile} 300`}
                stroke="var(--color-hairline)"
                strokeWidth="2"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: 0.4 + i * 0.1 }}
              />
               {pulseIndices.map(key => (
                <motion.path
                  key={`${key}-${cap.id}`}
                  d={`M 160 200 L ${cap.xMobile} 260 L ${cap.xMobile} 300`}
                  stroke="var(--color-signal-amber)"
                  strokeWidth="2"
                  strokeDasharray="40 1000"
                  initial={{ strokeDashoffset: 1040 }}
                  animate={{ strokeDashoffset: -40 }}
                  transition={{ duration: 1.5, ease: "linear", delay: 0.75 }}
                />
              ))}
            </g>
          ))}
        </g>

        <g className="nodes-mobile">
          {agents.map((agent) => (
            <g
              key={agent.id}
              transform={`translate(${agent.xMobile}, 40)`}
              onClick={() => setHoveredNode(hoveredNode === agent.id ? null : agent.id as AgentNode)}
              className="cursor-pointer transition-opacity duration-300 outline-none"
              style={{ opacity: getOpacity(agent.id) }}
              tabIndex={0}
              role="button"
            >
              <text y="5" fill="var(--color-fog)" className="font-mono text-xs" textAnchor="middle">
                [{agent.label}]
              </text>
            </g>
          ))}

          <g transform={`translate(160, 180)`}>
            <rect x="-40" y="-16" width="80" height="32" rx="4" fill="var(--color-panel-dark)" stroke="var(--color-hairline)" />
            <text y="4" fill="var(--color-fog)" className="font-mono text-sm" textAnchor="middle">
              harnessy
            </text>
          </g>

          {caps.map((cap) => (
            <g
              key={cap.id}
              transform={`translate(${cap.xMobile}, 320)`}
              className="transition-opacity duration-300"
              style={{ opacity: hoveredNode ? 1 : 1 }}
            >
               <text y="5" fill="var(--color-fog-dim)" className="font-mono text-xs" textAnchor="middle">
                [{cap.label}]
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
