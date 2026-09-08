import { motion } from 'motion/react';

export function RouterIcon({ className }: { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      whileHover="hover"
      animate="rest"
    >
      <circle cx="12" cy="12" r="3" />
      <motion.path
        d="M12 4 L12 9"
        variants={{ rest: { pathLength: 1 }, hover: { pathLength: [0, 1] } }}
        transition={{ duration: 0.3, delay: 0 }}
      />
      <circle cx="12" cy="3" r="1" />
      
      <motion.path
        d="M5 19 L8.5 15.5"
        variants={{ rest: { pathLength: 1 }, hover: { pathLength: [0, 1] } }}
        transition={{ duration: 0.3, delay: 0.08 }}
      />
      <circle cx="4" cy="20" r="1" />

      <motion.path
        d="M19 19 L15.5 15.5"
        variants={{ rest: { pathLength: 1 }, hover: { pathLength: [0, 1] } }}
        transition={{ duration: 0.3, delay: 0.16 }}
      />
      <circle cx="20" cy="20" r="1" />
    </motion.svg>
  );
}

export function GateIcon({ className }: { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      whileHover="hover"
      whileInView="hover"
      viewport={{ once: true }}
    >
      <path d="M6 4 L6 20" />
      <path d="M18 4 L18 20" />
      <motion.path
        d="M6 12 L18 12"
        variants={{
          rest: { y: -6 },
          hover: { y: 0 }
        }}
        transition={{ type: "spring", stiffness: 300, damping: 15 }}
      />
    </motion.svg>
  );
}

export function DialIcon({ className }: { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      whileHover="hover"
    >
      <path d="M4 16 A 10 10 0 0 1 20 16" />
      <circle cx="12" cy="16" r="2" />
      <motion.path
        d="M12 16 L6 10"
        variants={{
          rest: { rotate: 0, transformOrigin: "12px 16px" },
          hover: { rotate: 60, transformOrigin: "12px 16px" }
        }}
        transition={{ type: "spring", stiffness: 100, damping: 12 }}
      />
    </motion.svg>
  );
}

export function StackedLayerIcon({ className }: { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      whileHover="hover"
    >
      <motion.path
        d="M12 4 L20 8 L12 12 L4 8 Z"
        variants={{ rest: { y: 0 }, hover: { y: -4 } }}
        transition={{ type: "spring", stiffness: 200, damping: 15 }}
      />
      <motion.path
        d="M4 12 L12 16 L20 12"
        variants={{ rest: { y: 0 }, hover: { y: -2 } }}
        transition={{ type: "spring", stiffness: 200, damping: 15 }}
      />
      <path d="M4 16 L12 20 L20 16" />
    </motion.svg>
  );
}

export function TerminalCaretIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 8 L10 12 L6 16" />
      <motion.rect
        x="13"
        y="8"
        width="2"
        height="8"
        fill="currentColor"
        stroke="none"
        animate={{ opacity: [1, 0, 1] }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
      />
    </svg>
  );
}

export function BranchMergeIcon({ className }: { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      whileInView="hover"
      viewport={{ once: true }}
    >
      <path d="M6 3 L6 7" />
      <path d="M6 17 L6 21" />
      <motion.path
        d="M6 7 C 6 10, 12 10, 12 12 C 12 14, 6 14, 6 17"
        variants={{ rest: { pathLength: 0 }, hover: { pathLength: 1 } }}
        transition={{ duration: 0.6 }}
      />
      <motion.path
        d="M6 7 C 6 10, 18 10, 18 12 C 18 14, 6 14, 6 17"
        variants={{ rest: { pathLength: 0 }, hover: { pathLength: 1 } }}
        transition={{ duration: 0.6, delay: 0.1 }}
      />
    </motion.svg>
  );
}
